import { describe, expect, it } from 'vitest';
import { appendLogLine, decisionLogPath, parseLogLines, recentDecisionLines } from '../src/core/log.js';

describe('log', () => {
  it('appends and keeps only the newest lines', () => {
    let text = '';
    for (let i = 0; i < 5; i++) text = appendLogLine(text, JSON.stringify({ at: i }), 3);
    expect(text).toBe('{"at":2}\n{"at":3}\n{"at":4}\n');
  });

  it('keeps file names safe', () => {
    expect(decisionLogPath('/h', 'a/b c')).toBe('/h/.local/state/tiergear/decisions/a_b_c.jsonl');
  });

  it('skips broken lines', () => {
    expect(parseLogLines('{"at":1,"change":"up"}\nnope\n').length).toBe(1);
  });
});

describe('recentDecisionLines', () => {
  const entry = (over: Record<string, unknown>) =>
    JSON.stringify({
      at: 1, source: 'hook', session: 's', phase: 'next', judge: 'jev', tier: 'deep', change: 'hold', confidence: 0.44, stuck: 0.1,
      outcome: 'ok', ms: 200, applied: { model: 'opus', effort: 'xhigh' }, reason: 'low confidence', proposed: 'quick', ...over,
    });
  const time = (at: number) => `t${at}`;

  it('shows what the judge proposed next to what tiergear did, newest first', () => {
    const text = [entry({ at: 1 }), entry({ at: 2, proposed: 'deep', confidence: 0.52, change: 'up', reason: 'harder step' })].join('\n');
    expect(recentDecisionLines(text, 10, time)).toEqual([
      't2  judge deep 0.52 → up deep (harder step) · opus/xhigh',
      't1  judge quick 0.44 → hold deep (low confidence) · opus/xhigh',
    ]);
  });

  it('keeps only the newest lines asked for', () => {
    const text = [1, 2, 3].map((at) => entry({ at })).join('\n');
    expect(recentDecisionLines(text, 2, time).map((l) => l.slice(0, 2))).toEqual(['t3', 't2']);
  });

  it('says when the judge was not asked or failed, and when the session runs on its own values', () => {
    const text = [
      entry({ at: 1, outcome: 'timeout', proposed: null, confidence: null, tier: null, reason: 'no answer', applied: null }),
      entry({ at: 2, outcome: 'skipped', proposed: null, confidence: null, change: 'set', reason: 'launched at deep' }),
    ].join('\n');
    expect(recentDecisionLines(text, 10, time)).toEqual([
      't2  judge skipped → set deep (launched at deep) · opus/xhigh',
      't1  judge timeout → hold unset (no answer) · session',
    ]);
  });

  it('marks an older entry that did not record the proposal', () => {
    const old = JSON.parse(entry({ applied: { effort: 'low' } })) as Record<string, unknown>;
    delete old['proposed'];
    expect(recentDecisionLines(JSON.stringify(old), 10, time)).toEqual(['t1  judge ? 0.44 → hold deep (low confidence) · low']);
  });
});
