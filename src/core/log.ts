import type { Applied, Change } from './decide.js';
import type { Tier } from './tiers.js';

export interface LogEntry {
  at: number;
  source: 'hook' | 'cli';
  session: string;
  phase: 'first' | 'next' | 'launch';
  judge: string;
  tier: Tier | null;
  change: Change;
  confidence: number | null;
  stuck: number | null;
  // 'ok', 'skipped', or the failure reason.
  outcome: string;
  ms: number | null;
  applied: Applied | null;
  reason: string;
}

export const MAX_LOG_LINES = 1000;

export function decisionsDir(home: string): string {
  return `${home}/.local/state/tiergear/decisions`;
}

export function decisionLogPath(home: string, name: string): string {
  return `${decisionsDir(home)}/${name.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`;
}

export function appendLogLine(existing: string, line: string, maxLines = MAX_LOG_LINES): string {
  const lines = existing.split('\n').filter((l) => l.length > 0);
  lines.push(line);
  return `${lines.slice(-maxLines).join('\n')}\n`;
}

export function parseLogLines(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as LogEntry;
      if (typeof parsed.at === 'number') entries.push(parsed);
    } catch {
      // A torn write leaves a partial line; skip it.
    }
  }
  return entries;
}
