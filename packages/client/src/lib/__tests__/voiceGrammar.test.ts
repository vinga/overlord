import { describe, expect, it } from 'vitest';
import {
  classifyUtterance,
  fuzzyName,
  isCommitWord,
  matchStart,
  matchTrailingPhrase,
  phraseEquals,
  phraseList,
  similarity,
  stripTrailing,
  stripLeadingAddress,
  tokenize,
} from '../voiceGrammar';

describe('tokenize', () => {
  it('strips punctuation but keeps spans into the original', () => {
    const t = tokenize('Overlord, fix it!');
    expect(t.map(x => x.word)).toEqual(['overlord', 'fix', 'it']);
    expect('Overlord, fix it!'.slice(t[1].start)).toBe('fix it!');
  });

  it('keeps apostrophes and hyphens inside words', () => {
    expect(tokenize("don't re-run").map(x => x.word)).toEqual(["don't", 're-run']);
  });

  it('normalizes the smart apostrophe STT emits', () => {
    expect(tokenize('don’t').map(x => x.word)).toEqual(["don't"]);
  });
});

describe('matchStart', () => {
  it('returns the text after the start word, preserving original casing', () => {
    const r = matchStart('overlord Fix the Enter bug', 'overlord');
    expect(r.matched).toBe(true);
    expect(r.rest).toBe('Fix the Enter bug');
  });

  it('ignores anything spoken before the start word', () => {
    expect(matchStart('um so anyway overlord fix the bug', 'overlord').rest).toBe('fix the bug');
  });

  it('does not match when the start word is absent', () => {
    expect(matchStart('fix the bug', 'overlord').matched).toBe(false);
  });

  it('matches a multi-word start phrase', () => {
    expect(matchStart('hey overlord fix it', 'hey overlord').rest).toBe('fix it');
  });

  it('wakes on a word that extends the wake phrase — deliberate', () => {
    // "overlords", "overlord's" and even "overlordian" all begin with the whole
    // phrase. Accepting them costs nothing (no common word starts with
    // "overlord") and buys the plural and possessive the engine often returns.
    expect(matchStart('overlords fix it', 'overlord').matched).toBe(true);
    expect(matchStart("overlord's fix it", 'overlord').matched).toBe(true);
  });

  // Speech engines mangle uncommon words; these are the shapes they actually
  // produce for "overlord", and every one of them must still wake.
  it('matches when the engine splits the word — "over lord"', () => {
    const r = matchStart('over lord fix the enter bug', 'overlord');
    expect(r.matched).toBe(true);
    expect(r.rest).toBe('fix the enter bug');
  });

  it('matches a near-miss substitution — "overload"', () => {
    const r = matchStart('overload fix the enter bug', 'overlord');
    expect(r.matched).toBe(true);
    expect(r.rest).toBe('fix the enter bug');
  });

  it('matches a split near-miss — "over load"', () => {
    expect(matchStart('over load fix it', 'overlord').rest).toBe('fix it');
  });

  it('rejects ordinary words that merely share the "over" stem', () => {
    // Measured: overlap 0.625, over 0.550, overview 0.500, overnight 0.444.
    for (const line of ['overlap the calls', 'over there', 'the overview page', 'overnight builds']) {
      expect(matchStart(line, 'overlord').matched).toBe(false);
    }
  });

  it('accepts that a couple of real words fall inside the floor', () => {
    // "overboard" (0.778) and "overlooked" (0.700) do wake. Deliberate: a false
    // wake only opens capture and is discarded by "cancel" or the cap, whereas
    // a missed wake looks like a dead feature. Pinned so the trade is explicit
    // rather than discovered later as a surprise.
    expect(matchStart('overboard fix it', 'overlord').matched).toBe(true);
    expect(matchStart('overlooked fix it', 'overlord').matched).toBe(true);
  });

  it('matches with a filler wedged into the seam — "over the lord"', () => {
    expect(matchStart('over the lord fix it', 'overlord').rest).toBe('fix it');
    expect(matchStart('over uh lord fix it', 'overlord').rest).toBe('fix it');
  });

  it('matches a looser substitution — "overlot"', () => {
    expect(matchStart('overlot fix it', 'overlord').matched).toBe(true);
  });

  it('does not let a filler open a match', () => {
    expect(matchStart('the lord will provide', 'overlord').matched).toBe(false);
  });

  // Whatever the engine actually returned for the wake word must be removed
  // from the prompt — not just a literal "overlord". Otherwise the mangled
  // variant would be sent to the worker as the first word of the instruction.
  it('strips the mangled variant, however many tokens it took', () => {
    expect(matchStart('overload say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('overlot say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('overlords say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('over lord say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('over load say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('over the lord say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('over uh lord say hi', 'overlord').rest).toBe('say hi');
    expect(matchStart('o ver lord say hi', 'overlord').rest).toBe('say hi');
  });

  it('also drops anything said before the wake word', () => {
    expect(matchStart('um so anyway overload say hi', 'overlord').rest).toBe('say hi');
  });

  it('does not wake on an unrelated word of similar length', () => {
    expect(matchStart('overnight builds are fine', 'overlord').matched).toBe(false);
    expect(matchStart('the offer looks good', 'overlord').matched).toBe(false);
  });

  it('tolerates a split in a worker name too', () => {
    const r = matchStart('mor ion fix the bug', 'overlord', ['morion']);
    expect(r.viaName).toBe('morion');
    expect(r.rest).toBe('fix the bug');
  });

  it('reports the worker name that opened capture', () => {
    const r = matchStart('morion fix the bug', 'overlord', ['morion']);
    expect(r.viaName).toBe('morion');
    expect(r.rest).toBe('fix the bug');
  });

  it('prefers the longest phrase at the same position', () => {
    const r = matchStart('overlord bridge fix it', 'overlord', ['overlord bridge']);
    expect(r.viaName).toBe('overlord bridge');
    expect(r.rest).toBe('fix it');
  });

  it('prefers the earliest match over the longest', () => {
    const r = matchStart('morion tell overlord bridge hi', 'overlord', ['morion', 'overlord bridge']);
    expect(r.viaName).toBe('morion');
  });

  it('returns empty rest when only the start word was said', () => {
    expect(matchStart('overlord', 'overlord')).toMatchObject({ matched: true, rest: '', viaName: undefined });
  });

  it('prefers the last wake word when asked, for restarting an utterance', () => {
    const r = matchStart('overlord wrong thing overlord right thing', 'overlord', [], 'last');
    expect(r.rest).toBe('right thing');
    const first = matchStart('overlord wrong thing overlord right thing', 'overlord');
    expect(first.rest).toBe('wrong thing overlord right thing');
    expect(r.at).toBeGreaterThan(first.at);
  });
});

describe('isCommitWord', () => {
  const PAUSE = 500;

  it('commits when the word arrives on its own after a pause', () => {
    expect(isCommitWord('go', 'go', PAUSE)).toBe(true);
  });

  it('does not commit without the pause', () => {
    expect(isCommitWord('go', 'go', 100)).toBe(false);
  });

  it('does NOT commit when the word is inside a larger chunk — "go ahead"', () => {
    expect(isCommitWord('go ahead and fix the injector', 'go', PAUSE)).toBe(false);
  });

  it('does NOT commit on a chunk that merely ends with the word', () => {
    // The pause was measured before the chunk, so it says nothing about a pause
    // before "go" — this is exactly the case the chunk rule exists to reject.
    expect(isCommitWord('fix the enter bug go', 'go', PAUSE)).toBe(false);
  });

  it('ignores surrounding punctuation and casing', () => {
    expect(isCommitWord(' Go. ', 'go', PAUSE)).toBe(true);
  });

  it('handles a multi-word commit phrase', () => {
    expect(isCommitWord('over and out', 'over and out', PAUSE)).toBe(true);
    expect(isCommitWord('over', 'over and out', PAUSE)).toBe(false);
    expect(isCommitWord('hand it over', 'over', PAUSE)).toBe(false);
  });
});

describe('phraseEquals', () => {
  it('is true only for an exact word sequence', () => {
    expect(phraseEquals('Over And Out!', 'over and out')).toBe(true);
    expect(phraseEquals('over and out now', 'over and out')).toBe(false);
  });

  it('is false for an empty phrase', () => {
    expect(phraseEquals('go', '')).toBe(false);
  });
});

describe('stripTrailing', () => {
  it('removes a trailing phrase and preserves casing', () => {
    expect(stripTrailing('Fix DetailPanel.tsx go', 'go')).toBe('Fix DetailPanel.tsx');
  });

  it('removes a trailing multi-word phrase', () => {
    expect(stripTrailing('fix the bug over and out', 'over and out')).toBe('fix the bug');
  });

  it('leaves text whose phrase is not trailing alone', () => {
    expect(stripTrailing('go ahead and fix it', 'go')).toBe('go ahead and fix it');
  });

  it('strips trailing punctuation with the phrase', () => {
    expect(stripTrailing('fix the bug, go.', 'go')).toBe('fix the bug,');
  });

  it('returns empty when the text is only the phrase', () => {
    expect(stripTrailing('go', 'go')).toBe('');
  });
});

describe('classifyUtterance', () => {
  it('treats a lone bare verb as a command', () => {
    expect(classifyUtterance('stop')).toMatchObject({ kind: 'control', verb: 'stop' });
  });

  it('treats a bare verb with a tail as a prompt', () => {
    expect(classifyUtterance('stop using that pattern')).toMatchObject({
      kind: 'prompt',
      text: 'stop using that pattern',
    });
  });

  it('takes the tail of an arg verb as its argument', () => {
    expect(classifyUtterance('select morion')).toMatchObject({
      kind: 'control',
      verb: 'select',
      arg: 'morion',
    });
  });

  it('treats a bare arg verb with no argument as a prompt', () => {
    expect(classifyUtterance('select')).toMatchObject({ kind: 'prompt' });
  });

  it('classifies a permission answer as a command', () => {
    expect(classifyUtterance('yes')).toMatchObject({ kind: 'control', verb: 'yes' });
    expect(classifyUtterance('escape')).toMatchObject({ kind: 'control', verb: 'escape' });
  });

  it('returns an empty prompt for empty input', () => {
    expect(classifyUtterance('   ')).toEqual({ kind: 'prompt', text: '' });
  });
});

describe('similarity / fuzzyName', () => {
  const workers = [
    { id: 'ovr-1', name: 'morion' },
    { id: 'ovr-2', name: 'atlas' },
  ];

  it('scores an exact match at 1', () => {
    expect(similarity('morion', 'Morion')).toBe(1);
  });

  it('hits on an exact name', () => {
    expect(fuzzyName('morion', workers, 0.72)).toMatchObject({ kind: 'hit', id: 'ovr-1' });
  });

  it('hits on a mangled name above the floor', () => {
    expect(fuzzyName('marion', workers, 0.72)).toMatchObject({ kind: 'hit', id: 'ovr-1' });
  });

  it('misses rather than guessing below the floor', () => {
    expect(fuzzyName('zeppelin', workers, 0.72)).toEqual({ kind: 'miss' });
  });

  it('reports ambiguity when two names are equally close to what was heard', () => {
    const twins = [
      { id: 'ovr-1', name: 'morion' },
      { id: 'ovr-2', name: 'narion' },
    ];
    const r = fuzzyName('marion', twins, 0.72);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map(c => c.name)).toEqual(['morion', 'narion']);
    }
  });

  it('lets an exact match win over a near-miss instead of calling it ambiguous', () => {
    const twins = [
      { id: 'ovr-1', name: 'morion' },
      { id: 'ovr-2', name: 'morian' },
    ];
    expect(fuzzyName('morion', twins, 0.72)).toMatchObject({ kind: 'hit', id: 'ovr-1' });
  });

  it('misses on an empty roster', () => {
    expect(fuzzyName('morion', [], 0.72)).toEqual({ kind: 'miss' });
  });
});

describe('stripLeadingAddress', () => {
  const workers = [{ id: 'ovr-1', name: 'morion' }];

  it('splits an address off the front of a prompt', () => {
    const r = stripLeadingAddress('morion fix the enter bug', workers, 0.9);
    expect(r.match).toMatchObject({ kind: 'hit', id: 'ovr-1' });
    expect(r.text).toBe('fix the enter bug');
  });

  it('leaves an unaddressed prompt whole', () => {
    const r = stripLeadingAddress('fix the enter bug', workers, 0.9);
    expect(r.match).toEqual({ kind: 'miss' });
    expect(r.text).toBe('fix the enter bug');
  });

  it('refuses to treat a bare name with no payload as an address', () => {
    expect(stripLeadingAddress('morion', workers, 0.9).match).toEqual({ kind: 'miss' });
  });

  it('prefers the longest matching name prefix', () => {
    const two = [
      { id: 'ovr-1', name: 'morion' },
      { id: 'ovr-2', name: 'morion bridge' },
    ];
    const r = stripLeadingAddress('morion bridge fix it', two, 0.9);
    expect(r.match).toMatchObject({ kind: 'hit', id: 'ovr-2' });
    expect(r.text).toBe('fix it');
  });
});

describe('matchTrailingPhrase — the stop word tolerates mangling too', () => {
  it('strips an exact trailing stop word', () => {
    expect(matchTrailingPhrase('fix the enter bug go', 'go'))
      .toEqual({ hit: true, stripped: 'fix the enter bug' });
  });

  it('does not fire on a word that merely resembles a short stop word', () => {
    // Short words are naturally protected: "going" scores 0.46 against "go".
    expect(matchTrailingPhrase('the build is going', 'go').hit).toBe(false);
    expect(matchTrailingPhrase('that was an hour ago', 'go').hit).toBe(false);
    expect(matchTrailingPhrase('what is the goal', 'go').hit).toBe(false);
  });

  it('matches a multi-word stop phrase that contains a filler word', () => {
    // "and" is normally skipped as filler — but not when the phrase owns it.
    expect(matchTrailingPhrase('fix the bug over and out', 'over and out'))
      .toEqual({ hit: true, stripped: 'fix the bug' });
  });

  it('matches a split multi-word stop phrase', () => {
    expect(matchTrailingPhrase('fix the bug over and owt', 'over and out').hit).toBe(true);
  });

  it('does not match a partial multi-word phrase', () => {
    expect(matchTrailingPhrase('hand it over', 'over and out').hit).toBe(false);
  });

  it('leaves text alone when the phrase is not at the end', () => {
    expect(matchTrailingPhrase('go ahead and fix it', 'go'))
      .toEqual({ hit: false, stripped: 'go ahead and fix it' });
  });

  it('preserves casing and inner punctuation of what remains', () => {
    expect(matchTrailingPhrase('Fix DetailPanel.tsx, go.', 'go').stripped).toBe('Fix DetailPanel.tsx,');
  });

  it('returns empty when the text is only the stop word', () => {
    expect(matchTrailingPhrase('go', 'go')).toEqual({ hit: true, stripped: '' });
  });
});

describe('comma-separated alternatives', () => {
  it('splits a setting into alternatives', () => {
    expect(phraseList('overlord, overload , over lord')).toEqual(['overlord', 'overload', 'over lord']);
    expect(phraseList('  ')).toEqual([]);
  });

  it('wakes on any listed alternative', () => {
    const setting = 'overlord, of a lord, hey boss';
    expect(matchStart('of a lord say hi', setting).rest).toBe('say hi');
    expect(matchStart('hey boss say hi', setting).rest).toBe('say hi');
    expect(matchStart('overlord say hi', setting).rest).toBe('say hi');
  });

  it('still rejects speech matching none of them', () => {
    expect(matchStart('the meeting is over', 'overlord, hey boss').matched).toBe(false);
  });

  it('commits on any listed stop-word alternative', () => {
    expect(matchTrailingPhrase('fix it over and out', 'go, over and out').hit).toBe(true);
    expect(matchTrailingPhrase('fix it go', 'go, over and out').hit).toBe(true);
    expect(matchTrailingPhrase('fix it now', 'go, over and out').hit).toBe(false);
  });

  it('strips only the alternative that matched', () => {
    expect(matchTrailingPhrase('fix it over and out', 'go, over and out').stripped).toBe('fix it');
  });
});
