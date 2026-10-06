import { describe, expect, it } from 'vitest';
import { planLaunch, type LaunchPlan } from '../src/cli/launch.js';
import { OrcaError, type OrcaExec } from '../src/cli/orca.js';
import { briefProblem, spawnWorker, type SpawnParams } from '../src/cli/spawn.js';
import type { AskResult } from '../src/core/judge.js';
import { DEFAULT_TABLES } from '../src/core/tables.js';
import type { TierRange } from '../src/core/tiers.js';

const plan: LaunchPlan = {
  tier: 'deep', judgedTier: 'deep', confidence: 0.8, target: { model: 'opus', effort: 'xhigh' },
  command: 'claude --model opus --effort xhigh', warning: null, outcome: 'ok', ms: 300, floor: { tier: 'deep' },
};

const planned = (result: AskResult, range: TierRange) =>
  planLaunch({ brief: 'review the diff', harness: 'claude', judge: { name: 'jev', ask: async () => result }, tables: DEFAULT_TABLES, now: () => 0, range });

const receipt = {
  ok: true,
  result: {
    runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1',
    effects: [
      { kind: 'worktree', action: 'reused', id: 'r1::/w/task' },
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term_w' },
    ],
  },
};

function fakeOrca(waits: (boolean | { satisfied: boolean; blockedReason?: string })[], options: { staleOnce?: boolean; run?: string | null; events?: string[] } = {}) {
  const calls: { args: string[]; cwd?: string }[] = [];
  let stale = options.staleOnce ?? false;
  const exec: OrcaExec = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    options.events?.push(`${args[0]} ${args[1]}`);
    const [group, action] = args;
    if (group === 'orchestration' && action === 'run-current') return { ok: true, result: { run: options.run ? { id: options.run } : null } };
    if (group === 'orchestration' && action === 'worker-start') return receipt;
    if (group === 'worktree' && action === 'create') return { worktree: { id: 'r1::/w/task' } };
    if (group === 'terminal' && action === 'create') return { terminal: { handle: 'h1' } };
    if (group === 'terminal' && action === 'list') return { terminals: [{ title: 'claude', handle: 'h2', worktreeId: 'r1::/w/task', agentIdentity: 'claude' }] };
    if (group === 'terminal' && action === 'wait') {
      if (stale) {
        stale = false;
        throw new OrcaError('stale', 'terminal_handle_stale');
      }
      const next = waits.shift() ?? false;
      return { wait: typeof next === 'boolean' ? { satisfied: next } : next };
    }
    if (group === 'terminal' && action === 'send') return { ok: true };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { exec, calls };
}

function run(exec: OrcaExec, overrides: Partial<SpawnParams> = {}) {
  return spawnWorker({ brief: 'fix it', name: 'task', harness: 'claude', repoDir: '/repo', plan, orca: exec, writeFloor: async () => {}, log: () => {}, ...overrides });
}

describe('spawnWorker without a bound run', () => {
  it('creates, writes the floor, launches, waits and sends the brief verbatim', async () => {
    const { exec, calls } = fakeOrca([true]);
    const floors: string[] = [];
    const brief = 'fix "the" bug\nthen run $HOME/test';
    const result = await run(exec, { brief, writeFloor: async (p) => void floors.push(p) });
    expect(result).toEqual({ status: 'sent', worktree: { id: 'r1::/w/task', path: '/w/task' }, handle: 'h1', dispatch: null });
    expect(calls[0]!.args).toEqual(['orchestration', 'run-current']);
    expect(calls[1]).toEqual({ args: ['worktree', 'create', '--name', 'task', '--no-parent'], cwd: '/repo' });
    expect(calls[2]!.args).toEqual(['terminal', 'create', '--worktree', 'id:r1::/w/task', '--title', 'task', '--command', 'claude --model opus --effort xhigh']);
    expect(calls.at(-1)!.args).toEqual(['terminal', 'send', '--terminal', 'h1', '--text', brief, '--enter']);
    expect(floors).toEqual(['/w/task']);
  });

  it('waits once more with a longer timeout and does not send if still not ready', async () => {
    const { exec, calls } = fakeOrca([false, false]);
    const result = await run(exec);
    expect(result.status).toBe('not-started');
    expect(calls.filter((c) => c.args[1] === 'wait').map((c) => c.args.at(-1))).toEqual(['60000', '120000']);
    expect(calls.some((c) => c.args[1] === 'send')).toBe(false);
  });

  it('recovers a stale handle from the terminal list and uses only the new one', async () => {
    const { exec, calls } = fakeOrca([true], { staleOnce: true });
    const result = await run(exec);
    expect(result.handle).toBe('h2');
    expect(calls.at(-1)!.args).toContain('h2');
  });

  it('writes no floor for a Codex worker', async () => {
    const { exec } = fakeOrca([true]);
    const floors: string[] = [];
    await run(exec, { harness: 'codex', writeFloor: async (p) => void floors.push(p) });
    expect(floors).toEqual([]);
  });

  it('logs the trust prompt, never answers it, and sends once the retry wait is satisfied', async () => {
    const { exec, calls } = fakeOrca([{ satisfied: false, blockedReason: 'agent-trust-workspace' }, { satisfied: true }]);
    const logs: string[] = [];
    const result = await run(exec, { log: (l) => void logs.push(l) });
    expect(result.status).toBe('sent');
    expect(logs).toContain('Claude is asking whether to trust /w/task; approve it in Orca — waiting up to 120s');
    expect(calls.filter((c) => c.args[1] === 'send')).toHaveLength(1);
  });

  it('creates the worktree from the given base branch', async () => {
    const { exec, calls } = fakeOrca([true]);
    await run(exec, { baseBranch: 'main' });
    expect(calls[1]!.args).toEqual(['worktree', 'create', '--name', 'task', '--no-parent', '--base-branch', 'main']);
  });
});

describe('spawnWorker with a bound run', () => {
  it('writes the floor before worker-start places the agent in the new worktree with the judged model and effort', async () => {
    const events: string[] = [];
    const { exec, calls } = fakeOrca([], { run: 'run_1', events });
    const result = await run(exec, { writeFloor: async (p) => void events.push(`floor ${p}`) });
    expect(events).toEqual(['orchestration run-current', 'worktree create', 'floor /w/task', 'orchestration worker-start']);
    expect(calls.at(-1)!.args).toEqual([
      'orchestration', 'worker-start', '--spec', 'fix it', '--task-title', 'task', '--worktree', 'id:r1::/w/task',
      '--agent', 'claude', '--model', 'opus', '--effort', 'xhigh', '--timeout-ms', '180000',
    ]);
    expect(result).toEqual({
      status: 'sent',
      worktree: { id: 'r1::/w/task', path: '/w/task' },
      handle: 'term_w',
      dispatch: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', handle: 'term_w' },
    });
  });

  it('omits --effort for a model without effort', async () => {
    const { exec, calls } = fakeOrca([], { run: 'run_1' });
    await run(exec, { plan: { ...plan, tier: 'trivial', target: { model: 'haiku', effort: null }, command: 'claude --model haiku' } });
    const start = calls.at(-1)!.args;
    expect(start).toContain('haiku');
    expect(start).not.toContain('--effort');
  });

  it('never types into a terminal itself', async () => {
    const { exec, calls } = fakeOrca([], { run: 'run_1' });
    await run(exec);
    expect(calls.some((c) => c.args[0] === 'terminal')).toBe(false);
  });
});

describe('spawnWorker with a tier range', () => {
  it.each([null, 'run_1'])('floors the clamped tier and the ceiling and starts the agent at that tier (run: %s)', async (bound) => {
    const { exec, calls } = fakeOrca([true], { run: bound });
    const floors: unknown[] = [];
    const ranged = await planned({ ok: true, verdict: { tier: { tier: 'quick', confidence: 0.9 }, stuck: null } }, { min: 'standard', max: 'deep' });
    await run(exec, { plan: ranged, writeFloor: async (path, floor) => void floors.push([path, floor]) });
    expect(floors).toEqual([['/w/task', { tier: 'standard', ceiling: 'deep' }]]);
    const start = calls.find((c) => c.args[1] === 'worker-start' || (c.args[0] === 'terminal' && c.args[1] === 'create'))!.args;
    expect(start.join(' ')).toContain(bound ? '--model sonnet --effort medium' : 'claude --model sonnet --effort medium');
  });

  it.each([null, 'run_1'])('floors the range even when the judge failed (run: %s)', async (bound) => {
    const { exec } = fakeOrca([true], { run: bound });
    const floors: unknown[] = [];
    const ranged = await planned({ ok: false, reason: 'offline' }, { min: 'deep' });
    await run(exec, { plan: ranged, writeFloor: async (path, floor) => void floors.push([path, floor]) });
    expect(floors).toEqual([['/w/task', { tier: 'deep' }]]);
  });

  it('writes no floor after a judge fallback without a range, and says so', async () => {
    const { exec } = fakeOrca([true]);
    const floors: string[] = [];
    const logs: string[] = [];
    const fallback = await planned({ ok: false, reason: 'offline' }, {});
    await run(exec, { plan: fallback, writeFloor: async (p) => void floors.push(p), log: (l) => void logs.push(l) });
    expect(floors).toEqual([]);
    expect(logs).toContain('no floor written (judge fallback)');
  });
});

describe('briefProblem', () => {
  it('refuses what a worker prompt would run instead of read', () => {
    expect(briefProblem('!echo tg > /tmp/tg-probe')).toContain('!');
    expect(briefProblem('  /review the diff')).toContain('/');
    expect(briefProblem('fix it\u001b[2J')).toContain('control');
    expect(briefProblem('fix it\rnow')).toContain('control');
  });

  it('accepts ordinary text, line breaks and tabs', () => {
    expect(briefProblem('fix "the" bug\nthen run $HOME/test\tnow')).toBeNull();
    expect(briefProblem('README의 /path 를 읽어줘')).toBeNull();
  });
});
