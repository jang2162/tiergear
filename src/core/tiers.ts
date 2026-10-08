export const TIER_ORDER = ['trivial', 'quick', 'standard', 'deep', 'max'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type Harness = 'claude' | 'codex';

export interface Target {
  model: string;
  // null: send no effort (Haiku 5.5 has none).
  effort: Effort | null;
}

// turn.step names the request's model by id; the CLI flags take aliases.
export const CLAUDE_MODEL_IDS: Readonly<Record<string, string>> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

export function claudeModelId(model: string): string {
  return CLAUDE_MODEL_IDS[model] ?? model;
}

// A dated (`claude-haiku-5-5-20251001`) or suffixed (`claude-opus-5-5[1m]`) id names the same model.
export function claudeAlias(model: string): string {
  for (const [alias, id] of Object.entries(CLAUDE_MODEL_IDS)) {
    if (model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}[`)) return alias;
  }
  return model;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_ORDER as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

export function stepUp(tier: Tier): Tier {
  return TIER_ORDER[Math.min(tierRank(tier) + 1, TIER_ORDER.length - 1)]!;
}

export function stepDown(tier: Tier): Tier {
  return TIER_ORDER[Math.max(tierRank(tier) - 1, 0)]!;
}

export function maxTier(a: Tier, b: Tier | null): Tier {
  return b !== null && tierRank(b) > tierRank(a) ? b : a;
}

// The bounds a person put on a launch (`--min-tier`, `--max-tier`); either may be left out.
export interface TierRange {
  min?: Tier;
  max?: Tier;
}

export function clampTier(tier: Tier, range: TierRange): Tier {
  if (range.min && tierRank(tier) < tierRank(range.min)) return range.min;
  if (range.max && tierRank(tier) > tierRank(range.max)) return range.max;
  return tier;
}

export function launchCommand(harness: Harness, target: Target): string {
  // Tables admit only id characters, so quoting is needed just to keep a shell from globbing `[1m]`.
  const model = /^[A-Za-z0-9._:/-]+$/.test(target.model) ? target.model : `'${target.model}'`;
  if (harness === 'claude') {
    return target.effort ? `claude --model ${model} --effort ${target.effort}` : `claude --model ${model}`;
  }
  return target.effort ? `codex --model ${model} -c model_reasoning_effort="${target.effort}"` : `codex --model ${model}`;
}
