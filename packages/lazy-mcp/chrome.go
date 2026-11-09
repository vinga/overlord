package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"time"
)

type chromeSpec struct {
	Port        int
	UserDataDir string
	Path        string
}

type portState int

const (
	portFree portState = iota
	portChrome
	// portTaken: something answers but not with the DevTools HTTP endpoint —
	// e.g. a normal Chrome with remote debugging switched on in
	// chrome://inspect, which serves only a WebSocket and 404s /json/version.
	portTaken
)

func probePort(port int) portState {
	client := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return portFree
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return portChrome
	}
	return portTaken
}

func chromeUp(port int) bool { return probePort(port) == portChrome }

// ensureChrome makes sure a debuggable Chrome answers on spec.Port, launching
// one on spec.UserDataDir if nothing does. The browser is started in its own
// session so it outlives this shim and the Claude session that triggered it:
// every session pointed at the same port shares it, including its logins.
func ensureChrome(spec chromeSpec, logf func(string, ...any)) error {
	switch probePort(spec.Port) {
	case portChrome:
		return nil
	case portTaken:
		return fmt.Errorf("port %d is used by another process that is not a debuggable Chrome (your own Chrome with remote debugging on?); pick another port", spec.Port)
	}
	if err := os.MkdirAll(spec.UserDataDir, 0o755); err != nil {
		return fmt.Errorf("user data dir: %w", err)
	}
	cmd := exec.Command(spec.Path,
		fmt.Sprintf("--remote-debugging-port=%d", spec.Port),
		"--user-data-dir="+spec.UserDataDir,
		"--no-first-run",
		"--no-default-browser-check",
	)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch chrome: %w", err)
	}
	logf("launched chrome pid=%d port=%d", cmd.Process.Pid, spec.Port)
	go cmd.Wait() // reap if it exits while we are still alive
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if chromeUp(spec.Port) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("chrome did not answer on port %d within 10s", spec.Port)
}
