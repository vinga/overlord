import { describe, it, expect } from 'vitest';
import { gatherScanSegments, extractPrRefs } from '../transcriptReader.js';

const userText = (text: string, isMeta = false) =>
  JSON.stringify({ type: 'user', isMeta, message: { content: text } });

const userBlocks = (blocks: unknown[], isMeta = false) =>
  JSON.stringify({ type: 'user', isMeta, message: { content: blocks } });

const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const toolResult = (content: unknown) =>
  userBlocks([{ type: 'tool_result', content }]);

const toolUse = (input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input }] } });

describe('gatherScanSegments', () => {
  it('puts user text in both slices', () => {
    const { user, wide } = gatherScanSegments([userText('review https://github.com/o/r/pull/1')]);
    expect(user).toEqual(['review https://github.com/o/r/pull/1']);
    expect(wide).toEqual(['review https://github.com/o/r/pull/1']);
  });

  it('puts assistant text in wide only', () => {
    const { user, wide } = gatherScanSegments([assistantText('opened https://github.com/o/r/pull/2')]);
    expect(user).toEqual([]);
    expect(wide).toEqual(['opened https://github.com/o/r/pull/2']);
  });

  it('puts tool_result string content in wide only', () => {
    const { user, wide } = gatherScanSegments([toolResult('https://github.com/o/r/pull/3\n')]);
    expect(user).toEqual([]);
    expect(wide).toEqual(['https://github.com/o/r/pull/3\n']);
  });

  it('unwraps tool_result block-array content', () => {
    const { wide } = gatherScanSegments([
      toolResult([{ type: 'text', text: 'https://github.com/o/r/pull/4' }]),
    ]);
    expect(wide).toEqual(['https://github.com/o/r/pull/4']);
  });

  it('skips isMeta user messages entirely — both slices', () => {
    const { user, wide } = gatherScanSegments([
      userText('skill doc example: https://github.com/o/r/pull/999', true),
    ]);
    expect(user).toEqual([]);
    expect(wide).toEqual([]);
  });

  it('skips tool_use input', () => {
    const { user, wide } = gatherScanSegments([
      toolUse({ file_path: '/docs/x.md', note: 'https://github.com/o/r/pull/998' }),
    ]);
    expect(user).toEqual([]);
    expect(wide).toEqual([]);
  });

  it('skips unparseable and empty lines', () => {
    const { user, wide } = gatherScanSegments(['', 'not json', userText('hi')]);
    expect(user).toEqual(['hi']);
    expect(wide).toEqual(['hi']);
  });
});

describe('extractPrRefs', () => {
  it('detects a PR from gh pr create output', () => {
    const { wide } = gatherScanSegments([
      toolResult('Creating pull request...\nhttps://github.com/exampleorg/demo-service/pull/819\n'),
    ]);
    expect(extractPrRefs(wide)).toEqual(['exampleorg/demo-service#819']);
  });

  it('detects a PR from assistant prose', () => {
    const { wide } = gatherScanSegments([assistantText('Opened https://github.com/o/r/pull/12 — CI is green.')]);
    expect(extractPrRefs(wide)).toEqual(['o/r#12']);
  });

  it('ignores non-PR github URLs', () => {
    const { wide } = gatherScanSegments([
      assistantText('branch https://github.com/o/r/tree/feat and issue https://github.com/o/r/issues/5'),
    ]);
    expect(extractPrRefs(wide)).toEqual([]);
  });

  it('dedupes case-insensitively, keeping the casing first written', () => {
    const { wide } = gatherScanSegments([
      assistantText('https://github.com/Acme/Repo/pull/7'),
      assistantText('https://github.com/acme/repo/pull/7/files'),
    ]);
    expect(extractPrRefs(wide)).toEqual(['acme/repo#7']);
  });

  it('keeps the newest mentions when the cap bites, in chronological order', () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(n => assistantText(`https://github.com/o/r/pull/${n}`));
    const { wide } = gatherScanSegments(lines);
    expect(extractPrRefs(wide)).toEqual(['o/r#3', 'o/r#4', 'o/r#5', 'o/r#6', 'o/r#7']);
  });

  it('re-mention moves a PR to the newest slot', () => {
    const { wide } = gatherScanSegments([
      assistantText('https://github.com/o/r/pull/1'),
      assistantText('https://github.com/o/r/pull/2'),
      assistantText('back to https://github.com/o/r/pull/1'),
    ]);
    expect(extractPrRefs(wide)).toEqual(['o/r#2', 'o/r#1']);
  });

  it('handles several PRs on one line', () => {
    const { wide } = gatherScanSegments([
      assistantText('see https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2'),
    ]);
    expect(extractPrRefs(wide)).toEqual(['o/r#1', 'o/r#2']);
  });

  it('strips markdown/prose punctuation around the URL', () => {
    const { wide } = gatherScanSegments([
      assistantText('([PR](https://github.com/o/r/pull/9)), and https://github.com/o/r/pull/10.'),
    ]);
    expect(extractPrRefs(wide)).toEqual(['o/r#9', 'o/r#10']);
  });

  it('returns empty for segments with no PR path', () => {
    expect(extractPrRefs(['nothing here', 'https://example.com/a/b'])).toEqual([]);
  });
});

const bashUse = (id: string, command: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const bashResult = (id: string, content: unknown) =>
  userBlocks([{ type: 'tool_result', tool_use_id: id, content }]);

describe('gatherScanSegments: own PRs and pushes', () => {
  it('pairs `gh pr create` output with its call', () => {
    const { prCreates, pushes } = gatherScanSegments([
      bashUse('t1', 'gh pr create --title x --body y'),
      bashResult('t1', 'https://github.com/o/r/pull/12\n'),
    ]);
    expect(prCreates).toEqual(['https://github.com/o/r/pull/12\n']);
    expect(pushes).toEqual([]);
  });

  it('recognises the REST create fallback, not other gh api calls', () => {
    const { prCreates } = gatherScanSegments([
      bashUse('a', 'gh api repos/o/r/pulls --method POST -f title=x'),
      bashResult('a', '{"html_url":"https://github.com/o/r/pull/3"}'),
      bashUse('b', 'gh api repos/o/r/pulls/3/comments -X POST -f body=x'),
      bashResult('b', 'https://github.com/o/r/pull/3#c1'),
    ]);
    expect(prCreates).toEqual(['{"html_url":"https://github.com/o/r/pull/3"}']);
  });

  it('does not treat a mentioned PR as authored', () => {
    const { prCreates } = gatherScanSegments([
      bashUse('t1', 'gh pr view 12'),
      bashResult('t1', 'https://github.com/o/r/pull/12'),
    ]);
    expect(prCreates).toEqual([]);
  });

  it('collects `git push` output, including `git -C dir push`', () => {
    const { pushes } = gatherScanSegments([
      bashUse('p1', 'cd ../x && git -C ../x push -u origin feat'),
      bashResult('p1', [{ type: 'text', text: 'To github.com:o/x.git\n * [new branch] feat -> feat' }]),
    ]);
    expect(pushes).toEqual(['To github.com:o/x.git\n * [new branch] feat -> feat']);
  });

  it('pairs Codex function calls by call_id', () => {
    const call = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', arguments: '{"cmd":"git push origin main"}' } });
    const out = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'To https://github.com/o/r.git\n   a1b2c3d..e4f5a6b  main -> main' } });
    expect(gatherScanSegments([call, out]).pushes).toEqual(['To https://github.com/o/r.git\n   a1b2c3d..e4f5a6b  main -> main']);
  });
});
