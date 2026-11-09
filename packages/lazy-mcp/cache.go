package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// cacheFormat changes whenever the on-disk layout does, invalidating old files.
const cacheFormat = "1"

// listMethods are the requests a client sends right after the handshake to
// discover what a server offers. Each one the server's capabilities announce
// is fetched once and replayed from the cache afterwards.
var listMethods = map[string]string{
	"tools/list":               "tools",
	"prompts/list":             "prompts",
	"resources/list":           "resources",
	"resources/templates/list": "resources",
}

type cacheFile struct {
	Key        string                     `json:"key"`
	Initialize json.RawMessage            `json:"initialize"`
	Lists      map[string]json.RawMessage `json:"lists"`
}

// cacheKey identifies the real server build without running it: the resolved
// executable (symlinks followed, so an npm upgrade that swaps the target counts)
// plus its size and mtime, plus the argument list.
func cacheKey(command string, args []string) string {
	h := sha256.New()
	fmt.Fprintf(h, "format=%s\n", cacheFormat)
	resolved := command
	if p, err := exec.LookPath(command); err == nil {
		resolved = p
	}
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		resolved = real
	}
	fmt.Fprintf(h, "cmd=%s\n", resolved)
	if st, err := os.Stat(resolved); err == nil {
		fmt.Fprintf(h, "size=%d mtime=%d\n", st.Size(), st.ModTime().UnixNano())
	}
	fmt.Fprintf(h, "args=%s\n", strings.Join(args, "\x00"))
	return hex.EncodeToString(h.Sum(nil))
}

func loadCache(path, key string) *cacheFile {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var c cacheFile
	if json.Unmarshal(raw, &c) != nil || c.Key != key || len(c.Initialize) == 0 {
		return nil
	}
	if c.Lists == nil {
		c.Lists = map[string]json.RawMessage{}
	}
	// A server that announces tools must have its list cached, or the lazy
	// path would have to spawn the server on the client's very first request.
	for method, capability := range listMethods {
		if hasCapability(c.Initialize, capability) && method != "resources/templates/list" {
			if _, ok := c.Lists[method]; !ok {
				return nil
			}
		}
	}
	return &c
}

func saveCache(path string, c *cacheFile) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// hasCapability reports whether an initialize result announces a top-level
// server capability ("tools", "prompts", "resources").
func hasCapability(initResult json.RawMessage, name string) bool {
	var r struct {
		Capabilities map[string]json.RawMessage `json:"capabilities"`
	}
	if json.Unmarshal(initResult, &r) != nil {
		return false
	}
	_, ok := r.Capabilities[name]
	return ok
}

// paginated reports whether a list result carries a nextCursor. Those are not
// cached: replaying only the first page would hide the rest.
func paginated(result json.RawMessage) bool {
	var r struct {
		NextCursor *string `json:"nextCursor"`
	}
	return json.Unmarshal(result, &r) == nil && r.NextCursor != nil && *r.NextCursor != ""
}
