import type { Harness } from '../core/tiers.js';
import type { LaunchFloor, LaunchPlan } from './launch.js';
import {
  OrcaError,
  findAgentHandle,
  parseBlockedReason,
  parseHandle,
  parseRunId,
  parseSatisfied,
  parseWorkerStart,
  parseWorktree,
  type OrcaExec,
  type WorkerDispatch,
} from './orca.js';

export const WAIT_FIRST_MS = 60_000;
export const WAIT_RETRY_MS = 120_000;

export interface SpawnParams {
  brief: string;
  name: string;
  harness: Harness;
  repoDir: string;
  baseBranch?: string;
  plan: LaunchPlan;
  orca: OrcaExec;
  writeFloor: (worktreePath: string, floor: LaunchFloor) => Promise<void>;
  log: (line: string) => void;
}

export interface SpawnResult {
  status: 'sent' | 'not-started';
  worktree: { id: string; path: string };
  handle: string;
  dispatch: WorkerDispatch | null;
}

// The direct path types the brief into the agent's prompt, where a leading `!` runs a shell command and `/` a command.
export function briefProblem(brief: string): string | null {
  const start = brief.trimStart()[0];
  if (start === '!' || start === '/') return `the brief starts with '${start}', which a Claude Code prompt runs as a command; start it with text`;
  // Line breaks and tabs only: a carriage return submits early and an escape drives the terminal.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(brief)) return 'the brief contains control characters; only line breaks and tabs are allowed';
  return null;
}

export async function spawnWorker(p: SpawnParams): Promise<SpawnResult> {
  // worker-start only works for the coordinator of a bound Run; without one, launch the agent directly.
  const runId = parseRunId(await p.orca(['orchestration', 'run-current']));
  const base = p.baseBranch ? ['--base-branch', p.baseBranch] : [];
  const worktree = parseWorktree(await p.orca(['worktree', 'create', '--name', p.name, '--no-parent', ...base], p.repoDir));
  p.log(`worktree ${worktree.path}`);
  // The floor must exist before the agent reads its first prompt, which worker-start sends itself.
  if (p.harness === 'claude') {
    if (p.plan.floor) await p.writeFloor(worktree.path, p.plan.floor);
    else p.log('no floor written (judge fallback)');
  }

  const selector = `id:${worktree.id}`;
  if (runId) {
    const { model, effort } = p.plan.target;
    const dispatch = parseWorkerStart(
      await p.orca([
        'orchestration', 'worker-start', '--spec', p.brief, '--task-title', p.name, '--worktree', selector,
        '--agent', p.harness, '--model', model, ...(effort ? ['--effort', effort] : []),
        // Same budget as the direct path, so there is time to approve a trust prompt in Orca.
        '--timeout-ms', String(WAIT_FIRST_MS + WAIT_RETRY_MS),
      ]),
    );
    return { status: 'sent', worktree, handle: dispatch.handle, dispatch };
  }
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
  if (!ready) return { status: 'not-started', worktree, handle, dispatch: null };

  await withHandle((h) => ['terminal', 'send', '--terminal', h, '--text', p.brief, '--enter']);
  return { status: 'sent', worktree, handle, dispatch: null };
}
