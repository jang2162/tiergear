import { parseArgs } from 'node:util';
import { createSystemOneJudge } from '../core/judges/systemone.js';
import type { Harness } from '../core/tiers.js';
import { appendDecision, readDecisions, readTables, writeFloorFile } from './files.js';
import { cliJudgeOptions } from './judge.js';
import { planLaunch, type LaunchPlan } from './launch.js';
import { homeDir, nodeSleep, nodeTransport } from './node.js';
import { summarize } from './stats.js';

export const USAGE = `usage:
  tiergear launch "<brief>" [--agent claude|codex] [--worktree <path>] [--judge jev|laya|kev] [--judge-url <url>] [--judge-model <name>]
  tiergear spawn "<brief>" --name <task> [--agent claude|codex] [--repo <dir>] [--judge ...]
  tiergear stats [days]`;

async function plan(
  command: string,
  brief: string,
  harness: Harness,
  home: string,
  flags: { judge?: string; url?: string; model?: string },
): Promise<LaunchPlan> {
  const options = cliJudgeOptions(flags, process.env);
  const judge = createSystemOneJudge({ ...options, transport: nodeTransport, sleep: nodeSleep });
  const result = await planLaunch({ brief, harness, judge, tables: await readTables(home), now: Date.now });
  if (result.warning) console.error(`tiergear: ${result.warning}`);
  await appendDecision(home, `cli-${new Date().toISOString().slice(0, 10)}`, {
    at: Date.now(),
    source: 'cli',
    session: command,
    phase: 'launch',
    judge: options.name,
    tier: result.tier,
    change: 'set',
    confidence: result.confidence,
    stuck: null,
    outcome: result.outcome,
    ms: result.ms,
    applied: { model: result.target.model, effort: result.target.effort },
    reason: command,
  });
  return result;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      agent: { type: 'string', default: 'claude' },
      worktree: { type: 'string' },
      name: { type: 'string' },
      repo: { type: 'string' },
      judge: { type: 'string' },
      'judge-url': { type: 'string' },
      'judge-model': { type: 'string' },
    },
  });
  const home = homeDir();

  if (command === 'stats') {
    const days = Number(positionals[0] ?? 7);
    console.log(summarize(await readDecisions(home), Date.now() - days * 86_400_000));
    return 0;
  }

  const brief = positionals.join(' ').trim();
  const harness = values.agent;
  if ((command !== 'launch' && command !== 'spawn') || !brief || (harness !== 'claude' && harness !== 'codex')) {
    console.error(USAGE);
    return 2;
  }
  const flags = { judge: values.judge, url: values['judge-url'], model: values['judge-model'] };

  if (command === 'launch') {
    const launch = await plan(command, brief, harness, home, flags);
    if (values.worktree && harness === 'claude') await writeFloorFile(home, values.worktree, launch.tier, Date.now());
    console.log(launch.command);
    return 0;
  }

  console.error('tiergear: spawn is not available yet');
  return 2;
}
