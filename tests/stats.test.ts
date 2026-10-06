import { describe, expect, it } from 'vitest';
import { summarize } from '../src/cli/stats.js';
import type { LogEntry } from '../src/core/log.js';

const entry = (over: Partial<LogEntry>): LogEntry => ({
  at: 100, source: 'hook', session: 's', phase: 'next', judge: 'jev', tier: 'deep', change: 'hold',
  confidence: 0.9, stuck: null, outcome: 'ok', ms: 400, applied: null, reason: 'same tier', ...over,
});

describe('summarize', () => {
  it('counts changes and judge answers since the cutoff, per judge', () => {
    const text = summarize([
      entry({ change: 'up', ms: 300 }),
      entry({ change: 'down', ms: 500 }),
      entry({ outcome: 'timed out after 1200ms', ms: 1200 }),
      entry({ outcome: 'skipped', ms: null }),
      entry({ judge: 'laya', ms: 900 }),
      entry({ at: 1, change: 'up' }),
    ], 50);
    expect(text).toBe(
      'decisions: 5\nset 0 · up 1 · down 1 · hold 3\njev answered 2/3 · avg 400ms\nlaya answered 1/1 · avg 900ms',
    );
  });

  it('says so when there is nothing', () => {
    expect(summarize([], 0)).toBe('no decisions yet');
  });
});
