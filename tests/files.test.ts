import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecision, readDecisions, readTables, writeFloorFile } from '../src/cli/files.js';
import { parseFloor } from '../src/core/floor.js';
import type { LogEntry } from '../src/core/log.js';
import { DEFAULT_TABLES, tablesPath } from '../src/core/tables.js';

describe('files', () => {
  it('writes a floor the hook can read back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-'));
    const path = await writeFloorFile(home, '/w/task/', 'deep', 1000);
    expect(parseFloor(await readFile(path, 'utf8'), '/w/task', 1000)).toMatchObject({ tier: 'deep' });
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
