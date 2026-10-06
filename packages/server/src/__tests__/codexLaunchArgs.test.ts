import { describe, it, expect } from 'vitest';
import { buildCodexSpawnArgs, buildCodexResumeArgs, buildCodexResumeCommand } from '../session/codexSession.js';

const FULL_ACCESS = '--dangerously-bypass-approvals-and-sandbox';

describe('Codex launch args', () => {
  it('fresh spawn starts with full access', () => {
    expect(buildCodexSpawnArgs()).toEqual([FULL_ACCESS]);
  });

  it('resume keeps full access on the resume subcommand', () => {
    expect(buildCodexResumeArgs()).toEqual(['resume', '--last', FULL_ACCESS]);
  });

  it('external/bridged resume command carries full access', () => {
    expect(buildCodexResumeCommand()).toBe(`codex resume --last ${FULL_ACCESS}`);
  });

  it('resumes the known codex session id instead of --last', () => {
    const id = '01a0f22d-b0b2-7753-893d-8e8835bfe118';
    expect(buildCodexResumeArgs(id)).toEqual(['resume', id, FULL_ACCESS]);
    expect(buildCodexResumeCommand(id)).toBe(`codex resume ${id} ${FULL_ACCESS}`);
  });

  it('falls back to --last for an id that is not shell-safe', () => {
    expect(buildCodexResumeArgs('x; rm -rf /')).toEqual(['resume', '--last', FULL_ACCESS]);
  });
});
