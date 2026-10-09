import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const NOTE_MAX_BYTES = 1024 * 1024; // 1 MB
const NOTE_ID_RE = /^note-[a-z0-9-]+$/;

/** Resolved per call so tests can stub $HOME. */
function notesDir(): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'notes');
}

export function isNoteId(id: string): boolean {
  return NOTE_ID_RE.test(id);
}

export const NOTE_PREVIEW_LINES = 20;

/** First non-empty lines, markdown markers stripped — the worker's preview. */
export function notePreview(content: string): string {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const text = line
      .replace(/^[\s#>*\-+_`~]+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (!text) continue;
    lines.push(text.slice(0, 160));
    if (lines.length === NOTE_PREVIEW_LINES) break;
  }
  return lines.join('\n');
}

function notePath(id: string): string {
  if (!isNoteId(id)) throw new Error(`invalid note id: ${id}`);
  return path.join(notesDir(), `${id}.md`);
}

/** Markdown content of notepad sessions — one file per note under
 *  `~/.claude/overlord/notes/`. Same atomic-write scheme as scratchpadStore. */
class NoteStore {
  load(id: string): { content: string; mtime: number } {
    const file = notePath(id);
    try {
      const stat = fs.statSync(file);
      return { content: fs.readFileSync(file, 'utf-8'), mtime: stat.mtimeMs };
    } catch {
      return { content: '', mtime: 0 };
    }
  }

  save(id: string, content: string): { mtime: number } {
    const file = notePath(id);
    if (Buffer.byteLength(content, 'utf-8') > NOTE_MAX_BYTES) {
      throw new Error('note content exceeds 1 MB');
    }
    fs.mkdirSync(notesDir(), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    return { mtime: fs.statSync(file).mtimeMs };
  }

  remove(id: string): void {
    try { fs.unlinkSync(notePath(id)); } catch { /* already gone */ }
  }
}

export const noteStore = new NoteStore();
