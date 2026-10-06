import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTiergear, type HookHost } from '../hooks/tiergear.ts';
import { appendDecision, readDecisions, readTables, realWorktree, writeFloorFile } from '../src/cli/files.js';
import { parseFloor } from '../src/core/floor.js';
import type { LogEntry } from '../src/core/log.js';
import { DEFAULT_TABLES, tablesPath } from '../src/core/tables.js';

describe('files', () => {
  it('writes a floor the hook can read back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-'));
    const path = await writeFloorFile(home, '/w/task/', 'deep', 1000);
    expect(parseFloor(await readFile(path, 'utf8'), '/w/task', 1000)).toMatchObject({ tier: 'deep' });
  });

  it('resolves a worktree to its absolute real path, or the resolved path when it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    expect(await realWorktree(relative(process.cwd(), dir))).toBe(await realpath(dir));
    expect(await realWorktree('no/such/worktree')).toBe(resolve('no/such/worktree'));
  });

  it('writes the same floor file for a relative worktree as for its absolute path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-'));
    const dir = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    const fromRelative = await writeFloorFile(home, relative(process.cwd(), dir), 'deep', 1000);
    expect(await writeFloorFile(home, dir, 'deep', 1000)).toBe(fromRelative);
  });

  it('writes a floor the hook finds from the same HOME and cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    await writeFloorFile(home, relative(process.cwd(), worktree), 'deep', Date.now());
    let judgeCalls = 0;
    const store = new Map<string, unknown>();
    const host: HookHost = {
      // Claude Code reports the physical working directory (on macOS /private/var/..., not /var/...).
      session: { messages: async () => [], cwd: async () => realpath(worktree), id: async () => 'e2e' },
      store: {
        get: async (k) => store.get(k),
        set: async (k, v) => void store.set(k, v),
        delete: async (k) => void store.delete(k),
        keys: async () => [...store.keys()],
      },
      fs: { read: (path) => readFile(path, 'utf8'), write: (path, text) => writeFile(path, text) },
      env: { get: async (name) => (name === 'HOME' ? home : undefined) },
      settings: { read: async () => ({}) },
      http: {
        fetch: async () => {
          judgeCalls++;
          return { status: 500, ok: false, text: '' };
        },
      },
      clock: { now: async () => Date.now(), sleep: () => new Promise<void>(() => {}) },
      ui: { status: () => {}, log: () => {} },
    };
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, { text: 'go', origin: { kind: 'composer' } });
    expect(judgeCalls).toBe(0);
    expect(tiergear.applied('e2e')).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('appends decisions and reads them across files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-'));
    const e = { at: 1, source: 'cli', session: 'launch', phase: 'launch', judge: 'jev', tier: 'deep', change: 'set', confidence: 0.8, stuck: null, outcome: 'ok', ms: 300, applied: null, reason: 'launch' } satisfies LogEntry;
    await appendDecision(home, 'cli-a', e);
    await appendDecision(home, 'cli-b', { ...e, at: 2 });
    expect((await readDecisions(home)).map((x) => x.at).sort()).toEqual([1, 2]);
  });

  it('reads table overrides and falls back to the defaults', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-'));
    expect(await readTables(home)).toEqual(DEFAULT_TABLES);
    await mkdir(dirname(tablesPath(home)), { recursive: true });
    await writeFile(tablesPath(home), JSON.stringify({ claude: { models: { max: 'opus' } } }));
    expect((await readTables(home)).claude.models.max).toBe('opus');
    await writeFile(tablesPath(home), '{');
    expect(await readTables(home)).toEqual(DEFAULT_TABLES);
  });
});
