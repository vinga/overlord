/**
 * Settings shape for the lazy MCP shim (`packages/lazy-mcp`). Kept free of
 * imports so globalSettingsStore can depend on it without a cycle.
 *
 * Stored in settings.json as a partial; read sites resolve it against
 * LAZY_MCP_DEFAULTS with resolveLazyMcp().
 */

/** Where the real chrome-devtools-mcp finds its browser.
 *  - shared:   one debuggable Chrome on `sharedBrowser.port`, launched on first
 *              use; every session that uses the tool shares its logins and tabs.
 *  - isolated: `--isolated`, a throwaway Chrome per session, no shared cookies.
 *  - none:     args passed as-is (servers that are not Chrome). */
export type LazyMcpBrowser = 'shared' | 'isolated' | 'none';

export interface LazyMcpSharedBrowser {
  port: number;
  userDataDir: string;
  chromePath: string;
}

export interface LazyMcpServer {
  enabled: boolean;
  command: string;
  args: string[];
  browser: LazyMcpBrowser;
  sharedBrowser: LazyMcpSharedBrowser;
}

export interface LazyMcpConfig {
  enabled: boolean;
  servers: Record<string, LazyMcpServer>;
}

/** Stored form: every key optional. In a PATCH, a server set to null is removed. */
export interface LazyMcpStored {
  enabled?: boolean;
  servers?: Record<string, Partial<Omit<LazyMcpServer, 'sharedBrowser'>> & { sharedBrowser?: Partial<LazyMcpSharedBrowser> } | null>;
}

const DEFAULT_SHARED_BROWSER: LazyMcpSharedBrowser = {
  port: 9222,
  userDataDir: '~/.cache/overlord-chrome',
  chromePath: process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome',
};

const DEFAULT_SERVER_TEMPLATE: LazyMcpServer = {
  enabled: true,
  command: '',
  args: [],
  browser: 'none',
  sharedBrowser: DEFAULT_SHARED_BROWSER,
};

export const LAZY_MCP_DEFAULTS: LazyMcpConfig = {
  enabled: false,
  servers: {
    'chrome-devtools': {
      enabled: true,
      command: 'chrome-devtools-mcp',
      args: ['--no-usage-statistics'],
      browser: 'shared',
      sharedBrowser: DEFAULT_SHARED_BROWSER,
    },
  },
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Field-by-field validation; anything invalid is dropped, not coerced. */
export function sanitizeLazyMcp(input: unknown): LazyMcpStored | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as Record<string, unknown>;
  const out: LazyMcpStored = {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (src.servers && typeof src.servers === 'object' && !Array.isArray(src.servers)) {
    const servers: NonNullable<LazyMcpStored['servers']> = {};
    for (const [name, raw] of Object.entries(src.servers as Record<string, unknown>)) {
      if (!NAME_RE.test(name)) continue;
      if (raw === null) { servers[name] = null; continue; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const s = raw as Record<string, unknown>;
      const srv: NonNullable<NonNullable<LazyMcpStored['servers']>[string]> = {};
      if (typeof s.enabled === 'boolean') srv.enabled = s.enabled;
      if (typeof s.command === 'string' && s.command.trim() !== '') srv.command = s.command.trim();
      if (Array.isArray(s.args) && s.args.every(a => typeof a === 'string')) srv.args = (s.args as string[]).slice(0, 64);
      if (s.browser === 'shared' || s.browser === 'isolated' || s.browser === 'none') srv.browser = s.browser;
      if (s.sharedBrowser && typeof s.sharedBrowser === 'object' && !Array.isArray(s.sharedBrowser)) {
        const b = s.sharedBrowser as Record<string, unknown>;
        const sb: Partial<LazyMcpSharedBrowser> = {};
        if (typeof b.port === 'number' && Number.isInteger(b.port) && b.port >= 1024 && b.port <= 65535) sb.port = b.port;
        if (typeof b.userDataDir === 'string' && b.userDataDir.trim() !== '') sb.userDataDir = b.userDataDir.trim();
        if (typeof b.chromePath === 'string' && b.chromePath.trim() !== '') sb.chromePath = b.chromePath.trim();
        if (Object.keys(sb).length > 0) srv.sharedBrowser = sb;
      }
      servers[name] = srv;
    }
    out.servers = servers;
  }
  return out;
}

/** Merges a sanitized PATCH into the stored value key by key, so the settings
 *  UI can send one field without clearing the rest. `null` removes a server. */
export function mergeLazyMcp(prev: LazyMcpStored | undefined, incoming: LazyMcpStored): LazyMcpStored {
  const next: LazyMcpStored = { ...prev };
  if (incoming.enabled !== undefined) next.enabled = incoming.enabled;
  if (incoming.servers) {
    const servers = { ...(prev?.servers ?? {}) };
    for (const [name, srv] of Object.entries(incoming.servers)) {
      // null drops the stored entry: a custom server disappears, a built-in
      // default returns to its defaults (built-ins are turned off with enabled).
      if (srv === null) { delete servers[name]; continue; }
      const before = servers[name] ?? {};
      servers[name] = {
        ...before,
        ...srv,
        ...(srv.sharedBrowser || before.sharedBrowser
          ? { sharedBrowser: { ...before.sharedBrowser, ...srv.sharedBrowser } }
          : {}),
      };
    }
    next.servers = servers;
  }
  return next;
}

/** Effective config: defaults overlaid with the stored partial. A stored server
 *  without a command (and no default to supply one) is skipped. */
export function resolveLazyMcp(stored: LazyMcpStored | undefined): LazyMcpConfig {
  const servers: Record<string, LazyMcpServer> = {};
  const names = new Set([...Object.keys(LAZY_MCP_DEFAULTS.servers), ...Object.keys(stored?.servers ?? {})]);
  for (const name of names) {
    const s = stored?.servers?.[name] ?? undefined;
    const base = LAZY_MCP_DEFAULTS.servers[name] ?? DEFAULT_SERVER_TEMPLATE;
    const merged: LazyMcpServer = {
      ...base,
      ...s,
      sharedBrowser: { ...base.sharedBrowser, ...s?.sharedBrowser },
    };
    if (!merged.command) continue;
    servers[name] = merged;
  }
  return { enabled: stored?.enabled ?? LAZY_MCP_DEFAULTS.enabled, servers };
}
