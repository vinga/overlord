## Spec: Closed Sessions & Resume

**Goal:** Distinguish "terminal closed" sessions from naturally-idle ones, show them in a dedicated `closed` state, and offer two resume paths — inline PTY inside Overlord and a clipboard copy of `claude --resume <id>`. Also surface how each session was originally launched (terminal, IDE, or Overlord-internal).

---

**Inputs / Triggers:**
- Session PID dies (detected by `processChecker` every 5 s)
- User clicks "Resume here" in the detail panel of a closed session
- User clicks "Copy resume command" in the detail panel of a closed session
- Session is spawned via PTY inside Overlord (sets `launchMethod = 'overlord-pty'`)
- Session has an `ideName` in its `.lock` file (sets `launchMethod = 'ide'`)
- Session has no IDE lock (sets `launchMethod = 'terminal'`)

---

**Outputs / Side effects:**
- New `WorkerState`: `'working' | 'thinking' | 'waiting' | 'closed'` — `idle` is removed; all places that previously set/read `idle` use `closed`
- New `Session` field: `launchMethod: 'terminal' | 'ide' | 'overlord-pty'`
- Detail panel shows resume buttons and launch context for closed sessions
- `Worker` component renders a visually distinct style for `closed` state

---

**Acceptance Criteria:**

### State

- [ ] `WorkerState` no longer includes `'idle'`; `'closed'` is added in its place in both `packages/server/src/types.ts` and `packages/client/src/types.ts`
- [ ] `stateManager.updateAlivePids()` transitions dead-PID sessions to `'closed'` (was `'idle'`), keeping the existing 30 s grace period
- [ ] All existing code that gated on `state === 'idle'` is updated to use `state === 'closed'` (dormitory auto-entry, Room sort, DetailPanel sibling banner, App.tsx sibling computation, continuation banner)

### Launch Method

- [ ] `Session` and `ClientSession` interfaces gain a `launchMethod: 'terminal' | 'ide' | 'overlord-pty'` field
- [ ] `stateManager.addOrUpdate()` sets `launchMethod`:
  - `'ide'` when `ideName` is non-empty (derived from `.lock` file, already read)
  - `'overlord-pty'` when the session was spawned by Overlord's PTY manager (detect via `resumedFrom` being set at creation time, OR via a new `trackPtySpawn(sessionId)` call in `ptyManager` before spawning)
  - `'terminal'` otherwise
- [ ] `launchMethod` is included in the `OfficeSnapshot` broadcast

### Detail Panel — Resume (closed sessions only)

- [ ] When `state === 'closed'`, the Details tab shows a "Resume" section with two buttons:
  - **"Resume here"** — existing PTY resume flow (sends `terminal:resume` WS message); label updated from "▶ Resume" to "Resume in Overlord"
  - **"Copy resume command"** — copies `claude --resume <sessionId>` to clipboard; shows a transient "Copied!" confirmation for 2 s
- [ ] The two resume buttons are **not shown** for sessions with `state !== 'closed'`

### Detail Panel — Launch Context

- [ ] The Details tab shows a "Launched from" row:
  - `launchMethod === 'terminal'` → "Terminal"
  - `launchMethod === 'ide'` → IDE name (e.g., "VS Code", "JetBrains") — use the existing `ideName` value, title-cased
  - `launchMethod === 'overlord-pty'` → "Overlord (internal)"
- [ ] If `resumedFrom` is set, an additional "Resumed from" row links to the parent session name (customName → proposedName → 8-char ID prefix); clicking it selects that session in the panel

### Worker Visual

- [ ] `Worker` component renders `closed` state with a visually distinct style: desaturated/dimmed appearance (e.g., reduced opacity + grayscale filter), different from the active states
- [ ] The state badge in the detail panel header shows "closed" in a muted gray (same slot as the current `idle` color `#374151`)

---

**Out of scope:**
- Persisting `launchMethod` across server restarts (in-memory only is fine; it re-derives on session re-read)
- Auto-resuming sessions on server startup
- Showing resume buttons inside the worker tooltip or room view
- Any changes to the dormitory feature beyond the `idle → closed` rename

---

**Open questions:**
- *(resolved)* `idle` → `closed` rename is a breaking change in the WS protocol; client and server ship together so this is safe
- Should `launchMethod` survive a server restart? Decision: no — it re-derives from `ideName` and `pendingResumes` on first `addOrUpdate` call
