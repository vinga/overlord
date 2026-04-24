import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GlobalSettings {
  disableBackgroundLLM: boolean;
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
  return out;
}

function shallowEqual(a: GlobalSettings, b: GlobalSettings): boolean {
  return a.disableBackgroundLLM === b.disableBackgroundLLM;
}

export const globalSettingsStore = new GlobalSettingsStore();
