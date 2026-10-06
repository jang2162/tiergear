import { JUDGE_PRESETS, isAllowedJudgeUrl, isJudgeName, presetKeyApplies, type JudgeName } from '../core/judges/presets.js';

export interface CliJudgeOptions {
  name: JudgeName;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  keyRequired: boolean;
}

// The CLI cannot read the plugin's options, so it takes flags first, then TIERGEAR_* variables, then the preset.
export function cliJudgeOptions(
  flags: { judge?: string; url?: string; model?: string },
  env: Readonly<Record<string, string | undefined>>,
): CliJudgeOptions {
  const name = flags.judge ?? env['TIERGEAR_JUDGE'] ?? 'jev';
  if (!isJudgeName(name)) throw new Error(`unknown judge ${name} (use jev, laya or kev)`);
  const preset = JUDGE_PRESETS[name];
  const baseUrl = flags.url ?? env['TIERGEAR_JUDGE_URL'] ?? preset.baseUrl;
  if (!isAllowedJudgeUrl(baseUrl)) throw new Error(`judge URL ${baseUrl} must be https, or http to localhost`);
  const presetKey = presetKeyApplies(preset, baseUrl) ? env[preset.keyEnv] : undefined;
  return {
    name,
    baseUrl,
    model: flags.model ?? env['TIERGEAR_JUDGE_MODEL'] ?? preset.model,
    apiKey: env['TIERGEAR_JUDGE_API_KEY'] || presetKey || undefined,
    keyRequired: preset.keyRequired,
  };
}
