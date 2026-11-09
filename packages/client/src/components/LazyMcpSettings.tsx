import { useCallback, useEffect, useState } from 'react';
import type { GlobalSettings, LazyMcpBrowser, LazyMcpStored } from '../types';
import styles from './SettingsModal.module.css';

interface ServerStatus {
  enabled: boolean;
  browser: LazyMcpBrowser;
  cache: 'present' | 'missing';
  sessions: number;
  active: number;
  conflicts: string[];
}

interface Status {
  enabled: boolean;
  envDisabled: boolean;
  binary: { path: string; present: boolean };
  servers: Record<string, ServerStatus>;
}

const BROWSER_OPTIONS: { value: LazyMcpBrowser; label: string }[] = [
  { value: 'shared', label: 'Shared' },
  { value: 'isolated', label: 'Isolated' },
  { value: 'none', label: 'None' },
];

const BROWSER_HINT: Record<LazyMcpBrowser, string> = {
  shared: 'One Chrome on the port below, started on first use. Sessions share its logins (log into SSO once) and can see each other’s tabs.',
  isolated: 'Each session gets its own throwaway Chrome. No shared tabs, no shared logins.',
  none: 'Arguments are passed through unchanged. For servers that are not Chrome.',
};

interface Props {
  settings: GlobalSettings;
  onUpdate: (partial: Partial<GlobalSettings>) => void;
}

export function LazyMcpSettings({ settings, onUpdate }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [ports, setPorts] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    fetch('/api/lazy-mcp')
      .then(r => (r.ok ? r.json() : null))
      .then((s: Status | null) => { if (s) setStatus(s); })
      .catch(() => { /* server down — keep last status */ });
  }, []);

  // Re-read after every settings change: the status reflects the saved config.
  useEffect(() => { refresh(); }, [refresh, settings.lazyMcp]);

  const stored: LazyMcpStored = settings.lazyMcp ?? {};
  const enabled = stored.enabled === true;
  const patch = (lazyMcp: LazyMcpStored) => onUpdate({ lazyMcp });
  const patchServer = (name: string, partial: NonNullable<LazyMcpStored['servers']>[string]) =>
    patch({ servers: { [name]: partial } });

  return (
    <>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>Start MCP servers on first use</div>
          <div className={styles.rowHint}>
            Sessions Overlord starts get these servers through a small stand-in that answers the tool
            list from a cache. The real server starts only when the session first calls one of its
            tools, one per session. Applies to sessions started or resumed after the change.
          </div>
        </div>
        <button
          className={`${styles.toggle} ${enabled ? styles.toggleOn : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Start MCP servers on first use"
          onClick={() => patch({ enabled: !enabled })}
        />
      </div>

      {status?.envDisabled && (
        <div className={styles.note}>
          <div className={styles.noteTitle}>Turned off by environment</div>
          <div className={styles.noteFoot}><code>OVERLORD_LAZY_MCP=0</code> is set for the server, so this setting has no effect.</div>
        </div>
      )}
      {status && !status.binary.present && (
        <div className={styles.note}>
          <div className={styles.noteTitle}>Stand-in not built</div>
          <div className={styles.noteFoot}>
            Sessions start without it until you run{' '}
            <code>cd packages/lazy-mcp &amp;&amp; go build -o overlord-lazy-mcp .</code>
          </div>
        </div>
      )}

      {status && Object.entries(status.servers).map(([name, s]) => {
        const sharedPort = String(stored.servers?.[name]?.sharedBrowser?.port ?? 9223);
        const portDraft = ports[name] ?? sharedPort;
        const commitPort = () => {
          const n = Number(portDraft);
          if (Number.isInteger(n) && n >= 1024 && n <= 65535 && String(n) !== sharedPort) {
            patchServer(name, { sharedBrowser: { port: n } });
          } else {
            setPorts(p => ({ ...p, [name]: sharedPort }));
          }
        };
        return (
          <div key={name} className={styles.subgroup}>
            <h4 className={styles.subgroupTitle}>{name}</h4>
            <p className={styles.subgroupHint}>
              {s.sessions === 0
                ? 'No running session uses the stand-in yet.'
                : `${s.sessions} session${s.sessions === 1 ? '' : 's'} with the stand-in, ${s.active} with the real server started.`}
              {' '}Tool list cache: {s.cache === 'present' ? 'saved' : 'built by the first session'}.
            </p>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>Use the stand-in for {name}</div>
              </div>
              <button
                className={`${styles.toggle} ${s.enabled ? styles.toggleOn : ''}`}
                role="switch"
                aria-checked={s.enabled}
                aria-label={`Use the stand-in for ${name}`}
                onClick={() => patchServer(name, { enabled: !s.enabled })}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>Browser</div>
                <div className={styles.rowHint}>{BROWSER_HINT[s.browser]}</div>
              </div>
              <div className={styles.segmented} role="radiogroup" aria-label={`${name} browser`}>
                {BROWSER_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    className={`${styles.segmentBtn} ${s.browser === o.value ? styles.segmentBtnActive : ''}`}
                    role="radio"
                    aria-checked={s.browser === o.value}
                    onClick={() => patchServer(name, { browser: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {s.browser === 'shared' && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Shared Chrome port</span>
                <span className={styles.fieldHint}>
                  Remote debugging port. If a debuggable Chrome already answers there, it is used as is.
                </span>
                <input
                  className={`${styles.input} ${styles.inputNarrow}`}
                  type="number"
                  min={1024}
                  max={65535}
                  value={portDraft}
                  onChange={e => setPorts(p => ({ ...p, [name]: e.target.value }))}
                  onBlur={commitPort}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            )}

            {enabled && s.enabled && s.conflicts.length > 0 && (
              <div className={styles.note}>
                <div className={styles.noteTitle}>Also defined in ~/.claude.json</div>
                <ul className={styles.noteList}>
                  {s.conflicts.map(where => (
                    <li key={where}>{where === 'global' ? <strong>global mcpServers</strong> : where}</li>
                  ))}
                </ul>
                <div className={styles.noteFoot}>
                  Sessions Overlord starts use the stand-in in place of that entry. Sessions started
                  elsewhere keep using the entry, so leaving it there is fine.
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
