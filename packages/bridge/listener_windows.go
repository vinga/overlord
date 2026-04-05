//go:build windows

package main

import (
	"fmt"
	"net"
	"os/exec"

	"overlord-bridge/namedpipe"
)

func createListener(name string) (net.Listener, string, error) {
	pipePath := `\\.\pipe\` + name
	ln, err := namedpipe.Listen(pipePath)
	if err != nil {
		return nil, "", fmt.Errorf("named pipe %s: %w", pipePath, err)
	}
	return ln, pipePath, nil
}

func cleanupListener(ln net.Listener, name string) {
	ln.Close()
	// Windows named pipes are cleaned up automatically when the last handle closes
}

func configureCmdPlatform(cmd *exec.Cmd) {
	// On Windows, we want the child to inherit our console so the user
	// can interact with it directly. No special SysProcAttr needed.
}
