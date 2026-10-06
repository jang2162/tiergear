import { describe, expect, it } from 'vitest';
import { cliJudgeOptions } from '../src/cli/judge.js';

describe('cliJudgeOptions', () => {
  it('defaults to jev with its key', () => {
    expect(cliJudgeOptions({}, { TYPESAFE_API_KEY: 'k' })).toEqual({ name: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKey: 'k', keyRequired: true });
  });

  it('lets flags beat environment variables and fills the rest from the preset', () => {
    const env = { TIERGEAR_JUDGE: 'laya', TIERGEAR_JUDGE_URL: 'http://gpu-box:11435', KEV_API_KEY: 'kk' };
    expect(cliJudgeOptions({}, env)).toMatchObject({ name: 'laya', baseUrl: 'http://gpu-box:11435', model: 'laya', apiKey: undefined, keyRequired: false });
    expect(cliJudgeOptions({ judge: 'kev' }, env)).toMatchObject({ name: 'kev', baseUrl: 'http://gpu-box:11435', model: 'kev-latest', apiKey: 'kk' });
    expect(cliJudgeOptions({ judge: 'kev', url: 'https://me--kev-api.modal.run', model: 'kev-9b' }, env)).toMatchObject({ baseUrl: 'https://me--kev-api.modal.run', model: 'kev-9b' });
  });

  it('prefers TIERGEAR_JUDGE_API_KEY and rejects an unknown judge', () => {
    expect(cliJudgeOptions({}, { TIERGEAR_JUDGE_API_KEY: 'a', TYPESAFE_API_KEY: 'b' }).apiKey).toBe('a');
    expect(() => cliJudgeOptions({ judge: 'gpt' }, {})).toThrow('unknown judge gpt');
  });
});
