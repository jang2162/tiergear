import { execFile } from 'node:child_process';

export type OrcaExec = (args: readonly string[], cwd?: string) => Promise<unknown>;

export class OrcaError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export function pick(json: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    let value: unknown = json;
    for (const part of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    }
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// A long --json call streams one-line keepalive objects before its result, so drop those first.
export function parseOrcaOutput(stdout: string): unknown {
  const body = stdout
    .split('\n')
    .filter((line) => !/^\{"_keepalive":true\b/.test(line.trim()))
    .join('\n')
    .trim();
  return body ? safeJson(body) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorCode(json: unknown): string | null {
  const code = pick(json, ['error.code', 'code']);
  return typeof code === 'string' ? code : null;
}

// Arguments go to execFile as an array: no shell, so a brief's quotes and $ stay literal.
export function createOrcaExec(binary = process.env['ORCA_CLI_COMMAND'] || 'orca'): OrcaExec {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(binary, [...args, '--json'], { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const parsed = parseOrcaOutput(stdout);
        if (error) {
          const detail = (stderr || stdout || error.message).trim().slice(0, 300);
          reject(new OrcaError(`orca ${args.slice(0, 2).join(' ')} failed: ${detail}`, errorCode(parsed) ?? errorCode(safeJson(stderr))));
          return;
        }
        resolve(parsed);
      });
    });
}

export function parseWorktree(json: unknown): { id: string; path: string } {
  const id = pick(json, ['result.worktree.id', 'worktree.id']);
  if (typeof id !== 'string' || !id.includes('::')) throw new Error('orca worktree create returned no worktree.id');
  return { id, path: id.slice(id.indexOf('::') + 2) };
}

export function parseHandle(json: unknown): string {
  const handle = pick(json, ['result.terminal.handle', 'terminal.handle', 'handle']);
  if (typeof handle !== 'string' || !handle) throw new Error('orca terminal create returned no handle');
  return handle;
}

export function parseRunId(json: unknown): string | null {
  const id = pick(json, ['result.run.id', 'run.id']);
  return typeof id === 'string' && id ? id : null;
}

export interface WorkerDispatch {
  runId: string;
  taskId: string;
  dispatchId: string;
  handle: string;
}

export function parseWorkerStart(json: unknown): WorkerDispatch {
  if (pick(json, ['ok']) === false) {
    const code = errorCode(json);
    const message = pick(json, ['error.message']);
    throw new OrcaError(`orca orchestration worker-start failed: ${code ?? 'error'}: ${typeof message === 'string' ? message : ''}`.trim(), code);
  }
  const runId = pick(json, ['result.runId']);
  const taskId = pick(json, ['result.taskId']);
  const dispatchId = pick(json, ['result.dispatchId']);
  const effects = pick(json, ['result.effects']);
  const terminal = Array.isArray(effects)
    ? effects.find((e): e is { id: unknown } => !!e && typeof e === 'object' && e.kind === 'terminal' && e.role === 'agent')
    : undefined;
  const handle = terminal?.id;
  if (typeof runId !== 'string' || typeof taskId !== 'string' || typeof dispatchId !== 'string' || typeof handle !== 'string') {
    throw new Error('orca orchestration worker-start returned no dispatch ids or agent terminal');
  }
  return { runId, taskId, dispatchId, handle };
}

export function parseSatisfied(json: unknown): boolean {
  return pick(json, ['result.wait.satisfied', 'wait.satisfied', 'satisfied']) === true;
}

export function parseBlockedReason(json: unknown): string | null {
  const reason = pick(json, ['result.wait.blockedReason', 'wait.blockedReason']);
  return typeof reason === 'string' ? reason : null;
}

// Orca renames a terminal to its agent, so match on worktree + agent identity first and the title second.
export function findAgentHandle(json: unknown, worktreeId: string, agent: string, title: string): string | null {
  const list = pick(json, ['result.terminals', 'terminals']);
  if (!Array.isArray(list)) return null;
  const entries = list.filter((t): t is { handle?: unknown; title?: unknown; worktreeId?: unknown; agentIdentity?: unknown } => !!t && typeof t === 'object');
  const match = entries.find((t) => t.worktreeId === worktreeId && t.agentIdentity === agent) ?? entries.find((t) => t.title === title);
  return typeof match?.handle === 'string' ? match.handle : null;
}
