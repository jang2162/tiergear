import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config.js';
import {
  JUDGE_PAUSE_MS,
  canAskJudge,
  decideFirstTurn,
  decideNextTurn,
  decidePause,
  decidePick,
  newRecord,
  noteJudgeOutcome,
  parseRecord,
  statusParts,
  statusText,
  type SessionRecord,
} from '../src/core/decide.js';
import type { Verdict } from '../src/core/judge.js';
import { abridge } from '../src/core/state.js';
import { DEFAULT_TABLES, mergeTables } from '../src/core/tables.js';
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

const next = (record: SessionRecord, v: Verdict | null, repeatedFailures = 0, c: Config = config, sessionModel: string | null = null) =>
  decideNextTurn({ record, verdict: v, repeatedFailures, sessionModel, config: c, tables });

describe('decideFirstTurn', () => {
  const first = (v: Verdict | null, extra: Partial<Parameters<typeof decideFirstTurn>[0]> = {}) =>
    decideFirstTurn({ record: newRecord('t', now), floor: null, verdict: v, config, tables, ...extra });

  it('applies table A and B for the confident tier and puts the floor one step below', () => {
    const d = first(verdict('deep', 0.8));
    expect(d.change).toBe('set');
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', model: 'opus', applied: { model: 'opus', effort: 'xhigh' } });
  });

  it('starts trivial on sonnet at low effort', () => {
    expect(first(verdict('trivial', 0.9)).record.applied).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('sends no effort when trivial is set back to haiku', () => {
    const haikuTables = mergeTables(tables, { claude: { models: { trivial: 'haiku' } } })!;
    expect(first(verdict('trivial', 0.9), { tables: haikuTables }).record.applied).toEqual({ model: 'haiku', effort: null });
  });

  it('keeps the session as it is on low confidence or no answer', () => {
    expect(first(verdict('deep', 0.3)).change).toBe('hold');
    const none = first(null);
    expect(none.change).toBe('hold');
    expect(none.record.applied).toBeNull();
  });

  it('uses a launch floor without the judge', () => {
    const d = first(null, { floor: { worktree: '/w', tier: 'max', createdAt: now } });
    expect(d.record).toMatchObject({ tier: 'max', floor: 'max', ceiling: null, applied: { model: 'fable', effort: 'xhigh' } });
  });

  it('keeps the launch ceiling on the record', () => {
    const d = first(null, { floor: { worktree: '/w', tier: 'quick', createdAt: now, ceiling: 'standard' } });
    expect(d.record).toMatchObject({ tier: 'quick', floor: 'quick', ceiling: 'standard' });
  });

  it('follows overridden tables', () => {
    const custom = { ...tables, claude: { ...tables.claude, effort: { ...tables.claude.effort, opus: { ...tables.claude.effort['opus']!, deep: 'max' as const } } } };
    expect(first(verdict('deep'), { tables: custom }).record.applied).toEqual({ model: 'opus', effort: 'max' });
  });

  it('stores the first prompt abridged to 2000 chars', () => {
    expect(newRecord('y'.repeat(5000), now).firstPrompt).toBe(abridge('y'.repeat(5000), 2000));
    expect(newRecord('short', now).firstPrompt).toBe('short');
  });

  it('does nothing for a pinned session', () => {
    const d = first(verdict('max'), { record: { ...newRecord('t', now), pinned: true, applied: { effort: 'low' } } });
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

  it('lowers at once to the tier asked, above the floor, when the judge is sure enough for the instant switch', () => {
    const instant = { ...config, instantSwitchConfidence: 0.95 };
    const sure = next(at('max', { floor: 'quick' }), verdict('trivial', 0.97), 0, instant);
    expect(sure).toMatchObject({ change: 'down', reason: 'instant switch' });
    expect(sure.record.tier).toBe('quick');
    expect(next(at('max', { floor: 'trivial' }), verdict('standard', 0.97), 0, instant).record.tier).toBe('standard');
    expect(next(at('deep'), verdict('trivial', 0.9), 0, instant).change).toBe('hold');
    expect(next(at('quick', { floor: 'quick' }), verdict('trivial', 0.99), 0, instant).reason).toBe('at floor');
  });

  it('needs the streak as before when the instant switch is off', () => {
    expect(next(at('deep'), verdict('trivial', 0.99)).change).toBe('hold');
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

  it('raises no higher than the ceiling, and holds at it', () => {
    const capped = next(at('quick', { ceiling: 'standard' }), verdict('max', 0.9));
    expect(capped.change).toBe('up');
    expect(capped.record.tier).toBe('standard');
    const held = next(capped.record, verdict('max', 0.9));
    expect(held.change).toBe('hold');
    expect(held.reason).toBe('at ceiling');
    expect(held.record.tier).toBe('standard');
  });

  it('raises no higher than the ceiling when stuck', () => {
    expect(next(at('quick', { ceiling: 'standard' }), null, 3).record.tier).toBe('standard');
    const held = next(at('standard', { ceiling: 'standard' }), verdict('standard', 0.9, 0.9));
    expect(held.change).toBe('hold');
    expect(held.reason).toBe('at ceiling');
  });

  it('sets a tier later from the live session model when the first turn held', () => {
    const d = next(newRecord('t', now), verdict('deep', 0.7), 0, config, 'sonnet');
    expect(d.change).toBe('set');
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', model: 'sonnet', applied: { model: 'sonnet', effort: 'high' } });
  });

  it('falls back to effort only when the session model is unknown', () => {
    const d = next(newRecord('t', now), verdict('deep', 0.7));
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', applied: { effort: 'xhigh' } });
    expect(d.record.applied?.model).toBeUndefined();
  });

  it('moves off a model that has no effort when raising', () => {
    const haiku = at('trivial', { model: 'haiku', applied: { model: 'haiku', effort: null } });
    const up = next(haiku, verdict('deep', 0.8));
    expect(up.change).toBe('up');
    expect(up.record.applied).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(up.record.model).toBe('opus');
    expect(next(haiku, null, 3).record.applied).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('explains holds', () => {
    expect(next(at('standard'), null).reason).toBe('no answer');
    expect(next(at('standard'), verdict('deep', 0.4)).reason).toBe('low confidence');
  });

  it('holds a pinned session and clears applied, so its own model and effort rule', () => {
    const d = next(at('quick', { pinned: true }), verdict('max'), 5);
    expect(d.change).toBe('hold');
    expect(d.reason).toBe('paused');
    expect(d.record.applied).toBeNull();
  });
});

describe('manual controls', () => {
  const pick = (record: SessionRecord, tier: Tier, sessionModel: string | null = null, c: Config = config) =>
    decidePick({ record, tier, sessionModel, config: c, tables });
  const firstTurn = (v: Verdict | null, extra: Partial<Parameters<typeof decideFirstTurn>[0]> = {}) =>
    decideFirstTurn({ record: newRecord('t', now), floor: null, verdict: v, config, tables, ...extra });
  const unprompted = (extra: Partial<SessionRecord> = {}): SessionRecord => ({ ...newRecord('', now), started: false, ...extra });

  it('starts from a picked tier mid-session, holding the model and taking its effort', () => {
    const d = pick(at('deep', { floor: 'standard', model: 'opus', applied: { model: 'opus', effort: 'xhigh' } }), 'quick');
    expect(d).toMatchObject({ change: 'set', reason: 'manual tier', confidence: null });
    expect(d.record).toMatchObject({ tier: 'quick', model: 'opus', applied: { model: 'opus', effort: 'low' }, pinned: false, downStreak: 0 });
  });

  it('lowers the floor to a pick below it and keeps it otherwise', () => {
    expect(pick(at('deep', { floor: 'standard' }), 'trivial').record.floor).toBe('trivial');
    expect(pick(at('deep', { floor: 'standard' }), 'max').record.floor).toBe('standard');
    expect(pick(at('deep', { floor: null }), 'deep').record.floor).toBe('standard');
  });

  it('lets a pick pass the launch ceiling, while the judge stays capped', () => {
    const picked = pick(at('quick', { ceiling: 'standard' }), 'deep');
    expect(picked.record).toMatchObject({ tier: 'deep', ceiling: 'standard' });
    const later = next(picked.record, verdict('max', 0.9));
    expect(later.change).toBe('hold');
    expect(later.reason).toBe('at ceiling');
    expect(later.record.tier).toBe('deep');
  });

  it('switches the model too when switchModelMidSession is on', () => {
    expect(pick(at('quick'), 'deep', null, { ...config, switchModelMidSession: true }).record.applied).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it("unpauses on a pick and holds the session's own model, not the one it was held on before", () => {
    const paused = at('deep', { pinned: true, applied: null, model: 'sonnet' });
    const d = pick(paused, 'deep', 'opus');
    expect(d.record).toMatchObject({ pinned: false, model: 'opus', applied: { model: 'opus', effort: 'xhigh' } });
  });

  it('starts a pick made before the first prompt on table A, as the first turn would', () => {
    const d = pick(unprompted(), 'deep');
    expect(d.record).toMatchObject({ tier: 'deep', floor: 'standard', model: 'opus', applied: { model: 'opus', effort: 'xhigh' }, started: false });
  });

  it('keeps a pick made before the first prompt for that turn, without the judge', () => {
    const picked = pick(unprompted(), 'deep').record;
    const d = firstTurn(verdict('trivial', 0.99), { record: picked });
    expect(d).toMatchObject({ change: 'hold', reason: 'manual tier', confidence: null });
    expect(d.record).toMatchObject({ tier: 'deep', applied: { model: 'opus', effort: 'xhigh' } });
  });

  it('keeps the launch bounds under a pick made before the first prompt', () => {
    const launch = { worktree: '/w', tier: 'standard' as const, createdAt: now, ceiling: 'deep' as const };
    expect(firstTurn(null, { record: pick(unprompted(), 'quick').record, floor: launch }).record).toMatchObject({ tier: 'quick', floor: 'quick', ceiling: 'deep' });
    expect(firstTurn(null, { record: pick(unprompted(), 'max').record, floor: launch }).record).toMatchObject({ tier: 'max', floor: 'standard', ceiling: 'deep' });
  });

  it('pauses: nothing applied, the session on its own model and effort', () => {
    const d = decidePause(at('deep', { downStreak: 1 }));
    expect(d).toMatchObject({ change: 'hold', reason: 'paused', confidence: null });
    expect(d.record).toMatchObject({ pinned: true, applied: null, downStreak: 0, tier: 'deep' });
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

  it('reads a record stored before the first-prompt mark as started', () => {
    const { started: _, ...old } = at('quick');
    expect(parseRecord(JSON.parse(JSON.stringify(old)))?.started).toBe(true);
    const unprompted = { ...newRecord('', now), started: false };
    expect(parseRecord(JSON.parse(JSON.stringify(unprompted)))?.started).toBe(false);
  });

  it('round-trips a ceiling and reads a record stored before ceilings as having none', () => {
    const capped = at('quick', { ceiling: 'standard' });
    expect(parseRecord(JSON.parse(JSON.stringify(capped)))).toEqual(capped);
    const { ceiling: _, ...old } = capped;
    expect(parseRecord(JSON.parse(JSON.stringify(old)))?.ceiling).toBeNull();
  });

  it('describes changes and holds', () => {
    expect(statusText(next(at('quick'), verdict('deep', 0.91)))).toBe('tiergear · deep 0.91 → sonnet/high');
    expect(statusText(next(at('quick'), verdict('quick', 0.62)))).toBe('tiergear · quick 0.62 · unchanged (same tier)');
    const haikuTables = mergeTables(tables, { claude: { models: { trivial: 'haiku' } } })!;
    const haiku = decideFirstTurn({ record: newRecord('t', now), floor: null, verdict: verdict('trivial', 0.9), config, tables: haikuTables });
    expect(statusText(haiku)).toBe('tiergear · trivial 0.90 → haiku/-');
  });

  it('builds the line from the parts asked for', () => {
    const all = { tier: true, confidence: true, modelEffort: true, reason: true };
    const up = next(at('quick'), verdict('deep', 0.91));
    const held = next(at('quick'), verdict('quick', 0.62));
    const current = { model: 'opus', effort: 'xhigh' };
    expect(statusParts(up, current, all)).toBe('deep 0.91 → opus/xhigh');
    expect(statusParts(held, current, all)).toBe('quick 0.62 · opus/xhigh · unchanged (same tier)');
    expect(statusParts(up, current, { ...all, confidence: false })).toBe('deep → opus/xhigh');
    expect(statusParts(up, current, { ...all, tier: false, confidence: false })).toBe('→ opus/xhigh');
    expect(statusParts(held, current, { ...all, modelEffort: false })).toBe('quick 0.62 · unchanged (same tier)');
    expect(statusParts(held, current, { tier: false, confidence: true, modelEffort: false, reason: true })).toBe('0.62 · unchanged (same tier)');
    expect(statusParts(held, current, { ...all, reason: false })).toBe('quick 0.62 · opus/xhigh');
    expect(statusParts(up, current, { tier: false, confidence: false, modelEffort: false, reason: true })).toBe('');
  });

  it('shows the model and effort in effect, on holds too', () => {
    const current = { model: 'opus', effort: 'xhigh' };
    expect(statusText(next(at('quick'), verdict('quick', 0.62)), current)).toBe('tiergear · quick 0.62 · opus/xhigh · unchanged (same tier)');
    expect(statusText(next(at('quick'), verdict('deep', 0.91)), { model: 'sonnet', effort: 'high' })).toBe('tiergear · deep 0.91 → sonnet/high');
    expect(statusText(next(at('standard'), null), { model: 'haiku', effort: null })).toBe('tiergear · standard n/d · haiku/- · unchanged (no answer)');
  });
});
