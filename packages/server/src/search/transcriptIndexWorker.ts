import * as fs from 'fs';
import { parentPort } from 'worker_threads';

/** Where in a conversation a query matched. */
export type ConversationSource = 'you' | 'agent' | 'tool';

/** Tool inputs can be whole files (Write, Edit); only their head is searchable. */
const TOOL_INPUT_CAP = 2048;
const READ_CHUNK = 1 << 20;

interface FileIndex {
  size: number;
  offset: number;
  /** Bytes after the last newline, carried into the next read. */
  partial: string;
  you: string;
  agent: string;
  tool: string;
}

type Sink = (source: ConversationSource, text: string) => void;

/** Injected, not typed by the user: command echoes, hook output, reminders. */
function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<command-') || t.startsWith('<local-command-') || t.startsWith('<system-reminder>')
    || t.startsWith('<task-notification>') || t.startsWith('Caveat:')
    || t.startsWith('<environment_context>') || t.startsWith('<user_instructions>') || t.startsWith('# AGENTS.md');
}

function toolText(name: unknown, input: unknown): string {
  const body = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return `${typeof name === 'string' ? name : ''} ${body.slice(0, TOOL_INPUT_CAP)}`;
}

/** Claude Code transcript line. */
function classifyClaude(d: Record<string, unknown>, sink: Sink): void {
  if (d.isMeta || d.isCompactSummary) return;
  const msg = d.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (d.type === 'user') {
    if (typeof content === 'string') { if (!isInjected(content)) sink('you', content); return; }
    if (!Array.isArray(content)) return;
    for (const b of content as Array<Record<string, unknown>>) {
      // tool_result blocks ride on user lines but are tool output — not indexed.
      if (b?.type === 'text' && typeof b.text === 'string' && !isInjected(b.text)) sink('you', b.text);
    }
    return;
  }
  if (d.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === 'text' && typeof b.text === 'string') sink('agent', b.text);
      else if (b?.type === 'tool_use') sink('tool', toolText(b.name, b.input));
    }
  }
}

/** Codex rollout line (`response_item` payloads only). */
function classifyCodex(d: Record<string, unknown>, sink: Sink): void {
  const p = d.payload as Record<string, unknown> | undefined;
  if (!p) return;
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
    for (const part of p.content as Array<Record<string, unknown>>) {
      if (typeof part?.text !== 'string') continue;
      if (p.role === 'user') { if (!isInjected(part.text)) sink('you', part.text); }
      else sink('agent', part.text);
    }
  } else if (p.type === 'function_call') {
    sink('tool', toolText(p.name, p.arguments));
  } else if (p.type === 'custom_tool_call') {
    sink('tool', toolText(p.name, p.input));
  }
}

/** Index one JSONL line into `sink`. Unknown shapes and bad JSON are skipped. */
export function classifyLine(line: string, sink: Sink): void {
  if (!line) return;
  let d: unknown;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object') return;
  const rec = d as Record<string, unknown>;
  if (rec.type === 'response_item') classifyCodex(rec, sink);
  else classifyClaude(rec, sink);
}

/**
 * Lowercased user / agent / tool-call text per transcript, read incrementally:
 * a file that grew is read only from where the last read stopped; one that
 * shrank (rewritten) is read again from the start.
 */
export class TranscriptIndex {
  private files = new Map<string, FileIndex>();

  private update(path: string): FileIndex | null {
    let size: number;
    try { size = fs.statSync(path).size; } catch { this.files.delete(path); return null; }
    let idx = this.files.get(path);
    if (!idx || size < idx.size) {
      idx = { size: 0, offset: 0, partial: '', you: '', agent: '', tool: '' };
      this.files.set(path, idx);
    }
    if (size === idx.offset) return idx;
    const parts: Record<ConversationSource, string[]> = { you: [], agent: [], tool: [] };
    const sink: Sink = (source, text) => { parts[source].push(text.toLowerCase()); };
    let fd: number;
    try { fd = fs.openSync(path, 'r'); } catch { return idx; }
    try {
      const buf = Buffer.alloc(READ_CHUNK);
      let pos = idx.offset;
      let carry = idx.partial;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(READ_CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) classifyLine(line, sink);
      }
      idx.offset = pos;
      idx.partial = carry;
      idx.size = size;
    } finally {
      fs.closeSync(fd);
    }
    for (const k of ['you', 'agent', 'tool'] as const) {
      if (parts[k].length) idx[k] += (idx[k] ? '\n' : '') + parts[k].join('\n');
    }
    return idx;
  }

  /** Sources that contain `query` (case-insensitive) per file; files with no match are left out. */
  search(query: string, paths: string[]): Record<string, ConversationSource[]> {
    const q = query.toLowerCase();
    const out: Record<string, ConversationSource[]> = {};
    for (const p of paths) {
      const idx = this.update(p);
      if (!idx) continue;
      const hits = (['you', 'agent', 'tool'] as const).filter(k => idx[k].includes(q));
      if (hits.length) out[p] = hits;
    }
    return out;
  }

  /** Total indexed characters, for the one-off size log. */
  chars(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.you.length + f.agent.length + f.tool.length;
    return n;
  }
}

// ── Worker entry ────────────────────────────────────────────────────────────
// Runs off the main thread: the first search parses every transcript (GBs of
// JSONL), which would otherwise freeze WebSocket broadcasts and PTY relays.
// This file has no relative imports on purpose: a worker does not inherit
// tsx's loader in dev, and Node strips the types of a self-contained .ts file
// natively. In tests (main thread) parentPort is null and nothing attaches.
if (parentPort) {
  const index = new TranscriptIndex();
  let logged = false;
  parentPort.on('message', (msg: { id: number; q: string; paths: string[] }) => {
    const started = Date.now();
    try {
      const result = index.search(msg.q, msg.paths);
      if (!logged) {
        logged = true;
        console.log(`[search-index] built in ${Date.now() - started}ms: ${msg.paths.length} transcripts, ${(index.chars() / 1e6).toFixed(1)}M chars`);
      }
      parentPort?.postMessage({ id: msg.id, result });
    } catch (err) {
      parentPort?.postMessage({ id: msg.id, error: (err as Error).message });
    }
  });
}
