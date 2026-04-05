//go:build windows

// Package namedpipe provides a minimal net.Listener for Windows named pipes.
package namedpipe

import (
	"errors"
	"net"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procCreateNamedPipeW      = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe      = kernel32.NewProc("ConnectNamedPipe")
	procDisconnectNamedPipe   = kernel32.NewProc("DisconnectNamedPipe")
	procCreateEventW          = kernel32.NewProc("CreateEventW")
	procWaitForSingleObject   = kernel32.NewProc("WaitForSingleObject")
)

const (
	PIPE_ACCESS_DUPLEX     = 0x00000003
	FILE_FLAG_OVERLAPPED   = 0x40000000
	PIPE_TYPE_BYTE         = 0x00000000
	PIPE_READMODE_BYTE     = 0x00000000
	PIPE_WAIT              = 0x00000000
	PIPE_UNLIMITED_INSTANCES = 255
	PIPE_BUFFER_SIZE       = 4096
	INVALID_HANDLE         = ^syscall.Handle(0)
	WAIT_OBJECT_0          = 0
	WAIT_TIMEOUT           = 0x00000102
	ERROR_IO_PENDING       = 997
	ERROR_PIPE_CONNECTED   = 535
)

// Listener implements net.Listener for Windows named pipes.
type Listener struct {
	path   string
	closed bool
	mu     sync.Mutex
	done   chan struct{}
}

// Listen creates a named pipe listener at the given path.
func Listen(path string) (net.Listener, error) {
	// Validate by creating and immediately closing a test pipe
	h, err := createPipe(path)
	if err != nil {
		return nil, err
	}
	syscall.CloseHandle(h)

	return &Listener{
		path: path,
		done: make(chan struct{}),
	}, nil
}

func createPipe(path string) (syscall.Handle, error) {
	pathUTF16, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return INVALID_HANDLE, err
	}

	h, _, err := procCreateNamedPipeW.Call(
		uintptr(unsafe.Pointer(pathUTF16)),
		PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED,
		PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,
		PIPE_UNLIMITED_INSTANCES,
		PIPE_BUFFER_SIZE,
		PIPE_BUFFER_SIZE,
		0,
		0,
	)

	if h == uintptr(INVALID_HANDLE) {
		return INVALID_HANDLE, err
	}
	return syscall.Handle(h), nil
}

// Accept waits for a client to connect to the named pipe.
func (l *Listener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, errors.New("listener closed")
	}
	l.mu.Unlock()

	h, err := createPipe(l.path)
	if err != nil {
		return nil, err
	}

	// Create an event for overlapped ConnectNamedPipe
	evtH, _, _ := procCreateEventW.Call(0, 1, 0, 0)
	if evtH == 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("failed to create event")
	}
	evt := syscall.Handle(evtH)
	defer syscall.CloseHandle(evt)

	overlapped := syscall.Overlapped{HEvent: evt}

	r, _, connectErr := procConnectNamedPipe.Call(uintptr(h), uintptr(unsafe.Pointer(&overlapped)))
	if r == 0 {
		errno, _ := connectErr.(syscall.Errno)
		if errno == ERROR_IO_PENDING {
			// Wait for connection or shutdown, polling periodically
			for {
				select {
				case <-l.done:
					syscall.CloseHandle(h)
					return nil, errors.New("listener closed")
				default:
				}
				wr, _, _ := procWaitForSingleObject.Call(evtH, 200)
				if wr == WAIT_OBJECT_0 {
					break
				}
				if wr == WAIT_TIMEOUT {
					continue
				}
				// Error
				syscall.CloseHandle(h)
				return nil, errors.New("wait failed")
			}
		} else if errno != ERROR_PIPE_CONNECTED {
			syscall.CloseHandle(h)
			return nil, connectErr
		}
	}

	return &pipeConn{handle: h, path: l.path}, nil
}

func (l *Listener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		close(l.done)
	}
	return nil
}

func (l *Listener) Addr() net.Addr {
	return pipeAddr(l.path)
}

// pipeConn implements net.Conn for a connected named pipe instance.
type pipeConn struct {
	handle syscall.Handle
	path   string
}

func (c *pipeConn) Read(b []byte) (int, error) {
	var n uint32
	err := syscall.ReadFile(c.handle, b, &n, nil)
	if err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (c *pipeConn) Write(b []byte) (int, error) {
	var n uint32
	err := syscall.WriteFile(c.handle, b, &n, nil)
	if err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (c *pipeConn) Close() error {
	procDisconnectNamedPipe.Call(uintptr(c.handle))
	return syscall.CloseHandle(c.handle)
}

func (c *pipeConn) LocalAddr() net.Addr                { return pipeAddr(c.path) }
func (c *pipeConn) RemoteAddr() net.Addr               { return pipeAddr(c.path) }
func (c *pipeConn) SetDeadline(t time.Time) error      { return nil }
func (c *pipeConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *pipeConn) SetWriteDeadline(t time.Time) error { return nil }

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }
