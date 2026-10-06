import { createSystemOneJudge } from '../src/core/judges/systemone.js';
import { JUDGE_PRESETS, isJudgeName } from '../src/core/judges/presets.js';
import { firstTurnState } from '../src/core/state.js';

const name = process.argv[2] ?? 'jev';
if (!isJudgeName(name)) throw new Error(`unknown judge ${name}`);
const preset = JUDGE_PRESETS[name];

const judge = createSystemOneJudge({
  name,
  baseUrl: process.env['TIERGEAR_JUDGE_URL'] ?? preset.baseUrl,
  model: process.env['TIERGEAR_JUDGE_MODEL'] ?? preset.model,
  apiKey: process.env[preset.keyEnv],
  keyRequired: preset.keyRequired,
  transport: async (url, init) => {
    const r = await fetch(url, init);
    return { status: r.status, ok: r.ok, text: await r.text() };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
});

const prompts = [
  'what is the version in package.json?',
  'rename the variable `cnt` to `count` in src/a.ts',
  'add a --dry-run flag to the deploy script and test it',
  'the payment webhook double-charges some customers; find out why and fix it',
  'ok continue',
];

for (const prompt of prompts) {
  const started = Date.now();
  const result = await judge.ask({ state: firstTurnState(prompt), withStuck: false, timeoutMs: 10_000 });
  console.log(`${name}\t${Date.now() - started}ms\t${JSON.stringify(result)}\t${prompt}`);
}
