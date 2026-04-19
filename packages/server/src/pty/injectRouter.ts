// Picks the correct injection strategy for sending bytes to a Claude Code
// session. Overlord-spawned PTYs MUST be written via ptyManager — CGEvent
// (injectViaMac) cannot reach node-pty children because there's no GUI terminal
// in their parent process chain.

export type InjectStrategy = 'pty' | 'pipe' | 'mac' | 'console';

export interface InjectDeps {
  ptyManager: { write(sessionId: string, data: string): boolean };
  isBridge: (sessionId: string) => boolean;
  injectViaPipe: (sessionId: string, text: string) => Promise<boolean>;
  injectViaMac: (pid: number, text: string, extraEnter?: boolean) => Promise<boolean>;
  injectText: (pid: number, text: string, extraEnter?: boolean, raw?: boolean) => Promise<void>;
  platform: NodeJS.Platform;
}

export interface InjectTarget {
  /** Claude session id — used for bridge pipe lookup and isBridge checks. */
  sessionId: string;
  /** Resolved pty session id (from ovrToPty). Undefined if not an Overlord PTY. */
  ptyId: string | undefined;
  /** Child process pid — used for OS-level injection fallbacks. */
  pid: number;
}

export interface InjectOptions {
  extraEnter?: boolean;
  raw?: boolean;
}

export async function injectToSession(
  deps: InjectDeps,
  target: InjectTarget,
  text: string,
  opts: InjectOptions = {},
): Promise<InjectStrategy> {
  if (target.ptyId && deps.ptyManager.write(target.ptyId, text)) {
    return 'pty';
  }
  if (deps.isBridge(target.sessionId)) {
    const ok = await deps.injectViaPipe(target.sessionId, text);
    if (ok) return 'pipe';
  }
  if (deps.platform === 'darwin') {
    await deps.injectViaMac(target.pid, text, opts.extraEnter ?? false);
    return 'mac';
  }
  await deps.injectText(target.pid, text, opts.extraEnter ?? false, opts.raw ?? true);
  return 'console';
}
