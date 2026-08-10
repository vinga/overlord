import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { resolveAllowedPath, looksSecret, setRoomCwdProvider } from '../api/pathGuard.js';

// Real files on disk: the guard resolves symlinks via realpath, which cannot be
// exercised against a virtual fs. Everything lives under one temp sandbox that
// doubles as a fake $HOME, so no real dotfile is touched.
let sandbox: string;
let roomCwd: string;
let outsideDir: string;
let realHome: string | undefined;
let realTmp: string | undefined;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'ovr-pathguard-')));
  realHome = process.env.HOME;
  realTmp = process.env.TMPDIR;
  process.env.HOME = join(sandbox, 'home');
  // os.tmpdir() is itself an allowed root, and the sandbox lives inside the real
  // one — point it at a subdir so "outside every root" is actually reachable.
  fs.mkdirSync(join(sandbox, 'tmp'), { recursive: true });
  process.env.TMPDIR = join(sandbox, 'tmp');
  fs.mkdirSync(join(sandbox, 'home', '.claude', 'overlord'), { recursive: true });
  fs.writeFileSync(join(sandbox, 'home', '.claude', 'overlord', 'note.md'), 'ok');

  roomCwd = join(sandbox, 'home', 'projects', 'demo');
  fs.mkdirSync(join(roomCwd, 'src'), { recursive: true });
  fs.writeFileSync(join(roomCwd, 'src', 'x.ts'), 'export {}');
  fs.writeFileSync(join(roomCwd, '.env'), 'SECRET=1');

  outsideDir = join(sandbox, 'elsewhere');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(join(outsideDir, 'passwd'), 'root:x:0:0');
  fs.writeFileSync(join(sandbox, 'home', 'id_rsa'), 'PRIVATE KEY');

  // The case a string-only `..` check misses: a link that lives inside an
  // allowed root but resolves outside it.
  fs.symlinkSync(join(sandbox, 'home', 'id_rsa'), join(roomCwd, 'innocent.txt'));
  fs.symlinkSync(outsideDir, join(roomCwd, 'linkdir'));

  setRoomCwdProvider(() => [roomCwd]);
});

afterAll(() => {
  setRoomCwdProvider(() => []);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveAllowedPath', () => {
  it('rejects a path with no allowed root', () => {
    const r = resolveAllowedPath(join(outsideDir, 'passwd'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('allows a file inside a known room cwd', () => {
    const r = resolveAllowedPath(join(roomCwd, 'src', 'x.ts'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join(roomCwd, 'src', 'x.ts'));
  });

  it('rejects traversal out of a room cwd', () => {
    const r = resolveAllowedPath(join(roomCwd, '..', '..', '..', 'elsewhere', 'passwd'));
    expect(r.ok).toBe(false);
  });

  it('rejects a symlink that escapes the room cwd', () => {
    // Name and location both look allowed; only realpath reveals the target.
    const r = resolveAllowedPath(join(roomCwd, 'innocent.txt'));
    expect(r.ok).toBe(false);
  });

  it('rejects a symlinked directory that escapes the room cwd', () => {
    const r = resolveAllowedPath(join(roomCwd, 'linkdir', 'passwd'));
    expect(r.ok).toBe(false);
  });

  it('rejects .env even inside an allowed root', () => {
    const r = resolveAllowedPath(join(roomCwd, '.env'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/secret/);
  });

  it('allows ~/.claude content', () => {
    const r = resolveAllowedPath(join(sandbox, 'home', '.claude', 'overlord', 'note.md'));
    expect(r.ok).toBe(true);
  });

  it('allows a not-yet-existing file in an allowed root (writes)', () => {
    const r = resolveAllowedPath(join(roomCwd, 'src', 'brand-new.ts'));
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown cwd once the provider stops listing it', () => {
    setRoomCwdProvider(() => []);
    const r = resolveAllowedPath(join(roomCwd, 'src', 'x.ts'));
    expect(r.ok).toBe(false);
    setRoomCwdProvider(() => [roomCwd]);
  });

  it('rejects a non-string or empty path with 400', () => {
    expect(resolveAllowedPath(undefined).ok).toBe(false);
    const r = resolveAllowedPath('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('browse mode reaches $HOME but still refuses secrets and outside dirs', () => {
    expect(resolveAllowedPath(join(sandbox, 'home', 'projects'), { mode: 'browse' }).ok).toBe(true);
    expect(resolveAllowedPath(join(sandbox, 'home', 'id_rsa'), { mode: 'browse' }).ok).toBe(false);
    expect(resolveAllowedPath(outsideDir, { mode: 'browse' }).ok).toBe(false);
  });

  it('honours OVERLORD_EXTRA_ROOTS', () => {
    const prev = process.env.OVERLORD_EXTRA_ROOTS;
    process.env.OVERLORD_EXTRA_ROOTS = outsideDir;
    expect(resolveAllowedPath(join(outsideDir, 'passwd')).ok).toBe(true);
    if (prev === undefined) delete process.env.OVERLORD_EXTRA_ROOTS;
    else process.env.OVERLORD_EXTRA_ROOTS = prev;
  });
});

describe('looksSecret', () => {
  it('flags secret basenames, extensions and directories', () => {
    for (const p of [
      '/a/.env', '/a/.env.local', '/a/id_rsa', '/a/id_ed25519.pub',
      '/a/.netrc', '/a/.npmrc', '/a/credentials',
      '/a/server.pem', '/a/tls.key', '/a/store.p12',
      '/home/u/.ssh/config', '/home/u/.aws/anything', '/home/u/.kube/config',
    ]) {
      expect(looksSecret(resolve(p)), p).toBe(true);
    }
  });

  it('leaves ordinary source files alone', () => {
    for (const p of ['/a/src/index.ts', '/a/README.md', '/a/environment.ts', '/a/keyboard.tsx']) {
      expect(looksSecret(resolve(p)), p).toBe(false);
    }
  });
});
