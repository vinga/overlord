import { describe, it, expect } from 'vitest';
import { jiraTypeToWorkerIcon, jiraSessionTitle } from '../jiraIcon';

describe('jiraTypeToWorkerIcon', () => {
  it('maps the standard JIRA issue types', () => {
    expect(jiraTypeToWorkerIcon('Bug')).toBe('bug');
    expect(jiraTypeToWorkerIcon('Defect')).toBe('bug');
    expect(jiraTypeToWorkerIcon('Story')).toBe('story');
    expect(jiraTypeToWorkerIcon('Task')).toBe('task');
    expect(jiraTypeToWorkerIcon('Epic')).toBe('ticket');
  });

  it('matches sub-task before task', () => {
    expect(jiraTypeToWorkerIcon('Sub-task')).toBe('task');
    expect(jiraTypeToWorkerIcon('Subtask')).toBe('task');
  });

  it('is case-insensitive', () => {
    expect(jiraTypeToWorkerIcon('BUG')).toBe('bug');
    expect(jiraTypeToWorkerIcon('  user story ')).toBe('story');
  });

  it('returns undefined when the type cannot be deduced', () => {
    expect(jiraTypeToWorkerIcon(undefined)).toBeUndefined();
    expect(jiraTypeToWorkerIcon('')).toBeUndefined();
    expect(jiraTypeToWorkerIcon('   ')).toBeUndefined();
    expect(jiraTypeToWorkerIcon('Spike')).toBeUndefined();
    expect(jiraTypeToWorkerIcon('Incident')).toBeUndefined();
  });
});

describe('jiraSessionTitle', () => {
  it('joins key and summary', () => {
    expect(jiraSessionTitle('BACKEND-1234', 'Fix null pointer'))
      .toBe('BACKEND-1234 Fix null pointer');
  });

  it('falls back to the bare key when the summary is missing', () => {
    expect(jiraSessionTitle('BACKEND-1234')).toBe('BACKEND-1234');
    expect(jiraSessionTitle('BACKEND-1234', '')).toBe('BACKEND-1234');
    expect(jiraSessionTitle('BACKEND-1234', '   ')).toBe('BACKEND-1234');
  });

  it('trims a padded summary', () => {
    expect(jiraSessionTitle('A-1', '  hello  ')).toBe('A-1 hello');
  });
});
