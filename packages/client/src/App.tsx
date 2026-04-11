import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOfficeData } from './hooks/useOfficeData';
import { useTerminal } from './hooks/useTerminal';
import { useCustomNames } from './hooks/useCustomNames';
import { useRoomOrder } from './hooks/useRoomOrder';

import type { Session, TerminalMessage, TerminalSpawnMode } from './types';
import { Office } from './components/Office';
import { DetailPanel } from './components/DetailPanel';
import { TaskListPanel } from './components/TaskListPanel';
import { LogsPage } from './components/LogsPage';
import { DirectoryPickerDialog } from './components/DirectoryPickerDialog';
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
  const [scrollTarget, setScrollTarget] = useState<{ sessionId: string; timestamp: string } | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#room\/(.+)/);
    return m ? m[1] : null;
  });
  const [pendingSpawnName, setPendingSpawnName] = useState('');
  const [spawnCwd, setSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnCwd, setTerminalSpawnCwd] = useState<string | null>(null);
  const [terminalSpawnMode, setTerminalSpawnMode] = useState<TerminalSpawnMode>('bridge');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [dirPickerSuggestedName, setDirPickerSuggestedName] = useState('');
  const { customNames, rename, migrateSession: migrateNames } = useCustomNames();
  const { migrateSession: migrateRoomOrder } = useRoomOrder();

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = localStorage.getItem('overlord:panelWidth');
    return saved ? Math.max(320, Math.min(900, parseInt(saved, 10))) : 680;
  });

  // Use a ref so the WS handler always sees the latest terminal message handler,
  // with zero render-cycle delay (avoids losing terminal:spawned on fast responses)
  const terminalHandlerRef = useRef<((msg: TerminalMessage) => void) | null>(null);
  const handleTerminalMessageStable = useCallback((msg: TerminalMessage) => {
    terminalHandlerRef.current?.(msg);
  }, []); // stable — no deps needed, reads ref at call time

  const handleSessionReplaced = useCallback((oldId: string, newId: string) => {
    // If we're currently viewing the old session, auto-follow to the new one
    setSelectedSessionId(prev => prev === oldId ? newId : prev);
    // Transfer custom name, auto name, and room order to the new session ID
    migrateNames(oldId, newId);
    migrateRoomOrder(oldId, newId);
  }, [migrateNames, migrateRoomOrder]);

  const { snapshot, connected, connecting, sendMessage } = useOfficeData(handleTerminalMessageStable, { onSessionReplaced: handleSessionReplaced });
  const terminal = useTerminal(sendMessage, (id) => setActivePtySessionId(id));

  // Build display names: proposedName from server > custom name from user > fallback
  // autoNames are only used for populating the spawn input, not for display.
  const displayNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (snapshot) {
      for (const room of snapshot.rooms) {
        for (const s of room.sessions) {
          if (s.proposedName) names[s.sessionId] = s.proposedName;
        }
      }
    }
    // Custom names (user-set) override proposedName
    return { ...names, ...customNames };
  }, [snapshot, customNames]);

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
    suppressHashChange.current = true;
    window.history.replaceState(null, '', hash || window.location.pathname);
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
  // When terminal:linked fires, activePtySessionId switches from 'pty-xxx' to real claudeSessionId.
  useEffect(() => {
    if (!activePtySessionId) return;
    if (activePtySessionId.startsWith('pty-')) {
      // Immediately show the PTY terminal (before session file is created / linked)
      setSelectedSessionId(activePtySessionId);
      setSelectedSubagentId(undefined);
      setSelectedRoomId(null);
      return;
    }
    const linkedId = activePtySessionId;
    setActivePtySessionId(null);
    setSelectedSessionId(linkedId);
    setSelectedSubagentId(undefined);
    setSelectedRoomId(null);
  }, [activePtySessionId]);

  // Derive the live session from the current snapshot so activityFeed stays fresh
  const selectedSession = useMemo<Session | null>(() =>
    selectedSessionId != null
      ? (snapshot?.rooms.flatMap(r => r.sessions).find(s => s.sessionId === selectedSessionId) ?? null)
      : null,
    [snapshot, selectedSessionId]
  );

  const selectedRoom: Room | null =
    selectedRoomId != null
      ? (snapshot?.rooms.find(r => r.id === selectedRoomId) ?? null)
      : null;

  function handleSelectSession(session: Session, subagentId?: string, timestamp?: string) {
    setSelectedSessionId(session.sessionId);
    setSelectedSubagentId(subagentId);
    setSelectedRoomId(null);
    setScrollTarget(timestamp ? { sessionId: session.sessionId, timestamp } : null);
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

  function handleAcceptSession(sessionId: string) {
    fetch(`/api/sessions/${sessionId}/accept`, { method: 'POST' }).catch(console.error);
  }

  function handleAcceptTask(sessionId: string, completedAt: string) {
    fetch(`/api/sessions/${sessionId}/accept-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedAt }),
    }).catch(console.error);
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
        onRenameSession={rename}
        isPtySession={terminal.isPtySession}
        platform={snapshot?.platform ?? 'darwin'}
        onOpenDirectoryPicker={() => {
          const usedNames = new Set([
            ...Object.values(customNames),
            ...(snapshot?.rooms.flatMap(r => r.sessions.map(s => s.proposedName)).filter(Boolean) ?? []),
          ] as string[]);
          const available = SESSION_NAMES.filter(n => !usedNames.has(n));
          const name = available.length > 0
            ? available[Math.floor(Math.random() * available.length)]
            : 'Session';
          setDirPickerSuggestedName(name);
          setShowDirectoryPicker(true);
        }}
      />
      <DirectoryPickerDialog
        open={showDirectoryPicker}
        onClose={() => setShowDirectoryPicker(false)}
        onSpawn={handleNewFolderSpawn}
        defaultPath={snapshot?.rooms[0]?.cwd}
        suggestedName={dirPickerSuggestedName}
        bridgePath={snapshot?.bridgePath}
      />
      {!selectedRoom && <DetailPanel
        selectedSession={selectedSession}
        selectedSessionId={selectedSessionId}
        selectedSubagentId={selectedSubagentId}
        customName={displayNames[selectedSession?.sessionId ?? '']}
        onRename={rename}
        onClose={handleClose}
        connected={connected}
        isPtySession={terminal.isPtySession}
        isBridgeSession={terminal.isBridgeSession}
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
          onResumeSession: (sessionId, cwd) => { terminal.resumeSession(sessionId, cwd); },
          onOpenInTerminal: (sessionId, cwd) => terminal.openInTerminal(sessionId, cwd),
          onOpenBridged: (sessionId, cwd) => terminal.openBridgedTerminal(sessionId, cwd),
          onFocusBridge: (sessionId) => sendMessage({ type: 'terminal:focus', sessionId }),
          onMarkDone: (sessionId) => { fetch(`/api/sessions/${sessionId}/mark-done`, { method: 'POST' }).catch(console.error); },
          onAcceptSession: handleAcceptSession,
          onAcceptTask: handleAcceptTask,
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
        onSelectSession={(s, subagentId) => handleSelectSession(s, subagentId)}
        customNames={displayNames}
        bridgePath={snapshot?.bridgePath}
        platform={snapshot?.platform ?? 'darwin'}
        scrollTarget={scrollTarget && scrollTarget.sessionId === selectedSession?.sessionId ? scrollTarget.timestamp : undefined}
        onScrollTargetConsumed={() => setScrollTarget(null)}
      />}
      {selectedRoom && (
        <TaskListPanel
          room={selectedRoom}
          customNames={displayNames}
          onSelectSession={(s, timestamp) => handleSelectSession(s, undefined, timestamp)}
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
