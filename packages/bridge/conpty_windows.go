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

func startChildWithPty(args []string, clients *clientRegistry) (func([]byte), func() int, int, error) {
	cmdLine := buildCommandLine(args)

	cols, rows := getConsoleSize()
	// Force buffer = window = detected size, so ConPTY and console agree
	syncConsoleDimensions(cols, rows)

	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		return nil, nil, 0, fmt.Errorf("conpty.Start: %w", err)
	}

	pid := cpty.Pid()
	fmt.Fprintf(os.Stderr, "[bridge] ConPTY started, PID=%d\n", pid)

	var writeMu sync.Mutex
	writeFunc := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		cpty.Write(data)
	}

	// Read ConPTY output → tee to console + pipe clients
	go func() {
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
	}()

	waitFunc := func() int {
		exitCode, err := cpty.Wait(context.Background())
		cpty.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[bridge] wait error: %v\n", err)
			return 1
		}
		return int(exitCode)
	}

	return writeFunc, waitFunc, pid, nil
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
