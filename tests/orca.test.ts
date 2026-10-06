import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrcaError, errorCode, findAgentHandle, parseBlockedReason, parseHandle, parseOrcaOutput, parseRunId, parseSatisfied, parseWorkerStart, parseWorktree } from '../src/cli/orca.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(`tests/fixtures/orca/${name}.json`, 'utf8'));

describe('orca parsers on recorded output', () => {
  it('reads the worktree id and path', () => {
    const worktree = parseWorktree(fixture('worktree-create'));
    expect(worktree.id).toContain('::');
    expect(worktree.path.startsWith('/')).toBe(true);
  });

  it('reads the terminal handle, the wait result, the list and an error code', () => {
    const handle = parseHandle(fixture('terminal-create'));
    const worktree = parseWorktree(fixture('worktree-create'));
    expect(handle.length).toBeGreaterThan(0);
    expect(typeof parseSatisfied(fixture('terminal-wait'))).toBe('boolean');
    expect(findAgentHandle(fixture('terminal-list'), worktree.id, 'claude', 'tiergear-probe')).toBe(handle);
    expect(errorCode(fixture('terminal-error'))).not.toBeNull();
  });

  it('reads the blocked reason of an unsatisfied wait', () => {
    expect(parseBlockedReason(fixture('terminal-wait'))).toBe('agent-trust-workspace');
    expect(parseBlockedReason({ wait: { satisfied: true } })).toBeNull();
  });

  it('reads the bound run, or null when none is bound', () => {
    expect(parseRunId(fixture('run-current'))).toBe('run_2ff269eb54f7');
    expect(parseRunId({ ok: true, result: { run: null } })).toBeNull();
  });

  it('reads the lifecycle ids and agent terminal from a worker-start receipt', () => {
    expect(parseWorkerStart(fixture('worker-start'))).toEqual({
      runId: 'run_2ff269eb54f7',
      taskId: 'task_b4eb2db75c1d',
      dispatchId: 'ctx_560165450ecd',
      handle: 'term_949ab59a-43c0-4149-b443-6016c4216f97',
    });
  });
});

describe('parseWorkerStart', () => {
  it('turns a failed receipt into an OrcaError with its code', () => {
    const failed = { ok: false, error: { code: 'consumer_fenced', message: 'worker-start requires the coordinator terminal' } };
    expect(() => parseWorkerStart(failed)).toThrow(OrcaError);
    expect(() => parseWorkerStart(failed)).toThrow('consumer_fenced');
  });
});

describe('parseOrcaOutput', () => {
  it('skips the keepalive lines a long --json call streams before its result', () => {
    const stdout = '{"_keepalive":true,"_heartbeat":true,"elapsedMs":15001,"deadlineMs":120000}\n{\n  "ok": true,\n  "result": { "run": null }\n}\n';
    expect(parseOrcaOutput(stdout)).toEqual({ ok: true, result: { run: null } });
  });

  it('returns null for empty or unparseable output', () => {
    expect(parseOrcaOutput('')).toBeNull();
    expect(parseOrcaOutput('not json')).toBeNull();
  });
});

describe('findAgentHandle', () => {
  const list = { terminals: [{ title: 'by-title', handle: 'h1', worktreeId: 'w2' }, { title: 'claude', handle: 'h2', worktreeId: 'w1', agentIdentity: 'claude' }] };
  it('prefers the agent identity in the worktree, then falls back to the title', () => {
    expect(findAgentHandle(list, 'w1', 'claude', 'by-title')).toBe('h2');
    expect(findAgentHandle(list, 'w9', 'codex', 'by-title')).toBe('h1');
    expect(findAgentHandle(list, 'w9', 'codex', 'none')).toBeNull();
  });
});

describe('orca parsers on shapes from the guide', () => {
  it('accepts the documented field names', () => {
    expect(parseWorktree({ worktree: { id: 'r1::/w/x' } })).toEqual({ id: 'r1::/w/x', path: '/w/x' });
    expect(parseSatisfied({ wait: { satisfied: true } })).toBe(true);
    expect(parseSatisfied({ wait: { satisfied: false } })).toBe(false);
    expect(() => parseWorktree({})).toThrow('worktree.id');
  });
});
