import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-note-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('noteStore', () => {
  it('round-trips content under ~/.claude/overlord/notes', async () => {
    const { noteStore } = await import('../session/noteStore.js');
    noteStore.save('note-1-abc', '# Hello\n\n- one');
    expect(noteStore.load('note-1-abc').content).toBe('# Hello\n\n- one');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'overlord', 'notes', 'note-1-abc.md'))).toBe(true);
  });

  it('returns empty content for a note never saved', async () => {
    const { noteStore } = await import('../session/noteStore.js');
    expect(noteStore.load('note-2-new')).toEqual({ content: '', mtime: 0 });
  });

  it('rejects ids that could escape the notes dir', async () => {
    const { noteStore, isNoteId } = await import('../session/noteStore.js');
    for (const bad of ['../x', 'note-../../etc', 'raw-123', 'note-A/B', '']) {
      expect(isNoteId(bad)).toBe(false);
    }
    expect(() => noteStore.save('../evil', 'x')).toThrow();
    expect(() => noteStore.load('note-../x')).toThrow();
  });

  it('rejects content over 1 MB', async () => {
    const { noteStore, NOTE_MAX_BYTES } = await import('../session/noteStore.js');
    expect(() => noteStore.save('note-3-big', 'x'.repeat(NOTE_MAX_BYTES + 1))).toThrow(/1 MB/);
  });

  it('remove deletes the file and tolerates a missing one', async () => {
    const { noteStore } = await import('../session/noteStore.js');
    noteStore.save('note-4-del', 'bye');
    noteStore.remove('note-4-del');
    expect(noteStore.load('note-4-del').content).toBe('');
    expect(() => noteStore.remove('note-4-del')).not.toThrow();
  });
});

describe('notePreview', () => {
  it('takes the first non-empty lines without markdown markers', async () => {
    const { notePreview } = await import('../session/noteStore.js');
    expect(notePreview('\n\n## **Groceries** list\n\n- milk')).toBe('Groceries list\nmilk');
    expect(notePreview('- [ ] call [Bob](https://x.y)')).toBe('call Bob');
    expect(notePreview('   \n')).toBe('');
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(notePreview(many).split('\n')).toHaveLength(20);
  });
});

describe('note sessions in stateManager', () => {
  async function freshStateManager() {
    const mod = await import('../session/stateManager.js');
    return new mod.StateManager(() => { /* noop */ });
  }

  it('creates a waiting note with the notes icon and no provider', async () => {
    const sm = await freshStateManager();
    const s = sm.addNoteSession('note-10-aaa', '/tmp/note-room', 'Ideas');
    expect(s.sessionType).toBe('note');
    expect(s.state).toBe('waiting');
    expect(s.icon).toBe('notes');
    expect(s.provider).toBeUndefined();
    const flat = sm.getSnapshot().rooms.flatMap(r => r.sessions);
    expect(flat.find(x => x.sessionId === 'note-10-aaa')?.proposedName).toBe('Ideas');
  });

  it('touchNote sets the preview and persists it', async () => {
    const sm = await freshStateManager();
    sm.addNoteSession('note-12-ccc', '/tmp/note-room', 'Log');
    sm.touchNote('note-12-ccc', 'first line');
    expect(sm.getSession('note-12-ccc')?.lastMessage).toBe('first line');
    const { sessionStore } = await import('../session/sessionStore.js');
    expect(sessionStore.getBySessionId('note-12-ccc')?.lastMessage).toBe('first line');
  });

  it('rehydrates from the session store as waiting, not closed', async () => {
    const sm = await freshStateManager();
    sm.addNoteSession('note-13-ddd', '/tmp/note-room', 'Persisted');
    sm.touchNote('note-13-ddd', 'kept');
    sm.remove('note-13-ddd');
    expect(sm.getSession('note-13-ddd')).toBeUndefined();

    const back = sm.rehydrateFromSessionStore('note-13-ddd');
    expect(back?.sessionType).toBe('note');
    expect(back?.state).toBe('waiting');
    expect(back?.provider).toBeUndefined();
    expect(back?.proposedName).toBe('Persisted');
    expect(back?.lastMessage).toBe('kept');
  });
});

describe('note close + archive', () => {
  async function freshStateManager() {
    const mod = await import('../session/stateManager.js');
    return new mod.StateManager(() => { /* noop */ });
  }

  it('close persists across rehydrate; saving reopens', async () => {
    const sm = await freshStateManager();
    sm.addNoteSession('note-20-eee', '/tmp/note-room', 'Closable');
    sm.markClosed('note-20-eee');
    expect(sm.getSession('note-20-eee')?.state).toBe('closed');

    sm.remove('note-20-eee');
    expect(sm.rehydrateFromSessionStore('note-20-eee')?.state).toBe('closed');

    sm.touchNote('note-20-eee', 'edited');
    expect(sm.getSession('note-20-eee')?.state).toBe('waiting');
    sm.remove('note-20-eee');
    expect(sm.rehydrateFromSessionStore('note-20-eee')?.state).toBe('waiting');
  });

  it('archives without a transcript, unarchives, and deleteArchive removes the content', async () => {
    const sm = await freshStateManager();
    const { noteStore } = await import('../session/noteStore.js');
    const { archiveManager } = await import('../archive/archiveManager.js');
    sm.addNoteSession('note-21-fff', '/tmp/note-room', 'Archivable');
    noteStore.save('note-21-fff', 'keep me');

    const entry = archiveManager.archive({ sessionId: 'note-21-fff', cwd: '/tmp/note-room', name: 'Archivable', pid: 0, sourceTranscriptPath: null });
    expect(entry?.sessionType).toBe('note');
    expect(entry?.transcripts).toEqual([]);
    expect(archiveManager.isArchived('note-21-fff')).toBe(true);
    expect(noteStore.load('note-21-fff').content).toBe('keep me');

    expect(archiveManager.unarchiveForAdoption('note-21-fff')).toBeDefined();
    expect(archiveManager.isArchived('note-21-fff')).toBe(false);

    archiveManager.archive({ sessionId: 'note-21-fff', cwd: '/tmp/note-room', name: 'Archivable', pid: 0, sourceTranscriptPath: null });
    expect(archiveManager.deleteArchive('note-21-fff')).toBe(true);
    expect(noteStore.load('note-21-fff').content).toBe('');
  });
});
