//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func enableVTProcessing() {}

// setRawInputMode puts stdin into raw mode on Unix/macOS.
// Without this the outer PTY stays in cooked mode (echo enabled), which causes
// the TTY line discipline to echo terminal control sequences (e.g. ESC[I focus
// events sent by Terminal.app) back to the display as visible ^[[I garbage —
// before the bridge even reads the bytes. Raw mode disables echo and canonical
// line buffering so every byte is immediately available and not echoed.
func setRawInputMode() {
	fd := int(os.Stdin.Fd())
	termios, err := unix.IoctlGetTermios(fd, unix.TIOCGETA)
	if err != nil {
		return // not a TTY or ioctl failed — silently skip
	}
	// Raw mode: disable echo, canonical mode, and signal character processing.
	termios.Lflag &^= unix.ECHO | unix.ECHOE | unix.ECHOK | unix.ECHONL |
		unix.ICANON | unix.ISIG | unix.IEXTEN
	// Disable input processing (CR→NL translation, flow control).
	termios.Iflag &^= unix.IXON | unix.IXOFF | unix.ICRNL | unix.INLCR | unix.IGNCR
	// Read 1 byte at a time with no timeout.
	termios.Cc[unix.VMIN] = 1
	termios.Cc[unix.VTIME] = 0
	unix.IoctlSetTermios(fd, unix.TIOCSETA, termios) //nolint:errcheck
}

func getConsoleSize() (int, int)          { return 120, 30 }
func syncConsoleDimensions(cols, rows int) {}
