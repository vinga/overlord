import React, { useState, useCallback, useRef } from 'react';
import { useOfficeData } from './hooks/useOfficeData';
import { useTerminal } from './hooks/useTerminal';
import { useCustomNames } from './hooks/useCustomNames';
import { useDormitorySessions } from './hooks/useDormitorySessions';
import type { Session, TerminalMessage } from './types';
import { Office } from './components/Office';
import { DetailPanel } from './components/DetailPanel';
import { PtyTerminalPanel } from './components/PtyTerminalPanel';


export function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>(undefined);
  const [activePtySessionId, setActivePtySessionId] = useState<string | null>(null);
  const { customNames, rename } = useCustomNames();
  const { dormitorySessions, toggleDormitory, isInDormitory } = useDormitorySessions();
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

  const { snapshot, connected, sendMessage } = useOfficeData(handleTerminalMessageStable);
  const terminal = useTerminal(sendMessage, (id) => setActivePtySessionId(id));

  // Keep ref in sync with the latest handler (runs synchronously during render)
  terminalHandlerRef.current = terminal.handleTerminalMessage;

  // Derive the live session from the current snapshot so activityFeed stays fresh
  const selectedSession: Session | null =
    selectedSessionId != null
      ? (snapshot?.rooms.flatMap(r => r.sessions).find(s => s.sessionId === selectedSessionId) ?? null)
      : null;

  function handleSelectSession(session: Session, subagentId?: string) {
    setSelectedSessionId(session.sessionId);
    setSelectedSubagentId(subagentId);
  }

  function handleClose() {
    setSelectedSessionId(null);
    setSelectedSubagentId(undefined);
  }

  function handleSpawnSession(cwd: string) {
    terminal.spawnSession(cwd);
  }

  function handleKillPty(sessionId: string) {
    terminal.killSession(sessionId);
    setActivePtySessionId(null);
  }

  function handleDeleteSession(sessionId: string) {
    sendMessage({ type: 'session:delete', sessionId });
  }

  return (
    <>
      <Office
        snapshot={snapshot}
        connected={connected}
        onSelectSession={handleSelectSession}
        customNames={customNames}
        onSpawnSession={handleSpawnSession}
        dormitorySessions={dormitorySessions}
        selectedSessionId={selectedSessionId}
        rightOffset={selectedSessionId ? panelWidth : 0}
      />
      {activePtySessionId && (() => {
        const ptySession = snapshot?.rooms.flatMap(r => r.sessions).find(s => s.sessionId === activePtySessionId);
        return (
          <PtyTerminalPanel
            sessionId={activePtySessionId}
            session={ptySession}
            customName={customNames[activePtySessionId]}
            isExited={terminal.exitedSessions.has(activePtySessionId)}
            sendInput={terminal.sendInput}
            resizePty={terminal.resizePty}
            registerOutputHandler={terminal.registerOutputHandler}
            onKill={handleKillPty}
            onRename={rename}
          />
        );
      })()}
      <DetailPanel
        selectedSession={selectedSession}
        selectedSubagentId={selectedSubagentId}
        customName={customNames[selectedSession?.sessionId ?? '']}
        onRename={rename}
        onClose={handleClose}
        connected={connected}
        isPtySession={terminal.isPtySession}
        sendInput={terminal.sendInput}
        injectText={terminal.injectText}
        resizePty={terminal.resizePty}
        registerOutputHandler={terminal.registerOutputHandler}
        exitedSessions={terminal.exitedSessions}
        getError={terminal.getError}
        isInDormitory={isInDormitory}
        onToggleDormitory={toggleDormitory}
        onDeleteSession={handleDeleteSession}
        panelWidth={panelWidth}
        onPanelWidthChange={setPanelWidth}
        siblingActiveSessions={
          selectedSession && selectedSession.state === 'idle'
            ? (snapshot?.rooms
                .find(r => r.cwd === selectedSession.cwd)
                ?.sessions.filter(s => s.sessionId !== selectedSession.sessionId && s.state !== 'idle')
                .sort((a, b) => b.startedAt - a.startedAt) ?? [])
            : []
        }
        onSelectSession={(s) => handleSelectSession(s)}
        customNames={customNames}
        onResumeSession={(sessionId, cwd) => {
          terminal.resumeSession(sessionId, cwd);
        }}
      />
    </>
  );
}
