//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
)

func socketPath(name string) string {
	return filepath.Join(os.TempDir(), name+".sock")
}

func createListener(name string) (net.Listener, string, error) {
	path := socketPath(name)
	// Remove stale socket if it exists
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, "", fmt.Errorf("unix socket %s: %w", path, err)
	}
	return ln, path, nil
}

func cleanupListener(ln net.Listener, name string) {
	ln.Close()
	os.Remove(socketPath(name))
}

func configureCmdPlatform(cmd *exec.Cmd) {
	// No special config needed on Unix
	_ = cmd
}
