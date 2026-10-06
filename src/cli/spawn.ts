import type { Harness } from '../core/tiers.js';
import type { LaunchPlan } from './launch.js';
import { OrcaError, findAgentHandle, parseBlockedReason, parseHandle, parseSatisfied, parseWorktree, type OrcaExec } from './orca.js';

export const WAIT_FIRST_MS = 60_000;
export const WAIT_RETRY_MS = 120_000;

export interface SpawnParams {
  brief: string;
  name: string;
  harness: Harness;
  repoDir: string;
  plan: LaunchPlan;
  orca: OrcaExec;
  writeFloor: (worktreePath: string) => Promise<void>;
  log: (line: string) => void;
}

export interface SpawnResult {
  status: 'sent' | 'not-started';
  worktree: { id: string; path: string };
  handle: string;
}

export async function spawnWorker(p: SpawnParams): Promise<SpawnResult> {
  const worktree = parseWorktree(await p.orca(['worktree', 'create', '--name', p.name, '--no-parent'], p.repoDir));
  p.log(`worktree ${worktree.path}`);
  // The floor must exist before the agent reads its first prompt.
  if (p.harness === 'claude') await p.writeFloor(worktree.path);

  const selector = `id:${worktree.id}`;
  let handle = parseHandle(await p.orca(['terminal', 'create', '--worktree', selector, '--title', p.name, '--command', p.plan.command]));

  // After an Orca restart a handle goes stale: re-list once and continue with the replacement only.
  const withHandle = async (args: (h: string) => string[]): Promise<unknown> => {
    try {
      return await p.orca(args(handle));
    } catch (error) {
      if (!(error instanceof OrcaError) || error.code !== 'terminal_handle_stale') throw error;
      const replacement = findAgentHandle(await p.orca(['terminal', 'list', '--worktree', selector]), worktree.id, p.harness, p.name);
      if (!replacement) throw error;
      handle = replacement;
      p.log(`handle refreshed: ${handle}`);
      return p.orca(args(handle));
    }
  };

  const wait = (ms: number) => withHandle((h) => ['terminal', 'wait', '--terminal', h, '--for', 'tui-idle', '--timeout-ms', String(ms)]);
  const first = await wait(WAIT_FIRST_MS);
  let ready = parseSatisfied(first);
  if (!ready) {
    // Never accept the trust prompt on the user's behalf.
    if (parseBlockedReason(first) === 'agent-trust-workspace') {
      p.log(`Claude is asking whether to trust ${worktree.path}; approve it in Orca — waiting up to 120s`);
    }
    ready = parseSatisfied(await wait(WAIT_RETRY_MS));
  }
  // A prompt typed into a TUI that is still starting is lost, so never send blind.
  if (!ready) return { status: 'not-started', worktree, handle };

  await withHandle((h) => ['terminal', 'send', '--terminal', h, '--text', p.brief, '--enter']);
  return { status: 'sent', worktree, handle };
}
