import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRATCHPAD_DIR = path.join(os.homedir(), '.claude', 'overlord');
const SCRATCHPAD_PATH = path.join(SCRATCHPAD_DIR, 'scratchpad.md');

export const SCRATCHPAD_MAX_BYTES = 1024 * 1024; // 1 MB

class ScratchpadStore {
  load(): { content: string; mtime: number } {
    try {
      const stat = fs.statSync(SCRATCHPAD_PATH);
      const content = fs.readFileSync(SCRATCHPAD_PATH, 'utf-8');
      return { content, mtime: stat.mtimeMs };
    } catch {
      return { content: '', mtime: 0 };
    }
  }

  save(content: string): { mtime: number } {
    if (Buffer.byteLength(content, 'utf-8') > SCRATCHPAD_MAX_BYTES) {
      throw new Error('scratchpad content exceeds 1 MB');
    }
    fs.mkdirSync(SCRATCHPAD_DIR, { recursive: true });
    const tmp = `${SCRATCHPAD_PATH}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, SCRATCHPAD_PATH);
    return { mtime: fs.statSync(SCRATCHPAD_PATH).mtimeMs };
  }
}

export const scratchpadStore = new ScratchpadStore();
