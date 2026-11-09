package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Overlord lazy MCP shim.
//
// Stands in for a stdio MCP server. The handshake (`initialize`) and the
// discovery lists (`tools/list`, …) are answered from a cache, so an idle
// session costs one small process instead of the real server. The first request
// the cache cannot answer — normally a `tools/call` — spawns the real server,
// replays the client's `initialize` to it, and from then on the shim is a
// transparent line pipe in both directions.
//
// Without a valid cache the first `initialize` spawns the server at once,
// fetches the lists, writes the cache and stays a pipe for that session; the
// next sessions are lazy.

const internalPrefix = "__lazy_"

type config struct {
	Command   string
	Args      []string
	CachePath string
	Chrome    *chromeSpec
	// InitTimeout bounds the replayed handshake and each cache fetch.
	InitTimeout time.Duration
	Logf        func(string, ...any)
}

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

func (m *message) hasID() bool {
	return len(m.ID) > 0 && string(m.ID) != "null"
}

type child struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	done     chan struct{}
	mu       sync.Mutex
	pending  map[string]json.RawMessage // client request ids awaiting a reply
	internal map[string]chan message    // our own requests awaiting a reply
	exited   bool
}

type shim struct {
	cfg     config
	key     string
	cache   *cacheFile
	out     io.Writer
	outMu   sync.Mutex
	initReq []byte // the client's initialize request, replayed to every new child
	seq     atomic.Int64

	mu    sync.Mutex
	child *child
}

func newShim(cfg config, out io.Writer) *shim {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.InitTimeout == 0 {
		cfg.InitTimeout = 60 * time.Second
	}
	s := &shim{cfg: cfg, out: out}
	s.key = cacheKey(cfg.Command, cfg.Args)
	s.cache = loadCache(cfg.CachePath, s.key)
	if s.cache != nil {
		cfg.Logf("cache hit %s", cfg.CachePath)
	} else {
		cfg.Logf("cache miss %s", cfg.CachePath)
	}
	return s
}

func (s *shim) write(line []byte) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	s.out.Write(line)
	if len(line) == 0 || line[len(line)-1] != '\n' {
		s.out.Write([]byte{'\n'})
	}
}

func (s *shim) reply(id json.RawMessage, result json.RawMessage) {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	s.write(b)
}

func (s *shim) replyError(id json.RawMessage, msg string) {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": -32603, "message": msg},
	})
	s.write(b)
}

// run serves the client on in until EOF, then stops the real server.
func (s *shim) run(in io.Reader) {
	r := bufio.NewReader(in)
	for {
		line, err := r.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			s.handle(trimmed)
		}
		if err != nil {
			break
		}
	}
	s.stop()
}

func (s *shim) live() *child {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.child
}

func (s *shim) handle(line []byte) {
	var m message
	if json.Unmarshal(line, &m) != nil {
		if c := s.live(); c != nil {
			c.send(line)
		}
		return
	}
	isRequest := m.Method != "" && m.hasID()

	switch {
	case m.Method == "initialize" && isRequest:
		s.initReq = append([]byte(nil), line...)
		if s.cache != nil {
			s.reply(m.ID, s.cache.Initialize)
			return
		}
		result, err := s.activate()
		if err != nil {
			s.replyError(m.ID, "lazy-mcp: "+err.Error())
			return
		}
		s.reply(m.ID, result)
		s.fillCache(result)
		return

	case m.Method == "notifications/initialized":
		// activate() sends its own to every child it starts.
		return
	}

	if c := s.live(); c != nil && (!isRequest || c.track(m.ID)) {
		c.send(line)
		return
	}

	switch {
	case m.Method == "ping" && isRequest:
		s.reply(m.ID, json.RawMessage(`{}`))
	case isRequest && s.cachedList(m.Method) != nil:
		s.reply(m.ID, s.cachedList(m.Method))
	case isRequest:
		if s.initReq == nil {
			s.replyError(m.ID, "lazy-mcp: request before initialize")
			return
		}
		if _, err := s.activate(); err != nil {
			s.replyError(m.ID, "lazy-mcp: "+err.Error())
			return
		}
		if c := s.live(); c != nil && c.track(m.ID) {
			c.send(line)
		} else {
			s.replyError(m.ID, "lazy-mcp: server exited during startup")
		}
	default:
		// Notifications and stray responses with no server to receive them.
	}
}

func (s *shim) cachedList(method string) json.RawMessage {
	if s.cache == nil {
		return nil
	}
	return s.cache.Lists[method]
}

// activate starts the real server and completes the handshake with the
// client's own initialize params. Returns the server's initialize result.
func (s *shim) activate() (json.RawMessage, error) {
	if s.cfg.Chrome != nil {
		if err := ensureChrome(*s.cfg.Chrome, s.cfg.Logf); err != nil {
			s.cfg.Logf("ensure chrome: %v", err)
		}
	}
	cmd := exec.Command(s.cfg.Command, s.cfg.Args...)
	ownGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = logWriter{s.cfg.Logf}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", s.cfg.Command, err)
	}
	s.cfg.Logf("started %s pid=%d", s.cfg.Command, cmd.Process.Pid)
	c := &child{
		cmd: cmd, stdin: stdin, done: make(chan struct{}),
		pending:  map[string]json.RawMessage{},
		internal: map[string]chan message{},
	}
	go s.pump(c, stdout)

	initReq, err := withID(s.initReq, s.nextID("init"))
	if err != nil {
		s.kill(c)
		return nil, err
	}
	resp, err := c.call(initReq, s.cfg.InitTimeout)
	if err != nil {
		s.kill(c)
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if len(resp.Error) > 0 {
		s.kill(c)
		return nil, fmt.Errorf("initialize: %s", resp.Error)
	}
	// Published before `initialized`, so a server-to-client request the server
	// sends right after it (roots/list) finds a pipe for the client's reply.
	s.mu.Lock()
	s.child = c
	s.mu.Unlock()
	c.send([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	return resp.Result, nil
}

// fillCache fetches every announced list from the live child and writes the
// cache. Called once, after the first eager activation.
func (s *shim) fillCache(initResult json.RawMessage) {
	c := s.live()
	if c == nil {
		return
	}
	cache := &cacheFile{Key: s.key, Initialize: initResult, Lists: map[string]json.RawMessage{}}
	for method, capability := range listMethods {
		if !hasCapability(initResult, capability) {
			continue
		}
		id := s.nextID("list")
		req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": map[string]any{}})
		resp, err := c.call(req, s.cfg.InitTimeout)
		if err != nil || len(resp.Error) > 0 || paginated(resp.Result) {
			if method == "resources/templates/list" {
				continue // optional even when resources are announced
			}
			s.cfg.Logf("not caching: %s failed or paginated", method)
			return
		}
		cache.Lists[method] = resp.Result
	}
	if err := saveCache(s.cfg.CachePath, cache); err != nil {
		s.cfg.Logf("save cache: %v", err)
		return
	}
	s.cache = cache
	s.cfg.Logf("cache written %s", s.cfg.CachePath)
}

func (s *shim) nextID(kind string) string {
	return fmt.Sprintf("%s%s_%d", internalPrefix, kind, s.seq.Add(1))
}

// pump copies the child's stdout to the client, diverting replies to our own
// requests, and fails the client's in-flight requests when the child exits.
func (s *shim) pump(c *child, stdout io.Reader) {
	r := bufio.NewReader(stdout)
	for {
		line, err := r.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			s.fromChild(c, trimmed)
		}
		if err != nil {
			break
		}
	}
	c.cmd.Wait()
	s.cfg.Logf("server exited")

	s.mu.Lock()
	if s.child == c {
		s.child = nil
	}
	s.mu.Unlock()

	c.mu.Lock()
	c.exited = true
	pending := c.pending
	c.pending = map[string]json.RawMessage{}
	for _, ch := range c.internal {
		close(ch)
	}
	c.internal = map[string]chan message{}
	c.mu.Unlock()
	for _, id := range pending {
		s.replyError(id, "lazy-mcp: server exited; it restarts on the next call")
	}
	close(c.done)
}

func (s *shim) fromChild(c *child, line []byte) {
	var m message
	if json.Unmarshal(line, &m) == nil && m.Method == "" && m.hasID() {
		var sid string
		if json.Unmarshal(m.ID, &sid) == nil && len(sid) > len(internalPrefix) && sid[:len(internalPrefix)] == internalPrefix {
			c.mu.Lock()
			ch := c.internal[sid]
			delete(c.internal, sid)
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
			return
		}
		c.mu.Lock()
		delete(c.pending, string(m.ID))
		c.mu.Unlock()
	}
	s.write(line)
}

func (c *child) send(line []byte) {
	buf := make([]byte, 0, len(line)+1)
	buf = append(buf, line...)
	buf = append(buf, '\n')
	c.stdin.Write(buf)
}

// track records a client request as in flight. False once the child has
// exited: its replies can no longer arrive, so the caller must not send.
func (c *child) track(id json.RawMessage) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exited {
		return false
	}
	c.pending[string(id)] = append(json.RawMessage(nil), id...)
	return true
}

// call sends one of our own requests (id must carry internalPrefix) and waits
// for its reply.
func (c *child) call(req []byte, timeout time.Duration) (message, error) {
	var m message
	if err := json.Unmarshal(req, &m); err != nil {
		return m, err
	}
	var id string
	json.Unmarshal(m.ID, &id)
	ch := make(chan message, 1)
	c.mu.Lock()
	if c.exited {
		c.mu.Unlock()
		return m, errors.New("server exited")
	}
	c.internal[id] = ch
	c.mu.Unlock()
	c.send(req)
	select {
	case resp, ok := <-ch:
		if !ok {
			return resp, errors.New("server exited")
		}
		return resp, nil
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.internal, id)
		c.mu.Unlock()
		return message{}, fmt.Errorf("no reply within %s", timeout)
	}
}

// withID returns req with its id replaced.
func withID(req []byte, id string) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(req, &obj); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(id)
	obj["id"] = raw
	return json.Marshal(obj)
}

func (s *shim) kill(c *child) {
	c.stdin.Close()
	select {
	case <-c.done:
		return
	case <-time.After(2 * time.Second):
	}
	killGroup(c.cmd, false)
	select {
	case <-c.done:
		return
	case <-time.After(2 * time.Second):
	}
	killGroup(c.cmd, true)
	<-c.done
}

func (s *shim) stop() {
	if c := s.live(); c != nil {
		s.kill(c)
	}
}

type logWriter struct{ logf func(string, ...any) }

func (w logWriter) Write(p []byte) (int, error) {
	w.logf("server: %s", bytes.TrimRight(p, "\n"))
	return len(p), nil
}
