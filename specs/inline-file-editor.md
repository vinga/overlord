## Spec: Inline File Editor

**Goal:** Clicking any file path in the UI opens an inline editor overlay with markdown support and save capability.

**Placement:** Full-screen overlay anchored within the DetailPanel, triggered from any clickable file path (`toolDescLink` buttons).

---

### Inputs / Triggers

- User clicks a file path button in DetailPanel tool results (currently calls `/api/open-file`)
- Applies to all paths matching `isFilePath()` regex

### Outputs / Side effects

- Overlay renders with file content
- `.md` files: rendered markdown by default, toggle to raw
- All files: editable textarea mode, save writes back via API
- Overlay closes on `Escape` or explicit close button

---

### Server

**New endpoint — `GET /api/file`**

```ts
// query: path (absolute)
// response: { content: string, writable: boolean }
```

- Reads any file the process can access (no scope restriction — user explicitly clicked it)
- `writable: true` if file passes a write-access check (`fs.access(path, fs.W_OK)`)

**New endpoint — `PUT /api/file`**

```ts
// body: { path: string, content: string }
// response: 204
```

- Writes file at `path` with `content`
- Returns 403 if path not writable

---

### Client

**New component — `FileEditorOverlay.tsx` + `FileEditorOverlay.module.css`**

```
packages/client/src/components/FileEditorOverlay.tsx
packages/client/src/components/FileEditorOverlay.module.css
```

**State:**
```ts
type FileEditorState = {
  path: string;
  content: string;
  original: string;     // for dirty detection
  writable: boolean;
  mode: 'preview' | 'edit';  // edit always available, preview only for .md
  saving: boolean;
  error: string | null;
}
```

**Layout:**
- Full-screen semi-transparent backdrop
- Centered modal: `min(90vw, 900px)` wide, `min(85vh, 800px)` tall
- Header: trimmed file path, `[Preview | Edit]` toggle (only if `.md`), `Save` button (disabled when unmodified or not writable), `✕` close
- Body: scrollable
  - Preview mode: `dangerouslySetInnerHTML` with `marked` (same pattern as BrainTab)
  - Edit mode: `<textarea>` filling body, monospace, no resize

**Integration — DetailPanel.tsx line ~822:**

Replace the `onClick` that calls `/api/open-file` with state setter that opens the overlay.

```tsx
// Instead of fetch('/api/open-file')
onClick={() => openFileEditor(tool.content)}
```

`openFileEditor` sets `fileEditorPath` state in DetailPanel, which renders `<FileEditorOverlay path={fileEditorPath} onClose={() => setFileEditorPath(null)} cwd={cwd} />`.

**UX rules:**
- Escape key closes overlay
- Backdrop click closes if no unsaved changes; prompts if dirty
- Markdown toggle remembers last mode per session (localStorage key `overlord:fileEditorMode`)
- Save shows brief success flash ("Saved"), error shows inline red message

---

### Acceptance Criteria

**Server**
- [ ] `GET /api/file?path=<abs>` returns `{ content, writable }` for any readable file
- [ ] `PUT /api/file` writes content and returns 204
- [ ] `GET /api/file` returns 404 for non-existent path
- [ ] `PUT /api/file` returns 403 for non-writable path

**Client**
- [ ] Clicking a file path in DetailPanel opens overlay (not external IDE)
- [ ] `.md` files default to Preview mode with rendered markdown
- [ ] Non-`.md` files open directly in Edit mode (no toggle shown)
- [ ] Edit textarea fills the overlay body, monospace font
- [ ] Save button disabled when content matches original or `writable: false`
- [ ] Save writes via `PUT /api/file`, shows "Saved" flash on success
- [ ] Escape closes overlay; backdrop click closes if clean, warns if dirty
- [ ] Overlay renders correctly at both narrow (700px) and wide (1400px) viewport

**Performance**
- [ ] File content loads within 300ms for files ≤1MB

---

### Out of scope

- Syntax highlighting for non-markdown files
- Git diff view
- Multiple tabs / split view

### Open questions

1. Should clicking a file path still also trigger `/api/open-file` as a secondary action? Suggest: No — inline editor replaces the external-open behavior entirely.
2. Should very large files (>1MB) be truncated or rejected? Suggest: Return a 413 / show "File too large to edit inline (>1MB)" with a fallback "Open in IDE" button.
