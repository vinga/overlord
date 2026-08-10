import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';
import { initOriginGuard, verifyRequest, verifyWsClient, isLoopbackBind } from '../api/originGuard.js';

function req(headers: Record<string, string>, url = '/api/stats'): IncomingMessage {
  return { headers, url, method: 'GET' } as unknown as IncomingMessage;
}

const LOCAL = { host: 'localhost:3173' };

describe('originGuard — local tokenless mode', () => {
  beforeEach(() => initOriginGuard({ port: 3173, bindHost: '127.0.0.1', token: '' }));
  afterEach(() => {
    delete process.env.OVERLORD_ALLOWED_ORIGINS;
    delete process.env.OVERLORD_ALLOWED_HOSTS;
  });

  it('allows a request with no Origin (curl, the Vite proxy)', () => {
    expect(verifyRequest(req(LOCAL)).ok).toBe(true);
  });

  it('allows the dev client and the served client', () => {
    expect(verifyRequest(req({ ...LOCAL, origin: 'http://localhost:5173' })).ok).toBe(true);
    expect(verifyRequest(req({ ...LOCAL, origin: 'http://127.0.0.1:3173' })).ok).toBe(true);
  });

  it('rejects a drive-by page — CORS would not stop the request itself', () => {
    const v = verifyRequest(req({ ...LOCAL, origin: 'https://evil.example' }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(403);
      expect(v.reason).toMatch(/OVERLORD_ALLOWED_ORIGINS/);
    }
  });

  it('rejects a rebound hostname pointed at 127.0.0.1', () => {
    const v = verifyRequest(req({ host: 'attacker.example:3173' }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/OVERLORD_ALLOWED_HOSTS/);
  });

  it('accepts IPv6 loopback and a bare host with no port', () => {
    expect(verifyRequest(req({ host: '[::1]:3173' })).ok).toBe(true);
    expect(verifyRequest(req({ host: '127.0.0.1' })).ok).toBe(true);
  });

  it('honours the two allowlist env vars', () => {
    process.env.OVERLORD_ALLOWED_ORIGINS = 'https://trusted.example';
    process.env.OVERLORD_ALLOWED_HOSTS = 'overlord.internal';
    expect(verifyRequest(req({ host: 'overlord.internal:3173', origin: 'https://trusted.example' })).ok).toBe(true);
  });

  it('rejects a foreign-origin WebSocket upgrade', () => {
    expect(verifyWsClient({ req: req({ ...LOCAL, origin: 'https://evil.example' }, '/ws') })).toBe(false);
    expect(verifyWsClient({ req: req(LOCAL, '/ws') })).toBe(true);
  });
});

describe('originGuard — token mode', () => {
  beforeEach(() => initOriginGuard({ port: 3173, bindHost: '0.0.0.0', token: 's3cret-token' }));

  it('rejects a missing or wrong token', () => {
    expect(verifyRequest(req({ host: '192.168.1.5:3173' })).ok).toBe(false);
    expect(verifyRequest(req({ host: '192.168.1.5:3173', 'x-overlord-token': 'nope' })).ok).toBe(false);
    // Length mismatch must not throw out of timingSafeEqual.
    expect(verifyRequest(req({ host: '192.168.1.5:3173', 'x-overlord-token': 'short' })).ok).toBe(false);
  });

  it('accepts the token from a header or the query string', () => {
    expect(verifyRequest(req({ host: '192.168.1.5:3173', 'x-overlord-token': 's3cret-token' })).ok).toBe(true);
    expect(verifyRequest(req({ host: '192.168.1.5:3173' }, '/ws?token=s3cret-token')).ok).toBe(true);
  });

  it('still rejects a foreign Origin even with a valid token', () => {
    const v = verifyRequest(req({ host: '192.168.1.5:3173', origin: 'https://evil.example', 'x-overlord-token': 's3cret-token' }));
    expect(v.ok).toBe(false);
  });
});

describe('isLoopbackBind', () => {
  it('separates loopback from exposed binds', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('localhost')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(isLoopbackBind('192.168.1.5')).toBe(false);
  });
});
