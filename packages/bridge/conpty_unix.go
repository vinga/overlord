//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
)

// startChildWithPty on Unix: use a simple pipe-based approach.
// For full PTY support on Unix, cgo would be needed for openpty/forkpty.
// This fallback works for injection; output goes to console directly.
func startChildWithPty(args []string, clients *clientRegistry) (func([]byte), func() int, int, error) {
	cmd := exec.Command(args[0], args[1:]...)
	childIn, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, 0, err
	}
	childOut, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, 0, err
	}
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		return nil, nil, 0, err
	}

	var writeMu sync.Mutex
	writeFunc := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		childIn.Write(data)
	}

	// Tee stdout to console + pipe clients
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := childOut.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				os.Stdout.Write(chunk)
				clients.broadcast(chunk)
			}
			if err != nil {
				if err != io.EOF {
					// ignore
				}
				break
			}
		}
	}()

	waitFunc := func() int {
		err := cmd.Wait()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				return exitErr.ExitCode()
			}
			return 1
		}
		return 0
	}

	return writeFunc, waitFunc, cmd.Process.Pid, nil
}
