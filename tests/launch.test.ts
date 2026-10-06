import { describe, expect, it } from 'vitest';
import { planLaunch } from '../src/cli/launch.js';
import type { AskResult, Judge } from '../src/core/judge.js';
import { DEFAULT_TABLES } from '../src/core/tables.js';

const judgeSaying = (result: AskResult): Judge => ({ name: 'jev', ask: async () => result });
const base = { brief: 'b', tables: DEFAULT_TABLES, now: () => 0 };

describe('planLaunch', () => {
  it('uses the confident tier with tables A and B for the chosen harness', async () => {
    const plan = await planLaunch({ ...base, harness: 'codex', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'deep', confidence: 0.8 }, stuck: null } }) });
    expect(plan).toMatchObject({ tier: 'deep', confidence: 0.8, warning: null, command: 'codex --model gpt-5.6-terra -c model_reasoning_effort="xhigh"' });
    const trivial = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'trivial', confidence: 0.9 }, stuck: null } }) });
    expect(trivial.command).toBe('claude --model sonnet --effort low');
  });

  it('falls back to standard with a warning on failure or low confidence', async () => {
    const failed = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: false, reason: 'offline' }) });
    expect(failed).toMatchObject({ tier: 'standard', command: 'claude --model sonnet --effort medium', outcome: 'offline' });
    expect(failed.warning).toContain('offline');
    const unsure = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'max', confidence: 0.2 }, stuck: null } }) });
    expect(unsure.tier).toBe('standard');
    expect(unsure.warning).toContain('low confidence');
  });
});
