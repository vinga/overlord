## Spec: Spawn Session in New Folder

**Goal:** Allow users to start a new Claude session in any directory on the filesystem, not only in directories where sessions already exist (i.e., existing rooms).

**Inputs / Triggers:**
- A new UI element (button/action) accessible from the Office view, outside any specific room
- User provides or selects a target directory path
- User provides a session name (follows existing name-first spawn flow)
- User selects session type: embedded, bridge, or plain

**Outputs / Side effects:**
- A new Claude session is spawned with `cwd` set to the chosen directory
- A new room appears in the Office view for that directory (if one doesn't already exist)
- The session appears in that room with the provided name
- All existing spawn mechanics apply (PTY linking, name markers, etc.)

**Acceptance Criteria:**
- [ ] A "New Session" button is visible in the Office header area (not tied to any room)
- [ ] Clicking it opens a dialog/popover where the user can enter a directory path
- [ ] Path input supports autocomplete or at minimum free-text entry
- [ ] User can choose session type (embedded / bridge / plain)
- [ ] User can provide a session name (pre-filled with auto-generated name)
- [ ] Submitting spawns a session in the specified directory
- [ ] If the directory already has a room, the session appears in that room
- [ ] If the directory is new, a new room is created automatically
- [ ] Invalid or non-existent directory paths show a clear error
- [ ] The flow is consistent with the existing in-room spawn flow (name-first, same terminal messages)

**Out of scope:**
- Directory browser/picker (native OS dialog) — free-text path entry is sufficient for v1
- Creating the directory if it doesn't exist — the path must already exist
- Remembering recently used directories (could be a follow-up)

**Open questions:**
- Should there be a "recent directories" or "favorites" list for quick access?
- Should the path input show suggestions from existing rooms for quick re-selection?
- Where exactly in the header should the button be placed — next to the Overlord logo, or as a floating action button?
