import { afterEach, describe, expect, it } from 'vitest';
import { MacSpeechRelay, macSpeechAvailability, type SpeechOut } from '../macSpeech.js';

// A fake helper: echoes each stdin command back as a result line, emits a
// malformed line and an error on 'start', and exits on {"cmd":"crash"}.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.cmd === 'crash') process.exit(3);
  if (m.cmd === 'start') {
    process.stdout.write('not json\\n');
    process.stdout.write(JSON.stringify({ type: 'error', message: 'boom' }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'result', transcript: 'got ' + m.cmd + (m.lang ? ' ' + m.lang : ''), isFinal: m.cmd === 'reset' }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

function relay(): MacSpeechRelay {
  return new MacSpeechRelay({ command: { cmd: process.execPath, args: ['-e', FAKE] } });
}

function collector() {
  const got: SpeechOut[] = [];
  return { got, sink: (m: SpeechOut) => { got.push(m); } };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}

let r: MacSpeechRelay | null = null;
afterEach(() => { r?.dispose(); r = null; });

describe('MacSpeechRelay', () => {
  it('spawns on first start and relays results + errors, skipping malformed lines', async () => {
    r = relay();
    const a = collector();
    expect(r.isRunning()).toBe(false);
    r.start('a', a.sink, 'en-US');
    expect(r.isRunning()).toBe(true);
    await until(() => a.got.length >= 2);
    expect(a.got).toEqual([
      { type: 'speech:error', message: 'boom' },
      { type: 'speech:result', transcript: 'got start en-US', isFinal: false },
    ]);
  });

  it('only sends to subscribers and forwards reset', async () => {
    r = relay();
    const a = collector();
    const b = collector();
    r.start('a', a.sink, 'en-US');
    await until(() => a.got.length >= 2);
    r.reset('b'); // not subscribed: ignored
    r.reset('a');
    await until(() => a.got.length >= 3);
    expect(a.got[2]).toEqual({ type: 'speech:result', transcript: 'got reset', isFinal: true });
    expect(b.got).toEqual([]);
  });

  it('kills the helper only when the last subscriber stops', async () => {
    r = relay();
    const a = collector();
    const b = collector();
    r.start('a', a.sink, 'en-US');
    r.start('b', b.sink, 'en-US');
    r.stop('a');
    expect(r.isRunning()).toBe(true);
    expect(r.subscriberCount()).toBe(1);
    r.stop('b');
    expect(r.isRunning()).toBe(false);
    r.stop('b'); // idempotent
  });

  it('reports an unexpected helper exit as an error', async () => {
    r = relay();
    const a = collector();
    r.start('a', a.sink, 'en-US');
    await until(() => a.got.length >= 2);
    (r as unknown as { write(o: object): void }).write({ cmd: 'crash' });
    await until(() => a.got.some(m => m.type === 'speech:error' && m.message.includes('exited')));
    expect(r.isRunning()).toBe(false);
  });

  it('reports a missing binary instead of spawning', () => {
    r = new MacSpeechRelay({ binary: '/nonexistent/overlord-speech' });
    const a = collector();
    r.start('a', a.sink, 'en-US');
    expect(r.isRunning()).toBe(false);
    expect(a.got[0]?.type).toBe('speech:error');
  });
});

describe('macSpeechAvailability', () => {
  it('is unavailable when the binary is missing', () => {
    expect(macSpeechAvailability('/nonexistent/overlord-speech').available).toBe(false);
  });
});
