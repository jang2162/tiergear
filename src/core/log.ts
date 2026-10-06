import { appliedText, type Applied, type Change } from './decide.js';
import type { Tier } from './tiers.js';

export interface LogEntry {
  at: number;
  source: 'hook' | 'cli';
  session: string;
  // manual: a tier picked, a pause or a resume from the band.
  phase: 'first' | 'next' | 'launch' | 'manual';
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
  // The tier the judge answered, applied or not; null when it was not asked or failed. Absent in older entries.
  proposed?: Tier | null;
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

function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function judgeText(entry: LogEntry): string {
  if (entry.outcome !== 'ok') return entry.outcome;
  const said = entry.confidence === null ? 'n/d' : entry.confidence.toFixed(2);
  return `${entry.proposed === undefined ? '?' : (entry.proposed ?? '-')} ${said}`;
}

/** One line per decision, newest first: what the judge said, what tiergear did, and what ran. */
export function recentDecisionLines(text: string, limit: number, time: (at: number) => string = clockTime): string[] {
  return parseLogLines(text)
    .slice(-limit)
    .reverse()
    .map((e) => {
      const ran = e.applied ? appliedText(e.applied) : 'session';
      const who = e.phase === 'manual' ? 'manual' : `judge ${judgeText(e)}`;
      return `${time(e.at)}  ${who} → ${e.change} ${e.tier ?? 'unset'} (${e.reason}) · ${ran}`;
    });
}
