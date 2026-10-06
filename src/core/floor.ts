import { isTier, tierRank, type Tier } from './tiers.js';

export interface FloorRecord {
  worktree: string;
  tier: Tier;
  createdAt: number;
  // The highest tier the session may reach (`--max-tier`); files written before ceilings have none.
  ceiling?: Tier;
}

export const FLOOR_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

// FNV-1a: stable in the hook runtime and in Node without a crypto module.
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function floorPath(home: string, worktree: string): string {
  return `${home}/.local/state/tiergear/floors/${fnv1a(normalizePath(worktree))}.json`;
}

export function serializeFloor(record: FloorRecord): string {
  return JSON.stringify(record);
}

export function parseFloor(text: string, worktree: string, now: number): FloorRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Partial<FloorRecord>;
  if (typeof record.worktree !== 'string') return null;
  if (normalizePath(record.worktree) !== normalizePath(worktree)) return null;
  if (!isTier(record.tier) || typeof record.createdAt !== 'number') return null;
  if (record.ceiling !== undefined && (!isTier(record.ceiling) || tierRank(record.ceiling) < tierRank(record.tier))) return null;
  if (now - record.createdAt > FLOOR_TTL_MS) return null;
  const floor: FloorRecord = { worktree: record.worktree, tier: record.tier, createdAt: record.createdAt };
  return record.ceiling === undefined ? floor : { ...floor, ceiling: record.ceiling };
}
