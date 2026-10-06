import { createSystemOneJudge } from '../src/core/judges/systemone.js';
import { cliJudgeOptions } from '../src/cli/judge.js';
import { nodeSleep, nodeTransport } from '../src/cli/node.js';
import { firstTurnState } from '../src/core/state.js';

// The CLI's own rules: https or localhost only, and a preset's key only to its own address.
const options = cliJudgeOptions({ judge: process.argv[2] }, process.env);
const judge = createSystemOneJudge({ ...options, transport: nodeTransport, sleep: nodeSleep });

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
  console.log(`${options.name}\t${Date.now() - started}ms\t${JSON.stringify(result)}\t${prompt}`);
}
