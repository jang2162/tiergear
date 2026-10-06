import { describe, expect, it } from 'vitest';
import { cliJudgeOptions } from '../src/cli/judge.js';
import { JUDGE_PRESETS, isAllowedJudgeUrl, presetKeyApplies } from '../src/core/judges/presets.js';

describe('cliJudgeOptions', () => {
  it('defaults to jev with its key', () => {
    expect(cliJudgeOptions({}, { TYPESAFE_API_KEY: 'k' })).toEqual({ name: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKey: 'k', keyRequired: true });
  });

  it('lets flags beat environment variables and fills the rest from the preset', () => {
    const env = { TIERGEAR_JUDGE: 'laya', TIERGEAR_JUDGE_URL: 'http://127.0.0.1:11435', KEV_API_KEY: 'kk' };
    expect(cliJudgeOptions({}, env)).toMatchObject({ name: 'laya', baseUrl: 'http://127.0.0.1:11435', model: 'laya', apiKey: undefined, keyRequired: false });
    expect(cliJudgeOptions({ judge: 'kev', url: 'http://localhost:8009' }, env)).toMatchObject({ name: 'kev', baseUrl: 'http://localhost:8009', model: 'kev-latest', apiKey: 'kk' });
    expect(cliJudgeOptions({ judge: 'kev', url: 'https://me--kev-api.modal.run', model: 'kev-9b' }, env)).toMatchObject({ baseUrl: 'https://me--kev-api.modal.run', model: 'kev-9b' });
  });

  it("never sends a preset's key to another address", () => {
    expect(cliJudgeOptions({ url: 'https://judge.example' }, { TYPESAFE_API_KEY: 'k' }).apiKey).toBeUndefined();
    expect(cliJudgeOptions({ url: 'https://judge.example' }, { TIERGEAR_JUDGE_API_KEY: 'mine', TYPESAFE_API_KEY: 'k' }).apiKey).toBe('mine');
    expect(cliJudgeOptions({ url: 'https://api.typesafe.ai/' }, { TYPESAFE_API_KEY: 'k' }).apiKey).toBe('k');
  });

  it('refuses plain http to another machine', () => {
    expect(() => cliJudgeOptions({ judge: 'kev', url: 'http://gpu-box:8009' }, {})).toThrow('https');
  });

  it('prefers TIERGEAR_JUDGE_API_KEY and rejects an unknown judge', () => {
    expect(cliJudgeOptions({}, { TIERGEAR_JUDGE_API_KEY: 'a', TYPESAFE_API_KEY: 'b' }).apiKey).toBe('a');
    expect(() => cliJudgeOptions({ judge: 'gpt' }, {})).toThrow('unknown judge gpt');
  });
});

describe('judge addresses', () => {
  it('allows https anywhere and plain http only to this machine', () => {
    for (const url of ['https://api.typesafe.ai', 'http://localhost:11435', 'http://127.0.0.1:8009', 'http://[::1]:8009']) expect(isAllowedJudgeUrl(url)).toBe(true);
    for (const url of ['http://gpu-box:8009', 'http://localhost.evil.example', 'ftp://x', 'not a url']) expect(isAllowedJudgeUrl(url)).toBe(false);
  });

  it("matches a preset's own address, ignoring a trailing slash", () => {
    expect(presetKeyApplies(JUDGE_PRESETS.jev, 'https://api.typesafe.ai/')).toBe(true);
    expect(presetKeyApplies(JUDGE_PRESETS.jev, 'https://judge.example')).toBe(false);
  });
});
