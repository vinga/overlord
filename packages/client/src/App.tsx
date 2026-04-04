import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOfficeData } from './hooks/useOfficeData';
import { useTerminal } from './hooks/useTerminal';
import { useCustomNames } from './hooks/useCustomNames';

import type { Session, TerminalMessage } from './types';
import { Office } from './components/Office';
import { DetailPanel } from './components/DetailPanel';
import { TaskListPanel } from './components/TaskListPanel';
import { LogsPage } from './components/LogsPage';
import type { Room } from './types';


export function App() {
  const [view, setView] = useState<'office' | 'logs'>('office');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>(undefined);
  const [activePtySessionId, setActivePtySessionId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [pendingSpawnName, setPendingSpawnName] = useState('');
  const [spawnCwd, setSpawnCwd] = useState<string | null>(null);
  const [spawnLinkedId, setSpawnLinkedId] = useState<string | null>(null);
  const [terminalSpawnCwd, setTerminalSpawnCwd] = useState<string | null>(null);
  const { customNames, rename } = useCustomNames();

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
    // Migrate custom name from old session to new one
    const oldName = customNames[oldId];
    if (oldName) rename(newId, oldName);
  }, [customNames, rename]);

  const { snapshot, connected, sendMessage } = useOfficeData(handleTerminalMessageStable, { onSessionReplaced: handleSessionReplaced });
  const terminal = useTerminal(sendMessage, (id) => setActivePtySessionId(id));

  // Keep ref in sync with the latest handler (runs synchronously during render)
  terminalHandlerRef.current = terminal.handleTerminalMessage;

  // Auto-select PTY sessions in DetailPanel when they are spawned/resumed
  // When terminal:linked fires, activePtySessionId switches from 'pty-xxx' to real claudeSessionId.
  // Auto-select it in DetailPanel and clear activePtySessionId to prevent re-triggering.
  // Keep spawnCwd/pendingSpawnName visible so the user can still type a name; dismiss on Enter/Escape or after 20s.
  useEffect(() => {
    if (!activePtySessionId || activePtySessionId.startsWith('pty-')) return;
    const linkedId = activePtySessionId;
    setSpawnLinkedId(linkedId);
    // Don't open DetailPanel yet — wait for user to commit name
    setActivePtySessionId(null);
    // Auto-dismiss after 20s regardless
    const t = setTimeout(() => {
      setPendingSpawnName(prev => {
        if (prev.trim()) rename(linkedId, prev.trim());
        return '';
      });
      setSpawnCwd(null);
      setSpawnLinkedId(null);
      setSelectedSessionId(linkedId);   // open DetailPanel after timeout
      setSelectedSubagentId(undefined);
      setSelectedRoomId(null);
    }, 20_000);
    return () => clearTimeout(t);
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

  function handleSelectSession(session: Session, subagentId?: string) {
    setSelectedSessionId(session.sessionId);
    setSelectedSubagentId(subagentId);
    setSelectedRoomId(null);
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
    setSpawnCwd(cwd);
    setPendingSpawnName('');
    terminal.spawnSession(cwd);
  }

  function handleSpawnCommit(name: string) {
    if (name.trim() && spawnLinkedId) {
      rename(spawnLinkedId, name.trim());
    }
    if (spawnLinkedId) {
      setSelectedSessionId(spawnLinkedId);
      setSelectedSubagentId(undefined);
      setSelectedRoomId(null);
    }
    setSpawnCwd(null);
    setSpawnLinkedId(null);
    setPendingSpawnName('');
  }

  function handleNewTerminalSession(cwd: string) {
    setTerminalSpawnCwd(cwd);
  }

  function handleTerminalSpawnCommit(name: string) {
    if (terminalSpawnCwd) {
      terminal.openNewTerminal(terminalSpawnCwd, name || undefined);
    }
    setTerminalSpawnCwd(null);
  }

  function handleDeleteSession(sessionId: string) {
    sendMessage({ type: 'session:delete', sessionId });
  }

  function handleCloneSession(sessionId: string) {
    sendMessage({ type: 'session:clone', sessionId });
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
      <button
        onClick={() => setView('logs')}
        style={{
          position: 'fixed',
          top: 12,
          right: 16,
          zIndex: 1000,
          background: 'transparent',
          border: '1px solid #333',
          color: '#888',
          fontSize: '12px',
          padding: '4px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontFamily: 'Inter, system-ui, sans-serif',
          transition: 'border-color 0.15s ease, color 0.15s ease',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#d4af37';
          (e.currentTarget as HTMLButtonElement).style.color = '#d4af37';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = '#333';
          (e.currentTarget as HTMLButtonElement).style.color = '#888';
        }}
      >
        Logs
      </button>
      <Office
        snapshot={snapshot}
        connected={connected}
        onSelectSession={handleSelectSession}
        customNames={customNames}
        onSpawnSession={handleSpawnSession}
        onNewTerminalSession={handleNewTerminalSession}

        selectedSessionId={selectedSessionId}
        rightOffset={(selectedSessionId || selectedRoomId) ? panelWidth : 0}
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
      />
      <DetailPanel
        selectedSession={selectedSession}
        selectedSubagentId={selectedSubagentId}
        customName={customNames[selectedSession?.sessionId ?? '']}
        onRename={rename}
        onClose={handleClose}
        connected={connected}
        isPtySession={terminal.isPtySession}
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
        onSelectSession={(s) => handleSelectSession(s)}
        customNames={customNames}
      />
      {selectedRoom && (
        <TaskListPanel
          room={selectedRoom}
          customNames={customNames}
          onSelectSession={handleSelectSession}
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
