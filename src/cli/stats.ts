import type { LogEntry } from '../core/log.js';

export function summarize(entries: readonly LogEntry[], sinceMs: number): string {
  const recent = entries.filter((e) => e.at >= sinceMs);
  if (recent.length === 0) return 'no decisions yet';
  const count = (change: LogEntry['change']) => recent.filter((e) => e.change === change).length;
  const lines = [
    `decisions: ${recent.length}`,
    `set ${count('set')} · up ${count('up')} · down ${count('down')} · hold ${count('hold')}`,
  ];
  const judges = [...new Set(recent.map((e) => e.judge))];
  for (const judge of judges) {
    const asked = recent.filter((e) => e.judge === judge && e.outcome !== 'skipped');
    const answered = asked.filter((e) => e.outcome === 'ok');
    const latencies = answered.map((e) => e.ms).filter((ms): ms is number => typeof ms === 'number');
    const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    lines.push(`${judge} answered ${answered.length}/${asked.length}${avg !== null ? ` · avg ${avg}ms` : ''}`);
  }
  return lines.join('\n');
}
