import type { Config } from './config.js';
import type { FloorRecord } from './floor.js';
import type { Verdict } from './judge.js';
import { abridge } from './state.js';
import { effortFor, firstTarget, type Tables } from './tables.js';
import { isEffort, isTier, maxTier, stepDown, stepUp, tierRank, type Effort, type Tier } from './tiers.js';

export interface Applied {
  model?: string;
  // null: send no effort.
  effort: Effort | null;
}

export interface SessionRecord {
  firstPrompt: string;
  tier: Tier | null;
  floor: Tier | null;
  // From the launch floor file: the tier is never raised above it.
  ceiling: Tier | null;
  // The model the session is held on after the first turn (an alias).
  model: string | null;
  // What turn.step writes on main-loop requests.
  applied: Applied | null;
  downStreak: number;
  pinned: boolean;
  judgeFailures: number;
  judgePausedUntil: number;
  updatedAt: number;
}

export type Change = 'set' | 'up' | 'down' | 'hold';

export interface Decision {
  record: SessionRecord;
  change: Change;
  confidence: number | null;
  reason: string;
}

export const JUDGE_FAILURE_LIMIT = 3;
export const JUDGE_PAUSE_MS = 5 * 60_000;
export const RECORD_TTL_MS = 7 * 24 * 60 * 60_000;
// $.store is one JSON file that rejects writes past 4 MiB, so records are capped in count and size.
export const MAX_RECORDS = 200;
export const FIRST_PROMPT_CHARS = 2000;

const PIN = /^\s*!pin\b\s*/;

export function isPinPrompt(text: string): boolean {
  return PIN.test(text);
}

export function stripPin(text: string): string {
  const stripped = text.replace(PIN, '');
  return stripped.length > 0 ? stripped : text;
}

export function newRecord(firstPrompt: string, now: number): SessionRecord {
  return {
    // The judge only ever sees this many characters of it.
    firstPrompt: abridge(firstPrompt, FIRST_PROMPT_CHARS),
    tier: null,
    floor: null,
    ceiling: null,
    model: null,
    applied: null,
    downStreak: 0,
    pinned: false,
    judgeFailures: 0,
    judgePausedUntil: 0,
    updatedAt: now,
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readApplied(value: unknown): Applied | null {
  if (!value || typeof value !== 'object') return null;
  const { model, effort } = value as { model?: unknown; effort?: unknown };
  if (effort !== null && !isEffort(effort)) return null;
  return typeof model === 'string' ? { model, effort } : { effort };
}

export function parseRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r['firstPrompt'] !== 'string' || typeof r['updatedAt'] !== 'number') return null;
  const tier = r['tier'];
  const floor = r['floor'];
  if (tier !== null && !isTier(tier)) return null;
  if (floor !== null && !isTier(floor)) return null;
  return {
    firstPrompt: r['firstPrompt'],
    tier,
    floor,
    // Records stored before ceilings have none.
    ceiling: isTier(r['ceiling']) ? r['ceiling'] : null,
    model: typeof r['model'] === 'string' ? r['model'] : null,
    applied: readApplied(r['applied']),
    downStreak: count(r['downStreak']),
    pinned: r['pinned'] === true,
    judgeFailures: count(r['judgeFailures']),
    judgePausedUntil: count(r['judgePausedUntil']),
    updatedAt: r['updatedAt'],
  };
}

function appliedFor(model: string | null, tier: Tier, config: Config, tables: Tables): Applied {
  if (config.switchModelMidSession) {
    const target = firstTarget(tables, 'claude', tier);
    return { model: target.model, effort: target.effort };
  }
  // Model held: only the effort follows the tier, from the session model's column in table B.
  const effort = effortFor(tables, 'claude', model ?? '', tier);
  if (model && effort === null) {
    // A model without effort cannot be raised by effort alone, so move to the tier's own model.
    const target = firstTarget(tables, 'claude', tier);
    if (target.model !== model) return { model: target.model, effort: target.effort };
  }
  return model ? { model, effort } : { effort };
}

// A pinned session runs on its own model and effort: nothing is applied.
function pinnedHold(record: SessionRecord, confidence: number | null): Decision {
  return { record: { ...record, applied: null, downStreak: 0 }, change: 'hold', confidence, reason: 'pinned' };
}

export function decideFirstTurn(input: {
  record: SessionRecord;
  floor: FloorRecord | null;
  verdict: Verdict | null;
  config: Config;
  tables: Tables;
}): Decision {
  const { record, floor, verdict, config, tables } = input;
  if (record.pinned) return pinnedHold(record, null);
  if (floor) {
    const target = firstTarget(tables, 'claude', floor.tier);
    return {
      record: {
        ...record,
        tier: floor.tier,
        floor: floor.tier,
        ceiling: floor.ceiling ?? null,
        model: target.model,
        applied: { model: target.model, effort: target.effort },
      },
      change: 'set',
      confidence: null,
      reason: `launched at ${floor.tier}`,
    };
  }
  const answer = verdict?.tier ?? null;
  if (!answer || answer.confidence < config.minUpgradeConfidence) {
    return { record, change: 'hold', confidence: answer?.confidence ?? null, reason: answer ? 'low confidence' : 'no answer' };
  }
  // The first turn has no cache to lose, so the model changes with the tier.
  const target = firstTarget(tables, 'claude', answer.tier);
  return {
    record: { ...record, tier: answer.tier, floor: stepDown(answer.tier), model: target.model, applied: { model: target.model, effort: target.effort } },
    change: 'set',
    confidence: answer.confidence,
    reason: 'first turn',
  };
}

export function decideNextTurn(input: {
  record: SessionRecord;
  verdict: Verdict | null;
  repeatedFailures: number;
  // The alias of the live main-loop model, used when the first turn left record.model unset.
  sessionModel: string | null;
  config: Config;
  tables: Tables;
}): Decision {
  const { record, verdict, config, tables } = input;
  const model = record.model ?? input.sessionModel;
  const answer = verdict?.tier ?? null;
  const confidence = answer?.confidence ?? null;
  const hold = (reason: string, downStreak = 0): Decision => ({ record: { ...record, downStreak }, change: 'hold', confidence, reason });
  const move = (tier: Tier, change: Change, reason: string): Decision => {
    const applied = appliedFor(model, tier, config, tables);
    return { record: { ...record, tier, applied, model: applied.model ?? model, downStreak: 0 }, change, confidence, reason };
  };

  if (record.pinned) return pinnedHold(record, confidence);

  if (record.tier === null) {
    if (!answer || answer.confidence < config.minUpgradeConfidence) return hold(answer ? 'low confidence' : 'no answer');
    const decided = move(answer.tier, 'set', 'tier decided');
    return { ...decided, record: { ...decided.record, floor: record.floor ?? stepDown(answer.tier) } };
  }

  const current = record.tier;
  const raise = (tier: Tier, reason: string): Decision => {
    const capped = record.ceiling !== null && tierRank(tier) > tierRank(record.ceiling) ? record.ceiling : tier;
    return tierRank(capped) > tierRank(current) ? move(capped, 'up', reason) : hold('at ceiling');
  };
  if (answer && tierRank(answer.tier) > tierRank(current) && answer.confidence >= config.minUpgradeConfidence) {
    return raise(answer.tier, 'harder step');
  }

  const stuck = (verdict?.stuck ?? 0) >= config.stuckConfidence || input.repeatedFailures >= config.stuckFailures;
  if (stuck) return current === 'max' ? hold('stuck at max') : raise(stepUp(current), 'stuck');

  // Lowering needs a confident judge on consecutive turns, so one terse follow-up cannot drop the tier.
  if (answer && tierRank(answer.tier) < tierRank(current) && answer.confidence >= config.minDowngradeConfidence) {
    const streak = record.downStreak + 1;
    if (streak < config.downgradeStreak) return hold(`easier step ${streak}/${config.downgradeStreak}`, streak);
    const lower = maxTier(stepDown(current), record.floor);
    return lower === current ? hold('at floor') : move(lower, 'down', 'easier steps');
  }

  if (!answer) return hold('no answer');
  const bar = tierRank(answer.tier) > tierRank(current) ? config.minUpgradeConfidence : tierRank(answer.tier) < tierRank(current) ? config.minDowngradeConfidence : 0;
  return hold(answer.confidence < bar ? 'low confidence' : 'same tier');
}

export function canAskJudge(record: SessionRecord, now: number): boolean {
  return now >= record.judgePausedUntil;
}

export function noteJudgeOutcome(record: SessionRecord, ok: boolean, now: number): SessionRecord {
  if (ok) return { ...record, judgeFailures: 0 };
  const failures = record.judgeFailures + 1;
  return failures >= JUDGE_FAILURE_LIMIT
    ? { ...record, judgeFailures: 0, judgePausedUntil: now + JUDGE_PAUSE_MS }
    : { ...record, judgeFailures: failures };
}

export function appliedText(applied: Applied): string {
  const effort = applied.effort ?? '-';
  return applied.model ? `${applied.model}/${effort}` : effort;
}

/** The model (alias) and effort a main-loop request actually runs on. */
export interface InEffect {
  model: string | null;
  effort: string | number | null;
}

// tiergear's override wins over the engine's values; a missing piece is the engine's.
export function inEffect(applied: Applied | null, engine: InEffect | null): InEffect | null {
  if (!applied) return engine;
  return { model: applied.model ?? engine?.model ?? null, effort: applied.effort };
}

function inEffectText(current: InEffect): string {
  const effort = current.effort === null ? '-' : String(current.effort);
  return current.model ? `${current.model}/${effort}` : effort;
}

export function statusText(decision: Decision, current: InEffect | null = null): string {
  const { record, change, confidence, reason } = decision;
  const tier = record.tier ?? 'unset';
  const said = confidence === null ? 'n/d' : confidence.toFixed(2);
  if (change === 'hold' || !record.applied) {
    const now = current ? ` · ${inEffectText(current)}` : '';
    return `tiergear · ${tier} ${said}${now} · unchanged (${reason})`;
  }
  return `tiergear · ${tier} ${said} → ${current ? inEffectText(current) : appliedText(record.applied)}`;
}
