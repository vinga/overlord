package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
)

func main() {
	pipeName := flag.String("pipe", "", "Pipe/socket name (e.g. overlord-{sessionId})")
	flag.Parse()

	if *pipeName == "" {
		fmt.Fprintln(os.Stderr, "Usage: overlord-bridge --pipe <name> -- <command> [args...]")
		os.Exit(1)
	}

	// Everything after "--" is the child command
	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "No command specified after --")
		os.Exit(1)
	}

	// Create platform-specific listener
	listener, addr, err := createListener(*pipeName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create listener: %v\n", err)
		os.Exit(1)
	}
	defer cleanupListener(listener, *pipeName)

	fmt.Fprintf(os.Stderr, "[bridge] Listening on %s\n", addr)

	// Start the child process
	cmd := exec.Command(args[0], args[1:]...)
	childIn, err := cmd.StdinPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create stdin pipe: %v\n", err)
		os.Exit(1)
	}

	// Child stdout/stderr go directly to our stdout/stderr
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// On Windows, create the child in its own console group so it can handle
	// Ctrl+C independently. On Unix this is not needed.
	configureCmdPlatform(cmd)

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start child: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "[bridge] Child PID: %d\n", cmd.Process.Pid)

	// Mutex protects writes to childIn from multiple goroutines
	var mu sync.Mutex

	// Forward our stdin to child stdin (so user can still type)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				mu.Lock()
				childIn.Write(buf[:n])
				mu.Unlock()
			}
			if err != nil {
				break
			}
		}
	}()

	// Accept pipe/socket connections in a loop (Overlord may reconnect)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				// Listener closed — bridge shutting down
				break
			}
			fmt.Fprintf(os.Stderr, "[bridge] Client connected\n")
			go handleConnection(conn, childIn, &mu)
		}
	}()

	// Forward signals to child
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	if runtime.GOOS != "windows" {
		signal.Notify(sigCh, syscall.SIGTERM)
	}
	go func() {
		for sig := range sigCh {
			cmd.Process.Signal(sig)
		}
	}()

	// Wait for child to exit
	err = cmd.Wait()
	fmt.Fprintf(os.Stderr, "[bridge] Child exited\n")

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
	os.Exit(0)
}

func handleConnection(conn net.Conn, childIn io.WriteCloser, mu *sync.Mutex) {
	defer conn.Close()
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			mu.Lock()
			childIn.Write(buf[:n])
			mu.Unlock()
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "[bridge] Client disconnected\n")
			break
		}
	}
}
