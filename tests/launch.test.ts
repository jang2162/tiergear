import { describe, expect, it } from 'vitest';
import { parseTierRange, planLaunch } from '../src/cli/launch.js';
import type { AskResult, Judge } from '../src/core/judge.js';
import { DEFAULT_TABLES } from '../src/core/tables.js';
import type { Tier } from '../src/core/tiers.js';

const judgeSaying = (result: AskResult): Judge => ({ name: 'jev', ask: async () => result });
const confident = (tier: Tier, confidence = 0.9) => judgeSaying({ ok: true, verdict: { tier: { tier, confidence }, stuck: null } });
const base = { brief: 'b', tables: DEFAULT_TABLES, now: () => 0 };

describe('planLaunch', () => {
  it('uses the confident tier with tables A and B for the chosen harness', async () => {
    const plan = await planLaunch({ ...base, harness: 'codex', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'deep', confidence: 0.8 }, stuck: null } }) });
    expect(plan).toMatchObject({ tier: 'deep', judgedTier: 'deep', confidence: 0.8, warning: null, command: 'codex --model gpt-5.6-terra -c model_reasoning_effort="xhigh"' });
    expect(plan.floor).toEqual({ tier: 'deep' });
    const trivial = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'trivial', confidence: 0.9 }, stuck: null } }) });
    expect(trivial.command).toBe('claude --model sonnet --effort low');
  });

  it('falls back to standard with a warning and no floor on failure or low confidence', async () => {
    const failed = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: false, reason: 'offline' }) });
    expect(failed).toMatchObject({ tier: 'standard', judgedTier: null, command: 'claude --model sonnet --effort medium', outcome: 'offline', floor: null });
    expect(failed.warning).toContain('offline');
    expect(failed.warning).toContain('using standard');
    const unsure = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: true, verdict: { tier: { tier: 'max', confidence: 0.2 }, stuck: null } }) });
    expect(unsure).toMatchObject({ tier: 'standard', judgedTier: null, floor: null });
    expect(unsure.warning).toContain('low confidence');
  });
});

describe('planLaunch with a tier range', () => {
  it('clamps the judged tier into the range and keeps both tiers', async () => {
    const raised = await planLaunch({ ...base, harness: 'claude', judge: confident('quick'), range: { min: 'deep' } });
    expect(raised).toMatchObject({ judgedTier: 'quick', tier: 'deep', command: 'claude --model opus --effort xhigh', warning: null });
    expect(raised.floor).toEqual({ tier: 'deep' });
    const lowered = await planLaunch({ ...base, harness: 'claude', judge: confident('max'), range: { max: 'standard' } });
    expect(lowered).toMatchObject({ judgedTier: 'max', tier: 'standard', command: 'claude --model sonnet --effort medium' });
    expect(lowered.floor).toEqual({ tier: 'standard', ceiling: 'standard' });
  });

  it('clamps the standard fallback and still floors the range when the judge fails, gives no tier or is unsure', async () => {
    const failed = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: false, reason: 'offline' }), range: { min: 'deep', max: 'max' } });
    expect(failed).toMatchObject({ judgedTier: null, tier: 'deep', command: 'claude --model opus --effort xhigh', floor: { tier: 'deep', ceiling: 'max' } });
    expect(failed.warning).toContain('using deep');
    const silent = await planLaunch({ ...base, harness: 'claude', judge: judgeSaying({ ok: true, verdict: { tier: null, stuck: null } }), range: { min: 'deep' } });
    expect(silent).toMatchObject({ judgedTier: null, tier: 'deep', floor: { tier: 'deep' } });
    const unsure = await planLaunch({ ...base, harness: 'claude', judge: confident('max', 0.2), range: { max: 'quick' } });
    expect(unsure).toMatchObject({ judgedTier: null, tier: 'quick', floor: { tier: 'quick', ceiling: 'quick' } });
    expect(unsure.warning).toContain('using quick');
  });

  it('starts a Codex launch inside the range', async () => {
    const codex = await planLaunch({ ...base, harness: 'codex', judge: confident('trivial'), range: { min: 'deep' } });
    expect(codex.command).toBe('codex --model gpt-5.6-terra -c model_reasoning_effort="xhigh"');
  });
});

describe('parseTierRange', () => {
  it('accepts either bound, both or none', () => {
    expect(parseTierRange(undefined, undefined)).toEqual({ ok: true, range: {} });
    expect(parseTierRange('deep', undefined)).toEqual({ ok: true, range: { min: 'deep' } });
    expect(parseTierRange(undefined, 'quick')).toEqual({ ok: true, range: { max: 'quick' } });
    expect(parseTierRange('quick', 'quick')).toEqual({ ok: true, range: { min: 'quick', max: 'quick' } });
  });

  it('refuses an unknown tier and a minimum above the maximum', () => {
    expect(parseTierRange('huge', undefined)).toEqual({ ok: false, error: '--min-tier must be one of trivial|quick|standard|deep|max, not "huge"' });
    expect(parseTierRange('deep', 'Max')).toEqual({ ok: false, error: '--max-tier must be one of trivial|quick|standard|deep|max, not "Max"' });
    expect(parseTierRange('deep', 'quick')).toEqual({ ok: false, error: '--min-tier deep is above --max-tier quick' });
  });
});
