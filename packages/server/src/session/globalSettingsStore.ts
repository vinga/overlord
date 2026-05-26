import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GlobalSettings {
  disableBackgroundLLM: boolean;
  /** Root URL of the JIRA instance, e.g. "https://hypatos.atlassian.net".
   *  Used to build chip links: `${jiraBaseUrl}/browse/PROJ-123`. */
  jiraBaseUrl?: string;
  /** Comma-separated allowlist of project key prefixes (e.g. "PROJ,PE,API").
   *  When empty, every regex match is kept (after marker / denylist filters). */
  jiraProjects?: string;
  /** Atlassian account email — paired with jiraApiToken for Basic auth.
   *  When set, the server fetches issue summaries for the keys it shows. */
  jiraEmail?: string;
  /** Atlassian API token. Never returned in /api/settings — clients see "***"
   *  when set, "" when unset. PATCHing "***" leaves the value untouched. */
  jiraApiToken?: string;
}

const DEFAULTS: GlobalSettings = {
  disableBackgroundLLM: false,
};

const SETTINGS_DIR = path.join(os.homedir(), '.claude', 'overlord');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

type Listener = (settings: GlobalSettings, prev: GlobalSettings) => void;

class GlobalSettingsStore {
  private cache: GlobalSettings = { ...DEFAULTS };
  private loaded = false;
  private listeners = new Set<Listener>();

  load(): GlobalSettings {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Partial<GlobalSettings>;
        this.cache = { ...DEFAULTS, ...sanitize(raw) };
      }
    } catch {
      this.cache = { ...DEFAULTS };
    }
    this.loaded = true;
    return this.cache;
  }

  get(): GlobalSettings {
    if (!this.loaded) this.load();
    return this.cache;
  }

  patch(partial: Partial<GlobalSettings>): GlobalSettings {
    if (!this.loaded) this.load();
    const prev = this.cache;
    const next: GlobalSettings = { ...prev, ...sanitize(partial) };
    if (shallowEqual(prev, next)) return prev;
    this.cache = next;
    this.persist();
    for (const l of this.listeners) {
      try { l(next, prev); } catch { /* ignore */ }
    }
    return next;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    try {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
      const tmp = `${SETTINGS_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      fs.renameSync(tmp, SETTINGS_PATH);
    } catch (err) {
      console.warn('[settings] failed to persist:', (err as Error).message);
    }
  }
}

function sanitize(input: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const out: Partial<GlobalSettings> = {};
  if (typeof input.disableBackgroundLLM === 'boolean') out.disableBackgroundLLM = input.disableBackgroundLLM;
  if (typeof input.jiraBaseUrl === 'string') {
    const trimmed = input.jiraBaseUrl.trim().replace(/\/+$/, '');
    if (trimmed === '' || /^https?:\/\//i.test(trimmed)) {
      out.jiraBaseUrl = trimmed;
    }
    // non-http(s) values silently dropped
  }
  if (typeof input.jiraProjects === 'string') {
    out.jiraProjects = input.jiraProjects.trim();
  }
  if (typeof input.jiraEmail === 'string') {
    out.jiraEmail = input.jiraEmail.trim();
  }
  if (typeof input.jiraApiToken === 'string') {
    out.jiraApiToken = input.jiraApiToken.trim();
  }
  return out;
}

function shallowEqual(a: GlobalSettings, b: GlobalSettings): boolean {
  return a.disableBackgroundLLM === b.disableBackgroundLLM
    && (a.jiraBaseUrl ?? '') === (b.jiraBaseUrl ?? '')
    && (a.jiraProjects ?? '') === (b.jiraProjects ?? '')
    && (a.jiraEmail ?? '') === (b.jiraEmail ?? '')
    && (a.jiraApiToken ?? '') === (b.jiraApiToken ?? '');
}

export const globalSettingsStore = new GlobalSettingsStore();
