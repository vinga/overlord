package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
)

// clientRegistry tracks connected pipe clients for output broadcast
type clientRegistry struct {
	mu      sync.RWMutex
	clients map[net.Conn]struct{}
}

func newClientRegistry() *clientRegistry {
	return &clientRegistry{clients: make(map[net.Conn]struct{})}
}

func (r *clientRegistry) add(conn net.Conn) {
	r.mu.Lock()
	r.clients[conn] = struct{}{}
	r.mu.Unlock()
}

func (r *clientRegistry) remove(conn net.Conn) {
	r.mu.Lock()
	delete(r.clients, conn)
	r.mu.Unlock()
}

func (r *clientRegistry) broadcast(data []byte) {
	r.mu.RLock()
	var dead []net.Conn
	for conn := range r.clients {
		_, err := conn.Write(data)
		if err != nil {
			dead = append(dead, conn)
		}
	}
	r.mu.RUnlock()
	// Clean up broken connections
	if len(dead) > 0 {
		r.mu.Lock()
		for _, conn := range dead {
			delete(r.clients, conn)
			conn.Close()
			fmt.Fprintf(os.Stderr, "[bridge] removed dead client from broadcast\n")
		}
		r.mu.Unlock()
	}
}

func main() {
	// Redirect stderr to a log file so bridge diagnostics don't render
	// in the console window and corrupt ConPTY output
	logFile, err := os.OpenFile(filepath.Join(os.TempDir(), "overlord-bridge.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		os.Stderr = logFile
	}

	enableVTProcessing()
	setRawInputMode()

	pipeName := flag.String("pipe", "", "Pipe/socket name (e.g. overlord-{sessionId})")
	titleFlag := flag.String("title", "", "Short display name to set as terminal window title")
	flag.Parse()

	if *pipeName == "" {
		fmt.Fprintln(os.Stderr, "Usage: overlord-bridge --pipe <name> [--title <name>] -- <command> [args...]")
		os.Exit(1)
	}

	// Set a clean terminal title and suppress child's own title escape sequences.
	// The child (Claude) embeds bridge marker suffixes in its --name flag which it
	// broadcasts via OSC title sequences — this keeps the host terminal title short.
	var titleFilter *stdoutTitleFilter
	if *titleFlag != "" {
		fmt.Printf("\033]0;%s\007", *titleFlag)
		titleFilter = newStdoutTitleFilter()
	}

	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "No command specified after --")
		os.Exit(1)
	}

	// Create named pipe / unix socket listener
	listener, addr, err := createListener(*pipeName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create listener: %v\n", err)
		os.Exit(1)
	}
	defer cleanupListener(listener, *pipeName)

	fmt.Fprintf(os.Stderr, "[bridge] Listening on %s\n", addr)

	clients := newClientRegistry()

	// Start child via ConPTY (Windows) or plain pty (Unix)
	// Returns: write-to-child func, wait func, child PID, nudge func, resize+nudge func, reader-dead channel
	writeToChild, waitForChild, childPid, nudgeRedraw, resizeAndNudge, readerDead, err := startChildWithPty(args, clients, titleFilter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start child: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "[bridge] Child PID: %d\n", childPid)

	// Forward console stdin to child, stripping DA1/DA2 terminal responses
	// that Terminal.app injects on focus (e.g. ESC[?1;2c) — these must not
	// reach Claude as input or they appear as visible garbage in the prompt.
	go func() {
		f := newStdinFilter()
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				fmt.Fprintf(os.Stderr, "[bridge-stdin] raw %d bytes: %q\n", n, string(buf[:n]))
				if filtered := f.filter(buf[:n]); len(filtered) > 0 {
					fmt.Fprintf(os.Stderr, "[bridge-stdin] forwarding %d bytes: %q\n", len(filtered), string(filtered))
					writeToChild(filtered)
				} else {
					fmt.Fprintf(os.Stderr, "[bridge-stdin] all filtered\n")
				}
			}
			if err != nil {
				break
			}
		}
	}()

	// Accept pipe connections
	// Protocol: client sends a 6-byte handshake to identify connection type:
	//   "INPUT\n"  → input-only (reads forwarded to child, no output broadcast)
	//   "OUTPT\n"  → output-only (receives broadcast, no reads forwarded)
	//   anything else → legacy bidirectional connection
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				break
			}
			go func() {
				header := make([]byte, 6)
				n, err := conn.Read(header)
				if err != nil {
					conn.Close()
					return
				}

				if n == 6 && string(header[:6]) == "OUTPT\n" {
					// Output-only connection: receives broadcast, no input forwarding
					fmt.Fprintf(os.Stderr, "[bridge] Output-only client connected\n")
					clients.add(conn)
					// Nudge ConPTY to redraw so this client gets the current screen
					nudgeRedraw()
					defer func() {
						clients.remove(conn)
						conn.Close()
						fmt.Fprintf(os.Stderr, "[bridge] Output-only client disconnected\n")
					}()
					// Block until the connection is closed (drain any unexpected data)
					buf := make([]byte, 4096)
					for {
						_, err := conn.Read(buf)
						if err != nil {
							break
						}
					}
					return
				}

				if n == 6 && string(header[:6]) == "NUDGE\n" {
					// Nudge-only connection: trigger full redraw and close immediately
					fmt.Fprintf(os.Stderr, "[bridge] Nudge request: triggering ConPTY redraw\n")
					nudgeRedraw()
					conn.Close()
					return
				}

				if n == 6 && string(header[:6]) == "RSNUD\n" {
					// Resize+Nudge: read "cols rows\n", resize ConPTY to match Overlord's xterm,
					// then force a full repaint so content renders at the correct width.
					sizeBuf := make([]byte, 32)
					sn, _ := conn.Read(sizeBuf)
					var newCols, newRows int
					fmt.Sscanf(string(sizeBuf[:sn]), "%d %d", &newCols, &newRows)
					fmt.Fprintf(os.Stderr, "[bridge] Resize+Nudge: %dx%d\n", newCols, newRows)
					if newCols > 0 && newRows > 0 {
						resizeAndNudge(newCols, newRows)
					} else {
						nudgeRedraw()
					}
					conn.Close()
					return
				}

				if n == 6 && string(header[:6]) == "GETTY\n" {
					// GETTY: respond with this bridge's controlling TTY path, then close.
					// The server uses the path to find the right Terminal.app tab via AppleScript.
					ttyPath := getBridgeTTY()
					fmt.Fprintf(os.Stderr, "[bridge] GETTY: %q\n", ttyPath)
					conn.Write([]byte(ttyPath + "\n"))
					conn.Close()
					return
				}

				if n == 6 && string(header[:6]) == "INPUT\n" {
					// Input-only connection: forward pipe→child, no broadcast.
					// Apply the same filter as stdin to strip focus-tracking sequences
					// (ESC[I / ESC[O) that xterm.js generates on browser focus changes.
					fmt.Fprintf(os.Stderr, "[bridge] Input-only client connected\n")
					defer func() {
						conn.Close()
						fmt.Fprintf(os.Stderr, "[bridge] Input-only client disconnected\n")
					}()
					pf := newStdinFilter()
					buf := make([]byte, 4096)
					for {
						n, err := conn.Read(buf)
						if n > 0 {
							fmt.Fprintf(os.Stderr, "[bridge] pipe→child %d bytes: %q\n", n, string(buf[:n]))
							if filtered := pf.filter(buf[:n]); len(filtered) > 0 {
								writeToChild(filtered)
							}
						}
						if err != nil {
							break
						}
					}
				} else {
					// Normal bidirectional connection: read input + receive broadcast
					fmt.Fprintf(os.Stderr, "[bridge] Client connected\n")
					// Forward the header bytes we already read (they're real input)
					if n > 0 {
						writeToChild(header[:n])
					}
					clients.add(conn)
					defer func() {
						clients.remove(conn)
						conn.Close()
						fmt.Fprintf(os.Stderr, "[bridge] Client disconnected\n")
					}()
					buf := make([]byte, 4096)
					for {
						n, err := conn.Read(buf)
						if n > 0 {
							writeToChild(buf[:n])
						}
						if err != nil {
							break
						}
					}
				}
			}()
		}
	}()

	// Forward signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	if runtime.GOOS != "windows" {
		signal.Notify(sigCh, syscall.SIGTERM)
	}
	go func() {
		for range sigCh {
			// ConPTY child gets signals through the pseudo-console
		}
	}()

	// Wait for child to exit OR ConPTY reader to die
	exitCh := make(chan int, 1)
	go func() {
		exitCh <- waitForChild()
	}()

	select {
	case exitCode := <-exitCh:
		fmt.Fprintf(os.Stderr, "[bridge] Child exited with code %d\n", exitCode)
		os.Exit(exitCode)
	case <-readerDead:
		// ConPTY reader died but child is still alive — bridge is now useless
		// (can't produce output). Exit so Overlord can detect the disconnection.
		fmt.Fprintf(os.Stderr, "[bridge] ConPTY reader died while child is still alive — exiting bridge\n")
		os.Exit(2)
	}
}
