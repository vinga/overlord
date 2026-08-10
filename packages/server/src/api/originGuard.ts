import { timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { log } from '../logger.js';

/**
 * Blocks the two ways a non-user reaches this server:
 *
 *  - a browser acting for another site. CORS stops a page *reading* our
 *    responses, it does not stop it *sending* the request — every
 *    side-effecting POST (spawn, inject, file write) is reachable from any tab
 *    without an Origin check.
 *  - DNS rebinding, which turns a loopback-only bind back into a remote one by
 *    pointing an attacker-controlled hostname at 127.0.0.1. The Host check is
 *    what closes it.
 *
 * A token is required only when the server is deliberately bound off-loopback;
 * the default local flow never sees one.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

let config = {
  port: 3173,
  bindHost: '127.0.0.1',
  token: '',
};

export function initOriginGuard(opts: { port: number; bindHost: string; token: string }): void {
  config = { ...opts };
}

export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const port of [config.port, 5173]) {
      set.add(`http://${host}:${port}`);
    }
  }
  for (const extra of (process.env.OVERLORD_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) set.add(trimmed.replace(/\/+$/, ''));
  }
  return set;
}

function extraHosts(): Set<string> {
  const set = new Set<string>();
  for (const extra of (process.env.OVERLORD_ALLOWED_HOSTS ?? '').split(',')) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) set.add(trimmed);
  }
  return set;
}

function hostnameOf(hostHeader: string): string {
  // Strip the port; keep bracketed IPv6 literals intact.
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}

function tokenMatches(supplied: string): boolean {
  const expected = config.token;
  if (!expected) return true;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function suppliedToken(req: IncomingMessage): string {
  const header = req.headers['x-overlord-token'];
  if (typeof header === 'string' && header) return header;
  try {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    return url.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

export type GuardVerdict = { ok: true } | { ok: false; status: number; reason: string };

/** The single check behind both the Express middleware and the WS upgrade. */
export function verifyRequest(req: IncomingMessage): GuardVerdict {
  // 1. Origin — absent means a non-browser caller (curl, the Vite dev proxy),
  //    which is not the threat this guard addresses.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null') {
    if (!allowedOrigins().has(origin.replace(/\/+$/, ''))) {
      return { ok: false, status: 403, reason: `origin ${origin} not allowed (set OVERLORD_ALLOWED_ORIGINS)` };
    }
  }

  // 2. Host — only enforced in the tokenless local mode. With a token set the
  //    server is knowingly remote-reachable under some other hostname, and the
  //    token is what authorizes the caller.
  if (!config.token) {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';
    const hostname = hostnameOf(hostHeader);
    if (!LOOPBACK_HOSTNAMES.has(hostname) && !extraHosts().has(hostname)) {
      return { ok: false, status: 403, reason: `host ${hostname || '(missing)'} not allowed (set OVERLORD_ALLOWED_HOSTS)` };
    }
  }

  // 3. Token, when configured.
  if (config.token && !tokenMatches(suppliedToken(req))) {
    return { ok: false, status: 403, reason: 'missing or invalid token' };
  }

  return { ok: true };
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const verdict = verifyRequest(req);
  if (verdict.ok) { next(); return; }
  log('info', `guard: rejected ${req.method} ${req.path}`, { extra: verdict.reason });
  res.status(verdict.status).json({ error: verdict.reason });
}

/** ws `verifyClient` — rejects the upgrade before any snapshot is sent. */
export function verifyWsClient(info: { req: IncomingMessage }): boolean {
  const verdict = verifyRequest(info.req);
  if (!verdict.ok) log('info', 'guard: rejected WebSocket upgrade', { extra: verdict.reason });
  return verdict.ok;
}
