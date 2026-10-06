import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config.js';
import {
  JUDGE_PAUSE_MS,
  canAskJudge,
  decideFirstTurn,
  decideNextTurn,
  isPinPrompt,
  newRecord,
  noteJudgeOutcome,
  parseRecord,
  statusText,
  stripPin,
  type SessionRecord,
} from '../src/core/decide.js';
import type { Verdict } from '../src/core/judge.js';
import { DEFAULT_TABLES } from '../src/core/tables.js';
import type { Tier } from '../src/core/tiers.js';

const now = 1_800_000_000_000;
const config: Config = { ...DEFAULT_CONFIG };
const tables = DEFAULT_TABLES;

function verdict(tier: Tier | null, confidence = 0.9, stuck: number | null = null): Verdict {
  return { tier: tier ? { tier, confidence } : null, stuck };
}

function at(tier: Tier, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { ...newRecord('task', now), tier, floor: 'quick', model: 'sonnet', applied: { model: 'sonnet', effort: 'medium' }, ...extra };
}

const next = (record: SessionRecord, v: Verdict | null, repeatedFailures = 0, c: Config = config) =>
  decideNextTurn({ record, verdict: v, repeatedFailures, config: c, tables });

describe('pin', () => {
  it('detects and strips !pin, keeping the text when nothing is left', () => {
    expect(isPinPrompt('!pin fix it')).toBe(true);
    expect(isPinPrompt('  !pin')).toBe(true);
    expect(isPinPrompt('!pinned')).toBe(false);
    expect(stripPin('!pin fix it')).toBe('fix it');
    expect(stripPin('!pin')).toBe('!pin');
  });
});

describe('decideFirstTurn', () => {
  const first = (v: Verdict | null, extra: Partial<Parameters<typeof decideFirstTurn>[0]> = {}) =>
    decideFirstTurn({ record: newRecord('t', now), floor: null, verdict: v, config, tables, ...extra });

  it('applies table A and B for the confident tier and puts the floor one step below', () => {
    const d = first(verdict('deep', 0.8));
    expect(d.change).toBe('set');
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', model: 'opus', applied: { model: 'opus', effort: 'xhigh' } });
  });

  it('sends no effort for a Haiku tier', () => {
    expect(first(verdict('trivial', 0.9)).record.applied).toEqual({ model: 'haiku', effort: null });
  });

  it('keeps the session as it is on low confidence or no answer', () => {
    expect(first(verdict('deep', 0.3)).change).toBe('hold');
    const none = first(null);
    expect(none.change).toBe('hold');
    expect(none.record.applied).toBeNull();
  });

  it('uses a launch floor without the judge', () => {
    const d = first(null, { floor: { worktree: '/w', tier: 'max', createdAt: now } });
    expect(d.record).toMatchObject({ tier: 'max', floor: 'max', applied: { model: 'fable', effort: 'xhigh' } });
  });

  it('follows overridden tables', () => {
    const custom = { ...tables, claude: { ...tables.claude, effort: { ...tables.claude.effort, opus: { ...tables.claude.effort['opus']!, deep: 'max' as const } } } };
    expect(first(verdict('deep'), { tables: custom }).record.applied).toEqual({ model: 'opus', effort: 'max' });
  });

  it('does nothing for a pinned session', () => {
    const d = first(verdict('max'), { record: { ...newRecord('t', now), pinned: true } });
    expect(d.change).toBe('hold');
    expect(d.record.applied).toBeNull();
  });
});

describe('decideNextTurn', () => {
  it('raises at once, several steps if needed, keeping the model and using its effort column', () => {
    const d = next(at('quick'), verdict('deep', 0.6));
    expect(d.change).toBe('up');
    expect(d.record.tier).toBe('deep');
    expect(d.record.applied).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('switches the model too when switchModelMidSession is on', () => {
    const d = next(at('quick'), verdict('deep', 0.6), 0, { ...config, switchModelMidSession: true });
    expect(d.record.applied).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(d.record.model).toBe('opus');
  });

  it('raises one step when stuck, by the judge or by repeated failures', () => {
    expect(next(at('standard'), verdict('standard', 0.9, 0.7)).record.tier).toBe('deep');
    expect(next(at('standard'), null, 3).record.tier).toBe('deep');
    expect(next(at('max'), null, 3).change).toBe('hold');
  });

  it('lowers one step only after two confident turns in a row', () => {
    const one = next(at('deep'), verdict('trivial', 0.9));
    expect(one.change).toBe('hold');
    expect(one.record.downStreak).toBe(1);
    const two = next(one.record, verdict('trivial', 0.9));
    expect(two.change).toBe('down');
    expect(two.record.tier).toBe('standard');
    expect(two.record.applied).toEqual({ model: 'sonnet', effort: 'medium' });
  });

  it('breaks the streak on an unconfident or non-lower turn', () => {
    const one = next(at('deep'), verdict('quick', 0.9));
    expect(next(one.record, verdict('quick', 0.7)).record.downStreak).toBe(0);
  });

  it('never goes below the floor', () => {
    const d = next(at('standard', { floor: 'standard', downStreak: 1 }), verdict('trivial', 0.95));
    expect(d.change).toBe('hold');
    expect(d.record.tier).toBe('standard');
  });

  it('sets a tier later when the first turn left it unset, effort only', () => {
    const d = next(newRecord('t', now), verdict('deep', 0.7));
    expect(d.change).toBe('set');
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', applied: { effort: 'xhigh' } });
    expect(d.record.applied?.model).toBeUndefined();
  });

  it('holds a pinned session', () => {
    expect(next(at('quick', { pinned: true }), verdict('max'), 5).change).toBe('hold');
  });
});

describe('judge pause', () => {
  it('pauses for five minutes after three failures in a row and resets on success', () => {
    let r = newRecord('t', now);
    r = noteJudgeOutcome(r, false, now);
    r = noteJudgeOutcome(r, false, now);
    expect(canAskJudge(r, now)).toBe(true);
    r = noteJudgeOutcome(r, false, now);
    expect(canAskJudge(r, now + 1000)).toBe(false);
    expect(canAskJudge(r, now + JUDGE_PAUSE_MS)).toBe(true);
    expect(noteJudgeOutcome({ ...r, judgeFailures: 2 }, true, now).judgeFailures).toBe(0);
  });
});

describe('records and status', () => {
  it('round-trips a record, including a null effort, and rejects garbage', () => {
    const r = at('trivial', { applied: { model: 'haiku', effort: null } });
    expect(parseRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(parseRecord({ tier: 'huge' })).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });

  it('describes changes and holds', () => {
    expect(statusText(next(at('quick'), verdict('deep', 0.91)))).toBe('tiergear · deep 0.91 → sonnet/high');
    expect(statusText(next(at('quick'), verdict('quick', 0.62)))).toBe('tiergear · quick 0.62 · unchanged (same tier)');
    const haiku = decideFirstTurn({ record: newRecord('t', now), floor: null, verdict: verdict('trivial', 0.9), config, tables });
    expect(statusText(haiku)).toBe('tiergear · trivial 0.90 → haiku/-');
  });
});
