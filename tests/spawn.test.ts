import { describe, expect, it } from 'vitest';
import type { LaunchPlan } from '../src/cli/launch.js';
import { OrcaError, type OrcaExec } from '../src/cli/orca.js';
import { spawnWorker } from '../src/cli/spawn.js';

const plan: LaunchPlan = {
  tier: 'deep', confidence: 0.8, target: { model: 'opus', effort: 'xhigh' },
  command: 'claude --model opus --effort xhigh', warning: null, outcome: 'ok', ms: 300,
};

function fakeOrca(waits: (boolean | { satisfied: boolean; blockedReason?: string })[], options: { staleOnce?: boolean } = {}) {
  const calls: { args: string[]; cwd?: string }[] = [];
  let stale = options.staleOnce ?? false;
  const exec: OrcaExec = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const [group, action] = args;
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

function run(exec: OrcaExec, brief = 'fix it', floors: string[] = [], logs: string[] = []) {
  return spawnWorker({ brief, name: 'task', harness: 'claude', repoDir: '/repo', plan, orca: exec, writeFloor: async (p) => void floors.push(p), log: (l) => void logs.push(l) });
}

describe('spawnWorker', () => {
  it('creates, writes the floor, launches, waits and sends the brief verbatim', async () => {
    const { exec, calls } = fakeOrca([true]);
    const floors: string[] = [];
    const brief = 'fix "the" bug\nthen run $HOME/test';
    const result = await run(exec, brief, floors);
    expect(result).toEqual({ status: 'sent', worktree: { id: 'r1::/w/task', path: '/w/task' }, handle: 'h1' });
    expect(calls[0]).toEqual({ args: ['worktree', 'create', '--name', 'task', '--no-parent'], cwd: '/repo' });
    expect(calls[1]!.args).toEqual(['terminal', 'create', '--worktree', 'id:r1::/w/task', '--title', 'task', '--command', 'claude --model opus --effort xhigh']);
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
    await spawnWorker({ brief: 'b', name: 'task', harness: 'codex', repoDir: '/repo', plan, orca: exec, writeFloor: async (p) => void floors.push(p), log: () => {} });
    expect(floors).toEqual([]);
  });

  it('logs the trust prompt, never answers it, and sends once the retry wait is satisfied', async () => {
    const { exec, calls } = fakeOrca([{ satisfied: false, blockedReason: 'agent-trust-workspace' }, { satisfied: true }]);
    const logs: string[] = [];
    const result = await run(exec, 'fix it', [], logs);
    expect(result.status).toBe('sent');
    expect(logs).toContain('Claude is asking whether to trust /w/task; approve it in Orca — waiting up to 120s');
    expect(calls.filter((c) => c.args[1] === 'send')).toHaveLength(1);
  });
});
