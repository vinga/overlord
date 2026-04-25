// Shared "Compacting conversation" detector for both PTY and bridge output streams.
// Maintains a rolling stripped-text buffer per key so matches across chunk boundaries
// are caught. Clears after every successful match to prevent duplicate triggers on the
// same spinner frame sequence.

const BUF_SIZE = 500;
const buffers = new Map<string, string>();

function stripForMatch(raw: string): string {
  return raw
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[^\x20-\x7e\n\t\r]/g, (ch) => /\s/.test(ch) ? ' ' : '');
}

export function feedCompactDetector(
  key: string,
  chunk: string,
  onDetect: (line: string) => void,
): void {
  // Hot path: PTY data callback fires hundreds of times per second during
  // session resume / claude streaming. The 5 regex passes in stripForMatch
  // are expensive — gate on a cheap substring before doing any of it.
  // Compact spinner always emits the literal "ompacting" (covers case where
  // 'C' falls on a chunk boundary). Anything else cannot become a match no
  // matter how the rolling buffer concatenates.
  const prev = buffers.get(key) ?? '';
  if (!prev && chunk.indexOf('ompacting') === -1) return;
  const stripped = stripForMatch(chunk);
  const combined = (prev + stripped).slice(-BUF_SIZE);
  buffers.set(key, combined);
  if (combined.includes('Compacting conversation')) {
    const match = combined.match(/Compacting conversation[^\n]*/);
    const line = match ? match[0].trim() : 'Compacting conversation…';
    onDetect(line);
    buffers.set(key, '');
  }
}

export function clearCompactDetector(key: string): void {
  buffers.delete(key);
}
