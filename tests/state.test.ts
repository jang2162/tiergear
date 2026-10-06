import { describe, expect, it } from 'vitest';
import { abridge, countChangedFiles, firstTurnState, nextTurnState, type ContextMessage } from '../src/core/state.js';

describe('abridge', () => {
  it('keeps short text and cuts long text to head and tail', () => {
    expect(abridge('short', 10)).toBe('short');
    const long = 'a'.repeat(60) + 'b'.repeat(40);
    const cut = abridge(long, 50);
    expect(cut.startsWith('a'.repeat(30))).toBe(true);
    expect(cut.endsWith('b'.repeat(20))).toBe(true);
    expect(cut).toContain('chars omitted');
  });
});

describe('countChangedFiles', () => {
  it('counts distinct edited paths only', () => {
    const messages: ContextMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool: 'Edit', input: { file_path: 'a.ts' } }, { tool: 'Read', input: { file_path: 'b.ts' } }] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Write', input: { file_path: 'a.ts' } }, { tool: 'Write', input: { file_path: 'c.ts' } }] },
    ];
    expect(countChangedFiles(messages)).toBe(2);
  });
});

describe('state', () => {
  it('sends only the task on the first turn', () => {
    expect(firstTurnState('fix the bug')).toEqual({ task: 'fix the bug' });
  });

  it('carries the task, the last three exchanges, the prompt and the stats after it', () => {
    const messages: ContextMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `m${i}`,
      toolUses: i === 7 ? [{ tool: 'Edit', input: { file_path: 'x.ts' } }] : [],
    }));
    const state = nextTurnState({ firstPrompt: 'refactor the parser', prompt: 'ok continue', messages, repeatedFailures: 2, tier: 'deep', effort: 'xhigh' }) as {
      task: string;
      recent: { text: string; tools: string[] }[];
      next_prompt: string;
      stats: object;
      current: object;
    };
    expect(state.task).toBe('refactor the parser');
    expect(state.recent.map((m) => m.text)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(state.recent[5]!.tools).toEqual(['Edit']);
    expect(state.next_prompt).toBe('ok continue');
    expect(state.stats).toEqual({ files_changed: 1, repeated_failures: 2 });
    expect(state.current).toEqual({ tier: 'deep', effort: 'xhigh' });
  });
});

describe('recent exchanges', () => {
  const user = (text: string): ContextMessage => ({ role: 'user', text });
  const toolResult = (text = ''): ContextMessage => ({ role: 'user', text, isToolResult: true });
  const assistant = (text: string, ...tools: string[]): ContextMessage => ({ role: 'assistant', text, toolUses: tools.map((tool) => ({ tool })) });
  const recentOf = (messages: ContextMessage[], firstPrompt = 'task') =>
    nextTurnState({ firstPrompt, prompt: 'yes', messages, repeatedFailures: 0, tier: 'deep', effort: 'xhigh' }) as {
      task: string;
      recent: { role: string; text: string; tools: string[] }[];
    };

  it('groups messages into exchanges, so tool steps do not push the conversation out', () => {
    const messages = [
      user('p1'), assistant('a1'),
      user('p2'), assistant('looking', 'Bash'), toolResult(), assistant('', 'Read'), toolResult('reminder text'), assistant('done, commit?'),
      user('p3'), assistant('', 'Edit'), toolResult(), assistant('r3 final'),
      user('p4'), assistant('x', 'Grep'), toolResult(), assistant('', 'Bash'), toolResult(), assistant('', 'Bash'), toolResult(), assistant('Shall I commit?'),
    ];
    const { recent } = recentOf(messages);
    expect(recent.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:p2', 'assistant:done, commit?', 'user:p3', 'assistant:r3 final', 'user:p4', 'assistant:Shall I commit?',
    ]);
    expect(recent[1]!.tools).toEqual(['Bash', 'Read']);
    expect(recent[5]!.tools).toEqual(['Grep', 'Bash']);
  });

  it('gives the reply the next prompt answers the most room, keeping its end', () => {
    const last = 'h'.repeat(1000) + 'q'.repeat(1000);
    const { recent } = recentOf([user('o'.repeat(1000)), assistant('o'.repeat(1000)), user('p'.repeat(1000)), assistant(last)]);
    const [olderPrompt, olderReply, lastPrompt, lastReply] = recent.map((m) => m.text);
    expect(lastReply!.endsWith('q'.repeat(1000))).toBe(true);
    expect(lastReply!.length).toBeLessThan(1600);
    for (const text of [olderPrompt, olderReply, lastPrompt]) {
      expect(text).toContain('chars omitted');
      expect(text!.length).toBeLessThan(450);
    }
  });

  it('shortens the first prompt, which matters less as the session goes on', () => {
    const first = 'f'.repeat(2000);
    expect(recentOf([user('p'), assistant('a')], first).task).toBe(abridge(first, 500));
  });
});
