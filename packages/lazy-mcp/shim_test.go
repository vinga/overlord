package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake MCP server when FAKE_MCP_SPAWNS is set:
// it appends a line to that file on every start, so tests can count spawns.
func TestMain(m *testing.M) {
	if log := os.Getenv("FAKE_MCP_SPAWNS"); log != "" {
		fakeServer(log)
		return
	}
	os.Exit(m.Run())
}

func fakeServer(spawnLog string) {
	f, _ := os.OpenFile(spawnLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	fmt.Fprintln(f, os.Getpid())
	f.Close()
	in := bufio.NewReader(os.Stdin)
	initialized := false
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			return
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		json.Unmarshal(line, &m)
		send := func(result any) {
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
			os.Stdout.Write(append(b, '\n'))
		}
		switch m.Method {
		case "initialize":
			send(map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "fake", "version": "1"},
			})
		case "notifications/initialized":
			initialized = true
		case "tools/list":
			send(map[string]any{"tools": []any{map[string]any{"name": "echo"}, map[string]any{"name": "crash"}}})
		case "tools/call":
			if !initialized {
				send(map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "not initialized"}}})
				continue
			}
			if m.Params.Name == "crash" {
				os.Exit(1)
			}
			send(map[string]any{"content": []any{map[string]any{"type": "text", "text": "pid " + fmt.Sprint(os.Getpid())}}})
		}
	}
}

type harness struct {
	t      *testing.T
	in     *io.PipeWriter
	out    *bufio.Reader
	spawns string
	done   chan struct{}
}

func start(t *testing.T, dir string, chrome *chromeSpec) *harness {
	t.Helper()
	spawns := filepath.Join(dir, "spawns")
	t.Setenv("FAKE_MCP_SPAWNS", spawns)
	exe, _ := os.Executable()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	cfg := config{
		Command:     exe,
		Args:        []string{"-test.run=^$"},
		CachePath:   filepath.Join(dir, "cache.json"),
		Chrome:      chrome,
		InitTimeout: 5 * time.Second,
		Logf:        func(f string, a ...any) { t.Logf(f, a...) },
	}
	h := &harness{t: t, in: inW, out: bufio.NewReader(outR), spawns: spawns, done: make(chan struct{})}
	go func() {
		newShim(cfg, outW).run(inR)
		outW.Close()
		close(h.done)
	}()
	return h
}

func (h *harness) send(s string) { h.in.Write([]byte(s + "\n")) }

func (h *harness) recv() map[string]any {
	h.t.Helper()
	ch := make(chan []byte, 1)
	go func() { line, _ := h.out.ReadBytes('\n'); ch <- line }()
	select {
	case line := <-ch:
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			h.t.Fatalf("bad line %q: %v", line, err)
		}
		return m
	case <-time.After(10 * time.Second):
		h.t.Fatal("no reply")
		return nil
	}
}

func (h *harness) spawnCount() int {
	b, _ := os.ReadFile(h.spawns)
	return strings.Count(string(b), "\n")
}

func (h *harness) close() {
	h.in.Close()
	select {
	case <-h.done:
	case <-time.After(10 * time.Second):
		h.t.Fatal("shim did not exit on stdin EOF")
	}
}

const initMsg = `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`

func handshake(h *harness) {
	h.send(initMsg)
	if r := h.recv(); r["result"] == nil {
		h.t.Fatalf("initialize: %v", r)
	}
	h.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
}

func TestColdStartFillsCacheThenLazy(t *testing.T) {
	dir := t.TempDir()

	h := start(t, dir, nil)
	handshake(h)
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if tools := h.recv()["result"].(map[string]any)["tools"].([]any); len(tools) != 2 {
		t.Fatalf("tools: %v", tools)
	}
	h.close()
	if n := h.spawnCount(); n != 1 {
		t.Fatalf("cold start spawns = %d, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "cache.json")); err != nil {
		t.Fatalf("cache not written: %v", err)
	}

	// Second session: handshake and list from cache, no spawn.
	h2 := start(t, dir, nil)
	os.Remove(h2.spawns)
	handshake(h2)
	h2.send(`{"jsonrpc":"2.0","id":"a","method":"tools/list"}`)
	r := h2.recv()
	if r["id"] != "a" || len(r["result"].(map[string]any)["tools"].([]any)) != 2 {
		t.Fatalf("cached tools/list: %v", r)
	}
	h2.send(`{"jsonrpc":"2.0","id":7,"method":"ping"}`)
	if r := h2.recv(); r["id"].(float64) != 7 {
		t.Fatalf("ping: %v", r)
	}
	if n := h2.spawnCount(); n != 0 {
		t.Fatalf("lazy session spawned %d servers before a call", n)
	}

	// First call spawns exactly once, with the handshake replayed.
	h2.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo"}}`)
	r = h2.recv()
	if r["id"].(float64) != 2 || r["result"].(map[string]any)["isError"] == true {
		t.Fatalf("call: %v", r)
	}
	h2.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo"}}`)
	h2.recv()
	if n := h2.spawnCount(); n != 1 {
		t.Fatalf("spawns after two calls = %d, want 1", n)
	}
	h2.close()
}

func TestCrashFailsInFlightAndRespawns(t *testing.T) {
	dir := t.TempDir()
	h := start(t, dir, nil)
	handshake(h)
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crash"}}`)
	r := h.recv()
	if r["id"].(float64) != 1 || r["error"] == nil {
		t.Fatalf("crash should fail the in-flight call: %v", r)
	}
	h.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo"}}`)
	r = h.recv()
	if r["id"].(float64) != 2 || r["result"] == nil {
		t.Fatalf("call after crash: %v", r)
	}
	if n := h.spawnCount(); n != 2 {
		t.Fatalf("spawns = %d, want 2", n)
	}
	h.close()
}

func TestCacheKeyChangeRefreshes(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "cache.json"), []byte(`{"key":"stale","initialize":{"capabilities":{}},"lists":{}}`), 0o644)
	h := start(t, dir, nil)
	handshake(h)
	if n := h.spawnCount(); n != 1 {
		t.Fatalf("stale cache must spawn eagerly, spawns = %d", n)
	}
	h.close()
	b, _ := os.ReadFile(filepath.Join(dir, "cache.json"))
	if strings.Contains(string(b), `"stale"`) {
		t.Fatal("stale cache not replaced")
	}
}

func TestEnsureChromeSkipsWhenPortAnswers(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("{}")) }))
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	// A bogus executable proves nothing was launched.
	err := ensureChrome(chromeSpec{Port: port, UserDataDir: t.TempDir(), Path: "/nonexistent/chrome"}, t.Logf)
	if err != nil {
		t.Fatalf("port answers, expected no launch: %v", err)
	}
	err = ensureChrome(chromeSpec{Port: 1, UserDataDir: t.TempDir(), Path: "/nonexistent/chrome"}, t.Logf)
	if err == nil {
		t.Fatal("dead port with bogus chrome must fail")
	}
}

func TestEnsureChromeRefusesTakenPort(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	go http.Serve(ln, http.NotFoundHandler())
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	err := ensureChrome(chromeSpec{Port: port, UserDataDir: t.TempDir(), Path: "/nonexistent/chrome"}, t.Logf)
	if err == nil || !strings.Contains(err.Error(), "not a debuggable Chrome") {
		t.Fatalf("want taken-port error, got %v", err)
	}
}
