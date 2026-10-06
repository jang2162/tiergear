import type { Judge } from '../core/judge.js';
import { firstTurnState } from '../core/state.js';
import { firstTarget, type Tables } from '../core/tables.js';
import { launchCommand, type Harness, type Target, type Tier } from '../core/tiers.js';

export const CLI_TIMEOUT_MS = 5000;
const MIN_CONFIDENCE = 0.5;

export interface LaunchPlan {
  tier: Tier;
  confidence: number | null;
  target: Target;
  command: string;
  warning: string | null;
  outcome: string;
  ms: number;
}

export async function planLaunch(params: { brief: string; harness: Harness; judge: Judge; tables: Tables; now: () => number }): Promise<LaunchPlan> {
  const started = params.now();
  const result = await params.judge.ask({ state: firstTurnState(params.brief), withStuck: false, timeoutMs: CLI_TIMEOUT_MS });
  const ms = params.now() - started;
  let tier: Tier = 'standard';
  let confidence: number | null = null;
  let warning: string | null = null;
  let outcome = 'ok';
  if (!result.ok) {
    outcome = result.reason;
    warning = `${params.judge.name} unavailable (${result.reason}); using standard`;
  } else if (!result.verdict.tier) {
    warning = `${params.judge.name} gave no tier; using standard`;
  } else if (result.verdict.tier.confidence < MIN_CONFIDENCE) {
    confidence = result.verdict.tier.confidence;
    warning = `low confidence ${confidence.toFixed(2)} for ${result.verdict.tier.tier}; using standard`;
  } else {
    tier = result.verdict.tier.tier;
    confidence = result.verdict.tier.confidence;
  }
  const target = firstTarget(params.tables, params.harness, tier);
  return { tier, confidence, target, command: launchCommand(params.harness, target), warning, outcome, ms };
}
