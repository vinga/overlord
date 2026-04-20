# Plan: Inline File Editor

## Server

- [ ] **S1** Add `GET /api/file` endpoint to `packages/server/src/api/apiRoutes.ts` — reads file, returns `{ content, writable }`, 404 if missing  
  _AC: GET /api/file returns content + writable_
- [ ] **S2** Add `PUT /api/file` endpoint — writes file content, 403 if not writable, 204 on success  
  _AC: PUT /api/file writes and returns 204; 403 on non-writable_

## Client

- [ ] **C1** Create `FileEditorOverlay.module.css` — backdrop, modal, header, toggle buttons, textarea, save flash  
  _AC: overlay renders cleanly at narrow + wide viewports_
- [ ] **C2** Create `FileEditorOverlay.tsx` — loads file via `GET /api/file`, shows preview/edit modes, saves via `PUT /api/file`  
  _AC: all client ACs_
- [ ] **C3** Wire `DetailPanel.tsx` line ~822 — replace `/api/open-file` fetch with `setFileEditorPath(tool.content)`; render `<FileEditorOverlay>` when path is set  
  _AC: clicking file path opens overlay, not external IDE_

## Verification

- [ ] **V1** Walk all acceptance criteria against running app
- [ ] **V2** Browser verify via Chrome DevTools MCP screenshot at `http://localhost:5173`
