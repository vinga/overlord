# Plan: Commit-ahead count in branch badge

Spec: `specs/git-ahead-badge.md`

## Server

- [ ] Add `gitAhead?: number` to Room in `packages/server/src/types.ts`
- [ ] Add per-cwd git status cache (Map + 15s TTL) to `stateManager.ts`
- [ ] Populate `room.gitAhead` from cached `readGitStatus().ahead` in `getSnapshot()`

## Client

- [ ] Add `gitAhead?: number` to Room in `packages/client/src/types.ts`
- [ ] Pass `gitAhead` from room data in `Room.tsx` to `GitBranchBadge`
- [ ] Render `+N` badge in `GitBranchBadge.tsx` when `gitAhead > 0`

## Verification

- [ ] Walk acceptance criteria
- [ ] Screenshot via Chrome DevTools MCP
