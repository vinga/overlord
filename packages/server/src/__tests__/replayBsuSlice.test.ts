import { describe, it, expect } from 'vitest';
import { sliceBufferFromLastBsu } from '../api/wsHandler.js';

const BSU = Buffer.from('\x1b[?2026h');
const BESU = Buffer.from('\x1b[?2026l');

describe('sliceBufferFromLastBsu', () => {
  it('returns [] for undefined / empty buffer', () => {
    expect(sliceBufferFromLastBsu(undefined)).toEqual([]);
    expect(sliceBufferFromLastBsu([])).toEqual([]);
  });

  it('returns [] when no BSU marker is present (buffer is mid-work tool output)', () => {
    const chunks = [
      Buffer.from('Write(file.ts)\r\n'),
      Buffer.from('  Wrote 40 lines\r\n'),
      Buffer.from('Read(other.ts)\r\n'),
    ];
    expect(sliceBufferFromLastBsu(chunks)).toEqual([]);
  });

  it('returns chunks from the last BSU onward', () => {
    const chunks = [
      Buffer.from('old output'),
      Buffer.concat([BSU, Buffer.from('first frame')]),
      Buffer.from('deltas after first frame'),
      Buffer.concat([BSU, Buffer.from('second frame')]),
      Buffer.from('deltas after second frame'),
    ];
    const slice = sliceBufferFromLastBsu(chunks);
    expect(slice.length).toBe(2);
    expect(slice[0].indexOf(BSU)).toBeGreaterThanOrEqual(0);
    expect(slice[1].toString()).toBe('deltas after second frame');
  });

  it('single BSU at buffer start replays whole buffer', () => {
    const chunks = [
      Buffer.concat([BSU, Buffer.from('frame')]),
      Buffer.from('delta 1'),
      Buffer.from('delta 2'),
    ];
    const slice = sliceBufferFromLastBsu(chunks);
    expect(slice.length).toBe(3);
  });

  it('single BSU as last chunk replays only that chunk', () => {
    const chunks = [
      Buffer.from('delta 1'),
      Buffer.from('delta 2'),
      Buffer.concat([BSU, Buffer.from('fresh frame')]),
    ];
    const slice = sliceBufferFromLastBsu(chunks);
    expect(slice.length).toBe(1);
    expect(slice[0].indexOf(BSU)).toBeGreaterThanOrEqual(0);
  });

  it('BESU (\\x1b[?2026l) alone does NOT count as a frame start', () => {
    const chunks = [
      Buffer.from('delta 1'),
      Buffer.concat([BESU, Buffer.from('frame-end-only')]),
    ];
    expect(sliceBufferFromLastBsu(chunks)).toEqual([]);
  });

  it('handles 500 chunks with BSU late in buffer — picks the late one', () => {
    const chunks: Buffer[] = [];
    for (let i = 0; i < 500; i++) chunks.push(Buffer.from(`chunk ${i}`));
    chunks[450] = Buffer.concat([BSU, Buffer.from('late frame')]);
    const slice = sliceBufferFromLastBsu(chunks);
    // 500 - 450 = 50 chunks from the late BSU onward
    expect(slice.length).toBe(50);
    expect(slice[0].indexOf(BSU)).toBeGreaterThanOrEqual(0);
  });
});
