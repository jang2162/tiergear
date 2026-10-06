import { parseArgs } from 'node:util';
import { createSystemOneJudge } from '../core/judges/systemone.js';
import type { Harness, TierRange } from '../core/tiers.js';
import { appendDecision, readDecisions, readTables, writeFloorFile } from './files.js';
import { cliJudgeOptions } from './judge.js';
import { parseTierRange, planLaunch, type LaunchPlan } from './launch.js';
import { createOrcaExec } from './orca.js';
import { homeDir, nodeSleep, nodeTransport, readStdin } from './node.js';
import { briefProblem, spawnWorker } from './spawn.js';
import { summarize } from './stats.js';
import { statusCommand } from './status.js';
import { isStatusField } from '../core/status.js';

export const USAGE = `usage:
  tiergear launch "<brief>" [--agent claude|codex] [--worktree <path>] [--min-tier <tier>] [--max-tier <tier>] [--judge jev|laya|kev] [--judge-url <url>] [--judge-model <name>]
  tiergear orca-spawn "<brief>" --name <task> [--agent claude|codex] [--repo <dir>] [--base-branch <ref>] [--min-tier <tier>] [--max-tier <tier>] [--judge ...]
  tiergear stats [days]
  tiergear status [tier|state|model|effort] [--session <id>] [--json] [--format <template>]
  <tier> is one of trivial|quick|standard|deep|max`;

async function plan(
  command: string,
  brief: string,
  harness: Harness,
  home: string,
  flags: { judge?: string; url?: string; model?: string },
  range: TierRange,
): Promise<LaunchPlan> {
  const options = cliJudgeOptions(flags, process.env);
  const judge = createSystemOneJudge({ ...options, transport: nodeTransport, sleep: nodeSleep });
  const result = await planLaunch({ brief, harness, judge, tables: await readTables(home), now: Date.now, range });
  if (result.warning) console.error(`tiergear: ${result.warning}`);
  try {
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
  } catch (error) {
    console.error(`tiergear: decision log not written: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      'base-branch': { type: 'string' },
      judge: { type: 'string' },
      'judge-url': { type: 'string' },
      'judge-model': { type: 'string' },
      'min-tier': { type: 'string' },
      'max-tier': { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean', default: false },
      format: { type: 'string' },
    },
  });
  const home = homeDir();

  if (command === 'status') {
    const field = positionals[0];
    if (positionals.length > 1 || (field !== undefined && !isStatusField(field))) {
      console.error(USAGE);
      return 2;
    }
    const out = await statusCommand({ home, session: values.session, stdin: () => readStdin(500), json: values.json, format: values.format, field });
    if (out) console.log(out);
    return 0;
  }

  if (command === 'stats') {
    const days = Number(positionals[0] ?? 7);
    console.log(summarize(await readDecisions(home), Date.now() - days * 86_400_000));
    return 0;
  }

  const brief = positionals.join(' ').trim();
  const harness = values.agent;
  if ((command !== 'launch' && command !== 'orca-spawn') || !brief || (harness !== 'claude' && harness !== 'codex')) {
    console.error(USAGE);
    return 2;
  }
  const flags = { judge: values.judge, url: values['judge-url'], model: values['judge-model'] };
  const parsedRange = parseTierRange(values['min-tier'], values['max-tier']);
  if (!parsedRange.ok) {
    console.error(`tiergear: ${parsedRange.error}`);
    return 2;
  }
  const { range } = parsedRange;
  const ranged = range.min !== undefined || range.max !== undefined;

  if (command === 'launch') {
    const launch = await plan(command, brief, harness, home, flags, range);
    // stdout carries only the command, so the tiers go to stderr.
    console.error(`tiergear: judged ${launch.judgedTier ?? 'none'}, applied ${launch.tier}`);
    if (harness === 'codex' && values.worktree) console.error('tiergear: --worktree ignored: floors are Claude-only');
    else if (harness === 'codex' && ranged) console.error('tiergear: the tier range sets the start only: floors are Claude-only');
    if (values.worktree && harness === 'claude') {
      if (launch.floor) await writeFloorFile(home, values.worktree, launch.floor, Date.now());
      else console.error('tiergear: no floor written (judge fallback)');
    }
    console.log(launch.command);
    return 0;
  }

  if (!values.name) {
    console.error(USAGE);
    return 2;
  }
  const problem = briefProblem(brief);
  if (problem) {
    console.error(`tiergear: ${problem}`);
    return 2;
  }
  const spawnPlan = await plan(command, brief, harness, home, flags, range);
  if (harness === 'codex' && ranged) console.error('tiergear: the tier range sets the start only: floors are Claude-only');
  const result = await spawnWorker({
    brief,
    name: values.name,
    harness,
    repoDir: values.repo ?? process.cwd(),
    baseBranch: values['base-branch'],
    plan: spawnPlan,
    orca: createOrcaExec(),
    writeFloor: async (path, floor) => {
      await writeFloorFile(home, path, floor, Date.now());
    },
    log: (line) => console.error(`tiergear: ${line}`),
  });
  if (result.status === 'not-started') {
    console.error('tiergear: the agent did not become ready; the brief was not sent. A fallback shell may remain in the worktree.');
  }
  console.log(JSON.stringify({ ...result, tier: spawnPlan.tier, judgedTier: spawnPlan.judgedTier, command: spawnPlan.command }));
  return result.status === 'sent' ? 0 : 1;
}
