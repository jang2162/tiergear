import { describe, expect, it } from 'vitest';
import { appendLogLine, decisionLogPath, parseLogLines } from '../src/core/log.js';

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
