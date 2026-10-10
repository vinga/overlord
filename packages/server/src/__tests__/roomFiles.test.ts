import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  listRoomFiles, checkRoomFile, readRoomFileText, validateRoomFileContent,
  parseGitignore, parsePorcelain, invalidateRoomFiles, MAX_ROOM_FILE_BYTES,
  parseNameStatus, resolveBase, readRoomFileDiff,
} from '../api/roomFiles.js';

// Real repos on disk: listing shells out to git and the gate resolves symlinks.
// One temp sandbox doubles as $HOME so nothing real is read or written.
let sandbox: string;
let repo: string;
let plain: string;
let outside: string;
let realHome: string | undefined;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });

function write(p: string, content = 'x'): void {
  fs.mkdirSync(join(p, '..'), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'ovr-roomfiles-')));
  realHome = process.env.HOME;
  process.env.HOME = join(sandbox, 'home');

  repo = join(sandbox, 'home', 'repo');
  write(join(repo, '.gitignore'), 'secret.txt\nlogs/\n');
  write(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  write(join(repo, 'README.md'), '# hi\n');
  write(join(repo, '.env'), 'TOKEN=1');                 // committed by mistake
  write(join(repo, 'dist', 'out.js'), 'compiled');      // committed build output
  gitIn(repo, 'init', '-q');
  gitIn(repo, 'add', '-f', '.gitignore', 'src/a.ts', 'README.md', '.env', 'dist/out.js');
  gitIn(repo, 'commit', '-qm', 'init');
  write(join(repo, 'secret.txt'), 'gitignored');
  write(join(repo, 'logs', 'run.log'), 'gitignored dir');
  write(join(repo, 'node_modules', 'pkg', 'index.js'), 'dep');
  write(join(repo, 'new.ts'), 'untracked');
  write(join(repo, 'bin.dat'), 'a\0b');
  fs.appendFileSync(join(repo, 'src', 'a.ts'), '// edit\n');

  outside = join(sandbox, 'outside.txt');
  write(outside, 'not in room');
  fs.symlinkSync(outside, join(repo, 'escape.txt'));
  fs.symlinkSync(join(repo, '.env'), join(repo, 'innocent.txt'));

  plain = join(sandbox, 'home', 'plain');
  write(join(plain, '.gitignore'), '*.log\ncache/\n');
  write(join(plain, 'main.py'), 'print(1)');
  write(join(plain, 'debug.log'), 'ignored');
  write(join(plain, 'cache', 'x.bin'), 'ignored');
  write(join(plain, '.venv', 'lib.py'), 'denied');
  write(join(plain, 'id_rsa'), 'KEY');
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('listRoomFiles', () => {
  it('lists tracked + untracked, hides gitignored, deny-listed and secret files', async () => {
    const r = await listRoomFiles(repo);
    expect(r.git).toBe(true);
    expect(r.files).toEqual(expect.arrayContaining(['src/a.ts', 'README.md', 'new.ts', '.gitignore']));
    for (const hidden of ['secret.txt', 'logs/run.log', 'node_modules/pkg/index.js', '.env', 'dist/out.js']) {
      expect(r.files).not.toContain(hidden);
    }
    expect(r.changed['src/a.ts']).toBe('M');
    expect(r.changed['new.ts']).toBe('?');
    expect(r.changed['.env']).toBeUndefined();
  });

  it('falls back to a walk with root .gitignore outside git', async () => {
    const r = await listRoomFiles(plain);
    expect(r.git).toBe(false);
    expect(r.files).toContain('main.py');
    for (const hidden of ['debug.log', 'cache/x.bin', '.venv/lib.py', 'id_rsa']) expect(r.files).not.toContain(hidden);
  });

  it('caches, and invalidate refreshes', async () => {
    await listRoomFiles(repo);
    write(join(repo, 'later.ts'));
    expect((await listRoomFiles(repo)).files).not.toContain('later.ts');
    invalidateRoomFiles(repo);
    expect((await listRoomFiles(repo)).files).toContain('later.ts');
  });
});

describe('checkRoomFile', () => {
  it('allows a listed file', async () => {
    const v = await checkRoomFile(repo, 'src/a.ts');
    expect(v.ok).toBe(true);
  });

  it.each([
    ['secret.txt', 403],
    ['logs/run.log', 403],
    ['.env', 403],
    ['innocent.txt', 403],      // symlink to .env
    ['escape.txt', 403],        // symlink out of the room
    ['../../outside.txt', 403],
    ['../nope.txt', 403],       // outside and missing: still 403, no existence probe
    ['node_modules/pkg/index.js', 403],
    ['missing.ts', 404],
    ['src', 400],
  ])('rejects %s with %i', async (rel, status) => {
    const v = await checkRoomFile(repo, rel);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(status);
  });

  it('rejects absolute and non-string paths', async () => {
    for (const bad of [outside, '', undefined, 42]) {
      const v = await checkRoomFile(repo, bad);
      expect(v.ok).toBe(false);
    }
  });

  it('honors root .gitignore outside git', async () => {
    expect((await checkRoomFile(plain, 'main.py')).ok).toBe(true);
    expect((await checkRoomFile(plain, 'debug.log')).ok).toBe(false);
    expect((await checkRoomFile(plain, 'cache/x.bin')).ok).toBe(false);
  });
});

describe('content limits', () => {
  it('refuses binary files on read', () => {
    const r = readRoomFileText(join(repo, 'bin.dat'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it('validates writes', () => {
    expect(validateRoomFileContent('ok').ok).toBe(true);
    expect(validateRoomFileContent(5).ok).toBe(false);
    expect(validateRoomFileContent('a\0b')).toMatchObject({ ok: false, status: 415 });
    expect(validateRoomFileContent('x'.repeat(MAX_ROOM_FILE_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
  });
});

describe('parsers', () => {
  it('parseGitignore handles anchors, dirs and globs', () => {
    const m = parseGitignore('/root.txt\nbuild/\n*.log\ndocs/**/tmp\n# c\n!keep.log\n');
    expect(m('root.txt', false)).toBe(true);
    expect(m('sub/root.txt', false)).toBe(false);
    expect(m('a/build', true)).toBe(true);
    expect(m('a/build', false)).toBe(false);
    expect(m('x/y.log', false)).toBe(true);
    expect(m('docs/a/b/tmp', false)).toBe(true);
  });

  it('parsePorcelain strips the cwd prefix and skips rename sources', () => {
    const out = ' M pkg/a.ts\0?? pkg/new.ts\0R  pkg/b.ts\0pkg/old.ts\0 M other/c.ts\0';
    expect(parsePorcelain(out, 'pkg/')).toEqual({ 'a.ts': 'M', 'new.ts': '?', 'b.ts': 'R' });
  });
});

describe('PR scope', () => {
  let feat: string;

  beforeAll(() => {
    feat = join(sandbox, 'home', 'feat');
    write(join(feat, 'keep.ts'), 'base\n');
    write(join(feat, 'gone.ts'), 'old\n');
    write(join(feat, 'edit.ts'), 'one\n');
    gitIn(feat, 'init', '-q', '-b', 'main');
    gitIn(feat, 'add', '.');
    gitIn(feat, 'commit', '-qm', 'base');
    gitIn(feat, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    gitIn(feat, 'checkout', '-qb', 'feature');
    write(join(feat, 'edit.ts'), 'two\n');
    write(join(feat, 'added.ts'), 'new\n');
    fs.rmSync(join(feat, 'gone.ts'));
    write(join(feat, '.env'), 'S=1');
    gitIn(feat, 'add', '-A');
    gitIn(feat, 'add', '-f', '.env');
    gitIn(feat, 'commit', '-qm', 'work');
    write(join(feat, 'edit.ts'), 'three\n');   // uncommitted on top
    write(join(feat, 'scratch.ts'), 'wip\n');  // untracked
  });

  it('resolveBase finds origin/main and is null on the base branch', async () => {
    expect((await resolveBase(feat))?.ref).toBe('origin/main');
    expect(await resolveBase(repo)).toBeNull();          // no remote
  });

  it('prChanged covers committed, uncommitted and untracked branch work', async () => {
    invalidateRoomFiles(feat);
    const r = await listRoomFiles(feat);
    expect(r.base).toBe('origin/main');
    expect(r.prChanged).toEqual({ 'edit.ts': 'M', 'added.ts': 'A', 'gone.ts': 'D', 'scratch.ts': 'A' });
    expect(r.changed).toEqual({ 'edit.ts': 'M', 'scratch.ts': '?' });
  });

  it('diffs vs HEAD and vs merge-base', async () => {
    expect(await readRoomFileDiff(feat, 'edit.ts', 'head')).toMatchObject({ ok: true, original: 'two\n', modified: 'three\n' });
    expect(await readRoomFileDiff(feat, 'edit.ts', 'pr')).toMatchObject({ ok: true, original: 'one\n', modified: 'three\n', base: 'origin/main' });
    expect(await readRoomFileDiff(feat, 'added.ts', 'pr')).toMatchObject({ ok: true, originalMissing: true, modified: 'new\n' });
    expect(await readRoomFileDiff(feat, 'gone.ts', 'pr')).toMatchObject({ ok: true, original: 'old\n', modifiedMissing: true });
  });

  it('diff applies the same gate', async () => {
    for (const [rel, status] of [['.env', 403], ['../repo/README.md', 403], ['nope.ts', 404]] as const) {
      expect(await readRoomFileDiff(feat, rel, 'pr')).toMatchObject({ ok: false, status });
    }
    expect(await readRoomFileDiff(repo, 'src/a.ts', 'pr')).toMatchObject({ ok: false, status: 409 });
  });

  it('parseNameStatus keeps the new side of renames', () => {
    expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0x.ts\0A\0y.ts\0'))
      .toEqual({ 'a.ts': 'M', 'new.ts': 'R', 'x.ts': 'D', 'y.ts': 'A' });
  });
});
