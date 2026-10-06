import type { FloorRecord } from '../core/floor.js';
import type { Judge } from '../core/judge.js';
import { firstTurnState } from '../core/state.js';
import { firstTarget, type Tables } from '../core/tables.js';
import { TIER_ORDER, clampTier, isTier, launchCommand, tierRank, type Harness, type Target, type Tier, type TierRange } from '../core/tiers.js';

export const CLI_TIMEOUT_MS = 5000;
const MIN_CONFIDENCE = 0.5;

export type LaunchFloor = Pick<FloorRecord, 'tier' | 'ceiling'>;

export interface LaunchPlan {
  // The tier launched on, after the range.
  tier: Tier;
  // The judge's tier before the range; null when it failed, gave none or was unsure.
  judgedTier: Tier | null;
  confidence: number | null;
  target: Target;
  command: string;
  warning: string | null;
  outcome: string;
  ms: number;
  // What a floor file should hold; null: write none.
  floor: LaunchFloor | null;
}

export function parseTierRange(min: string | undefined, max: string | undefined): { ok: true; range: TierRange } | { ok: false; error: string } {
  for (const [flag, value] of [['--min-tier', min], ['--max-tier', max]] as const) {
    if (value !== undefined && !isTier(value)) return { ok: false, error: `${flag} must be one of ${TIER_ORDER.join('|')}, not "${value}"` };
  }
  const range: TierRange = {};
  if (isTier(min)) range.min = min;
  if (isTier(max)) range.max = max;
  if (range.min && range.max && tierRank(range.min) > tierRank(range.max)) return { ok: false, error: `--min-tier ${range.min} is above --max-tier ${range.max}` };
  return { ok: true, range };
}

export async function planLaunch(params: { brief: string; harness: Harness; judge: Judge; tables: Tables; now: () => number; range?: TierRange }): Promise<LaunchPlan> {
  const range = params.range ?? {};
  const fallback = clampTier('standard', range);
  const started = params.now();
  const result = await params.judge.ask({ state: firstTurnState(params.brief), withStuck: false, timeoutMs: CLI_TIMEOUT_MS });
  const ms = params.now() - started;
  let judgedTier: Tier | null = null;
  let confidence: number | null = null;
  let warning: string | null = null;
  let outcome = 'ok';
  if (!result.ok) {
    outcome = result.reason;
    warning = `${params.judge.name} unavailable (${result.reason}); using ${fallback}`;
  } else if (!result.verdict.tier) {
    warning = `${params.judge.name} gave no tier; using ${fallback}`;
  } else if (result.verdict.tier.confidence < MIN_CONFIDENCE) {
    confidence = result.verdict.tier.confidence;
    warning = `low confidence ${confidence.toFixed(2)} for ${result.verdict.tier.tier}; using ${fallback}`;
  } else {
    judgedTier = result.verdict.tier.tier;
    confidence = result.verdict.tier.confidence;
  }
  const tier = judgedTier === null ? fallback : clampTier(judgedTier, range);
  // A range a person gave is not the judge's call, so it is floored even when the judge decided nothing.
  const floor = warning === null || range.min || range.max ? { tier, ceiling: range.max } : null;
  const target = firstTarget(params.tables, params.harness, tier);
  return { tier, judgedTier, confidence, target, command: launchCommand(params.harness, target), warning, outcome, ms, floor };
}
