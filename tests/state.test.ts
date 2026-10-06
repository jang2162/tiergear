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

  it('carries the task, the last six messages, the prompt and the stats after it', () => {
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
