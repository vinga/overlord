package main

// stdoutTitleFilter strips OSC title-setting escape sequences (ESC ] 0/1/2 ; text BEL/ST)
// from PTY output before it is written to the host terminal.
//
// This prevents the child process (Claude) from overriding the terminal window
// title with its internal session name (which contains bridge marker suffixes).
// OUTPT pipe clients receive unfiltered output, so xterm.js still sees the sequences.
//
// OSC title sequences:
//   ESC ] 0 ; <text> BEL  — set icon name + window title
//   ESC ] 1 ; <text> BEL  — set icon name
//   ESC ] 2 ; <text> BEL  — set window title
//   (BEL may be replaced by ST = ESC \)
type stdoutTitleFilter struct {
	state    int
	oscParam int
	pending  []byte
}

const (
	sftNormal          = iota
	sftEsc             // saw ESC
	sftOscParam        // saw ESC ], accumulating digits
	sftTitleDiscard    // inside a title OSC — discard until terminator
	sftTitleDiscardEsc // inside title discard, saw ESC (waiting for \ to complete ST)
	sftPassContent     // inside a non-title OSC — pass through until terminator
	sftPassContentEsc  // inside pass-through OSC, saw ESC
)

func newStdoutTitleFilter() *stdoutTitleFilter {
	return &stdoutTitleFilter{}
}

func (f *stdoutTitleFilter) filter(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for _, b := range data {
		out = f.processByte(out, b)
	}
	return out
}

func (f *stdoutTitleFilter) processByte(out []byte, b byte) []byte {
	switch f.state {
	case sftNormal:
		if b == 0x1b {
			f.pending = append(f.pending[:0], b)
			f.state = sftEsc
		} else {
			out = append(out, b)
		}

	case sftEsc:
		if b == ']' {
			f.pending = append(f.pending, b)
			f.oscParam = 0
			f.state = sftOscParam
		} else {
			out = append(out, f.pending...)
			out = append(out, b)
			f.pending = f.pending[:0]
			f.state = sftNormal
		}

	case sftOscParam:
		if b >= '0' && b <= '9' {
			f.pending = append(f.pending, b)
			f.oscParam = f.oscParam*10 + int(b-'0')
		} else if b == ';' {
			if f.oscParam == 0 || f.oscParam == 1 || f.oscParam == 2 {
				// Title OSC: discard buffer, enter discard mode
				f.pending = f.pending[:0]
				f.state = sftTitleDiscard
			} else {
				// Non-title OSC: flush buffer + semicolon, pass content through
				f.pending = append(f.pending, b)
				out = append(out, f.pending...)
				f.pending = f.pending[:0]
				f.state = sftPassContent
			}
		} else if b == 0x07 {
			// BEL before ';' — OSC with no content (unusual but valid)
			if f.oscParam != 0 && f.oscParam != 1 && f.oscParam != 2 {
				out = append(out, f.pending...)
				out = append(out, b)
			}
			f.pending = f.pending[:0]
			f.state = sftNormal
		} else {
			// Not a valid OSC param character — not an OSC, flush as-is
			out = append(out, f.pending...)
			out = append(out, b)
			f.pending = f.pending[:0]
			f.state = sftNormal
		}

	case sftTitleDiscard:
		if b == 0x07 { // BEL — end of OSC, discard silently
			f.state = sftNormal
		} else if b == 0x1b {
			f.state = sftTitleDiscardEsc
		}
		// else: discard byte

	case sftTitleDiscardEsc:
		if b == '\\' { // ESC \ = ST — end of OSC
			f.state = sftNormal
		} else {
			// Not ST, stay in discard (treat ESC as just noise inside title text)
			f.state = sftTitleDiscard
		}

	case sftPassContent:
		if b == 0x07 { // BEL
			out = append(out, b)
			f.state = sftNormal
		} else if b == 0x1b {
			f.state = sftPassContentEsc
		} else {
			out = append(out, b)
		}

	case sftPassContentEsc:
		if b == '\\' { // ST
			out = append(out, 0x1b, '\\')
			f.state = sftNormal
		} else {
			out = append(out, 0x1b, b)
			f.state = sftNormal
		}
	}
	return out
}

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
