import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readTranscriptState,
  extractSkillsUsed,
  extractSkillToolUses,
  unionSkillNames,
  _resetCachesForTest,
} from '../session/transcriptReader.js';
import { mergeSkillsUsed } from '../session/stateManager.js';

function cmdSegment(name: string): string {
  return `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>`;
}

describe('extractSkillsUsed', () => {
  it('extracts command names without the leading slash, first-seen order', () => {
    const segments = [cmdSegment('/skill-pr-start'), 'plain user text', cmdSegment('/hy-ticket-refiner')];
    expect(extractSkillsUsed(segments)).toEqual(['skill-pr-start', 'hy-ticket-refiner']);
  });

  it('keeps alias forms verbatim', () => {
    const segments = [cmdSegment('/pr-start'), cmdSegment('/skill-pr-start')];
    expect(extractSkillsUsed(segments)).toEqual(['pr-start', 'skill-pr-start']);
  });

  it('filters built-in commands', () => {
    const segments = [cmdSegment('/compact'), cmdSegment('/clear'), cmdSegment('/skill-pr-done'), cmdSegment('/resume')];
    expect(extractSkillsUsed(segments)).toEqual(['skill-pr-done']);
  });

  it('de-duplicates repeated invocations', () => {
    const segments = [cmdSegment('/skill-jira'), cmdSegment('/skill-jira'), cmdSegment('/skill-jira')];
    expect(extractSkillsUsed(segments)).toEqual(['skill-jira']);
  });

  it('caps at 12', () => {
    const segments = Array.from({ length: 20 }, (_, i) => cmdSegment(`/skill-${i}`));
    expect(extractSkillsUsed(segments)).toHaveLength(12);
  });

  it('lowercases and supports namespaced names', () => {
    const segments = [cmdSegment('/Code-Review:code-review')];
    expect(extractSkillsUsed(segments)).toEqual(['code-review:code-review']);
  });

  it('accepts command-name-first shape (real transcript order)', () => {
    const segments = ['<command-name>/skill-pr-done</command-name>\n<command-message>skill-pr-done</command-message>\n<command-args></command-args>'];
    expect(extractSkillsUsed(segments)).toEqual(['skill-pr-done']);
  });

  it('ignores command tags quoted mid-prose (e.g. compaction summaries)', () => {
    const segments = ['Summary: the transcript contains <command-name>/skill-pr-start</command-name> entries 5 times.'];
    expect(extractSkillsUsed(segments)).toEqual([]);
  });

  it('returns empty for segments without command markers', () => {
    expect(extractSkillsUsed(['just text', ''])).toEqual([]);
  });
});

function assistantToolLine(
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
  isSidechain?: boolean,
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(isSidechain ? { isSidechain: true } : {}),
    timestamp: new Date().toISOString(),
    message: { content: blocks.map((b) => ({ type: 'tool_use', name: b.name, input: b.input })) },
  });
}

describe('extractSkillToolUses', () => {
  it('picks up model-invoked Skill tool calls', () => {
    const lines = [
      assistantToolLine([{ name: 'Skill', input: { skill: 'overlord-plans', args: 'list' } }]),
      assistantToolLine([{ name: 'Skill', input: { skill: 'restart-server' } }]),
    ];
    expect(extractSkillToolUses(lines)).toEqual(['overlord-plans', 'restart-server']);
  });

  it('picks up SlashCommand tool calls, stripping slash and args', () => {
    const lines = [assistantToolLine([{ name: 'SlashCommand', input: { command: '/review 123' } }])];
    expect(extractSkillToolUses(lines)).toEqual(['review']);
  });

  it('ignores other tools, built-ins, and duplicates', () => {
    const lines = [
      assistantToolLine([{ name: 'Bash', input: { command: 'ls' } }]),
      assistantToolLine([{ name: 'SlashCommand', input: { command: '/compact' } }]),
      assistantToolLine([{ name: 'Skill', input: { skill: 'skill-jira' } }]),
      assistantToolLine([{ name: 'Skill', input: { skill: 'skill-jira' } }]),
    ];
    expect(extractSkillToolUses(lines)).toEqual(['skill-jira']);
  });

  it('skips sidechain (subagent) invocations', () => {
    const lines = [assistantToolLine([{ name: 'Skill', input: { skill: 'skill-jira' } }], true)];
    expect(extractSkillToolUses(lines)).toEqual([]);
  });

  it('caps at 12', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      assistantToolLine([{ name: 'Skill', input: { skill: `skill-${i}` } }]),
    );
    expect(extractSkillToolUses(lines)).toHaveLength(12);
  });
});

describe('unionSkillNames', () => {
  it('keeps first-occurrence order across lists and dedupes', () => {
    expect(unionSkillNames(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('caps at 12', () => {
    const a = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 10 }, (_, i) => `b${i}`);
    expect(unionSkillNames(a, b)).toHaveLength(12);
  });
});

describe('mergeSkillsUsed', () => {
  it('unions existing-first with dedupe', () => {
    expect(mergeSkillsUsed(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when both empty', () => {
    expect(mergeSkillsUsed(undefined, undefined)).toBeUndefined();
    expect(mergeSkillsUsed([], [])).toBeUndefined();
  });

  it('keeps existing when fresh is undefined (accumulation across polls)', () => {
    expect(mergeSkillsUsed(['a'], undefined)).toEqual(['a']);
  });

  it('caps at 12', () => {
    const existing = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const fresh = Array.from({ length: 10 }, (_, i) => `f${i}`);
    expect(mergeSkillsUsed(existing, fresh)).toHaveLength(12);
  });
});

describe('readTranscriptState skillsUsed', () => {
  let dir: string;

  beforeEach(() => {
    _resetCachesForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-used-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(lines: string[]): string {
    const p = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  }

  function userLine(text: string, isMeta?: boolean): string {
    return JSON.stringify({
      type: 'user',
      ...(isMeta ? { isMeta: true } : {}),
      timestamp: new Date().toISOString(),
      message: { content: text },
    });
  }

  it('surfaces invoked skills from command-name user entries', () => {
    const p = writeTranscript([
      userLine(cmdSegment('/skill-pr-start')),
      userLine('do the thing'),
      userLine(cmdSegment('/compact')),
      userLine(cmdSegment('/hy-ticket-refiner')),
    ]);
    const result = readTranscriptState(p);
    expect(result.skillsUsed).toEqual(['skill-pr-start', 'hy-ticket-refiner']);
  });

  it('ignores isMeta skill-body expansions', () => {
    const p = writeTranscript([
      userLine(cmdSegment('/skill-jira') + ' full skill doc with <command-name>/skill-example</command-name>', true),
      userLine('hello'),
    ]);
    const result = readTranscriptState(p);
    expect(result.skillsUsed).toBeUndefined();
  });

  it('is undefined when no commands were invoked', () => {
    const p = writeTranscript([userLine('plain message')]);
    const result = readTranscriptState(p);
    expect(result.skillsUsed).toBeUndefined();
  });

  it('unions typed slash commands with model-invoked Skill tool calls', () => {
    const p = writeTranscript([
      userLine(cmdSegment('/skill-pr-start')),
      assistantToolLine([{ name: 'Skill', input: { skill: 'restart-server' } }]),
      userLine('go on'),
    ]);
    const result = readTranscriptState(p);
    expect(result.skillsUsed).toEqual(['skill-pr-start', 'restart-server']);
  });

  it('surfaces skills the model loaded with no slash typed at all', () => {
    const p = writeTranscript([
      userLine('restart the server please'),
      assistantToolLine([{ name: 'Skill', input: { skill: 'restart-server' } }]),
    ]);
    const result = readTranscriptState(p);
    expect(result.skillsUsed).toEqual(['restart-server']);
  });
});
