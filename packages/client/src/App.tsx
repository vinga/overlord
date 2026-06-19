import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOfficeData } from './hooks/useOfficeData';
import { useTerminal } from './hooks/useTerminal';
import { useCustomNames } from './hooks/useCustomNames';
import { useRoomOrder } from './hooks/useRoomOrder';
import { setJiraBaseUrl } from './hooks/useJiraBaseUrl';
import { setJiraMeta } from './hooks/useJiraMeta';

import type { ArchiveEntry, Session, SessionProvider, TerminalMessage, TerminalSpawnMode } from './types';
import { Office } from './components/Office';
import { DetailPanel } from './components/DetailPanel';
import { PtyTerminalPanel } from './components/PtyTerminalPanel';
import { TaskListPanel } from './components/TaskListPanel';
import { LogsPage } from './components/LogsPage';
import { DirectoryPickerDialog } from './components/DirectoryPickerDialog';
import { AdvancedSearchPopup } from './components/AdvancedSearchPopup';
import { SettingsModal } from './components/SettingsModal';
import type { GlobalSettings } from './types';
import { SESSION_NAMES } from './components/Room';
import type { Room } from './types';

function StatsModal({ onClose }: { onClose: () => void }) {
  const [json, setJson] = useState<string>('Loading…');

  useEffect(() => {
    fetch('/api/stats')
      .then(r => r.json())
      .then(data => setJson(JSON.stringify(data, null, 2)))
      .catch(e => setJson(String(e)));
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg, #18181b)', border: '1px solid var(--border, #333)', borderRadius: 10, padding: '20px 24px', width: 520, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Stats</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.5, fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <textarea
          readOnly
          value={json}
          style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-secondary, #111)', border: '1px solid var(--border, #333)', borderRadius: 6, padding: '10px 12px', resize: 'vertical', minHeight: 320, color: 'inherit', width: '100%', boxSizing: 'border-box' }}
        />
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<'office' | 'logs'>(() => {
    return window.location.hash.startsWith('#logs') ? 'logs' : 'office';
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#session\/([^/]+)/);
    return m ? m[1] : null;
  });
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>(() => {
    const m = window.location.hash.match(/^#session\/[^/]+\/([^/]+)/);
    return m ? m[1] : undefined;
  });
  const [activePtySessionId, setActivePtySessionId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ sessionId: string; timestamp: string; query?: string } | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [pendingSpawnName, setPendingSpawnName] = useState('');
  const [spawnCwd, setSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnCwd, setTerminalSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnMode, setTerminalSpawnMode] = useState<TerminalSpawnMode>('bridge');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [archivedSession, setArchivedSession] = useState<Session | null>(null);
  const [dirPickerSuggestedName, setDirPickerSuggestedName] = useState('');
  const [pendingSpawns, setPendingSpawns] = useState<Array<{ id: string; cwd: string; fullName: string; startedAt: number }>>([]);
  const { rename, migrateSession: migrateNames, pendingRenames, reconcilePendingRenames } = useCustomNames();
  const { migrateSession: migrateRoomOrder } = useRoomOrder();

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = localStorage.getItem('overlord:panelWidth');
    const maxWidth = Math.max(900, window.innerWidth - 80);
    return saved ? Math.max(320, Math.min(maxWidth, parseInt(saved, 10))) : 680;
  });

  // Use a ref so the WS handler always sees the latest terminal message handler,
  // with zero render-cycle delay (avoids losing terminal:spawned on fast responses)
  const terminalHandlerRef = useRef<((msg: TerminalMessage) => void) | null>(null);
  const handleTerminalMessageStable = useCallback((msg: TerminalMessage) => {
    terminalHandlerRef.current?.(msg);
  }, []); // stable — no deps needed, reads ref at call time

  const handleSessionReplaced = useCallback((oldId: string, newId: string) => {
    // ovrId is stable across /clear — no need to migrate selectedSessionId.
    // Transfer custom name and room order (keyed by Claude UUID) to the new session ID.
    migrateNames(oldId, newId);
    migrateRoomOrder(oldId, newId);
  }, [migrateNames, migrateRoomOrder]);

  const { snapshot, connected, connecting, sendMessage } = useOfficeData(handleTerminalMessageStable, { onSessionReplaced: handleSessionReplaced });
  const terminal = useTerminal(sendMessage, (id) => setActivePtySessionId(id));

  useEffect(() => {
    setJiraBaseUrl(snapshot?.settings?.jiraBaseUrl);
  }, [snapshot?.settings?.jiraBaseUrl]);

  useEffect(() => {
    setJiraMeta(snapshot?.jiraMeta);
  }, [snapshot?.jiraMeta]);

  const snapshotBridgeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const room of snapshot?.rooms ?? []) {
      for (const s of room.sessions) {
        if (s.sessionType === 'bridge') ids.add(s.overlordId ?? s.sessionId);
      }
    }
    return ids;
  }, [snapshot]);

  const isBridgeSession = useCallback(
    (ovrId: string) => terminal.isBridgeSession(ovrId) || snapshotBridgeIds.has(ovrId),
    [terminal, snapshotBridgeIds]
  );

  // Display names come from OverlordSession.proposedName via the snapshot,
  // with a short-lived optimistic overlay (`pendingRenames`) so the title
  // doesn't flicker back to the old name between the PUT and the next snapshot.
  // Empty pending value = the user cleared the name; we override with slug/
  // shortId so the stale proposedName fallback doesn't briefly resurface.
  const displayNames = useMemo(() => {
    const names: Record<string, string> = {};
    const sessionById: Record<string, { slug?: string; sessionId: string }> = {};
    if (snapshot) {
      for (const room of snapshot.rooms) {
        for (const s of room.sessions) {
          if (s.proposedName) names[s.sessionId] = s.proposedName;
          sessionById[s.sessionId] = s;
        }
      }
    }
    for (const [sid, name] of Object.entries(pendingRenames)) {
      if (name) {
        names[sid] = name;
      } else {
        const s = sessionById[sid];
        names[sid] = s?.slug ?? sid.slice(0, 8);
      }
    }
    return names;
  }, [snapshot, pendingRenames]);

  // Clear optimistic rename entries once the snapshot reflects the new name.
  useEffect(() => {
    if (!snapshot) return;
    if (Object.keys(pendingRenames).length === 0) return;
    const live: Record<string, string | undefined> = {};
    for (const room of snapshot.rooms) {
      for (const s of room.sessions) {
        live[s.sessionId] = s.proposedName;
      }
    }
    reconcilePendingRenames(live);
  }, [snapshot, pendingRenames, reconcilePendingRenames]);

  // Sync state → URL hash
  const suppressHashChange = useRef(false);
  useEffect(() => {
    let hash = '';
    if (view === 'logs') {
      hash = '#logs';
    } else if (selectedSessionId) {
      hash = `#session/${selectedSessionId}`;
      if (selectedSubagentId) hash += `/${selectedSubagentId}`;
    }
    const currentHash = window.location.hash;
    if (currentHash === hash) return;
    suppressHashChange.current = true;
    const url = hash || window.location.pathname + window.location.search;
    window.history.pushState(null, '', url);
    // Reset flag after microtask so it doesn't block real navigation
    queueMicrotask(() => { suppressHashChange.current = false; });
  }, [view, selectedSessionId, selectedSubagentId]);

  // Sync URL hash → state (for link navigation / back button)
  useEffect(() => {
    function onHashChange() {
      if (suppressHashChange.current) return;
      const h = window.location.hash;
      if (h.startsWith('#logs')) {
        setView('logs');
      } else if (h.startsWith('#session/')) {
        const m = h.match(/^#session\/([^/]+)(?:\/(.+))?/);
        if (m) {
          setView('office');
          setSelectedSessionId(m[1]);
          setSelectedSubagentId(m[2] || undefined);
        }
      } else {
        setView('office');
        setSelectedSessionId(null);
        setSelectedSubagentId(undefined);
      }
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Keep ref in sync with the latest handler (runs synchronously during render)
  terminalHandlerRef.current = terminal.handleTerminalMessage;


  // Clear pendingSpawns once the live session lands in the snapshot (matched by
  // cwd + proposedName, with startedAt > pending.startedAt) or after 25s timeout.
  useEffect(() => {
    if (pendingSpawns.length === 0) return;
    const matched = new Set<string>();
    const now = Date.now();
    for (const p of pendingSpawns) {
      if (now - p.startedAt > 25_000) { matched.add(p.id); continue; }
      const room = snapshot?.rooms.find(r => r.cwd === p.cwd);
      if (!room) continue;
      const startedAfter = p.startedAt - 5_000;
      const hit = room.sessions.find(s =>
        s.proposedName === p.fullName && s.startedAt >= startedAfter
      );
      if (hit) matched.add(p.id);
    }
    if (matched.size > 0) {
      setPendingSpawns(prev => prev.filter(p => !matched.has(p.id)));
    }
  }, [snapshot, pendingSpawns]);

  // Tick every 2s while pendingSpawns non-empty so the timeout cleanup fires
  // even without snapshot changes.
  useEffect(() => {
    if (pendingSpawns.length === 0) return;
    const id = setInterval(() => {
      setPendingSpawns(prev => prev.filter(p => Date.now() - p.startedAt <= 25_000));
    }, 2000);
    return () => clearInterval(id);
  }, [pendingSpawns.length]);

  // Auto-select sessions in DetailPanel when this tab spawns one. Server pre-mints
  // the ovrId at spawn time, so `activePtySessionId` is always already an `ovr-XXX`
  // (or a legacy raw-/opencode- internal id for those provider paths). We only
  // Auto-select on spawn: activePtySessionId is always an ovrId (set via terminal:linked).
  // Boot-time replays never call onSpawned, so this only fires for user-initiated spawns.
  useEffect(() => {
    if (!activePtySessionId) return;
    const targetId = activePtySessionId;
    setActivePtySessionId(null);
    setSelectedSessionId(targetId);
    setSelectedSubagentId(undefined);
  }, [activePtySessionId]);

  // Upgrade legacy Claude UUID hash → ovrId once snapshot arrives.
  // Runs once per UUID-style selectedSessionId; no-op if already an ovrId.
  useEffect(() => {
    if (!selectedSessionId || selectedSessionId.startsWith('ovr-')) return;
    if (!snapshot) return;
    // Clear dead pty-xxx selections (PTY exited and never linked to a real session)
    if (selectedSessionId.startsWith('pty-') && terminal.exitedSessions.has(selectedSessionId)) {
      const all = snapshot.rooms.flatMap(r => r.sessions);
      if (!all.some(s => s.overlordId === selectedSessionId || s.sessionId === selectedSessionId)) {
        setSelectedSessionId(null);
        return;
      }
    }
    if (selectedSessionId.startsWith('pty-')) return;
    const all = snapshot.rooms.flatMap(r => r.sessions);
    let sess = all.find(s => s.sessionId === selectedSessionId);
    if (!sess) {
      // The selected UUID is an ancestor in the /resume or /clear chain. Walk
      // forward through resumedFrom pointers to find the current live session.
      let cursor = selectedSessionId;
      for (let i = 0; i < 5; i++) {
        const next = all.find(s => s.resumedFrom === cursor);
        if (!next) break;
        sess = next;
        cursor = next.sessionId;
      }
    }
    if (sess?.overlordId) setSelectedSessionId(sess.overlordId);
  }, [selectedSessionId, snapshot, terminal.exitedSessions]);

  // Derive the live session from the current snapshot so activityFeed stays fresh.
  // selectedSessionId is now an ovrId (ovr-xxx) — match on overlordId first, fall back
  // to sessionId for pre-ovrId hashes or pending pty-xxx IDs.
  const selectedSession = useMemo<Session | null>(() => {
    if (selectedSessionId == null) return null;
    // Prefer live snapshot over archivedSession so a just-resumed session
    // replaces the archived placeholder the moment it appears.
    const all = snapshot?.rooms.flatMap(r => r.sessions) ?? [];
    const matches = all.filter(s => s.overlordId === selectedSessionId || s.sessionId === selectedSessionId);
    // Prefer an active session over closed ones (same lineage can have both after a resume).
    const live = matches.find(s => s.state !== 'closed')
      ?? [...matches].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (live) return live;
    if (archivedSession && archivedSession.sessionId === selectedSessionId) {
      return archivedSession;
    }
    return null;
  }, [snapshot, selectedSessionId, archivedSession]);

  const selectedRoom: Room | null =
    selectedRoomId != null
      ? (snapshot?.rooms.find(r => r.id === selectedRoomId) ?? null)
      : null;

  function handleSelectSession(session: Session, subagentId?: string, timestamp?: string, query?: string) {
    // Use ovrId as the stable session key; fall back to sessionId for sessions without one
    const id = session.overlordId ?? session.sessionId;
    setSelectedSessionId(id);
    setSelectedSubagentId(subagentId);
    setScrollTarget(timestamp ? { sessionId: id, timestamp, query } : null);
    setSelectionNonce(n => n + 1);
  }

  function handleRoomClick(roomId: string) {
    setSelectedRoomId(prev => prev === roomId ? null : roomId);
  }

  function handleRoomDetailClose() {
    setSelectedRoomId(null);
  }

  function handleClose() {
    setSelectedSessionId(null);
    setSelectedSubagentId(undefined);
    setArchivedSession(null);
  }

  function handleSpawnSession(cwd: string) {
    // Show the name input first — spawn happens on commit
    setSpawnCwd(cwd);
    setPendingSpawnName('');
  }

  function addPendingSpawn(cwd: string, fullName: string) {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingSpawns(prev => [...prev, { id, cwd, fullName, startedAt: Date.now() }]);
  }

  function handleSpawnCommit(name: string | null) {
    if (name !== null && spawnCwd) {
      const trimmed = name.trim();
      terminal.spawnSession(spawnCwd, 80, 24, trimmed || undefined);
      if (trimmed) addPendingSpawn(spawnCwd, trimmed);
    }
    setSpawnCwd(null);
    setPendingSpawnName('');
  }

  function handleNewTerminalSession(cwd: string, mode: TerminalSpawnMode = 'bridge') {
    setTerminalSpawnCwd(cwd);
    setTerminalSpawnMode(mode);
  }

  function handleTerminalSpawnCommit(name: string | null) {
    if (name !== null && terminalSpawnCwd) {
      terminal.openNewTerminal(terminalSpawnCwd, name || undefined, terminalSpawnMode);
    }
    setTerminalSpawnCwd(null);
  }

  function handleNewFolderSpawn(cwd: string, name: string, mode: TerminalSpawnMode, provider: SessionProvider = 'claude') {
    setShowDirectoryPicker(false);
    if (mode === 'embedded') {
      terminal.spawnSession(cwd, 80, 24, name || undefined, provider);
      if (name) addPendingSpawn(cwd, name);
    } else if (mode === 'raw') {
      terminal.spawnRawShell(cwd, 80, 24, name || undefined);
      if (name) addPendingSpawn(cwd, name);
    } else {
      terminal.openNewTerminal(cwd, name || undefined, mode, provider);
    }
  }

  function handleDeleteSession(sessionId: string) {
    sendMessage({ type: 'session:delete', sessionId });
  }

  function handleCloseSession(sessionId: string) {
    sendMessage({ type: 'session:close', sessionId });
  }

  function handleCloneSession(sessionId: string) {
    sendMessage({ type: 'session:clone', sessionId, cols: 120, rows: 30 });
  }

  async function handleResumeArchived(sessionId: string, cwd: string) {
    try {
      const res = await fetch(`/api/archive/${sessionId}/unarchive`, { method: 'POST' });
      if (!res.ok) { console.error('unarchive failed', await res.text()); return; }
      // Keep the archived placeholder visible (with isArchived cleared) until the
      // live session reappears in snapshot; otherwise the DetailPanel goes blank
      // during the spawn gap and nothing is clickable.
      setArchivedSession(prev => prev && prev.sessionId === sessionId ? { ...prev, isArchived: false, state: 'closed' } : prev);
      window.dispatchEvent(new CustomEvent('archive:changed', { detail: {} }));
      terminal.resumeSession(sessionId, cwd);
    } catch (err) {
      console.error('unarchive error', err);
    }
  }

  async function handleDeleteArchived(sessionId: string) {
    try {
      const res = await fetch(`/api/archive/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) { console.error('delete archive failed', await res.text()); return; }
      setArchivedSession(prev => prev && prev.sessionId === sessionId ? null : prev);
      window.dispatchEvent(new CustomEvent('archive:changed', { detail: {} }));
      handleClose();
    } catch (err) {
      console.error('delete archive error', err);
    }
  }

  async function handleCloneArchived(sessionId: string, _cwd: string) {
    try {
      const res = await fetch(`/api/archive/${sessionId}/clone-prepare`, { method: 'POST' });
      if (!res.ok) { console.error('clone-prepare failed', await res.text()); return; }
      sendMessage({ type: 'session:clone', sessionId, cols: 120, rows: 30 });
    } catch (err) {
      console.error('clone-prepare error', err);
    }
  }

  function handleAcceptSession(sessionId: string) {
    fetch(`/api/sessions/${sessionId}/accept`, { method: 'POST' }).catch(console.error);
  }

  function handleArchiveSession(sessionId: string) {
    fetch(`/api/archive/${sessionId}`, { method: 'POST' }).catch(console.error);
  }

  function buildArchivedSession(entry: ArchiveEntry, activityFeed: Session['activityFeed']): Session {
    return {
      sessionId: entry.sessionId,
      overlordId: entry.sessionId,
      provider: entry.provider,
      proposedName: entry.name,
      pid: entry.pid,
      startedAt: entry.startedAt ?? 0,
      cwd: entry.cwd,
      state: 'closed',
      lastActivity: entry.lastActivity ?? entry.archivedAt,
      lastMessage: entry.lastMessage,
      activityFeed,
      color: entry.color ?? 'hsl(30, 75%, 55%)',
      subagents: [],
      model: entry.model,
      sessionType: entry.sessionType,
      intent: entry.intent,
      isArchived: true,
      archivedAt: entry.archivedAt,
      archivedGitBranch: entry.gitBranch,
      archivedPullRequest: entry.pullRequest,
    };
  }

  async function handleOpenArchive(entry: ArchiveEntry) {
    setSelectedSessionId(entry.sessionId);
    setSelectedSubagentId(undefined);
    // Show placeholder immediately so DetailPanel renders
    setArchivedSession(buildArchivedSession(entry, []));
    try {
      const res = await fetch(`/api/archive/${entry.sessionId}/transcript`);
      if (res.ok) {
        const body = await res.json() as { activityFeed?: Session['activityFeed'] };
        setArchivedSession(buildArchivedSession(entry, body.activityFeed ?? []));
      }
    } catch { /* ignore */ }
  }

  if (view === 'logs') {
    return <LogsPage onBack={() => setView('office')} />;
  }

  return (
    <>
      <Office
        snapshot={snapshot}
        connected={connected}
        connecting={connecting}
        onSelectSession={handleSelectSession}
        customNames={displayNames}
        onSpawnSession={handleSpawnSession}
        onSpawnDirect={handleNewFolderSpawn}
        onNewTerminalSession={handleNewTerminalSession}
        onLogsClick={() => setView('logs')}
        onSettingsClick={() => setShowSettings(true)}
        onStatsClick={() => setShowStats(true)}
        onOpenAdvancedSearch={() => setShowAdvancedSearch(true)}

        selectedSessionId={selectedSessionId}
        selectionNonce={selectionNonce}
        rightOffset={panelWidth}
        onRoomClick={handleRoomClick}
        spawnCwd={spawnCwd}
        onSpawnNameChange={setPendingSpawnName}
        onSpawnCommit={handleSpawnCommit}
        terminalSpawnCwd={terminalSpawnCwd}
        onTerminalSpawnCommit={handleTerminalSpawnCommit}
        onDeleteSession={handleDeleteSession}
        onCloneSession={handleCloneSession}
        onCloseSession={handleCloseSession}
        onArchiveSession={handleArchiveSession}
        onOpenArchive={handleOpenArchive}
        onDeleteArchive={handleDeleteArchived}
        onRenameSession={rename}
        isPtySession={terminal.isPtySession}
        pendingSpawns={pendingSpawns}
        platform={snapshot?.platform ?? 'darwin'}
        onOpenDirectoryPicker={() => {
          const usedNames = new Set(
            (snapshot?.rooms.flatMap(r => r.sessions.map(s => s.proposedName)).filter(Boolean) ?? []) as string[]
          );
          const available = SESSION_NAMES.filter(n => !usedNames.has(n));
          const name = available.length > 0
            ? available[Math.floor(Math.random() * available.length)]
            : 'Session';
          setDirPickerSuggestedName(name);
          setShowDirectoryPicker(true);
        }}
      />
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showSettings && snapshot?.settings && (
        <SettingsModal
          settings={snapshot.settings}
          onUpdate={(partial: Partial<GlobalSettings>) => {
            void fetch('/api/settings', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(partial),
            });
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showAdvancedSearch && (
        <AdvancedSearchPopup
          snapshot={snapshot}
          customNames={displayNames}
          onSelectSession={(session, timestamp, query) => handleSelectSession(session, undefined, timestamp, query)}
          onOpenArchive={(entry) => { void handleOpenArchive(entry); }}
          onClose={() => setShowAdvancedSearch(false)}
        />
      )}
      <DirectoryPickerDialog
        open={showDirectoryPicker}
        onClose={() => setShowDirectoryPicker(false)}
        onSpawn={handleNewFolderSpawn}
        defaultPath={snapshot?.rooms[0]?.cwd}
        suggestedName={dirPickerSuggestedName}
        bridgePath={snapshot?.bridgePath}
      />
      {(selectedSession?.sessionType === 'raw' || (selectedSessionId?.startsWith('raw-') && !selectedSession)) ? (
        <PtyTerminalPanel
          sessionId={selectedSessionId ?? selectedSession?.sessionId ?? ''}
          session={selectedSession ?? undefined}
          customName={displayNames[selectedSession?.sessionId ?? '']}
          isExited={terminal.exitedSessions.has(selectedSessionId ?? '')}
          sendInput={terminal.sendInput}
          resizePty={terminal.resizePty}
          registerOutputHandler={terminal.registerOutputHandler}
          onKill={(sessionId) => {
            terminal.killSession(sessionId);
            handleClose();
          }}
          onRestart={(sessionId) => terminal.restartShell(sessionId)}
          onRename={rename}
          onClose={handleClose}
          panelWidth={panelWidth}
          onPanelWidthChange={setPanelWidth}
        />
      ) : <DetailPanel
        selectedSession={selectedSession}
        selectedSessionId={selectedSessionId}
        selectedSubagentId={selectedSubagentId}
        customName={displayNames[selectedSession?.sessionId ?? '']}
        onRename={rename}
        onClose={handleClose}
        connected={connected}
        isPtySession={terminal.isPtySession}
        isBridgeSession={isBridgeSession}
        pty={{
          sendInput: terminal.sendInput,
          injectText: terminal.injectText,
          resizePty: terminal.resizePty,
          registerOutputHandler: terminal.registerOutputHandler,
          exitedSessions: terminal.exitedSessions,
          getError: terminal.getError,
        }}
        actions={{
          onDeleteSession: handleDeleteSession,
          onResumeSession: (sessionId, cwd) => {
            if (archivedSession && archivedSession.sessionId === sessionId) {
              void handleResumeArchived(sessionId, cwd);
            } else {
              terminal.resumeSession(sessionId, cwd);
            }
          },
          onResumeArchived: handleResumeArchived,
          onCloneArchived: handleCloneArchived,
          onDeleteArchived: handleDeleteArchived,
          onOpenInTerminal: (sessionId, cwd) => terminal.openInTerminal(sessionId, cwd),
          onOpenBridged: (sessionId, cwd) => terminal.openBridgedTerminal(sessionId, cwd),
          onFocusBridge: (sessionId) => sendMessage({ type: 'terminal:focus', sessionId }),
          onMarkDone: (sessionId) => { fetch(`/api/sessions/${sessionId}/mark-done`, { method: 'POST' }).catch(console.error); },
          onAcceptSession: handleAcceptSession,
        }}

        panelWidth={panelWidth}
        onPanelWidthChange={setPanelWidth}
        siblingActiveSessions={
          selectedSession && selectedSession.state === 'closed'
            ? (snapshot?.rooms
                .find(r => r.cwd === selectedSession.cwd)
                ?.sessions.filter(s => s.resumedFrom === selectedSession.sessionId)
                .sort((a, b) => b.startedAt - a.startedAt) ?? [])
            : []
        }
        onSelectSession={(s, subagentId, timestamp, query) => handleSelectSession(s, subagentId, timestamp, query)}
        customNames={displayNames}
        bridgePath={snapshot?.bridgePath}
        platform={snapshot?.platform ?? 'darwin'}
        scrollTarget={scrollTarget && (scrollTarget.sessionId === selectedSession?.overlordId || scrollTarget.sessionId === selectedSession?.sessionId) ? scrollTarget.timestamp : undefined}
        scrollQuery={scrollTarget && (scrollTarget.sessionId === selectedSession?.overlordId || scrollTarget.sessionId === selectedSession?.sessionId) ? scrollTarget.query : undefined}
        onScrollTargetConsumed={() => setScrollTarget(null)}
      />}
      {selectedRoom && (
        <TaskListPanel
          room={selectedRoom}
          customNames={displayNames}
          onSelectSession={(s, timestamp, query) => handleSelectSession(s, undefined, timestamp, query)}
          onClose={handleRoomDetailClose}
        />
      )}
    </>
  );
}
