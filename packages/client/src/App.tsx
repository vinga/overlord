import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOfficeData } from './hooks/useOfficeData';
import { useTerminal } from './hooks/useTerminal';
import { useCustomNames } from './hooks/useCustomNames';
import { useRoomOrder } from './hooks/useRoomOrder';

import type { ArchiveEntry, Session, TerminalMessage, TerminalSpawnMode } from './types';
import { Office } from './components/Office';
import { DetailPanel } from './components/DetailPanel';
import { PtyTerminalPanel } from './components/PtyTerminalPanel';
import { TaskListPanel } from './components/TaskListPanel';
import { LogsPage } from './components/LogsPage';
import { DirectoryPickerDialog } from './components/DirectoryPickerDialog';
import { AdvancedSearchPopup } from './components/AdvancedSearchPopup';
import { SESSION_NAMES } from './components/Room';
import type { Room } from './types';


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
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#room\/(.+)/);
    return m ? m[1] : null;
  });
  const [pendingSpawnName, setPendingSpawnName] = useState('');
  const [spawnCwd, setSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnCwd, setTerminalSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnMode, setTerminalSpawnMode] = useState<TerminalSpawnMode>('bridge');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [archivedSession, setArchivedSession] = useState<Session | null>(null);
  const [dirPickerSuggestedName, setDirPickerSuggestedName] = useState('');
  const { rename, migrateSession: migrateNames } = useCustomNames();
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

  // Display names come from OverlordSession.proposedName via the snapshot.
  // Renames PATCH the server; no client-side override layer.
  const displayNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (snapshot) {
      for (const room of snapshot.rooms) {
        for (const s of room.sessions) {
          if (s.proposedName) names[s.sessionId] = s.proposedName;
        }
      }
    }
    return names;
  }, [snapshot]);

  // Sync state → URL hash
  const suppressHashChange = useRef(false);
  useEffect(() => {
    let hash = '';
    if (view === 'logs') {
      hash = '#logs';
    } else if (selectedSessionId) {
      hash = `#session/${selectedSessionId}`;
      if (selectedSubagentId) hash += `/${selectedSubagentId}`;
    } else if (selectedRoomId) {
      hash = `#room/${selectedRoomId}`;
    }
    const currentHash = window.location.hash;
    if (currentHash === hash) return;
    suppressHashChange.current = true;
    const url = hash || window.location.pathname + window.location.search;
    window.history.pushState(null, '', url);
    // Reset flag after microtask so it doesn't block real navigation
    queueMicrotask(() => { suppressHashChange.current = false; });
  }, [view, selectedSessionId, selectedSubagentId, selectedRoomId]);

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
          setSelectedRoomId(null);
        }
      } else if (h.startsWith('#room/')) {
        const m = h.match(/^#room\/(.+)/);
        if (m) {
          setView('office');
          setSelectedRoomId(m[1]);
          setSelectedSessionId(null);
          setSelectedSubagentId(undefined);
        }
      } else {
        setView('office');
        setSelectedSessionId(null);
        setSelectedSubagentId(undefined);
        setSelectedRoomId(null);
      }
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Keep ref in sync with the latest handler (runs synchronously during render)
  terminalHandlerRef.current = terminal.handleTerminalMessage;


  // Auto-select PTY sessions in DetailPanel when they are spawned/resumed.
  // For pty-xxx IDs (pre-linking), immediately show the terminal panel.
  // When terminal:linked fires, activePtySessionId switches to the claudeSessionId —
  // we resolve its ovrId from the snapshot so selectedSessionId stays as an ovrId.
  useEffect(() => {
    if (!activePtySessionId) return;
    if (activePtySessionId.startsWith('pty-')) {
      // Immediately show the PTY terminal (before session file is created / linked)
      setSelectedSessionId(activePtySessionId);
      setSelectedSubagentId(undefined);
      setSelectedRoomId(null);
      setActivePtySessionId(null);
      return;
    }
    const claudeId = activePtySessionId;
    setActivePtySessionId(null);
    // Resolve ovrId — prefer it over the raw claudeId for stable routing
    const all = snapshot?.rooms.flatMap(r => r.sessions) ?? [];
    const linked = all.find(s => s.sessionId === claudeId);
    setSelectedSessionId(linked?.overlordId ?? claudeId);
    setSelectedSubagentId(undefined);
    setSelectedRoomId(null);
  }, [activePtySessionId, snapshot]);

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
    const live = all.find(s => s.overlordId === selectedSessionId || s.sessionId === selectedSessionId);
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
    setSelectedRoomId(null);
    setScrollTarget(timestamp ? { sessionId: id, timestamp, query } : null);
  }

  function handleRoomClick(roomId: string) {
    setSelectedRoomId(prev => prev === roomId ? null : roomId);
    setSelectedSessionId(null);
    setSelectedSubagentId(undefined);
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

  function handleSpawnCommit(name: string | null) {
    if (name !== null && spawnCwd) {
      terminal.spawnSession(spawnCwd, 80, 24, name.trim() || undefined);
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

  function handleNewFolderSpawn(cwd: string, name: string, mode: TerminalSpawnMode) {
    setShowDirectoryPicker(false);
    if (mode === 'embedded') {
      terminal.spawnSession(cwd, 80, 24, name || undefined);
    } else if (mode === 'raw') {
      terminal.spawnRawShell(cwd, 80, 24, name || undefined);
    } else {
      terminal.openNewTerminal(cwd, name || undefined, mode);
    }
  }

  function handleDeleteSession(sessionId: string) {
    sendMessage({ type: 'session:delete', sessionId });
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
    setSelectedRoomId(null);
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
        onOpenAdvancedSearch={() => setShowAdvancedSearch(true)}

        selectedSessionId={selectedSessionId}
        rightOffset={panelWidth}
        onRoomClick={handleRoomClick}
        spawnCwd={spawnCwd}
        onSpawnNameChange={setPendingSpawnName}
        onSpawnCommit={handleSpawnCommit}
        terminalSpawnCwd={terminalSpawnCwd}
        onTerminalSpawnCommit={handleTerminalSpawnCommit}
        onDeleteSession={handleDeleteSession}
        onCloneSession={handleCloneSession}
        onArchiveSession={handleArchiveSession}
        onOpenArchive={handleOpenArchive}
        onRenameSession={rename}
        isPtySession={terminal.isPtySession}
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
      {!selectedRoom && (selectedSession?.sessionType === 'raw' || (selectedSessionId?.startsWith('raw-') && !selectedSession)) ? (
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
      ) : !selectedRoom && <DetailPanel
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
          panelWidth={panelWidth}
          onPanelWidthChange={(w) => {
            setPanelWidth(w);
            localStorage.setItem('overlord:panelWidth', String(w));
          }}
        />
      )}
    </>
  );
}
