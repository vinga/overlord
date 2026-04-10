// overlord-bridge: wraps a claude session in a PTY and exposes a Unix socket
// so Overlord can inject text and stream output regardless of window focus.
//
// Usage:
//
//	overlord-bridge [--pipe overlord-<marker>] -- claude [args...]
//	overlord-bridge -- claude [args...]          # auto-generates marker
//
// Protocol (each connection sends a 6-char + newline handshake):
//
//	INPUT\n  → bytes forwarded to claude's PTY master (injection)
//	OUTPT\n  → PTY output streamed back (Overlord xterm panel)
//	NUDGE\n  → trigger PTY redraw via SIGWINCH
//	RSNUD\n  → next line: "cols rows\n", resize PTY then nudge
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/term"
)

func main() {
	pipeName := flag.String("pipe", "", "socket name (creates /tmp/<name>.sock); auto-generated if omitted")
	flag.Parse()

	// Everything after "--" (or all remaining args if no "--") is the command.
	args := flag.Args()
	sepIdx := -1
	for i, a := range args {
		if a == "--" {
			sepIdx = i
			break
		}
	}
	var cmdArgs []string
	if sepIdx >= 0 {
		cmdArgs = args[sepIdx+1:]
	} else {
		cmdArgs = args
	}
	if len(cmdArgs) == 0 {
		fmt.Fprintln(os.Stderr, "usage: overlord-bridge [--pipe overlord-<marker>] -- <command> [args...]")
		os.Exit(1)
	}

	// Auto-generate marker if --pipe not given.
	name := *pipeName
	if name == "" {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			fmt.Fprintln(os.Stderr, "failed to generate marker:", err)
			os.Exit(1)
		}
		name = "overlord-" + hex.EncodeToString(b)
	}

	// Derive the bridge marker (strip "overlord-" prefix if present).
	marker := name
	if strings.HasPrefix(marker, "overlord-") {
		marker = marker[len("overlord-"):]
	}

	sockPath := filepath.Join(os.TempDir(), name+".sock")

	// Inject ___BRG:<marker> into --name flag so Overlord can auto-link the session.
	cmdArgs = injectBridgeMarker(cmdArgs, marker)

	fmt.Fprintf(os.Stderr, "[overlord-bridge] marker=%s socket=%s\n", marker, sockPath)
	fmt.Fprintf(os.Stderr, "[overlord-bridge] cmd: %s\n", strings.Join(cmdArgs, " "))

	// Start the command in a fresh PTY.
	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Env = os.Environ()

	ptmx, err := pty.Start(cmd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to start command:", err)
		os.Exit(1)
	}
	defer ptmx.Close()

	// Mirror the launching terminal's size onto the new PTY.
	if sz, err := pty.GetsizeFull(os.Stdin); err == nil {
		_ = pty.Setsize(ptmx, sz)
	}

	// Propagate SIGWINCH (terminal resize) from bridge's terminal → inner PTY.
	winchCh := make(chan os.Signal, 1)
	signal.Notify(winchCh, syscall.SIGWINCH)
	go func() {
		for range winchCh {
			if sz, err := pty.GetsizeFull(os.Stdin); err == nil {
				_ = pty.Setsize(ptmx, sz)
			}
		}
	}()
	winchCh <- syscall.SIGWINCH // initial size sync

	// Raw mode so ctrl chars pass through to claude unchanged.
	oldState, rawErr := term.MakeRaw(int(os.Stdin.Fd()))
	if rawErr == nil {
		defer term.Restore(int(os.Stdin.Fd()), oldState)
	}

	// Fan-out: PTY output → stdout (IntelliJ terminal) + all OUTPT sockets.
	bcast := &broadcaster{}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				_, _ = os.Stdout.Write(chunk)
				bcast.broadcast(chunk)
			}
			if err != nil {
				break
			}
		}
		bcast.close()
	}()

	// User keyboard → PTY master.
	go func() { _, _ = io.Copy(ptmx, os.Stdin) }()

	// Unix socket listener for Overlord connections.
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to listen:", err)
		os.Exit(1)
	}
	defer func() {
		ln.Close()
		os.Remove(sockPath)
	}()

	go acceptLoop(ln, ptmx, bcast, cmd)

	// Forward SIGTERM/SIGINT to the child.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		if cmd.Process != nil {
			_ = cmd.Process.Signal(sig)
		}
	}()

	_ = cmd.Wait()
}

// injectBridgeMarker appends ___BRG:<marker> to the --name flag value.
// If no --name flag is found it adds one.
func injectBridgeMarker(args []string, marker string) []string {
	suffix := "___BRG:" + marker
	for i, a := range args {
		if a == "--name" && i+1 < len(args) {
			args[i+1] = args[i+1] + suffix
			return args
		}
		if strings.HasPrefix(a, "--name=") {
			args[i] = a + suffix
			return args
		}
	}
	return append(args, "--name", suffix)
}

// acceptLoop handles incoming Unix socket connections.
func acceptLoop(ln net.Listener, ptmx *os.File, bcast *broadcaster, cmd *exec.Cmd) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go handleConn(conn, ptmx, bcast, cmd)
	}
}

func handleConn(conn net.Conn, ptmx *os.File, bcast *broadcaster, cmd *exec.Cmd) {
	defer conn.Close()

	// Read the handshake line.
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}
	handshake := strings.TrimSpace(scanner.Text())

	switch handshake {
	case "INPUT":
		// All subsequent bytes are forwarded to the PTY master (injection).
		_, _ = io.Copy(ptmx, conn)

	case "OUTPT":
		// Stream PTY output back to this socket.
		ch := bcast.subscribe()
		defer bcast.unsubscribe(ch)
		for chunk := range ch {
			if _, err := conn.Write(chunk); err != nil {
				return
			}
		}

	case "NUDGE":
		// Trigger a full repaint by sending SIGWINCH to the child process.
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGWINCH)
		}

	case "RSNUD":
		// Resize then nudge: next line is "cols rows".
		if !scanner.Scan() {
			return
		}
		var cols, rows uint16
		fmt.Sscanf(scanner.Text(), "%d %d", &cols, &rows)
		if cols > 0 && rows > 0 {
			_ = pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
		}
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGWINCH)
		}
	}
}

// broadcaster fans out PTY output chunks to all subscribed OUTPUT sockets.
type broadcaster struct {
	mu     sync.Mutex
	subs   map[chan []byte]struct{}
	closed bool
}

func (b *broadcaster) subscribe() chan []byte {
	ch := make(chan []byte, 512)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[chan []byte]struct{})
	}
	if !b.closed {
		b.subs[ch] = struct{}{}
	} else {
		close(ch)
	}
	b.mu.Unlock()
	return ch
}

func (b *broadcaster) unsubscribe(ch chan []byte) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *broadcaster) broadcast(chunk []byte) {
	b.mu.Lock()
	for ch := range b.subs {
		select {
		case ch <- chunk:
		default:
			// Slow subscriber: drop to avoid blocking PTY output.
		}
	}
	b.mu.Unlock()
}

func (b *broadcaster) close() {
	b.mu.Lock()
	b.closed = true
	for ch := range b.subs {
		close(ch)
	}
	b.subs = nil
	b.mu.Unlock()
}
