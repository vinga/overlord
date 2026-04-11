//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/UserExistsError/conpty"
)

func startChildWithPty(args []string, clients *clientRegistry, _ *stdoutTitleFilter) (func([]byte), func() int, int, func(), func(int, int), <-chan struct{}, error) {
	cmdLine := buildCommandLine(args)

	cols, rows := getConsoleSize()
	// Force buffer = window = detected size, so ConPTY and console agree
	syncConsoleDimensions(cols, rows)

	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		return nil, nil, 0, nil, nil, nil, fmt.Errorf("conpty.Start: %w", err)
	}

	pid := cpty.Pid()
	fmt.Fprintf(os.Stderr, "[bridge] ConPTY started, PID=%d\n", pid)

	// currentCols/currentRows track the live ConPTY dimensions (updated by resizeAndNudge)
	currentCols, currentRows := cols, rows

	var writeMu sync.Mutex
	writeFunc := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		cpty.Write(data)
	}

	// readerDead is closed when the ConPTY read goroutine exits (used by main to detect zombie state)
	readerDead := make(chan struct{})

	// Read ConPTY output → tee to console + pipe clients
	go func() {
		defer close(readerDead)
		buf := make([]byte, 8192)
		for {
			n, err := cpty.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				os.Stdout.Write(chunk)
				clients.broadcast(chunk)
			}
			if err != nil {
				if err != io.EOF {
					fmt.Fprintf(os.Stderr, "[bridge] read error: %v\n", err)
				}
				break
			}
		}
		fmt.Fprintf(os.Stderr, "[bridge] ConPTY reader exited — bridge cannot produce output\n")
	}()

	// nudgeRedraw resizes ConPTY by +1 col then back, forcing the TUI to repaint.
	// Uses currentCols/currentRows so it works correctly after a resize.
	nudgeRedraw := func() {
		fmt.Fprintf(os.Stderr, "[bridge] nudging ConPTY redraw (%dx%d)\n", currentCols, currentRows)
		cpty.Resize(int(currentCols)+1, int(currentRows))
		cpty.Resize(int(currentCols), int(currentRows))
	}

	// resizeAndNudge resizes the ConPTY to the given dimensions and forces a full repaint.
	// Called when Overlord's xterm is a different size than the IntelliJ terminal that
	// launched the bridge, so Claude renders at the correct width for display.
	resizeAndNudge := func(newCols, newRows int) {
		fmt.Fprintf(os.Stderr, "[bridge] resize+nudge ConPTY %dx%d → %dx%d\n", currentCols, currentRows, newCols, newRows)
		currentCols = newCols
		currentRows = newRows
		cpty.Resize(newCols, newRows)
		// Nudge after resize so the TUI re-renders at the new size
		cpty.Resize(newCols+1, newRows)
		cpty.Resize(newCols, newRows)
	}

	waitFunc := func() int {
		exitCode, err := cpty.Wait(context.Background())
		cpty.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[bridge] wait error: %v\n", err)
			return 1
		}
		return int(exitCode)
	}

	return writeFunc, waitFunc, pid, nudgeRedraw, resizeAndNudge, readerDead, nil
}

// getBridgeTTY is not supported on Windows — ConPTY doesn't have a TTY device path.
func getBridgeTTY() string {
	return ""
}

func buildCommandLine(args []string) string {
	line := ""
	for i, arg := range args {
		if i > 0 {
			line += " "
		}
		needsQuote := false
		for _, c := range arg {
			if c == ' ' || c == '\t' {
				needsQuote = true
				break
			}
		}
		if needsQuote {
			line += `"` + arg + `"`
		} else {
			line += arg
		}
	}
	return line
}
