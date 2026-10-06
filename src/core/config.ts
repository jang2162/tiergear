import { JUDGE_PRESETS, isJudgeName, type JudgeName } from './judges/presets.js';

export interface Config {
  judge: JudgeName;
  judgeBaseUrl: string;
  judgeModel: string;
  judgeApiKey?: string;
  switchModelMidSession: boolean;
  minUpgradeConfidence: number;
  minDowngradeConfidence: number;
  downgradeStreak: number;
  stuckConfidence: number;
  stuckFailures: number;
  firstTurnTimeoutMs: number;
  turnTimeoutMs: number;
  // The [ Recent ] button in the band above the prompt; /tiergear opens the pane either way.
  showRecentButton: boolean;
  // The line and the tier buttons in the band; a status line tool can show the line instead (tiergear status).
  showStatusText: boolean;
  showTierButtons: boolean;
  // The parts of the band's line, each on its own; showStatusText off hides all four. The prefix is `tiergear ·`.
  showPrefix: boolean;
  showTier: boolean;
  showConfidence: boolean;
  showModelEffort: boolean;
  showReason: boolean;
}

// A hook has 10s; the judge gets at most 8s of it so the rest of the hook still fits.
export const MAX_JUDGE_TIMEOUT_MS = 8000;

type NumberKey = { [K in keyof Config]-?: Config[K] extends number ? K : never }[keyof Config];

const NUMBER_KEYS: readonly NumberKey[] = [
  'minUpgradeConfidence',
  'minDowngradeConfidence',
  'downgradeStreak',
  'stuckConfidence',
  'stuckFailures',
  'firstTurnTimeoutMs',
  'turnTimeoutMs',
];

function text(options: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
  const judge: JudgeName = isJudgeName(options['judge']) ? options['judge'] : 'jev';
  const preset = JUDGE_PRESETS[judge];
  const config: Config = {
    judge,
    judgeBaseUrl: text(options, 'judgeBaseUrl') ?? preset.baseUrl,
    judgeModel: text(options, 'judgeModel') ?? preset.model,
    switchModelMidSession: options['switchModelMidSession'] === true,
    minUpgradeConfidence: 0.5,
    minDowngradeConfidence: 0.85,
    downgradeStreak: 2,
    stuckConfidence: 0.6,
    stuckFailures: 3,
    firstTurnTimeoutMs: preset.firstTurnTimeoutMs,
    turnTimeoutMs: preset.turnTimeoutMs,
    showRecentButton: options['showRecentButton'] !== false,
    showStatusText: options['showStatusText'] !== false,
    showTierButtons: options['showTierButtons'] !== false,
    showPrefix: options['showPrefix'] !== false,
    showTier: options['showTier'] !== false,
    showConfidence: options['showConfidence'] !== false,
    showModelEffort: options['showModelEffort'] !== false,
    showReason: options['showReason'] !== false,
  };
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }
  config.firstTurnTimeoutMs = Math.min(config.firstTurnTimeoutMs, MAX_JUDGE_TIMEOUT_MS);
  config.turnTimeoutMs = Math.min(config.turnTimeoutMs, MAX_JUDGE_TIMEOUT_MS);
  const apiKey = text(options, 'judgeApiKey');
  if (apiKey) config.judgeApiKey = apiKey;
  return config;
}

export const DEFAULT_CONFIG: Config = resolveConfig({});
