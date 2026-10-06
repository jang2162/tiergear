import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { floorPath, normalizePath, serializeFloor } from '../core/floor.js';
import { appendLogLine, decisionLogPath, decisionsDir, parseLogLines, type LogEntry } from '../core/log.js';
import { DEFAULT_TABLES, parseTablesFile, tablesPath, type Tables } from '../core/tables.js';
import type { LaunchFloor } from './launch.js';

// The hook matches the session's cwd, which Claude Code reports as an absolute physical path.
export async function realWorktree(worktree: string): Promise<string> {
  const absolute = resolve(worktree);
  return realpath(absolute).catch(() => absolute);
}

export async function writeFloorFile(home: string, worktree: string, floor: LaunchFloor, now: number): Promise<string> {
  const real = normalizePath(await realWorktree(worktree));
  const path = floorPath(home, real);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeFloor({ worktree: real, tier: floor.tier, createdAt: now, ceiling: floor.ceiling }));
  return path;
}

export async function appendDecision(home: string, name: string, entry: LogEntry): Promise<void> {
  const path = decisionLogPath(home, name);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, appendLogLine(existing, JSON.stringify(entry)));
}

export async function readDecisions(home: string): Promise<LogEntry[]> {
  const dir = decisionsDir(home);
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries: LogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    entries.push(...parseLogLines(await readFile(join(dir, name), 'utf8')));
  }
  return entries;
}

export async function readTables(home: string): Promise<Tables> {
  const text = await readFile(tablesPath(home), 'utf8').catch(() => null);
  if (text === null) return DEFAULT_TABLES;
  const parsed = parseTablesFile(text);
  if (!parsed) console.error('tiergear: tables.json ignored: invalid JSON or values; using the default tables');
  return parsed ?? DEFAULT_TABLES;
}
