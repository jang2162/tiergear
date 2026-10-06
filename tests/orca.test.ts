import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorCode, findAgentHandle, parseBlockedReason, parseHandle, parseSatisfied, parseWorktree } from '../src/cli/orca.js';

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
