import { describe, it, expect } from 'vitest';
import { gatherScanSegments, extractJiraKeys } from '../transcriptReader.js';

const toolResult = (content: unknown) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content }] } });

const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const createResponse = (id: string, key: string) =>
  `{"id":"${id}","key":"${key}","self":"https://acme.atlassian.net/rest/api/3/issue/${id}"}`;

const BACKEND = /\b(BACKEND)-(\d{1,6})\b/g;

describe('gatherScanSegments created keys', () => {
  it('picks up the key from a Jira create response', () => {
    const { created, user } = gatherScanSegments([toolResult(`${createResponse('150408', 'BACKEND-2728')}\nShell cwd was reset`)]);
    expect(created).toEqual(['BACKEND-2728']);
    expect(user).toEqual([]);
  });

  it('picks up every key from several creates in one result', () => {
    const out = [
      `Parent -> ${createResponse('150410', 'BACKEND-2729')}`,
      `Child -> ${createResponse('150411', 'BACKEND-2730')}`,
    ].join('\n');
    expect(gatherScanSegments([toolResult([{ type: 'text', text: out }])]).created).toEqual(['BACKEND-2729', 'BACKEND-2730']);
  });

  it('ignores GET /issue and search responses (self before key)', () => {
    const get = '{"expand":"renderedFields","id":"150408","self":"https://acme.atlassian.net/rest/api/3/issue/150408","key":"BACKEND-2728","fields":{}}';
    expect(gatherScanSegments([toolResult(get)]).created).toEqual([]);
  });

  it('ignores bare key mentions in tool output and assistant prose', () => {
    expect(gatherScanSegments([
      toolResult('BACKEND-2725 | To Refine | In-app notices'),
      assistantText(createResponse('1', 'BACKEND-1')),
    ]).created).toEqual([]);
  });

  it('feeds through the project allowlist', () => {
    const { created } = gatherScanSegments([toolResult(createResponse('1', 'OTHER-5') + createResponse('2', 'BACKEND-7'))]);
    expect(extractJiraKeys(created, BACKEND)).toEqual(['BACKEND-7']);
  });
});
