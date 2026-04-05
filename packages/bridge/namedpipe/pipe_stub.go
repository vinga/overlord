//go:build !windows

// Package namedpipe provides a minimal net.Listener for Windows named pipes.
// On non-Windows platforms this package is unused — the unix socket listener
// is used instead. This stub exists to keep the module compilable.
package namedpipe

import (
	"errors"
	"net"
)

// Listen is not supported on non-Windows platforms.
func Listen(path string) (net.Listener, error) {
	return nil, errors.New("named pipes are only supported on Windows")
}
