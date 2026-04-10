//go:build !windows

package main

import (
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// startChildWithPty on Unix/macOS: allocate a real PTY so SIGWINCH triggers repaints.
func startChildWithPty(args []string, clients *clientRegistry) (func([]byte), func() int, int, func(), func(int, int), <-chan struct{}, error) {
	cmd := exec.Command(args[0], args[1:]...)

	// Initial size matches the Overlord bridge default (120×30)
	initialSize := &pty.Winsize{Cols: 120, Rows: 30}
	ptmx, err := pty.StartWithSize(cmd, initialSize)
	if err != nil {
		return nil, nil, 0, nil, nil, nil, err
	}

	pid := cmd.Process.Pid

	var writeMu sync.Mutex
	writeFunc := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		ptmx.Write(data)
	}

	readerDead := make(chan struct{})
	go func() {
		defer close(readerDead)
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				clients.broadcast(chunk)
			}
			if err != nil {
				break
			}
		}
	}()

	var wsMu sync.Mutex
	currentSize := *initialSize

	nudgeRedraw := func() {
		wsMu.Lock()
		ws := currentSize
		wsMu.Unlock()
		pty.Setsize(ptmx, &ws)
		unix.Kill(pid, unix.SIGWINCH)
	}

	resizeAndNudge := func(cols, rows int) {
		ws := pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}
		wsMu.Lock()
		currentSize = ws
		wsMu.Unlock()
		pty.Setsize(ptmx, &ws)
		unix.Kill(pid, unix.SIGWINCH)
	}

	waitFunc := func() int {
		err := cmd.Wait()
		ptmx.Close()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				return exitErr.ExitCode()
			}
			return 1
		}
		return 0
	}

	return writeFunc, waitFunc, pid, nudgeRedraw, resizeAndNudge, readerDead, nil
}
