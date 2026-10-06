import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

describe('main', () => {
  const home = process.env['HOME'];
  afterEach(() => {
    process.env['HOME'] = home;
    vi.restoreAllMocks();
  });

  it('notes that floors are Claude-only when --worktree is given with codex', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    process.env['HOME'] = tmp;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Port 9 refuses at once, so the judge falls back without waiting.
    const code = await main(['launch', 'fix it', '--agent', 'codex', '--worktree', tmp, '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9']);
    expect(code).toBe(0);
    expect(errors.filter((l) => l.includes('floors are Claude-only'))).toHaveLength(1);
    expect(await readdir(join(tmp, '.local/state/tiergear'))).not.toContain('floors');
  });
});
