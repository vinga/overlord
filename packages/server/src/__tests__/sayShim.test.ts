import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mergeByTime } from '../session/stateManager.js';

const SHIM = path.resolve(__dirname, '../../../../bin/say');

// bin/say against a stub Overlord: the real `say` is a script that logs its args.
describe('bin/say shim', () => {
  let server: http.Server;
  let base = '';
  let muted = false;
  let posts: Array<Record<string, string>> = [];
  let dir = '';
  let realSay = '';
  let log = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/speech/agent-muted') { res.end(JSON.stringify({ muted })); return; }
      if (req.url === '/api/speech/muted-say' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => { posts.push(JSON.parse(body)); res.end('{"ok":true}'); });
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'say-shim-'));
    log = path.join(dir, 'log');
    realSay = path.join(dir, 'real-say');
    fs.writeFileSync(realSay, `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  });
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { posts = []; fs.rmSync(log, { force: true }); });

  // Async: the stub server lives in this process, so spawnSync would starve it.
  const run = (args: string[], opts: { host?: string; input?: string; pty?: string } = {}) =>
    new Promise<{ status: number | null; stdout: string }>(resolve => {
      const p = spawn('bash', [SHIM, ...args], {
        env: { ...process.env, OVERLORD_HOST: opts.host ?? base, OVERLORD_REAL_SAY: realSay, OVERLORD_PTY_ID: opts.pty ?? 'pty-1' },
      });
      let stdout = '';
      p.stdout.on('data', c => { stdout += c; });
      p.on('close', status => resolve({ status, stdout }));
      p.stdin.end(opts.input ?? '');
    });
  const spoken = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  it('not muted: runs the real say with the same args', async () => {
    muted = false;
    expect((await run(['-v', 'Samantha', 'hello'])).status).toBe(0);
    expect(spoken()).toBe('-v Samantha hello\n');
    expect(posts).toEqual([]);
  });

  it('muted: no sound, prints the text, posts it to the session', async () => {
    muted = true;
    const r = await run(['-v', 'Samantha', '-r', '200', 'Urgent action needed.', 'Pods down']);
    expect(r.status).toBe(0);
    expect(spoken()).toBe('');
    expect(r.stdout).toBe('🔇 say (muted): Urgent action needed. Pods down\n');
    expect(posts).toEqual([{ ptyId: 'pty-1', text: 'Urgent action needed. Pods down' }]);
  });

  it('muted: text from stdin', async () => {
    muted = true;
    const r = await run([], { input: 'from a pipe\n' });
    expect(r.stdout).toBe('🔇 say (muted): from a pipe\n');
  });

  it('muted: -o renders to a file through the real say', async () => {
    muted = true;
    await run(['-o', '/tmp/x.aiff', 'hello']);
    expect(spoken()).toBe('-o /tmp/x.aiff hello\n');
  });

  it('Overlord unreachable: falls through to the real say', async () => {
    expect((await run(['hello'], { host: 'http://127.0.0.1:1' })).status).toBe(0);
    expect(spoken()).toBe('hello\n');
  });
});

describe('mergeByTime', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  it('inserts by time and keeps items without a timestamp in place', () => {
    const feed = [{ id: 'a', timestamp: at(1) }, { id: 'b' }, { id: 'c', timestamp: at(5) }];
    const out = mergeByTime(feed, [{ id: 's1', timestamp: at(3) }, { id: 's2', timestamp: at(9) }]);
    expect(out.map(i => i.id)).toEqual(['a', 'b', 's1', 'c', 's2']);
  });
});
