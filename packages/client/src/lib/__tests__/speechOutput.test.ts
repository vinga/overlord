import { describe, expect, it } from 'vitest';
import { MAX_SPOKEN_CHARS, looksPolish, pickEngine, pickVoice, toSpokenText } from '../speechOutput';

describe('toSpokenText', () => {
  it('drops fenced and inline code', () => {
    expect(toSpokenText('Fixed it.\n```ts\nconst a = 1;\n```\nRun `npm test` now.'))
      .toBe('Fixed it. Run now.');
  });

  it('drops an unclosed code fence', () => {
    expect(toSpokenText('Here:\n```\nhalf a block')).toBe('Here:');
  });

  it('keeps link labels but not URLs', () => {
    expect(toSpokenText('See [the PR](https://github.com/x/y/pull/1) and https://example.com.'))
      .toBe('See the PR and');
  });

  it('drops file paths', () => {
    expect(toSpokenText('Changed /Users/me/src/app.ts:12 and ./lib/x.ts done'))
      .toBe('Changed and done');
  });

  it('strips markdown markup', () => {
    expect(toSpokenText('## Summary\n- **Bold** point\n- _second_ point\n> quoted'))
      .toBe('Summary Bold point second point quoted');
  });

  it('drops tables', () => {
    expect(toSpokenText('Results:\n| a | b |\n|---|---|\n| 1 | 2 |\nAll good.')).toBe('Results: All good.');
  });

  it('cuts long text at a sentence end and says there is more', () => {
    const sentence = 'This is a sentence of moderate length here. ';
    const out = toSpokenText(sentence.repeat(20));
    expect(out.endsWith('here. More in the panel.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + ' More in the panel.'.length);
  });

  it('falls back to a word boundary when there is no sentence end', () => {
    const out = toSpokenText('word '.repeat(200));
    expect(out).toMatch(/word… More in the panel\.$/);
  });

  it('treats an upstream-truncated reply as cut, dropping the fragment', () => {
    expect(toSpokenText('All tests pass now. The remaining issue is the inj', MAX_SPOKEN_CHARS, { truncated: true }))
      .toBe('All tests pass now. More in the panel.');
  });

  it('returns empty for a code-only reply', () => {
    expect(toSpokenText('```\nonly code\n```')).toBe('');
  });
});

describe('pickVoice', () => {
  const v = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

  it('prefers an exact Google voice', () => {
    const voices = [v('Zosia', 'pl-PL'), v('Google polski', 'pl-PL'), v('Google US English', 'en-US')];
    expect(pickVoice(voices, 'pl-PL')?.name).toBe('Google polski');
  });

  it('falls back to the same base language', () => {
    expect(pickVoice([v('Daniel', 'en-GB')], 'en-US')?.name).toBe('Daniel');
  });

  it('returns null when no voice speaks the language', () => {
    expect(pickVoice([v('Daniel', 'en-GB')], 'pl-PL')).toBeNull();
  });
});

describe('looksPolish', () => {
  it('spots Polish diacritics', () => {
    expect(looksPolish('Zrobione, wszystko działa.')).toBe(true);
  });

  it('spots ASCII-only Polish by its words', () => {
    expect(looksPolish('Teraz jest gotowe, tylko test.')).toBe(true);
  });

  it('leaves English alone', () => {
    expect(looksPolish('All tests pass now. I pushed it to main.')).toBe(false);
    expect(looksPolish('Go to the panel')).toBe(false);
  });
});

describe('pickEngine', () => {
  it('uses Kokoro for English when chosen and usable', () => {
    expect(pickEngine('kokoro', 'All tests pass.', 'en-US', true)).toBe('kokoro');
  });

  it('falls back to Chrome for Polish text or a Polish language setting', () => {
    expect(pickEngine('kokoro', 'Wszystko działa.', 'en-US', true)).toBe('chrome');
    expect(pickEngine('kokoro', 'All tests pass.', 'pl-PL', true)).toBe('chrome');
  });

  it('falls back to Chrome when Kokoro is unusable or not chosen', () => {
    expect(pickEngine('kokoro', 'All tests pass.', 'en-US', false)).toBe('chrome');
    expect(pickEngine('chrome', 'All tests pass.', 'en-US', true)).toBe('chrome');
    expect(pickEngine(undefined, 'All tests pass.', 'en-US', true)).toBe('chrome');
  });
});
