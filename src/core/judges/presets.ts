export type JudgeName = 'jev' | 'laya' | 'kev';

export interface JudgePreset {
  baseUrl: string;
  model: string;
  keyEnv: string;
  keyRequired: boolean;
  firstTurnTimeoutMs: number;
  turnTimeoutMs: number;
}

// All three speak TypeSafe's /v1/systemone contract; only where and how to reach them differs.
export const JUDGE_PRESETS: Record<JudgeName, JudgePreset> = {
  jev: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', keyEnv: 'TYPESAFE_API_KEY', keyRequired: true, firstTurnTimeoutMs: 2000, turnTimeoutMs: 1200 },
  // Local models vary a lot by machine, so their budgets are wider.
  laya: { baseUrl: 'http://localhost:11435', model: 'laya', keyEnv: 'OLLAYA_API_KEY', keyRequired: false, firstTurnTimeoutMs: 3000, turnTimeoutMs: 2500 },
  kev: { baseUrl: 'http://localhost:8009', model: 'kev-latest', keyEnv: 'KEV_API_KEY', keyRequired: false, firstTurnTimeoutMs: 3000, turnTimeoutMs: 2000 },
};

export function isJudgeName(value: unknown): value is JudgeName {
  return value === 'jev' || value === 'laya' || value === 'kev';
}
