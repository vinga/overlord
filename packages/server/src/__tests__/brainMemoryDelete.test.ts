import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { pruneMemoryIndex } from '../brain/brainContext.js';
import { isInBrainScope, isMemoryFilePath } from '../api/apiRoutes.js';

const MEM_DIR = '/home/u/.claude/projects/-repo/memory';

const INDEX = [
  '# Memory Index',
  '',
  '- [My name](user_name.md) — what the user calls me',
  '- [Comms style](feedback_comms.md) — terse for status',
  '- [Enter injection](project_enter.md) — open bug',
  '',
  'Free prose that is not an entry.',
].join('\n');

describe('pruneMemoryIndex', () => {
  it('removes only the line pointing at the deleted file', () => {
    const out = pruneMemoryIndex(INDEX, MEM_DIR, path.join(MEM_DIR, 'feedback_comms.md'));
    expect(out).not.toBeNull();
    expect(out).toBe([
      '# Memory Index',
      '',
      '- [My name](user_name.md) — what the user calls me',
      '- [Enter injection](project_enter.md) — open bug',
      '',
      'Free prose that is not an entry.',
    ].join('\n'));
  });

  it('preserves the header, blank lines and non-entry prose', () => {
    const out = pruneMemoryIndex(INDEX, MEM_DIR, path.join(MEM_DIR, 'user_name.md'))!;
    expect(out.split('\n')[0]).toBe('# Memory Index');
    expect(out).toContain('Free prose that is not an entry.');
    expect(out.split('\n')[1]).toBe('');
  });

  it('returns null when the file is not listed', () => {
    expect(pruneMemoryIndex(INDEX, MEM_DIR, path.join(MEM_DIR, 'never_indexed.md'))).toBeNull();
  });

  it('matches by resolved path, not by raw string', () => {
    const out = pruneMemoryIndex(INDEX, MEM_DIR, path.join(MEM_DIR, 'sub', '..', 'project_enter.md'));
    expect(out).not.toBeNull();
    expect(out).not.toContain('project_enter.md');
  });

  it('does not match a different file with a similar name', () => {
    const out = pruneMemoryIndex(INDEX, MEM_DIR, path.join(MEM_DIR, 'user_name_2.md'));
    expect(out).toBeNull();
  });
});

describe('isMemoryFilePath', () => {
  const home = os.homedir();
  const memDir = path.join(home, '.claude', 'projects', '-Users-x-repo', 'memory');

  it('accepts a memory note', () => {
    expect(isMemoryFilePath(path.join(memDir, 'user_name.md'))).toBe(true);
  });

  it('rejects paths outside ~/.claude/projects', () => {
    expect(isMemoryFilePath(path.join(home, '.claude', 'memory', 'x.md'))).toBe(false);
    expect(isMemoryFilePath('/etc/passwd')).toBe(false);
  });

  it('rejects non-markdown files inside a memory dir', () => {
    expect(isMemoryFilePath(path.join(memDir, 'notes.txt'))).toBe(false);
  });

  it('rejects project files with no memory segment', () => {
    expect(isMemoryFilePath(path.join(home, '.claude', 'projects', '-Users-x-repo', 'CLAUDE.md'))).toBe(false);
  });
});

describe('isInBrainScope', () => {
  const home = os.homedir();
  const cwd = '/Users/x/repo';

  it('accepts ~/.claude and the room cwd', () => {
    expect(isInBrainScope(path.join(home, '.claude', 'settings.json'), cwd)).toBe(true);
    expect(isInBrainScope(path.join(cwd, 'CLAUDE.md'), cwd)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isInBrainScope('/etc/passwd', cwd)).toBe(false);
    expect(isInBrainScope('/Users/x/other-repo/CLAUDE.md', cwd)).toBe(false);
  });
});
