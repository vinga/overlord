## Spec: Brain Tab — Agent Context Viewer

**Goal:** Add a **Brain** tab to the **room-level** `TaskListPanel` that shows, at a glance, everything the Claude Code agents in this room are "bound by" — its CLAUDE.md chain, auto-memory, configured hooks, available skills, connected MCP servers, active permissions. Entirely read-only, sourced from files on disk.

**Placement rationale:** Every field shown is derived from the room's `cwd` (CLAUDE.md walk, settings merge, memory slug, skills dir). The data is identical for every session in a room, so the room panel is the correct home — per-session would duplicate the same payload N times.

**Inputs / Triggers:**
- User clicks the room name (opens `TaskListPanel`) and picks the **Brain** tab.
- Data fetched on first open and on explicit refresh; no WebSocket push.

**Outputs / Side effects:**
- `GET /api/brain?cwd=<room cwd>` server endpoint returns a JSON context blob. Only known-room cwds are accepted (same allowlist pattern as `/api/git/status`).
- `GET /api/brain/file?cwd=<room cwd>&path=<file>` reads a single referenced file (capped at 500 lines); path must be inside `~/.claude/` or under the room's cwd.
- Client renders the blob as a single-column scrolling view with collapsible cards.
- No disk writes. No agent round-trip. No mutation of session state.

---

### Server

**New endpoint** `GET /api/brain/:sessionId` → `BrainContext` JSON.

Resolution:
1. Look up the session by id in `StateManager` → get its `cwd`.
2. Collect data from the following sources:
   - **CLAUDE.md chain**: walk from `cwd` upward to `$HOME`, collecting every `CLAUDE.md` encountered; also include `$HOME/.claude/CLAUDE.md` (user global).
   - **Memory index**: read `$HOME/.claude/projects/<slug>/memory/MEMORY.md` where `<slug>` is the cwd encoded the same way Claude Code encodes it (replace `/` with `-`, leading `-`). Also list individual `.md` files in that memory dir.
   - **Settings**: read `$HOME/.claude/settings.json`, project `.claude/settings.json`, and `.claude/settings.local.json` (if present under `cwd`). Merge in the standard precedence order.
   - **Hooks**: extract `hooks` section from merged settings.
   - **Permissions**: extract `permissions.allow` / `permissions.deny` from merged settings, tagged by source file.
   - **MCP servers**: extract `mcpServers` from merged settings; include name + command/args, no secrets (redact any value under keys matching `/token|key|secret|password/i`).
   - **Skills**: read `$HOME/.claude/skills/*/SKILL.md` frontmatter and project `.claude/skills/*/SKILL.md`; list name, description, source.
3. Cache the result per sessionId with a 30s TTL and mtime-based invalidation on any of the source files.

**Recent fires**: out of scope for v1 — see "Out of scope" below.

### `BrainContext` shape

```ts
interface BrainContext {
  cwd: string;
  identity: Array<{ path: string; firstLine: string; lineCount: number }>;
  memory: {
    indexPath: string | null;
    entries: Array<{
      name: string;
      description: string;
      type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown';
      file: string; // absolute path
    }>;
  };
  hooks: Array<{
    event: string;           // e.g. "PreToolUse"
    matcher: string | null;  // e.g. "Bash"
    command: string;         // truncated to 200 chars
    source: string;          // path of settings file
  }>;
  skills: Array<{
    name: string;
    description: string;
    source: 'user' | 'project' | 'plugin';
    path: string;
  }>;
  mcpServers: Array<{
    name: string;
    command: string | null;
    args: string[];
    source: string;
    status: 'unknown'; // v1 doesn't probe live status
  }>;
  permissions: {
    allow: Array<{ rule: string; source: string }>;
    deny: Array<{ rule: string; source: string }>;
  };
}
```

---

### Client

**New tab** `'brain'` added to `DetailPanel` `activeTab` union, placed **after `terminal`** in the tab bar.

**Fetch**
- New hook `useBrainContext(sessionId)` — fetches `/api/brain/:sessionId` on tab activation and on manual refresh click.
- Loading skeleton while fetching. Error card with retry on failure.

**Layout** — single scrollable column inside the existing tab body. No nested tabs.

**Sticky header strip** (top of the tab body):
- Compact counters: `identity N · mem N · hooks N · skills N · mcp N · perm N`.
- A small search input filters card contents (case-insensitive substring across names, paths, descriptions, rules, commands).
- A refresh button (re-fetches).

**Cards** (in this order):

1. **Identity** — expanded by default.
   - One row per CLAUDE.md file: path (monospace, muted) · first non-empty line (1 line, ellipsized) · `N lines` pill.
   - Click a row → inline expand showing the file content inside a scrollable code block (max 400px tall).

2. **Memory** — expanded by default.
   - One row per memory entry from `MEMORY.md`: type badge · name · description.
   - Click a row → inline expand showing the underlying memory file content.
   - Empty state: "No memory for this project yet." with a link to the index path.

3. **Hooks** — expanded by default.
   - One row per hook: `event` badge · `matcher` · command (truncated, monospace).
   - Grouped under small subheaders by `event` (PreToolUse, PostToolUse, UserPromptSubmit, Stop, etc.).
   - Empty state: "No hooks configured."

4. **Skills** — collapsed by default.
   - Rows: name (bold) · source badge (user / project / plugin) · description (1 line).
   - Sort: project first, then user, then plugin; alphabetical within.

5. **MCP servers** — collapsed by default.
   - Rows: name · command + args (monospace, wrapping).
   - Small note: "status not probed in v1".

6. **Permissions** — collapsed by default.
   - Two subsections: Allow, Deny. Each row: rule (monospace) · source path (muted).

**Card UX rules**
- Every card header: title · count · chevron. Clicking the header toggles expansion.
- Expansion state persists per session in `localStorage` under `brainTab:<sessionId>:<card>`.
- Full-width cards. No two-column grids.

**Styling**
- Reuse existing `DetailPanel.module.css` idioms (colors, spacing, pills).
- Monospace font for paths, commands, rules. Sans (Inter) for names and descriptions.
- Muted row hover. No animations beyond the existing accordion pattern.

---

### Acceptance Criteria

**Server**
- [ ] `GET /api/brain/:sessionId` returns `BrainContext` JSON for any known session.
- [ ] Returns `404` with `{ error: 'session not found' }` if session id is unknown.
- [ ] CLAUDE.md chain includes, in order: user global, every ancestor dir from `cwd` upward that has a `CLAUDE.md`, and the `cwd` itself. Files that don't exist are omitted.
- [ ] Memory entries are parsed from `MEMORY.md` bullets of the form `- [Title](file.md) — hook`. Each entry's `type` is read from the target file's frontmatter; `unknown` if missing or unparsable.
- [ ] Hooks are extracted from merged settings and annotated with the source file path.
- [ ] Secrets in MCP server configs are redacted (value replaced with `***` for keys matching `/token|key|secret|password/i`).
- [ ] Response is cached 30s per session; cache invalidates when any source file's mtime changes.
- [ ] No file writes happen during request handling.

**Client**
- [ ] New `brain` tab appears in `DetailPanel` after `terminal`.
- [ ] Clicking the tab fetches and renders the context blob with a loading skeleton.
- [ ] Sticky header strip shows `identity N · mem N · hooks N · skills N · mcp N · perm N`.
- [ ] Search box in header filters rows across all cards; non-matching rows hidden, non-matching cards collapsed.
- [ ] Refresh button re-fetches and updates counters.
- [ ] Identity / Memory / Hooks cards expanded by default; Skills / MCP / Permissions collapsed by default.
- [ ] Clicking a card header toggles expansion; state persists per session in localStorage.
- [ ] Identity row click reveals file contents in a scrollable code block.
- [ ] Memory row click reveals the underlying memory file contents.
- [ ] Empty states render with helpful text (e.g. "No hooks configured.").
- [ ] Fetch errors show an error card with a Retry button; the rest of the panel stays usable.
- [ ] No console errors when switching between tabs or sessions.

**Performance**
- [ ] Typical context assembly completes in <200ms on a project with <20 skills, <10 hooks, <5 MCP servers.
- [ ] Server cache prevents re-reading unchanged files on rapid tab switches.

---

### Out of scope

- **Recent fires feed** — hook/tool/skill invocation log. Deferred to v2; needs a separate event capture pipeline.
- **Live MCP status probing** — just shows "unknown" status in v1.
- **Room-level Brain view** (shared context across all sessions in a room).
- **Diff view** — "what changed in hooks/memory since session started".
- **Edit affordances** — cards are read-only; no in-place editing of memory / hooks / permissions.
- **Cross-session comparison** (overlay two Brain tabs side-by-side).
- **Plugin discovery** beyond reading `.claude/skills/*/SKILL.md` — no remote/registry lookup.

### Open questions

1. **Slug encoding for memory dir.** MEMORY.md shows `/Users/kamilamyczkowska/.claude/projects/-Users-kamilamyczkowska-IdeaProjects-overlord/memory/`. Confirm the encoding rule (replace `/` with `-`, leading `-`) is stable, or derive it by listing the `projects/` dir and matching by prefix.
2. **Settings merge precedence.** Should project `.claude/settings.local.json` override project `.claude/settings.json`, which overrides user `~/.claude/settings.json`? (Assumed yes — matches Claude Code's own precedence.)
3. **Large CLAUDE.md files.** Project CLAUDE.md can be thousands of lines. Should expanded content be capped (first 500 lines) with a "View full file" link that opens in a new window/route? (Suggest yes; confirm.)
4. **Skill discovery scope.** Only `.claude/skills/*/SKILL.md`, or also built-in harness skills listed in system reminders? Built-in skills aren't on disk; we'd need a separate source. (Assumed: disk-only in v1.)
