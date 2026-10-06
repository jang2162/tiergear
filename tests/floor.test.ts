import { describe, expect, it } from 'vitest';
import { FLOOR_TTL_MS, floorPath, fnv1a, parseFloor, serializeFloor } from '../src/core/floor.js';

const now = 1_800_000_000_000;

describe('floor', () => {
  it('hashes stably and builds the state path', () => {
    expect(fnv1a('/a/b')).toBe(fnv1a('/a/b'));
    expect(fnv1a('/a/b')).not.toBe(fnv1a('/a/c'));
    expect(floorPath('/home/u', '/w/x')).toBe(`/home/u/.local/state/tiergear/floors/${fnv1a('/w/x')}.json`);
  });

  it('treats a trailing slash as the same worktree', () => {
    expect(floorPath('/h', '/w/x/')).toBe(floorPath('/h', '/w/x'));
    const text = serializeFloor({ worktree: '/w/x/', tier: 'deep', createdAt: now });
    expect(parseFloor(text, '/w/x', now)).toEqual({ worktree: '/w/x/', tier: 'deep', createdAt: now });
  });

  it('ignores another worktree, an expired record, a bad tier and broken JSON', () => {
    const ok = serializeFloor({ worktree: '/w/x', tier: 'deep', createdAt: now });
    expect(parseFloor(ok, '/w/y', now)).toBeNull();
    expect(parseFloor(ok, '/w/x', now + FLOOR_TTL_MS + 1)).toBeNull();
    expect(parseFloor(JSON.stringify({ worktree: '/w/x', tier: 'huge', createdAt: now }), '/w/x', now)).toBeNull();
    expect(parseFloor('{', '/w/x', now)).toBeNull();
  });
});
