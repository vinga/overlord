package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

const maxLogBytes = 1 << 20

func main() {
	name := flag.String("name", "server", "server name, used in log lines")
	cachePath := flag.String("cache", "", "path of the tools/initialize cache file")
	logPath := flag.String("log", "", "log file (truncated when over 1 MiB at start)")
	chromePort := flag.Int("chrome-port", 0, "ensure a debuggable Chrome on this port before starting the server (0 = off)")
	chromeDir := flag.String("chrome-user-data-dir", "", "profile dir for the Chrome started by --chrome-port")
	chromePath := flag.String("chrome-path", "", "Chrome executable for --chrome-port")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: overlord-lazy-mcp [flags] -- <command> [args...]\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	rest := flag.Args()
	if len(rest) == 0 {
		flag.Usage()
		os.Exit(2)
	}

	logf := openLog(*logPath, *name)
	cfg := config{Command: rest[0], Args: rest[1:], CachePath: *cachePath, Logf: logf}
	if *chromePort > 0 {
		if *chromeDir == "" || *chromePath == "" {
			fmt.Fprintln(os.Stderr, "--chrome-port needs --chrome-user-data-dir and --chrome-path")
			os.Exit(2)
		}
		cfg.Chrome = &chromeSpec{Port: *chromePort, UserDataDir: *chromeDir, Path: *chromePath}
	}
	newShim(cfg, os.Stdout).run(os.Stdin)
}

func openLog(path, name string) func(string, ...any) {
	if path == "" {
		return func(string, ...any) {}
	}
	if st, err := os.Stat(path); err == nil && st.Size() > maxLogBytes {
		os.Truncate(path, 0)
	}
	os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return func(string, ...any) {}
	}
	l := log.New(f, "", 0)
	pid := os.Getpid()
	return func(format string, args ...any) {
		l.Printf("%s %s[%d] %s", time.Now().Format(time.RFC3339), name, pid, fmt.Sprintf(format, args...))
	}
}
