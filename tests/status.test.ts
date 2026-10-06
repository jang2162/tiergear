import { describe, expect, it } from 'vitest';
import { formatStatus, parseStatus, statusField, statusPath, type StatusRecord } from '../src/core/status.js';

const base: StatusRecord = { session: 's1', tier: 'deep', model: 'opus', effort: 'xhigh', paused: false, reason: 'first turn', line: 'tiergear · deep 0.80 → opus/xhigh', updatedAt: 1 };

describe('status', () => {
  it('keeps one file per session under the state directory, with a safe name', () => {
    expect(statusPath('/h', 's1')).toBe('/h/.local/state/tiergear/status/s1.json');
    expect(statusPath('/h', 'a/b')).toBe('/h/.local/state/tiergear/status/a_b.json');
  });

  it('prints the tier and what runs, or that routing is paused', () => {
    expect(formatStatus(base)).toBe('deep · opus/xhigh');
    expect(formatStatus({ ...base, paused: true, model: 'sonnet', effort: 'medium' })).toBe('paused · sonnet/medium');
    expect(formatStatus({ ...base, model: 'haiku', effort: null })).toBe('deep · haiku/-');
    expect(formatStatus({ ...base, tier: null, model: null, effort: 'low' })).toBe('low');
    expect(formatStatus({ ...base, tier: null, model: null, effort: null })).toBe('');
  });

  it('fills a template', () => {
    expect(formatStatus(base, '{state} {tier} {model} {effort}')).toBe('auto deep opus xhigh');
    expect(formatStatus({ ...base, tier: null, model: null, effort: null, paused: true }, '{tier}|{model}|{effort}|{state}')).toBe('unset|-|-|paused');
    expect(formatStatus(base, '[{line}]')).toBe(`[${base.line}]`);
  });

  it('gives one value alone, empty when it is not known', () => {
    expect(statusField(base, 'tier')).toBe('deep');
    expect(statusField(base, 'model')).toBe('opus');
    expect(statusField(base, 'effort')).toBe('xhigh');
    expect(statusField(base, 'state')).toBe('auto');
    expect(statusField({ ...base, paused: true }, 'state')).toBe('paused');
    expect(statusField({ ...base, effort: 3 }, 'effort')).toBe('3');
    expect(statusField({ ...base, tier: null, model: null, effort: null }, 'tier')).toBe('');
    expect(statusField({ ...base, model: null }, 'model')).toBe('');
    expect(statusField({ ...base, effort: null }, 'effort')).toBe('');
  });

  it('reads back what was written and refuses anything else', () => {
    expect(parseStatus(JSON.stringify(base))).toEqual(base);
    expect(parseStatus(JSON.stringify({ ...base, effort: 3 }))).toEqual({ ...base, effort: 3 });
    expect(parseStatus('{')).toBeNull();
    expect(parseStatus(JSON.stringify({ ...base, tier: 'huge' }))).toBeNull();
    expect(parseStatus(JSON.stringify({ ...base, session: 1 }))).toBeNull();
  });
});
