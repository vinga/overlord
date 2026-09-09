import React, { useEffect, useMemo, useState } from 'react';
import type { GlobalSettings } from '../types';
import { useDockMode, type DockMode } from '../hooks/useOrientation';
import { resolveVoiceConfig, type VoiceInputConfig } from '../lib/voiceConfig';
import styles from './SettingsModal.module.css';

interface Props {
  settings: GlobalSettings;
  onUpdate: (partial: Partial<GlobalSettings>) => void;
  onClose: () => void;
}

type PageId =
  | 'general'
  | 'general.startup'
  | 'general.layout'
  | 'general.conversation'
  | 'general.voice'
  | 'ai'
  | 'ai.intent'
  | 'integrations'
  | 'integrations.jira';

interface TreeNode {
  id: PageId;
  label: string;
  /** Extra search terms so the sidebar filter finds a page by what it controls. */
  keywords: string;
  children?: TreeNode[];
}

const TREE: TreeNode[] = [
  {
    id: 'general',
    label: 'General',
    keywords: 'general basics',
    children: [
      { id: 'general.startup', label: 'Startup & Resume', keywords: 'auto resume restart respawn terminal pty boot' },
      { id: 'general.layout', label: 'Layout', keywords: 'layout dock panel bottom right side portrait landscape vertical monitor orientation split chat rooms' },
      { id: 'general.conversation', label: 'Conversation', keywords: 'sticky pinned user message feed prompt header detail panel' },
      { id: 'general.voice', label: 'Voice', keywords: 'voice mic microphone dictation speech stt start word stop word wake hands free language' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    keywords: 'ai llm model background queries',
    children: [
      { id: 'ai.intent', label: 'Intent Summaries', keywords: 'intent summary haiku background llm worker card label cost quiet' },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: 'integrations external services',
    children: [
      { id: 'integrations.jira', label: 'JIRA', keywords: 'jira atlassian ticket chip issue api token email base url project keys' },
    ],
  },
];

const PAGE_KEY = 'overlord.settings.page';
const DEFAULT_PAGE: PageId = 'general.startup';

const ALL_IDS = new Set<string>(
  TREE.flatMap(n => [n.id as string, ...(n.children ?? []).map(c => c.id as string)])
);

function findNode(id: PageId): { node: TreeNode; parent?: TreeNode } | null {
  for (const top of TREE) {
    if (top.id === id) return { node: top };
    for (const child of top.children ?? []) {
      if (child.id === id) return { node: child, parent: top };
    }
  }
  return null;
}

export function SettingsModal({ settings, onUpdate, onClose }: Props) {
  const [dockMode, setDockMode] = useDockMode();
  const voice = resolveVoiceConfig(settings.voiceInput);
  const [startWord, setLocalStartWord] = useState(voice.startWord);
  const [stopWord, setLocalStopWord] = useState(voice.stopWord);
  const [cancelWord, setLocalCancelWord] = useState(voice.cancelWord);
  const [voiceLang, setLocalVoiceLang] = useState(voice.lang);

  const [jiraBaseUrl, setLocalJiraBaseUrl] = useState(settings.jiraBaseUrl ?? '');
  const [jiraProjects, setLocalJiraProjects] = useState(settings.jiraProjects ?? '');
  const [jiraEmail, setLocalJiraEmail] = useState(settings.jiraEmail ?? '');
  const [jiraApiToken, setLocalJiraApiToken] = useState(settings.jiraApiToken ?? '');

  const [page, setPage] = useState<PageId>(() => {
    try {
      const saved = localStorage.getItem(PAGE_KEY);
      if (saved && ALL_IDS.has(saved)) return saved as PageId;
    } catch { /* storage unavailable */ }
    return DEFAULT_PAGE;
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    try { localStorage.setItem(PAGE_KEY, page); } catch { /* storage unavailable */ }
  }, [page]);

  useEffect(() => { setLocalStartWord(voice.startWord); }, [voice.startWord]);
  useEffect(() => { setLocalStopWord(voice.stopWord); }, [voice.stopWord]);
  useEffect(() => { setLocalCancelWord(voice.cancelWord); }, [voice.cancelWord]);
  useEffect(() => { setLocalVoiceLang(voice.lang); }, [voice.lang]);

  useEffect(() => { setLocalJiraBaseUrl(settings.jiraBaseUrl ?? ''); }, [settings.jiraBaseUrl]);
  useEffect(() => { setLocalJiraProjects(settings.jiraProjects ?? ''); }, [settings.jiraProjects]);
  useEffect(() => { setLocalJiraEmail(settings.jiraEmail ?? ''); }, [settings.jiraEmail]);
  useEffect(() => { setLocalJiraApiToken(settings.jiraApiToken ?? ''); }, [settings.jiraApiToken]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Absent in settings.json written before the setting existed → treat as on.
  const stickyOn = settings.showStickyUserMessage !== false;
  const intentOn = !settings.disableBackgroundLLM;

  // The server rejects a word that collides with the other two; showing that
  // inline beats letting the value silently snap back on the next snapshot.
  const wordCollision = (which: 'start' | 'stop' | 'cancel', value: string): string | null => {
    const parts = value.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0) return 'Cannot be empty';
    const others = {
      start: [stopWord, cancelWord],
      stop: [startWord, cancelWord],
      cancel: [startWord, stopWord],
    }[which].flatMap(w => w.split(',').map(x => x.trim().toLowerCase())).filter(Boolean);
    const clash = parts.find(p => others.includes(p));
    return clash ? `"${clash}" is already used by another word` : null;
  };

  const patchVoice = (partial: Partial<VoiceInputConfig>) =>
    onUpdate({ voiceInput: { ...settings.voiceInput, ...partial } });

  const commitWord = (which: 'start' | 'stop' | 'cancel', value: string) => {
    if (wordCollision(which, value)) return;
    const key = which === 'start' ? 'startWord' : which === 'stop' ? 'stopWord' : 'cancelWord';
    if (value.trim().toLowerCase() !== voice[key]) patchVoice({ [key]: value });
  };

  const commitJiraBaseUrl = () => {
    if (jiraBaseUrl !== (settings.jiraBaseUrl ?? '')) onUpdate({ jiraBaseUrl });
  };
  const commitJiraProjects = () => {
    if (jiraProjects !== (settings.jiraProjects ?? '')) onUpdate({ jiraProjects });
  };
  const commitJiraEmail = () => {
    if (jiraEmail !== (settings.jiraEmail ?? '')) onUpdate({ jiraEmail });
  };
  const commitJiraApiToken = () => {
    // "***" is the masked value sent by the server when a token is set;
    // ignore it so blurring without typing doesn't wipe the token.
    if (jiraApiToken !== '***' && jiraApiToken !== (settings.jiraApiToken ?? '')) {
      onUpdate({ jiraApiToken });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TREE;
    const hit = (n: TreeNode) => `${n.label} ${n.keywords}`.toLowerCase().includes(q);
    const out: TreeNode[] = [];
    for (const top of TREE) {
      if (hit(top)) { out.push(top); continue; }
      const kids = (top.children ?? []).filter(hit);
      if (kids.length) out.push({ ...top, children: kids });
    }
    return out;
  }, [query]);

  const searching = query.trim().length > 0;
  const located = findNode(page);
  const crumbs = located
    ? ([located.parent?.label, located.node.label].filter(Boolean) as string[])
    : ['Settings'];

  function renderLeaf(id: PageId): React.ReactNode {
    switch (id) {
      case 'general.startup':
        return (
          <ToggleRow
            label="Auto-resume sessions after restart"
            hint="Respawn sessions that had a live terminal when the Overlord server stopped. A clean stop records the live set; a reboot or kill -9 falls back to the 15s live-pty heartbeat."
            on={settings.autoResumeOnRestart}
            onToggle={() => onUpdate({ autoResumeOnRestart: !settings.autoResumeOnRestart })}
          />
        );

      case 'general.layout': {
        const dockOptions: { value: DockMode; label: string }[] = [
          { value: 'auto', label: 'Auto' },
          { value: 'right', label: 'Right' },
          { value: 'bottom', label: 'Bottom' },
        ];
        return (
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>Detail panel dock</div>
              <div className={styles.rowHint}>
                Where the session panel opens. Auto docks it to the bottom on portrait (vertical)
                monitors and to the right on landscape. Stored per browser, not synced.
              </div>
            </div>
            <div className={styles.segmented} role="radiogroup" aria-label="Detail panel dock">
              {dockOptions.map(o => (
                <button
                  key={o.value}
                  className={`${styles.segmentBtn} ${dockMode === o.value ? styles.segmentBtnActive : ''}`}
                  role="radio"
                  aria-checked={dockMode === o.value}
                  onClick={() => setDockMode(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      }

      case 'general.conversation':
        return (
          <ToggleRow
            label="Pin your message above the conversation"
            hint="Keeps the prompt that started the current stretch of the feed visible at the top while the agent works. Hidden when the message is already on screen."
            on={stickyOn}
            onToggle={() => onUpdate({ showStickyUserMessage: !stickyOn })}
          />
        );

      case 'general.voice':
        return (
          <>
            <ToggleRow
              label="Hands-free voice control"
              hint={'Say the start word, speak, then say the stop word. Nothing is sent until the stop word — silence never commits.'}
              on={voice.enabled}
              onToggle={() => patchVoice({ enabled: !voice.enabled })}
            />

            <div className={styles.subgroup}>
              <h4 className={styles.subgroupTitle}>Words</h4>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Start word</span>
                <span className={styles.fieldHint}>
                  Opens capture. Nothing you say is acted on until this is heard. Close
                  mishearings are accepted automatically (<code>over lord</code>, <code>overload</code>).
                  If your engine renders it some other way, add that spelling here as a
                  comma-separated alternative — the pill shows what it actually heard.
                </span>
                <input
                  className={styles.input}
                  type="text"
                  value={startWord}
                  onChange={(e) => setLocalStartWord(e.target.value)}
                  onBlur={() => commitWord('start', startWord)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {wordCollision('start', startWord) && (
                  <span className={styles.fieldHint}>{wordCollision('start', startWord)}</span>
                )}
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Stop word</span>
                <span className={styles.fieldHint}>
                  Sends what you said. Counted only when spoken on its own after a short pause, so
                  &ldquo;{stopWord.split(',')[0].trim()} ahead and fix it&rdquo; does not send. A phrase that
                  never ends a real instruction is safest — <code>over and out</code> or
                  <code>execute</code>. Comma-separated alternatives are allowed here too.
                </span>
                <input
                  className={styles.input}
                  type="text"
                  value={stopWord}
                  onChange={(e) => setLocalStopWord(e.target.value)}
                  onBlur={() => commitWord('stop', stopWord)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {wordCollision('stop', stopWord) && (
                  <span className={styles.fieldHint}>{wordCollision('stop', stopWord)}</span>
                )}
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Cancel word</span>
                <span className={styles.fieldHint}>Throws away the utterance in flight. Same rule as the stop word.</span>
                <input
                  className={styles.input}
                  type="text"
                  value={cancelWord}
                  onChange={(e) => setLocalCancelWord(e.target.value)}
                  onBlur={() => commitWord('cancel', cancelWord)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {wordCollision('cancel', cancelWord) && (
                  <span className={styles.fieldHint}>{wordCollision('cancel', cancelWord)}</span>
                )}
              </label>
            </div>

            <div className={styles.subgroup}>
              <h4 className={styles.subgroupTitle}>Addressing</h4>
              <ToggleRow
                label="Let a worker's name open capture"
                hint="Saying a worker's name works like the start word and targets that worker. With this off, only the start word opens capture and the open worker always receives."
                on={voice.wakeOnWorkerName}
                onToggle={() => patchVoice({ wakeOnWorkerName: !voice.wakeOnWorkerName })}
              />
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Language</span>
                <span className={styles.fieldHint}>
                  BCP-47 tag handed to the recognizer, e.g. <code>en-US</code>, <code>pl-PL</code>. Overridable per worker.
                </span>
                <input
                  className={styles.input}
                  type="text"
                  value={voiceLang}
                  onChange={(e) => setLocalVoiceLang(e.target.value)}
                  onBlur={() => { if (voiceLang.trim() !== voice.lang) patchVoice({ lang: voiceLang.trim() }); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            </div>

            <div className={styles.subgroup}>
              <h4 className={styles.subgroupTitle}>Limits</h4>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Discard an unfinished utterance after</span>
                <span className={styles.fieldHint}>
                  Seconds. If the stop word never comes, what you said is thrown away — never sent.
                </span>
                <input
                  className={styles.input}
                  type="number"
                  min={5}
                  max={120}
                  value={Math.round(voice.maxUtteranceMs / 1000)}
                  onChange={(e) => {
                    const secs = Number(e.target.value);
                    if (Number.isFinite(secs)) patchVoice({ maxUtteranceMs: secs * 1000 });
                  }}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Name match confidence</span>
                <span className={styles.fieldHint}>
                  0.5–1.0. How close a spoken name must be for <code>select</code> / <code>open</code> to accept it.
                  Below the bar Overlord refuses rather than guessing.
                </span>
                <input
                  className={styles.input}
                  type="number"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={voice.nameMatchFloor}
                  onChange={(e) => {
                    const f = Number(e.target.value);
                    if (Number.isFinite(f)) patchVoice({ nameMatchFloor: f });
                  }}
                />
              </label>
            </div>

            <div className={styles.note}>
              <div className={styles.noteTitle}>What to expect</div>
              <ul className={styles.noteList}>
                <li>Speech is recognized by <strong>Chrome&apos;s Web Speech API</strong>, which streams
                    microphone audio to Google while capture is running. Nothing is sent to the Overlord server.</li>
                <li>Stopping is the only way to release the microphone — use the pill or <code>Alt+M</code>.</li>
                <li><code>Esc</code> throws away an utterance in flight; so does the cancel word.</li>
                <li>Speaking at a busy worker is fine — its own prompt buffers the text until it is free.</li>
                <li>A lone command word acts (<code>stop</code>, <code>yes</code>, <code>escape</code>,
                    <code>select &lt;name&gt;</code>); anything longer is sent as a prompt.</li>
              <li>The pill prints, in dim italics, whatever the engine returned while no start
                  word matched — use it to find the spelling to add above.</li>
              </ul>
              <div className={styles.noteFoot}>
                Requires Chrome. Other browsers hide this feature entirely.
              </div>
            </div>
          </>
        );

      case 'ai.intent':
        return (
          <>
            <ToggleRow
              label="Enable background AI intent queries"
              hint="Lets Overlord run Haiku queries to label sessions with a rolling intent summary. Worker cards show what each session is working on. Turn off to be cheaper and quieter."
              on={intentOn}
              onToggle={() => onUpdate({ disableBackgroundLLM: !settings.disableBackgroundLLM })}
            />
            <div className={styles.note}>
              <div className={styles.noteTitle}>How the summary is produced</div>
              <ul className={styles.noteList}>
                <li>Regenerated after every <strong>5 new user turns</strong>, 2s after transcript activity settles.</li>
                <li>Reads the last 5–8 user messages from the transcript tail — never assistant output or file contents.</li>
                <li>Output is capped at one line of 60 characters; anything longer is discarded.</li>
                <li>Summaries persist per session and survive a server restart.</li>
              </ul>
              <div className={styles.noteFoot}>
                This switch is global — there is no per-room or per-session override. Turning it off stops new
                queries immediately; intents already generated stay on their cards.
              </div>
            </div>
          </>
        );

      case 'integrations.jira':
        return (
          <>
            <div className={styles.subgroup}>
              <h4 className={styles.subgroupTitle}>Chip detection &amp; links</h4>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Base URL</span>
                <span className={styles.fieldHint}>
                  Used to build chip links: <code>&lt;baseUrl&gt;/browse/PROJ-123</code>. Leave empty to render keys as plain (non-link) chips.
                </span>
                <input
                  className={styles.input}
                  type="url"
                  placeholder="https://your-org.atlassian.net"
                  value={jiraBaseUrl}
                  onChange={(e) => setLocalJiraBaseUrl(e.target.value)}
                  onBlur={commitJiraBaseUrl}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Project keys</span>
                <span className={styles.fieldHint}>
                  Comma-separated project prefixes (e.g. <code>PROJ,PE,API</code>). Required — chips only render for these prefixes. Leave empty to disable chips entirely.
                </span>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="PROJ,PE,API"
                  value={jiraProjects}
                  onChange={(e) => setLocalJiraProjects(e.target.value)}
                  onBlur={commitJiraProjects}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            </div>

            <div className={styles.subgroup}>
              <h4 className={styles.subgroupTitle}>Issue titles (optional)</h4>
              <p className={styles.subgroupHint}>
                When both fields are set, the server fetches each chip&apos;s summary.
              </p>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Atlassian email</span>
                <input
                  className={styles.input}
                  type="email"
                  placeholder="you@example.com"
                  value={jiraEmail}
                  onChange={(e) => setLocalJiraEmail(e.target.value)}
                  onBlur={commitJiraEmail}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>API token</span>
                <span className={styles.fieldHint}>
                  Create one at <code>id.atlassian.com/manage-profile/security/api-tokens</code>. Stored server-side; never returned to the browser.
                </span>
                <input
                  className={styles.input}
                  type="password"
                  placeholder={settings.jiraApiToken ? '••• set •••' : ''}
                  value={jiraApiToken === '***' ? '' : jiraApiToken}
                  onChange={(e) => setLocalJiraApiToken(e.target.value)}
                  onBlur={commitJiraApiToken}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  autoComplete="off"
                />
              </label>
            </div>
          </>
        );

      default:
        return null;
    }
  }

  function renderPage(id: PageId): React.ReactNode {
    const found = findNode(id);
    if (!found) return null;
    const { node } = found;
    if (!node.children?.length) return renderLeaf(id);
    // Parent page: stack every child section, IntelliJ-style overview.
    return (
      <>
        {node.children.map(child => (
          <section key={child.id} className={styles.groupSection}>
            <button className={styles.groupHeading} onClick={() => setPage(child.id)}>
              {child.label}
            </button>
            {renderLeaf(child.id)}
          </section>
        ))}
      </>
    );
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.content}>
          <nav className={styles.sidebar} aria-label="Settings sections">
            <div className={styles.searchWrap}>
              <span className={styles.searchIcon} aria-hidden="true">⌕</span>
              <input
                className={styles.search}
                type="text"
                placeholder="Filter settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                aria-label="Filter settings"
              />
            </div>
            <div className={styles.tree} role="tree">
              {filtered.length === 0 && <div className={styles.treeEmpty}>No matching settings</div>}
              {filtered.map(top => {
                const isCollapsed = !searching && collapsed.has(top.id);
                return (
                  <div key={top.id} className={styles.treeGroup}>
                    <div
                      className={`${styles.treeRow} ${styles.treeRowTop} ${page === top.id ? styles.treeRowActive : ''}`}
                      role="treeitem"
                      aria-expanded={!isCollapsed}
                      aria-selected={page === top.id}
                      tabIndex={0}
                      onClick={() => setPage(top.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPage(top.id); } }}
                    >
                      <button
                        className={`${styles.chevron} ${isCollapsed ? styles.chevronCollapsed : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsed(prev => {
                            const next = new Set(prev);
                            if (next.has(top.id)) next.delete(top.id); else next.add(top.id);
                            return next;
                          });
                        }}
                        aria-label={isCollapsed ? `Expand ${top.label}` : `Collapse ${top.label}`}
                        tabIndex={-1}
                      >
                        ▾
                      </button>
                      <span className={styles.treeLabel}>{top.label}</span>
                    </div>
                    {!isCollapsed && (top.children ?? []).map(child => (
                      <div
                        key={child.id}
                        className={`${styles.treeRow} ${styles.treeRowChild} ${page === child.id ? styles.treeRowActive : ''}`}
                        role="treeitem"
                        aria-selected={page === child.id}
                        tabIndex={0}
                        onClick={() => setPage(child.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPage(child.id); } }}
                      >
                        <span className={styles.treeLabel}>{child.label}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </nav>

          <div className={styles.pane}>
            <div className={styles.paneHeader}>
              <div className={styles.crumbs}>
                {crumbs.map((c, i) => (
                  <React.Fragment key={c}>
                    {i > 0 && <span className={styles.crumbSep}>›</span>}
                    <span className={i === crumbs.length - 1 ? styles.crumbCurrent : styles.crumb}>{c}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div className={styles.paneBody}>{renderPage(page)}</div>
          </div>
        </div>

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            Changes save immediately to <code>~/.claude/overlord/settings.json</code>
          </span>
          <button className={styles.doneButton} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, on, onToggle }: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowHint}>{hint}</div>
      </div>
      <button
        className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        aria-label={label}
      />
    </div>
  );
}
