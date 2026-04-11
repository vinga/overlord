package main

// stdinFilter strips terminal DA1/DA2 "Device Attributes" response sequences
// (ESC[?...c and ESC[>...c) from stdin before forwarding to the child process.
//
// Background: when macOS Terminal.app gains OS focus (e.g. via AppleScript
// `activate`), it re-sends a DA1 response (ESC[?1;2c) to the running process.
// The bridge, in raw mode, would forward these bytes unfiltered to Claude,
// which does not consume them — causing visible ^[[?1;2c garbage in the prompt.
//
// DA1 (primary):   ESC [ ? <params> c
// DA2 (secondary): ESC [ > <params> c
//
// All other escape sequences are passed through unchanged.

type stdinFilter struct {
	pending []byte // buffered bytes of a partial escape sequence
}

func newStdinFilter() *stdinFilter {
	return &stdinFilter{}
}

// filter processes a chunk of stdin data, returning the bytes that should be
// forwarded to the child. Strips DA1/DA2 responses; preserves everything else.
func (f *stdinFilter) filter(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for _, b := range data {
		out = f.processByte(out, b)
	}
	return out
}

func (f *stdinFilter) processByte(out []byte, b byte) []byte {
	switch len(f.pending) {
	case 0:
		// Not in a sequence. ESC starts one; everything else passes through.
		if b == 0x1b {
			f.pending = append(f.pending, b)
		} else {
			out = append(out, b)
		}

	case 1: // buffered: ESC
		if b == '[' {
			f.pending = append(f.pending, b) // ESC [ — could be CSI
		} else {
			// ESC + non-[ : not a CSI sequence, flush as-is
			out = append(out, f.pending...)
			out = append(out, b)
			f.pending = f.pending[:0]
		}

	case 2: // buffered: ESC [
		switch b {
		case '?', '>':
			// ESC [ ? → DA1 candidate; ESC [ > → DA2 candidate
			f.pending = append(f.pending, b)
		case 'I', 'O':
			// ESC [ I = focus-in; ESC [ O = focus-out (xterm focus tracking).
			// Terminal.app sends these when the window gains/loses OS focus.
			// Discard — Claude must not receive them as input.
			f.pending = f.pending[:0]
		default:
			// ESC [ <other> — not a filtered sequence, flush and pass byte through
			out = append(out, f.pending...)
			out = append(out, b)
			f.pending = f.pending[:0]
		}

	default: // buffered: ESC [ ? … or ESC [ > …
		switch {
		case b >= '0' && b <= '9', b == ';':
			// Parameter digit or separator: keep accumulating
			f.pending = append(f.pending, b)
		case b == 'c':
			// Sequence terminator for DA responses: discard the whole sequence
			f.pending = f.pending[:0]
		default:
			// Unexpected terminator — not a DA response after all, flush + byte
			out = append(out, f.pending...)
			out = append(out, b)
			f.pending = f.pending[:0]
		}
	}
	return out
}
