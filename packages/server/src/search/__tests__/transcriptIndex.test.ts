import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptIndex, classifyLine, type ConversationSource } from '../transcriptIndexWorker.js';

const line = (o: unknown) => JSON.stringify(o) + '\n';
const claudeUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', cwd: '/repo/overlord', gitBranch: 'main', message: { role: 'user', content }, ...extra });
const claudeAssistant = (content: unknown[]) =>
  line({ type: 'assistant', cwd: '/repo/overlord', message: { role: 'assistant', content } });
const codex = (payload: unknown) => line({ type: 'response_item', payload });

function classify(raw: string): Array<[ConversationSource, string]> {
  const out: Array<[ConversationSource, string]> = [];
  classifyLine(raw.trimEnd(), (s, t) => out.push([s, t]));
  return out;
}

describe('classifyLine — Claude', () => {
  it('user text is "you"; injected command / reminder text is skipped', () => {
    expect(classify(claudeUser('fix the mikrofon'))).toEqual([['you', 'fix the mikrofon']]);
    expect(classify(claudeUser('<command-name>/clear</command-name>'))).toEqual([]);
    expect(classify(claudeUser([{ type: 'text', text: '<system-reminder>x</system-reminder>' }]))).toEqual([]);
    expect(classify(claudeUser('meta', { isMeta: true }))).toEqual([]);
  });

  it('tool_result blocks on user lines are not indexed', () => {
    expect(classify(claudeUser([{ type: 'tool_result', content: 'file dump' }]))).toEqual([]);
  });

  it('assistant text is "agent", tool_use is "tool" with name and capped input', () => {
    const big = 'x'.repeat(5000);
    const got = classify(claudeAssistant([
      { type: 'thinking', thinking: 'secret' },
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', name: 'Bash', input: { command: big } },
    ]));
    expect(got[0]).toEqual(['agent', 'Done.']);
    expect(got[1][0]).toBe('tool');
    expect(got[1][1].startsWith('Bash {"command":"xxx')).toBe(true);
    expect(got[1][1].length).toBeLessThan(2100);
    expect(got).toHaveLength(2);
  });

  it('bad JSON and unknown shapes are skipped', () => {
    expect(classify('{not json')).toEqual([]);
    expect(classify(line({ type: 'summary', summary: 'mikrofon' }))).toEqual([]);
  });
});

describe('classifyLine — Codex', () => {
  it('maps user / assistant messages and both tool-call kinds', () => {
    expect(classify(codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }))).toEqual([['you', 'hello']]);
    expect(classify(codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }))).toEqual([]);
    expect(classify(codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }))).toEqual([['agent', 'ok']]);
    expect(classify(codex({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }))).toEqual([]);
    expect(classify(codex({ type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' }))).toEqual([['tool', 'shell {"cmd":"ls"}']]);
    expect(classify(codex({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' }))).toEqual([['tool', 'apply_patch *** Begin Patch']]);
    expect(classify(codex({ type: 'reasoning', summary: [] }))).toEqual([]);
  });
});

describe('TranscriptIndex', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-search-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('matches per source, case-insensitively, never on metadata fields', () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, claudeUser('Ask about MIKROFON') + claudeAssistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'needle' } }]));
    const idx = new TranscriptIndex();
    expect(idx.search('mikrofon', [f])).toEqual({ [f]: ['you'] });
    expect(idx.search('needle', [f])).toEqual({ [f]: ['tool'] });
    // `cwd` is /repo/overlord on every line — must not count as a match.
    expect(idx.search('overlord', [f])).toEqual({});
  });

  it('reads appended bytes, including a line split across writes', () => {
    const f = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f, claudeUser('first'));
    const idx = new TranscriptIndex();
    expect(idx.search('second', [f])).toEqual({});
    const next = claudeAssistant([{ type: 'text', text: 'second reply' }]);
    fs.appendFileSync(f, next.slice(0, 20));
    expect(idx.search('second', [f])).toEqual({});
    fs.appendFileSync(f, next.slice(20));
    expect(idx.search('second', [f])).toEqual({ [f]: ['agent'] });
    expect(idx.search('first', [f])).toEqual({ [f]: ['you'] });
  });

  it('re-reads a file that shrank and drops a deleted one', () => {
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, claudeUser('old words that are long enough'));
    const idx = new TranscriptIndex();
    expect(idx.search('old', [f])).toEqual({ [f]: ['you'] });
    fs.writeFileSync(f, claudeUser('new'));
    expect(idx.search('old', [f])).toEqual({});
    expect(idx.search('new', [f])).toEqual({ [f]: ['you'] });
    fs.unlinkSync(f);
    expect(idx.search('new', [f])).toEqual({});
  });
});
