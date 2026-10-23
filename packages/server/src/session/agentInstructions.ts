import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Default behaviour rules for every agent session, served over REST so one
 * edit reaches every new session in any folder:
 *
 *  - Claude Code: a SessionStart hook curls GET /api/agent-instructions
 *    (installed by bin/install-agent-defaults).
 *  - Codex: has no SessionStart hook, but reads ~/.codex/AGENTS.md in every
 *    session — Overlord keeps a marked block there in sync.
 */

export type InstructionProvider = 'claude' | 'codex';

const BEGIN = '<!-- overlord:begin (managed by Overlord — edit via PUT /api/agent-instructions) -->';
const END = '<!-- overlord:end -->';

export const DEFAULT_INSTRUCTIONS = `## Long waits: never block, never poll in a loop

For anything that takes minutes (deploy, CI, rollout, waiting for a slot):
- Claude Code: run the poll with Bash \`run_in_background: true\`, using \`ovr-watch\` (on PATH) or a script. You are notified once when it exits.
- Codex: run \`ovr-watch --detach --label "<what>" --every 60 --until '<regex>' -- <check command>\`. It returns at once; you get one \`[ovr-watch] …\` message when it ends. Do not poll it.
- Scripts may print \`::progress id=<row> label="<text>" step=N/M state=<word>:: <message>\` lines. Overlord shows them live, pinned above the composer, at no token cost. \`ovr-watch --help\` has the details.
- No foreground \`sleep\`, and no wakeups or follow-up polls just to report progress.`;

function home(): string {
  // $HOME first so tests can stub it (os.homedir() ignores the env on macOS).
  return process.env.HOME ?? os.homedir();
}

function storePath(): string {
  return path.join(home(), '.claude', 'overlord', 'agent-instructions.md');
}

export function codexAgentsPath(): string {
  return path.join(home(), '.codex', 'AGENTS.md');
}

export function readInstructions(): string {
  try {
    const text = fs.readFileSync(storePath(), 'utf-8').trim();
    if (text) return text;
  } catch { /* first run */ }
  return DEFAULT_INSTRUCTIONS;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeInstructions(text: string): void {
  atomicWrite(storePath(), `${text.trim()}\n`);
}

/** Text for one provider. Same rules today; the parameter keeps room to diverge. */
export function instructionsFor(_provider: InstructionProvider): string {
  return readInstructions();
}

/** Replace (or append) the managed block, leaving everything else untouched. */
export function withManagedBlock(existing: string, body: string): string {
  const block = `${BEGIN}\n${body.trim()}\n${END}`;
  const start = existing.indexOf('<!-- overlord:begin');
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  if (existing.trim() === '') return `${block}\n`;
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** Keep ~/.codex/AGENTS.md's managed block in sync. Skipped when Codex is not installed. */
export function syncCodexAgentsMd(): 'written' | 'unchanged' | 'no-codex' {
  if (!fs.existsSync(path.join(home(), '.codex'))) return 'no-codex';
  const file = codexAgentsPath();
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf-8'); } catch { /* new file */ }
  const next = withManagedBlock(existing, instructionsFor('codex'));
  if (next === existing) return 'unchanged';
  atomicWrite(file, next);
  return 'written';
}
