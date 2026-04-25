import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import { getBridgePath, getPipeName } from './pipeInjector.js';

export interface TerminalLauncherDeps {
  stateManager: { setSessionType: (sessionId: string, type: 'bridge') => void };
  bridgeManager: { enableReconnect: (sessionId: string) => void };
  connectBridgePipe: (sessionId: string, pipeName: string) => void;
  pruneStalePendingBridgeMarkers: () => void;
  pendingBridgeByMarker: Map<string, { pipeName: string; timestamp: number }>;
}

/** Open a native terminal window (Terminal.app on macOS, cmd.exe on Windows)
 *  running the given command in cwd. When useBridge is true and the bridge
 *  binary exists, the terminal launches the bridge wrapper which relays I/O
 *  via a named pipe so Overlord can attach. */
export async function openTerminalWindow(
  deps: TerminalLauncherDeps,
  cwd: string,
  command: string,
  title?: string,
  sessionId?: string,
  useBridge: boolean = true,
): Promise<void> {
  const { stateManager, bridgeManager, connectBridgePipe, pruneStalePendingBridgeMarkers, pendingBridgeByMarker } = deps;
  return new Promise<void>((resolve, reject) => {
    const windowTitle = (title ?? 'Claude').replace(/"/g, '');
    // Compute clean display name once — used for both --title flag and AppleScript custom title
    const displayTitle = windowTitle.replace(/___[A-Z]+:[^\s"]+/g, '').trim() || 'Claude';
    const safeTitle = displayTitle.replace(/"/g, '');
    const bridgePath = getBridgePath();
    const bridgeExists = useBridge && fs.existsSync(bridgePath);
    let pipeName: string | undefined;

    // Platform-independent bridge setup: configure pipe name and session state
    if (bridgeExists) {
      pipeName = sessionId
        ? getPipeName(sessionId)
        : `overlord-new-${Date.now().toString(36)}`;

      if (sessionId) {
        stateManager.setSessionType(sessionId, 'bridge');
        bridgeManager.enableReconnect(sessionId);
        // Use connectBridgePipe (dual-socket OUTPT+INPUT handshake) — bridgeManager.connect
        // is the legacy single-socket path that opens a TCP connection but never sends a
        // handshake byte, so the bridge blocks on conn.Read(header) and never adds the
        // socket to its broadcast set → no output ever reaches the client.
        setTimeout(() => connectBridgePipe(sessionId, pipeName!), 3000);
      } else {
        // Embed a unique marker in the command's --name flag for reliable matching
        const bridgeMarker = `brg-${Date.now().toString(36)}`;
        pruneStalePendingBridgeMarkers();
        pendingBridgeByMarker.set(bridgeMarker, { pipeName, timestamp: Date.now() });
        command = command.replace(/--name "([^"]*)"/, `--name "$1___BRG:${bridgeMarker}"`);
      }
    }

    let child: ReturnType<typeof spawn>;

    if (process.platform === 'darwin') {
      // macOS: build a bash command and run it in Terminal.app via osascript
      const safeCwd = cwd.replace(/"/g, '\\"');
      let bashCmd: string;
      if (bridgeExists && pipeName) {
        bashCmd = `cd "${safeCwd}" && "${bridgePath}" --pipe "${pipeName}" --title "${safeTitle}" -- ${command}`;
        console.log(`[open-terminal] macOS bridge, pipe=${pipeName}`);
      } else {
        bashCmd = `cd "${safeCwd}" && ${command}`;
        console.log('[open-terminal] macOS direct');
      }
      // Escape double-quotes for embedding inside an AppleScript string literal
      const safeForAS = bashCmd.replace(/"/g, '\\"');
      // Open window, set it to a comfortable size (160×50), and bring Terminal to front.
      // Creates (once) an "Overlord Bridge" settings set that shows only the custom title —
      // no process name, no arguments, no window size — keeping the title bar short.
      const script = [
        'tell application "Terminal"',
        '  -- Create/update the Overlord Bridge profile to show only custom title',
        '  if not (exists settings set "Overlord Bridge") then',
        '    make new settings set with properties {name:"Overlord Bridge"}',
        '  end if',
        '  tell settings set "Overlord Bridge"',
        '    set title displays custom title to true',
        '    set title displays shell path to false',
        '    set title displays device name to false',
        '    set title displays window size to false',
        '    set title displays settings name to false',
        '  end tell',
        `  set t to do script "${safeForAS}"`,
        '  set current settings of t to settings set "Overlord Bridge"',
        `  set custom title of t to "${safeTitle}"`,
        '  tell window 1',
        '    set number of columns to 160',
        '    set number of rows to 50',
        '  end tell',
        '  activate',
        'end tell',
      ].join('\n');
      console.log('[open-terminal] osascript:', script.split('\n')[0]);
      child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    } else {
      // Windows: use cmd.exe start command
      const safeBridge = bridgePath.replace(/\//g, '\\');
      let fullCmd: string;
      if (bridgeExists && pipeName) {
        // Run bridge directly (no cmd.exe /K) so it owns the console from row 0.
        fullCmd = `start "${windowTitle}" /D "${cwd}" ${safeBridge} --pipe ${pipeName} -- ${command}`;
        console.log(`[open-terminal] using bridge, pipe=${pipeName}`);
      } else {
        // Direct spawn — run command in a new terminal window.
        // If command starts with a quoted exe path, use start directly (no cmd.exe /K wrapper)
        // to avoid nested quote parsing issues. Otherwise wrap in cmd.exe /K.
        if (command.startsWith('"')) {
          fullCmd = `start "${windowTitle}" /D "${cwd}" ${command}`;
        } else {
          fullCmd = `start "${windowTitle}" /D "${cwd}" cmd.exe /K ${command}`;
        }
        console.log('[open-terminal] direct spawn');
      }
      console.log('[open-terminal] running:', fullCmd);
      child = spawn(fullCmd, [], { shell: true, stdio: 'ignore' });
    }

    child.on('error', (err) => {
      console.log('[open-terminal] error:', err.message);
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[open-terminal] success');
        resolve();
      } else {
        reject(new Error(`terminal open exited with code ${code}`));
      }
    });
  });
}

/**
 * Find the TTY device path of the terminal hosting a bridge session (macOS only).
 * Uses: claude PID → parent PID (bridge process) → ps tty.
 * Returns e.g. "/dev/ttys003", or "" on failure or non-macOS.
 *
 * Note: We intentionally do NOT use the GETTY pipe command here because old bridge
 * binaries (without GETTY support) would forward "GETTY\n" as text input to Claude.
 */
export function queryBridgeTTY(claudePid: number | undefined): string {
  if (process.platform !== 'darwin' || !claudePid) return '';
  try {
    const ppidOut = execSync(`ps -o ppid= -p ${claudePid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    const bridgePid = parseInt(ppidOut);
    if (isNaN(bridgePid) || bridgePid <= 1) return '';
    const ttyOut = execSync(`ps -o tty= -p ${bridgePid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!ttyOut || ttyOut === '??' || ttyOut === '?') return '';
    return `/dev/${ttyOut}`;
  } catch { return ''; }
}
