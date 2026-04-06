//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// Output mode flags (for stdout handle)
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

// Input mode flags (for stdin handle)
const (
	inputFlagProcessed = 0x0001 // ENABLE_PROCESSED_INPUT
	inputFlagLineInput = 0x0002 // ENABLE_LINE_INPUT
	inputFlagEcho      = 0x0004 // ENABLE_ECHO_INPUT
	inputFlagWindowIn  = 0x0008 // ENABLE_WINDOW_INPUT
	inputFlagVTInput   = 0x0200 // ENABLE_VIRTUAL_TERMINAL_INPUT
)

type smallRect struct {
	Left, Top, Right, Bottom int16
}

type coord struct {
	X, Y int16
}

type consoleScreenBufferInfo struct {
	Size              coord
	CursorPosition    coord
	Attributes        uint16
	Window            smallRect
	MaximumWindowSize coord
}

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procGetConsoleMode             = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode             = kernel32.NewProc("SetConsoleMode")
	procGetConsoleScreenBufferInfo = kernel32.NewProc("GetConsoleScreenBufferInfo")
	procSetConsoleScreenBufferSize = kernel32.NewProc("SetConsoleScreenBufferSize")
	procSetConsoleWindowInfo       = kernel32.NewProc("SetConsoleWindowInfo")
	procSetConsoleCursorPosition   = kernel32.NewProc("SetConsoleCursorPosition")
)

// enableVTProcessing enables ANSI/VT escape sequence processing on stdout
// so the console window renders colors and cursor movement correctly.
func enableVTProcessing() {
	handle := syscall.Handle(os.Stdout.Fd())
	var mode uint32
	r, _, _ := procGetConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode)))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] warning: GetConsoleMode failed\n")
		return
	}
	r, _, _ = procSetConsoleMode.Call(uintptr(handle), uintptr(mode|ENABLE_VIRTUAL_TERMINAL_PROCESSING))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] warning: SetConsoleMode failed\n")
	}
}

// setRawInputMode puts console stdin into raw mode: disables line buffering
// and local echo so each keypress goes directly to the ConPTY child.
// Without this, the console buffers input until Enter and echoes characters
// locally, which causes double-display and Enter key not reaching the child.
func setRawInputMode() {
	handle := syscall.Handle(os.Stdin.Fd())
	var mode uint32
	r, _, _ := procGetConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode)))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] warning: GetConsoleMode(stdin) failed\n")
		return
	}
	fmt.Fprintf(os.Stderr, "[bridge] stdin mode before: 0x%04x\n", mode)

	// Disable line input (wait for Enter) and echo (local character display)
	// Enable VT input so escape sequences pass through to ConPTY
	newMode := (mode &^ (inputFlagLineInput | inputFlagEcho)) | inputFlagVTInput
	r, _, _ = procSetConsoleMode.Call(uintptr(handle), uintptr(newMode))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] warning: SetConsoleMode(stdin, raw) failed\n")
	} else {
		fmt.Fprintf(os.Stderr, "[bridge] stdin mode after: 0x%04x (raw)\n", newMode)
	}
}

// getConsoleSize returns the visible window dimensions (cols, rows).
// Falls back to 120x30 if the console info can't be read.
func getConsoleSize() (int, int) {
	handle := syscall.Handle(os.Stdout.Fd())
	var info consoleScreenBufferInfo
	r, _, _ := procGetConsoleScreenBufferInfo.Call(uintptr(handle), uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] GetConsoleScreenBufferInfo failed, using defaults\n")
		return 120, 30
	}
	cols := int(info.Window.Right-info.Window.Left) + 1
	rows := int(info.Window.Bottom-info.Window.Top) + 1
	bufCols := int(info.Size.X)
	bufRows := int(info.Size.Y)
	fmt.Fprintf(os.Stderr, "[bridge] console: window=%dx%d buffer=%dx%d maxWindow=%dx%d cursor=(%d,%d)\n",
		cols, rows, bufCols, bufRows,
		int(info.MaximumWindowSize.X), int(info.MaximumWindowSize.Y),
		int(info.CursorPosition.X), int(info.CursorPosition.Y))

	// Write diagnostic to temp file for server-side inspection
	_ = os.WriteFile(fmt.Sprintf("%s\\overlord-bridge-diag.txt", os.TempDir()),
		[]byte(fmt.Sprintf("window=%dx%d buffer=%dx%d max=%dx%d\n",
			cols, rows, bufCols, bufRows,
			int(info.MaximumWindowSize.X), int(info.MaximumWindowSize.Y))), 0644)

	if cols < 20 {
		cols = 120
	}
	if rows < 5 {
		rows = 30
	}
	return cols, rows
}

// syncConsoleDimensions forces the console buffer AND window to match the given size.
// This ensures ConPTY and the visible console agree on dimensions.
func syncConsoleDimensions(cols, rows int) {
	handle := syscall.Handle(os.Stdout.Fd())

	// Step 0: Move cursor to origin so buffer shrink doesn't fail
	// (SetConsoleScreenBufferSize fails if cursor is beyond new buffer size)
	origin := uintptr(0) // COORD{X:0, Y:0} packed as DWORD
	procSetConsoleCursorPosition.Call(uintptr(handle), origin)

	// Step 1: Shrink the window to 1x1 (so buffer resize never fails due to
	// "buffer smaller than window" constraint)
	smallWindow := smallRect{Left: 0, Top: 0, Right: 0, Bottom: 0}
	procSetConsoleWindowInfo.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&smallWindow)))

	// Step 2: Set buffer to exact size
	bufSize := uintptr(int16(cols)) | (uintptr(int16(rows)) << 16)
	r, _, err := procSetConsoleScreenBufferSize.Call(uintptr(handle), bufSize)
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] SetConsoleScreenBufferSize(%dx%d) failed: %v\n", cols, rows, err)
	}

	// Step 3: Set window to cover the full buffer
	window := smallRect{Left: 0, Top: 0, Right: int16(cols - 1), Bottom: int16(rows - 1)}
	r, _, err = procSetConsoleWindowInfo.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&window)))
	if r == 0 {
		fmt.Fprintf(os.Stderr, "[bridge] SetConsoleWindowInfo(%dx%d) failed: %v\n", cols, rows, err)
	}

	// Step 4: Verify — read back actual dimensions
	var info consoleScreenBufferInfo
	r, _, _ = procGetConsoleScreenBufferInfo.Call(uintptr(handle), uintptr(unsafe.Pointer(&info)))
	if r != 0 {
		postBuf := fmt.Sprintf("%dx%d", int(info.Size.X), int(info.Size.Y))
		postWin := fmt.Sprintf("%dx%d",
			int(info.Window.Right-info.Window.Left)+1,
			int(info.Window.Bottom-info.Window.Top)+1)
		fmt.Fprintf(os.Stderr, "[bridge] post-sync: buffer=%s window=%s cursor=(%d,%d)\n",
			postBuf, postWin, int(info.CursorPosition.X), int(info.CursorPosition.Y))
		_ = os.WriteFile(fmt.Sprintf("%s\\overlord-bridge-postsync.txt", os.TempDir()),
			[]byte(fmt.Sprintf("buffer=%s window=%s\n", postBuf, postWin)), 0644)
	}

	fmt.Fprintf(os.Stderr, "[bridge] synced console to %dx%d\n", cols, rows)
}
