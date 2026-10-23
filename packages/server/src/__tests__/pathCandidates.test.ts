import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { resolvePathCandidates } from '../api/pathCandidates.js';
import { setRoomCwdProvider } from '../api/pathGuard.js';

// Sandbox doubles as a fake $HOME so no real file is probed.
let sandbox: string;
let home: string;
let room: string;
let gitRoot: string;
let otherRoom: string;
let realHome: string | undefined;
let realTmp: string | undefined;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'ovr-pathcand-')));
  realHome = process.env.HOME;
  home = join(sandbox, 'home');
  process.env.HOME = home;
  // os.tmpdir() is an allowed root and holds the sandbox — move it aside.
  realTmp = process.env.TMPDIR;
  fs.mkdirSync(join(sandbox, 'tmp'), { recursive: true });
  process.env.TMPDIR = join(sandbox, 'tmp');
  gitRoot = join(home, 'repo');
  room = join(gitRoot, 'packages', 'app');
  otherRoom = join(home, 'other');
  for (const d of [join(room, 'src'), join(gitRoot, 'src'), join(otherRoom, 'src'), join(home, 'notes')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(join(room, 'src', 'a.ts'), '');
  fs.writeFileSync(join(gitRoot, 'src', 'a.ts'), '');
  fs.writeFileSync(join(otherRoom, 'src', 'a.ts'), '');
  fs.writeFileSync(join(gitRoot, 'README.md'), '');
  fs.writeFileSync(join(home, 'notes', 'todo.md'), '');
  fs.writeFileSync(join(room, '.env'), 'X=1');
  setRoomCwdProvider(() => [room, otherRoom]);
});

afterAll(() => {
  setRoomCwdProvider(() => []);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('resolvePathCandidates', () => {
  it('absolute existing file → one openable candidate', () => {
    const r = resolvePathCandidates(join(room, 'src', 'a.ts'), { home });
    expect(r).toEqual([{ path: join(room, 'src', 'a.ts'), kind: 'file', base: 'absolute', openable: true, size: 0, preview: '' }]);
  });

  it('missing path → no candidates', () => {
    expect(resolvePathCandidates(join(room, 'nope.ts'), { home })).toEqual([]);
    expect(resolvePathCandidates('src/nope.ts', { cwd: room, gitRoot, home })).toEqual([]);
  });

  it('relative path lists every base that has it, in priority order', () => {
    const r = resolvePathCandidates('src/a.ts', { cwd: room, gitRoot, home, otherRooms: [room, otherRoom] });
    expect(r.map(c => c.base)).toEqual(['room', 'git root', 'room: other']);
  });

  it('git-root-only hit', () => {
    const r = resolvePathCandidates('README.md', { cwd: room, gitRoot, home });
    expect(r).toHaveLength(1);
    expect(r[0].base).toBe('git root');
  });

  it('~/ expands to home; outside rooms → revealable but not openable', () => {
    const r = resolvePathCandidates('~/notes/todo.md', { home });
    expect(r).toEqual([{ path: join(home, 'notes', 'todo.md'), kind: 'file', base: 'home', openable: false, size: 0 }]);
  });

  it('directory is reported as dir, never openable', () => {
    const r = resolvePathCandidates(join(room, 'src'), { home });
    expect(r[0]).toMatchObject({ kind: 'dir', openable: false });
  });

  it('same file via two bases is listed once', () => {
    const r = resolvePathCandidates('src/a.ts', { cwd: room, gitRoot: room, home });
    expect(r).toHaveLength(1);
  });

  it('secrets are revealable but never openable or previewed', () => {
    const [c] = resolvePathCandidates('.env', { cwd: room, home });
    expect(c).toMatchObject({ kind: 'file', openable: false });
    expect(c.preview).toBeUndefined();
  });

  it('files outside every allowed root still resolve, for Reveal', () => {
    const outside = join(sandbox, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(join(outside, 'x.patch'), 'diff');
    const [c] = resolvePathCandidates(join(outside, 'x.patch'), { home });
    expect(c).toMatchObject({ openable: false });
    expect(c.preview).toBeUndefined();
  });

  it('maps a hit to its deepest known room, with a repo-style rel path', () => {
    const r = resolvePathCandidates('src/a.ts', { cwd: room, gitRoot, home, otherRooms: [gitRoot] });
    expect(r.map(c => c.room)).toEqual([
      { cwd: room, rel: 'src/a.ts' },
      { cwd: gitRoot, rel: 'src/a.ts' },
    ]);
  });

  it('previews the head of a text file, never a binary', () => {
    fs.writeFileSync(join(room, 'long.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
    fs.writeFileSync(join(room, 'bin.dat'), Buffer.from([1, 0, 2]));
    const [text] = resolvePathCandidates(join(room, 'long.txt'), { home });
    expect(text.preview?.split('\n')).toHaveLength(14);
    expect(text.preview?.startsWith('line 0\nline 1')).toBe(true);
    const [bin] = resolvePathCandidates(join(room, 'bin.dat'), { home });
    expect(bin.preview).toBeUndefined();
  });
});
