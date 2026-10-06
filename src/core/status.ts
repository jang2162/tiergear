import { claudeModelId, isTier, type Tier } from './tiers.js';

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

export const STATUS_FIELDS = ['tier', 'state', 'model', 'effort'] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];

export function isStatusField(value: unknown): value is StatusField {
  return typeof value === 'string' && (STATUS_FIELDS as readonly string[]).includes(value);
}

// One value for a widget of its own; empty when not known, so the widget hides.
export function statusField(status: StatusRecord, field: StatusField): string {
  if (field === 'state') return status.paused ? 'paused' : 'auto';
  const value = status[field];
  return value === null ? '' : String(value);
}

// As Claude Code names a model: claude-opus-5-5 is "Opus 5.5"; anything else keeps its own name.
function modelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(claudeModelId(model));
  return match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}` : model;
}

// Placeholders: {tier} {model} {modelName} (as Claude Code names it) {effort} {state} (auto or paused) {line} (the band's text).
export function formatStatus(status: StatusRecord, template?: string): string {
  if (template !== undefined) {
    const values: Record<string, string> = {
      tier: status.tier ?? 'unset',
      model: status.model ?? '-',
      modelName: status.model === null ? '-' : modelName(status.model),
      effort: status.effort === null ? '-' : String(status.effort),
      state: status.paused ? 'paused' : 'auto',
      line: status.line,
    };
    const known: Record<string, boolean> = { tier: status.tier !== null, model: status.model !== null, modelName: status.model !== null, effort: status.effort !== null, state: true, line: true };
    const keys = [...template.matchAll(/\{(tier|modelName|model|effort|state|line)\}/g)].map((m) => m[1]!);
    // A template with nothing known in it prints nothing, so its widget hides.
    if (keys.length > 0 && keys.every((key) => !known[key])) return '';
    return template.replace(/\{(tier|modelName|model|effort|state|line)\}/g, (_, key: string) => values[key]!);
  }
  const effort = status.effort === null ? null : String(status.effort);
  const ran = status.model ? `${status.model}/${effort ?? '-'}` : effort;
  return [status.paused ? 'paused' : status.tier, ran].filter((part) => part !== null).join(' · ');
}
