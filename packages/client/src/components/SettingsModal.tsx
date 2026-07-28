import React, { useEffect, useState } from 'react';
import type { GlobalSettings } from '../types';
import styles from './SettingsModal.module.css';

interface Props {
  settings: GlobalSettings;
  onUpdate: (partial: Partial<GlobalSettings>) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, onUpdate, onClose }: Props) {
  const [jiraBaseUrl, setLocalJiraBaseUrl] = useState(settings.jiraBaseUrl ?? '');
  const [jiraProjects, setLocalJiraProjects] = useState(settings.jiraProjects ?? '');
  const [jiraEmail, setLocalJiraEmail] = useState(settings.jiraEmail ?? '');
  const [jiraApiToken, setLocalJiraApiToken] = useState(settings.jiraApiToken ?? '');

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

  const commitJiraBaseUrl = () => {
    if (jiraBaseUrl !== (settings.jiraBaseUrl ?? '')) {
      onUpdate({ jiraBaseUrl });
    }
  };
  const commitJiraProjects = () => {
    if (jiraProjects !== (settings.jiraProjects ?? '')) {
      onUpdate({ jiraProjects });
    }
  };
  const commitJiraEmail = () => {
    if (jiraEmail !== (settings.jiraEmail ?? '')) {
      onUpdate({ jiraEmail });
    }
  };
  const commitJiraApiToken = () => {
    // "***" is the masked value sent by the server when a token is set;
    // ignore it so blurring without typing doesn't wipe the token.
    if (jiraApiToken !== '***' && jiraApiToken !== (settings.jiraApiToken ?? '')) {
      onUpdate({ jiraApiToken });
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.body}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>Enable background AI intent queries</div>
              <div className={styles.rowHint}>
                Lets Overlord run Haiku queries to label sessions with a rolling intent summary. Worker cards will show what each session is working on. Turn off to be cheaper and quieter.
              </div>
            </div>
            <button
              className={`${styles.toggle} ${!settings.disableBackgroundLLM ? styles.toggleOn : ''}`}
              onClick={() => onUpdate({ disableBackgroundLLM: !settings.disableBackgroundLLM })}
              role="switch"
              aria-checked={!settings.disableBackgroundLLM}
              aria-label="Enable background AI intent queries"
            />
          </div>

          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>Auto-resume sessions after restart</div>
              <div className={styles.rowHint}>
                Respawn sessions that had a live terminal when the Overlord server stopped. Applies to clean restarts only; crashed servers don't record what was running.
              </div>
            </div>
            <button
              className={`${styles.toggle} ${settings.autoResumeOnRestart ? styles.toggleOn : ''}`}
              onClick={() => onUpdate({ autoResumeOnRestart: !settings.autoResumeOnRestart })}
              role="switch"
              aria-checked={settings.autoResumeOnRestart}
              aria-label="Auto-resume sessions after restart"
            />
          </div>

          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>Pin your message above the conversation</div>
              <div className={styles.rowHint}>
                Keeps the prompt that started the current stretch of the feed visible at the top while the agent works. Hidden when the message is already on screen.
              </div>
            </div>
            <button
              className={`${styles.toggle} ${stickyOn ? styles.toggleOn : ''}`}
              onClick={() => onUpdate({ showStickyUserMessage: !stickyOn })}
              role="switch"
              aria-checked={stickyOn}
              aria-label="Pin your message above the conversation"
            />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>JIRA</h3>
            </div>

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
                When both fields are set, the server fetches each chip's summary.
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
          </div>
        </div>
      </div>
    </div>
  );
}
