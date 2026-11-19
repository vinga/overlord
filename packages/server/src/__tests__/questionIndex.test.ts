import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isQuestion, firstQuestionSentence, answerPreview, extractQuestions, parseEntry, readConversation, clearQuestionCache,
  type ConversationEntry,
} from '../session/questionIndex.js';
import { readStars, setStar, deleteStars } from '../session/questionStars.js';
import { sessionQuestions } from '../api/questionRoutes.js';

let HOME: string;
const REAL_HOME = process.env.HOME;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-questions-'));
  process.env.HOME = HOME;
  clearQuestionCache();
});
afterEach(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const u = (text: string, ts: string): ConversationEntry => ({ role: 'user', text, timestamp: ts });
const a = (text: string, ts: string): ConversationEntry => ({ role: 'assistant', text, timestamp: ts });

describe('isQuestion', () => {
  it('plain and Polish questions', () => {
    expect(isQuestion('co to jest w ogole chat tools demo?')).toBe(true);
    expect(isQuestion('czemu az 3 branche? co tam robi PS')).toBe(true);
    expect(isQuestion('commitnij wszystko')).toBe(false);
  });
  it('ignores ? in code fences, inline code, URLs and pasted paths', () => {
    expect(isQuestion('run this\n```\nfoo?bar\n```')).toBe(false);
    expect(isQuestion('see `a?b` now')).toBe(false);
    expect(isQuestion('open https://x.io/search?q=1 please')).toBe(false);
    expect(isQuestion('look @/var/folders/x?.jpg')).toBe(false);
  });
});

describe('firstQuestionSentence / answerPreview', () => {
  it('picks the sentence with the first ?', () => {
    expect(firstQuestionSentence('I logged in. Is it redirecting to dev? Weird.')).toBe('Is it redirecting to dev?');
  });
  it('falls back to the first line for a starred non-question', () => {
    expect(firstQuestionSentence('\n  remember this\nsecond')).toBe('remember this');
  });
  it('strips markdown from the answer and clips it', () => {
    expect(answerPreview('## Title\n- **Bold** point with `code` and [link](http://x)')).toBe('Title Bold point with code and link');
    expect(answerPreview('x'.repeat(400)).length).toBe(160);
  });
});

describe('extractQuestions', () => {
  it('pairs each question with the last assistant text of its turn', () => {
    const qs = extractQuestions([
      u('do it', 't1'),
      a('ok', 't2'),
      u('why 3 branches?', 't3'),
      a('Checking the branches.', 't4'),
      a('Because PS, chat and infra.', 't5'),
      u('and now?', 't6'),
    ]);
    expect(qs).toEqual([
      { id: 't3', question: 'why 3 branches?', isQuestion: true, answer: 'Because PS, chat and infra.', answerAt: 't5' },
      { id: 't6', question: 'and now?', isQuestion: true },
    ]);
  });
  it('skips synthetic user text even with ?', () => {
    const qs = extractQuestions([
      u('This session is being continued from a previous conversation? summary', 't1'),
      u('Another Claude session sent a message: <teammate-message>done?</teammate-message>', 't2'),
    ]);
    expect(qs).toEqual([]);
  });
  it('a starred non-question is listed with isQuestion false', () => {
    const qs = extractQuestions([u('keep this', 't1'), a('noted', 't2')], new Set(['t1']));
    expect(qs).toEqual([{ id: 't1', question: 'keep this', isQuestion: false, answer: 'noted', answerAt: 't2' }]);
  });
  it('a question queued before any answer shares the next answer', () => {
    const qs = extractQuestions([u('what?', 't1'), u('also do x', 't2'), a('answer to both', 't3')]);
    expect(qs).toEqual([{ id: 't1', question: 'what?', isQuestion: true, answer: 'answer to both', answerAt: 't3' }]);
  });
  it('an answered question stops taking later answers', () => {
    const qs = extractQuestions([u('what?', 't1'), a('first', 't2'), u('next step', 't3'), a('second', 't4')]);
    expect(qs[0].answer).toBe('first');
  });
  it('an exact repeat of an unanswered question is listed once', () => {
    const qs = extractQuestions([u('why?', 't1'), u('why?', 't2'), a('because', 't3'), u('why?', 't4')]);
    expect(qs.map(q => q.id)).toEqual(['t1', 't4']);
  });
});

describe('parseEntry', () => {
  it('reads user, assistant and queued human prompts; drops meta and tool results', () => {
    expect(parseEntry(JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'hi?' } }))).toEqual({ role: 'user', text: 'hi?', timestamp: 't' });
    expect(parseEntry(JSON.stringify({ type: 'user', isMeta: true, timestamp: 't', message: { content: 'skill?' } }))).toBeNull();
    expect(parseEntry(JSON.stringify({ type: 'user', timestamp: 't', message: { content: [{ type: 'tool_result' }] } }))).toBeNull();
    expect(parseEntry(JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'yes' }] } })))
      .toEqual({ role: 'assistant', text: 'yes', timestamp: 't' });
    expect(parseEntry(JSON.stringify({ type: 'attachment', timestamp: 't0', attachment: { type: 'queued_command', prompt: 'q?', timestamp: 't1', origin: { kind: 'human' } } })))
      .toEqual({ role: 'user', text: 'q?', timestamp: 't1' });
  });
});

describe('readConversation', () => {
  it('parses appended lines only and waits for an unfinished last line', () => {
    const f = path.join(HOME, 't.jsonl');
    const line = (type: string, ts: string, text: string) => JSON.stringify({ type, timestamp: ts, message: { content: text } });
    fs.writeFileSync(f, `${line('user', 't1', 'one?')}\n`);
    expect(readConversation(f).map(e => e.timestamp)).toEqual(['t1']);
    fs.appendFileSync(f, `${line('assistant', 't2', 'ans')}\n${line('user', 't3', 'tw')}`);
    expect(readConversation(f).map(e => e.timestamp)).toEqual(['t1', 't2']);
    fs.appendFileSync(f, '\n');   // the last line is finished now
    expect(readConversation(f).map(e => e.timestamp)).toEqual(['t1', 't2', 't3']);
  });
  it('rereads from scratch when the file shrinks', () => {
    const f = path.join(HOME, 't.jsonl');
    fs.writeFileSync(f, `${JSON.stringify({ type: 'user', timestamp: 't1', message: { content: 'a long first message?' } })}\n`);
    readConversation(f);
    fs.writeFileSync(f, `${JSON.stringify({ type: 'user', timestamp: 't9', message: { content: 'b?' } })}\n`);
    expect(readConversation(f).map(e => e.timestamp)).toEqual(['t9']);
  });
});

describe('question stars', () => {
  it('round-trips under the stubbed HOME and deletes', () => {
    expect(readStars('ovr-a')).toEqual([]);
    expect(setStar('ovr-a', 't1', true)).toEqual(['t1']);
    expect(setStar('ovr-a', 't1', true)).toEqual(['t1']);
    expect(setStar('ovr-a', 't2', true)).toEqual(['t1', 't2']);
    expect(fs.existsSync(path.join(HOME, '.claude', 'overlord', 'questions', 'ovr-a.json'))).toBe(true);
    expect(setStar('ovr-a', 't1', false)).toEqual(['t2']);
    deleteStars('ovr-a');
    expect(readStars('ovr-a')).toEqual([]);
  });
  it('rejects unsafe ids', () => {
    expect(setStar('../x', 't', true)).toEqual([]);
  });
});

describe('sessionQuestions', () => {
  it('merges transcript questions with stars; unknown session → empty', () => {
    const f = path.join(HOME, 's.jsonl');
    fs.writeFileSync(f, [
      { type: 'user', timestamp: 't1', message: { content: 'pin me' } },
      { type: 'assistant', timestamp: 't2', message: { content: 'ok' } },
      { type: 'user', timestamp: 't3', message: { content: 'why?' } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n');
    const deps = {
      stateManager: {
        getSession: (id: string) => (id === 's1' ? { sessionId: 's1', overlordId: 'ovr-s' } : undefined),
        getActiveClaudeByOvr: () => undefined,
      } as never,
      transcriptPathFor: (sid: string) => (sid === 's1' ? f : null),
    };
    setStar('ovr-s', 't1', true);
    const out = sessionQuestions(deps, 's1');
    expect(out.starred).toEqual(['t1']);
    expect(out.questions.map(q => [q.id, q.isQuestion])).toEqual([['t1', false], ['t3', true]]);
    expect(sessionQuestions(deps, 'nope')).toEqual({ questions: [], starred: [] });
  });
});
