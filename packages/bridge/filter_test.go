package main

import (
	"testing"
)

// ── helpers ──────────────────────────────────────────────────────────────────

func filter(f *stdinFilter, data string) string {
	return string(f.filter([]byte(data)))
}

// ── plain passthrough ─────────────────────────────────────────────────────────

func TestFilter_Empty(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "")
	if got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestFilter_PlainText(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "hello world")
	if got != "hello world" {
		t.Errorf("expected %q, got %q", "hello world", got)
	}
}

// ── DA1 responses filtered ────────────────────────────────────────────────────

func TestFilter_DA1ResponseAlone(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[?1;2c")
	if got != "" {
		t.Errorf("DA1 response should be filtered, got %q", got)
	}
}

func TestFilter_DA1ResponseVariants(t *testing.T) {
	cases := []string{
		"\x1b[?1;2c",   // VT100 with AVO
		"\x1b[?6c",     // VT102
		"\x1b[?62;1;6c", // VT220
		"\x1b[?c",      // minimal
		"\x1b[?0c",     // VT100
	}
	for _, seq := range cases {
		f := newStdinFilter()
		got := filter(f, seq)
		if got != "" {
			t.Errorf("DA1 variant %q should be filtered, got %q", seq, got)
		}
	}
}

func TestFilter_DA1BeforeText(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[?1;2chello")
	if got != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestFilter_DA1AfterText(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "hello\x1b[?1;2c")
	if got != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestFilter_DA1SurroundedByText(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "before\x1b[?1;2cafter")
	if got != "beforeafter" {
		t.Errorf("expected %q, got %q", "beforeafter", got)
	}
}

func TestFilter_MultipleDA1(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[?1;2c\x1b[?1;2c")
	if got != "" {
		t.Errorf("multiple DA1 should all be filtered, got %q", got)
	}
}

// ── other escape sequences preserved ─────────────────────────────────────────

func TestFilter_ArrowKeysPreserved(t *testing.T) {
	cases := []struct {
		name string
		seq  string
	}{
		{"up", "\x1b[A"},
		{"down", "\x1b[B"},
		{"right", "\x1b[C"},
		{"left", "\x1b[D"},
	}
	for _, c := range cases {
		f := newStdinFilter()
		got := filter(f, c.seq)
		if got != c.seq {
			t.Errorf("%s: expected %q, got %q", c.name, c.seq, got)
		}
	}
}

func TestFilter_SGRColorPreserved(t *testing.T) {
	f := newStdinFilter()
	seq := "\x1b[31mred\x1b[0m"
	got := filter(f, seq)
	if got != seq {
		t.Errorf("expected %q, got %q", seq, got)
	}
}

func TestFilter_DA2ResponseFiltered(t *testing.T) {
	// DA2 (secondary device attributes): ESC[>...c — also a terminal response
	f := newStdinFilter()
	got := filter(f, "\x1b[>1;95;0c")
	if got != "" {
		t.Errorf("DA2 response should be filtered, got %q", got)
	}
}

func TestFilter_DA2WithTextAround(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "abc\x1b[>1;95;0cdef")
	if got != "abcdef" {
		t.Errorf("expected %q, got %q", "abcdef", got)
	}
}

// ── focus tracking sequences filtered ────────────────────────────────────────

func TestFilter_FocusInFiltered(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[I")
	if got != "" {
		t.Errorf("focus-in ESC[I should be filtered, got %q", got)
	}
}

func TestFilter_FocusOutFiltered(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[O")
	if got != "" {
		t.Errorf("focus-out ESC[O should be filtered, got %q", got)
	}
}

func TestFilter_FocusOutFocusInFiltered(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "\x1b[O\x1b[I")
	if got != "" {
		t.Errorf("ESC[O ESC[I should both be filtered, got %q", got)
	}
}

func TestFilter_FocusWithTextAround(t *testing.T) {
	f := newStdinFilter()
	got := filter(f, "hi\x1b[Ithere")
	if got != "hithere" {
		t.Errorf("expected %q, got %q", "hithere", got)
	}
}

// ── split sequences across calls (state machine) ──────────────────────────────

func TestFilter_SplitDA1(t *testing.T) {
	f := newStdinFilter()
	// Sequence \x1b[?1;2c split into two reads
	out1 := filter(f, "\x1b[?1;")
	out2 := filter(f, "2c")
	got := out1 + out2
	if got != "" {
		t.Errorf("split DA1 should be filtered across calls, got %q", got)
	}
}

func TestFilter_SplitEscAtBoundary(t *testing.T) {
	f := newStdinFilter()
	// ESC alone first, then the rest of a DA1
	out1 := filter(f, "\x1b")
	out2 := filter(f, "[?1;2c")
	got := out1 + out2
	if got != "" {
		t.Errorf("split DA1 (ESC boundary) should be filtered, got %q", got)
	}
}

func TestFilter_SplitEscNotDA1(t *testing.T) {
	f := newStdinFilter()
	// ESC alone, then a regular sequence like [A (arrow up) — should be passed through
	out1 := filter(f, "\x1b")
	out2 := filter(f, "[A")
	got := out1 + out2
	if got != "\x1b[A" {
		t.Errorf("split non-DA1 should pass through, got %q", got)
	}
}

func TestFilter_TextAfterSplitDA1(t *testing.T) {
	f := newStdinFilter()
	out1 := filter(f, "hi\x1b[?1;")
	out2 := filter(f, "2cthere")
	got := out1 + out2
	if got != "hithere" {
		t.Errorf("expected %q, got %q", "hithere", got)
	}
}
