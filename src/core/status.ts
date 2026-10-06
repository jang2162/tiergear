import { isTier, type Tier } from './tiers.js';

/** What the band shows for one session, written for status-line tools (`tiergear status`). */
export interface StatusRecord {
  session: string;
  tier: Tier | null;
  // The model (alias) and effort a main-loop request runs on; null when not known yet.
  model: string | null;
  effort: string | number | null;
  paused: boolean;
  reason: string;
  line: string;
  updatedAt: number;
}

export function statusDir(home: string): string {
  return `${home}/.local/state/tiergear/status`;
}

export function statusPath(home: string, session: string): string {
  return `${statusDir(home)}/${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export function parseStatus(text: string): StatusRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  const { session, tier, model, effort, paused, reason, line, updatedAt } = r;
  if (typeof session !== 'string' || typeof reason !== 'string' || typeof line !== 'string' || typeof updatedAt !== 'number') return null;
  if ((tier !== null && !isTier(tier)) || (model !== null && typeof model !== 'string') || typeof paused !== 'boolean') return null;
  if (effort !== null && typeof effort !== 'string' && typeof effort !== 'number') return null;
  return { session, tier, model, effort, paused, reason, line, updatedAt };
}

// Placeholders: {tier} {model} {effort} {state} (auto or paused) {line} (the band's text).
export function formatStatus(status: StatusRecord, template?: string): string {
  if (template !== undefined) {
    const values: Record<string, string> = {
      tier: status.tier ?? 'unset',
      model: status.model ?? '-',
      effort: status.effort === null ? '-' : String(status.effort),
      state: status.paused ? 'paused' : 'auto',
      line: status.line,
    };
    return template.replace(/\{(tier|model|effort|state|line)\}/g, (_, key: string) => values[key]!);
  }
  const effort = status.effort === null ? null : String(status.effort);
  const ran = status.model ? `${status.model}/${effort ?? '-'}` : effort;
  return [status.paused ? 'paused' : status.tier, ran].filter((part) => part !== null).join(' · ');
}
