// Codex's `exec` custom tool carries a JS snippet in `input` rather than JSON
// `arguments`, e.g. `const r=await tools.exec_command({cmd:"git status"});`.
// Without unpacking it every feed row reads "exec exec". The TUI shows
// "Ran <cmd>", so surface the inner tool calls and their shell commands.

const INNER_TOOL_NAMES: Record<string, string> = {
  exec_command: 'Bash',
  write_stdin: 'Bash',
  apply_patch: 'Edit',
  web__run: 'WebSearch',
};

export interface CodexExecSummary {
  toolName: string;
  content: string;
}

/** Decode a JS string literal body (without the quotes). */
function decodeJsString(body: string, quote: string): string {
  if (quote === '"') {
    try { return JSON.parse(`"${body}"`) as string; } catch { /* fall through */ }
  }
  return body.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

function extractStringArg(args: string, key: string): string | undefined {
  const re = new RegExp(`["']?${key}["']?\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`((?:[^\`\\\\]|\\\\.)*)\`)`);
  const m = re.exec(args);
  if (!m) return undefined;
  if (m[1] !== undefined) return decodeJsString(m[1], '"');
  if (m[2] !== undefined) return decodeJsString(m[2], "'");
  return decodeJsString(m[3], '`');
}

export function summarizeCodexExec(input: string): CodexExecSummary {
  const calls: Array<{ name: string; desc: string }> = [];
  const re = /tools\.([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const name = m[1];
    // Args run until the next inner call; good enough to find the first key.
    const next = input.indexOf('tools.', re.lastIndex);
    const args = input.slice(re.lastIndex, next === -1 ? undefined : next);
    const patchFiles = name === 'apply_patch'
      // The patch text is often bound to a variable first, so scan the whole input.
      ? [...new Set([...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\s\\]+)/g)].map(p => p[1]))]
      : [];
    // write_stdin with empty chars just polls a running command for output.
    const stdin = name === 'write_stdin' ? extractStringArg(args, 'chars') : undefined;
    const stdinDesc = stdin !== undefined ? (stdin ? `stdin: ${JSON.stringify(stdin)}` : 'poll output') : undefined;
    const desc = (patchFiles.length > 0 ? patchFiles.join(', ') : undefined)
      ?? stdinDesc
      ?? extractStringArg(args, 'cmd')
      ?? extractStringArg(args, 'q')
      ?? extractStringArg(args, 'ref_id')
      ?? extractStringArg(args, 'code')
      ?? '';
    calls.push({ name, desc: desc.split('\n')[0] });
  }
  if (calls.length === 0) {
    const firstLine = input.split('\n').map(l => l.trim()).find(Boolean) ?? '';
    return { toolName: 'exec', content: firstLine.slice(0, 300) };
  }
  const names = [...new Set(calls.map(c => INNER_TOOL_NAMES[c.name] ?? c.name))];
  const content = calls
    .map(c => c.desc || c.name)
    .join(' · ')
    .slice(0, 300);
  return { toolName: names.join(', '), content };
}

/** Flatten a Codex tool output (string or input_text blocks), dropping the
 *  "Script completed / Wall time / Output:" header. */
export function codexOutputText(output: unknown): { text: string; wallMs?: number; isError: boolean } {
  let text = '';
  if (typeof output === 'string') text = output;
  else if (Array.isArray(output)) {
    text = output.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') ? (b as { text: string }).text : '').join('');
  }
  const isError = /^Script (?:failed|error)/.test(text);
  let wallMs: number | undefined;
  const header = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/.exec(text);
  if (header) {
    wallMs = Math.round(parseFloat(header[1]) * 1000);
    text = text.slice(header[0].length);
  }
  return { text, wallMs, isError };
}
