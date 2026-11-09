import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAZY_MCP_DEFAULTS,
  mergeLazyMcp,
  resolveLazyMcp,
  sanitizeLazyMcp,
  type LazyMcpStored,
} from '../pty/lazyMcpConfig.js';

// The settings store is mocked: importing the real one reads and can write
// ~/.claude/overlord/settings.json.
let stored: LazyMcpStored | undefined;
vi.mock('../session/globalSettingsStore.js', () => ({
  globalSettingsStore: { get: () => ({ lazyMcp: stored }) },
}));

const { withLazyMcpConfig, buildMcpConfig, claudeJsonServerNames } = await import('../pty/lazyMcp.js');

let tmp: string;
let binary: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-mcp-test-'));
  vi.stubEnv('HOME', tmp);
  binary = path.join(tmp, 'overlord-lazy-mcp');
  fs.writeFileSync(binary, '');
  stored = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sanitizeLazyMcp', () => {
  it('keeps valid fields and drops the rest', () => {
    expect(sanitizeLazyMcp({
      enabled: 'yes',
      servers: {
        'chrome-devtools': { browser: 'isolated', args: ['--x'], sharedBrowser: { port: 80 } },
        'bad name!': { command: 'x' },
        other: { command: '  foo  ', browser: 'weird' },
      },
    })).toEqual({
      servers: {
        'chrome-devtools': { browser: 'isolated', args: ['--x'] },
        other: { command: 'foo' },
      },
    });
  });

  it('passes null through as a removal marker', () => {
    expect(sanitizeLazyMcp({ servers: { foo: null } })).toEqual({ servers: { foo: null } });
  });
});

describe('mergeLazyMcp', () => {
  it('merges per server and per sharedBrowser key', () => {
    const prev: LazyMcpStored = { enabled: true, servers: { 'chrome-devtools': { browser: 'isolated', sharedBrowser: { port: 9300 } } } };
    const next = mergeLazyMcp(prev, { servers: { 'chrome-devtools': { sharedBrowser: { userDataDir: '/x' } } } });
    expect(next).toEqual({
      enabled: true,
      servers: { 'chrome-devtools': { browser: 'isolated', sharedBrowser: { port: 9300, userDataDir: '/x' } } },
    });
  });

  it('null removes a stored server', () => {
    const next = mergeLazyMcp({ servers: { foo: { command: 'foo' } } }, { servers: { foo: null } });
    expect(next.servers).toEqual({});
  });
});

describe('resolveLazyMcp', () => {
  it('is off with the chrome-devtools default when nothing is stored', () => {
    const cfg = resolveLazyMcp(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.servers['chrome-devtools']).toEqual(LAZY_MCP_DEFAULTS.servers['chrome-devtools']);
  });

  it('skips a custom server without a command', () => {
    expect(resolveLazyMcp({ servers: { foo: { browser: 'none' } } }).servers.foo).toBeUndefined();
  });
});

describe('buildMcpConfig', () => {
  it('shared mode points the real server at the shared port and lets the shim launch Chrome', () => {
    const cfg = resolveLazyMcp({ enabled: true });
    const entry = buildMcpConfig(cfg, '/bin/shim', '/d').mcpServers['chrome-devtools'];
    expect(entry.command).toBe('/bin/shim');
    const sep = entry.args.indexOf('--');
    const shimArgs = entry.args.slice(0, sep);
    const realArgs = entry.args.slice(sep + 2);
    expect(shimArgs).toEqual(expect.arrayContaining(['--name', 'chrome-devtools', '--chrome-port', '9223', '--cache', '/d/chrome-devtools.cache.json']));
    expect(shimArgs[shimArgs.indexOf('--chrome-user-data-dir') + 1]).toBe(path.join(tmp, '.cache/overlord-chrome'));
    expect(realArgs).toEqual(['--no-usage-statistics', '--browserUrl', 'http://127.0.0.1:9223']);
  });

  it('isolated mode adds --isolated and no Chrome launch', () => {
    const cfg = resolveLazyMcp({ enabled: true, servers: { 'chrome-devtools': { browser: 'isolated' } } });
    const args = buildMcpConfig(cfg, '/bin/shim', '/d').mcpServers['chrome-devtools'].args;
    expect(args).not.toContain('--chrome-port');
    expect(args.at(-1)).toBe('--isolated');
  });

  it('leaves out disabled servers', () => {
    const cfg = resolveLazyMcp({ enabled: true, servers: { 'chrome-devtools': { enabled: false } } });
    expect(buildMcpConfig(cfg, '/bin/shim', '/d').mcpServers).toEqual({});
  });
});

describe('withLazyMcpConfig', () => {
  const dir = () => path.join(tmp, 'lazy');

  it('leaves args untouched when disabled', () => {
    expect(withLazyMcpConfig(['--name', 'x'], { binary, dir: dir() })).toEqual(['--name', 'x']);
  });

  it('appends --mcp-config once, also on resume', () => {
    stored = { enabled: true };
    const out = withLazyMcpConfig(['--resume', 'abc'], { binary, dir: dir() });
    expect(out.slice(0, 2)).toEqual(['--resume', 'abc']);
    expect(out.slice(2)).toEqual(['--mcp-config', path.join(dir(), 'mcp-config.json')]);
    const written = JSON.parse(fs.readFileSync(path.join(dir(), 'mcp-config.json'), 'utf8'));
    expect(Object.keys(written.mcpServers)).toEqual(['chrome-devtools']);
    expect(withLazyMcpConfig(out, { binary, dir: dir() })).toEqual(out);
  });

  it('skips when the shim binary is missing', () => {
    stored = { enabled: true };
    expect(withLazyMcpConfig(['--name', 'x'], { binary: path.join(tmp, 'nope'), dir: dir() })).toEqual(['--name', 'x']);
  });

  it('OVERLORD_LAZY_MCP=0 forces it off', () => {
    stored = { enabled: true };
    vi.stubEnv('OVERLORD_LAZY_MCP', '0');
    expect(withLazyMcpConfig(['--name', 'x'], { binary, dir: dir() })).toEqual(['--name', 'x']);
  });
});

describe('claudeJsonServerNames', () => {
  it('reports global and per-project definitions', () => {
    const file = path.join(tmp, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: { 'chrome-devtools': {} },
      projects: { '/p': { mcpServers: { 'chrome-devtools': {}, other: {} } } },
    }));
    const names = claudeJsonServerNames(file);
    expect(names.get('chrome-devtools')).toEqual(['global', '/p']);
    expect(names.get('other')).toEqual(['/p']);
  });
});

describe('command resolution', () => {
  it('resolves a symlinked PATH dir to its real location', () => {
    const real = path.join(tmp, 'real-bin');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'fake-mcp'), '#!/bin/sh\n', { mode: 0o755 });
    const link = path.join(tmp, 'shell-bin');
    fs.symlinkSync(real, link);
    vi.stubEnv('PATH', link);
    const cfg = resolveLazyMcp({ enabled: true, servers: { 'chrome-devtools': { command: 'fake-mcp', browser: 'none' } } });
    const args = buildMcpConfig(cfg, '/bin/shim', '/d').mcpServers['chrome-devtools'].args;
    expect(args[args.indexOf('--') + 1]).toBe(path.join(fs.realpathSync(real), 'fake-mcp'));
  });
});
