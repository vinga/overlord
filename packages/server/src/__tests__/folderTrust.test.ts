import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { ensureFolderTrusted, isAutoTrustEnabled } from '../pty/folderTrust.js';

// Explicit configPath everywhere — never touches the real ~/.claude.json.
let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'ovr-trust-'));
  configPath = join(dir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OVERLORD_AUTO_TRUST_FOLDERS;
});

const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

describe('ensureFolderTrusted', () => {
  it('adds the trust flag and keeps the rest of the config', () => {
    fs.writeFileSync(configPath, JSON.stringify({ numStartups: 7, projects: { '/a': { foo: 1 } } }));
    expect(ensureFolderTrusted('/b', configPath)).toBe(true);
    expect(read()).toEqual({
      numStartups: 7,
      projects: { '/a': { foo: 1 }, '/b': { hasTrustDialogAccepted: true } },
    });
  });

  it('keeps existing per-project fields', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projects: { '/a': { allowedTools: ['x'] } } }));
    ensureFolderTrusted('/a', configPath);
    expect(read().projects['/a']).toEqual({ allowedTools: ['x'], hasTrustDialogAccepted: true });
  });

  it('does not write when already trusted', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true } } }));
    const before = fs.statSync(configPath).mtimeMs;
    expect(ensureFolderTrusted('/a', configPath)).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
  });

  it('leaves an unparseable or missing config alone', () => {
    fs.writeFileSync(configPath, '{ half');
    expect(ensureFolderTrusted('/a', configPath)).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ half');
    expect(ensureFolderTrusted('/a', join(dir, 'missing.json'))).toBe(false);
  });
});

describe('isAutoTrustEnabled', () => {
  it('is off by default', () => {
    expect(isAutoTrustEnabled()).toBe(false);
  });

  it.each(['1', 'true'])('is on for %s', (v) => {
    process.env.OVERLORD_AUTO_TRUST_FOLDERS = v;
    expect(isAutoTrustEnabled()).toBe(true);
  });
});
