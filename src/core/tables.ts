import { claudeAlias, isEffort, isTier, type Effort, type Harness, type Target, type Tier } from './tiers.js';

export type EffortColumn = Record<Tier, Effort | null>;

export interface HarnessTables {
  // Table A: which model a tier starts on.
  models: Record<Tier, string>;
  // Table B: per model, which effort a tier needs.
  effort: Record<string, EffortColumn>;
}

export type Tables = Record<Harness, HarnessTables>;

function column(trivial: Effort | null, quick: Effort | null, standard: Effort | null, deep: Effort | null, max: Effort | null): EffortColumn {
  return { trivial, quick, standard, deep, max };
}

export const DEFAULT_TABLES: Tables = {
  claude: {
    // Not haiku for trivial: auto mode does not run on it, so every command waits for approval.
    // The haiku column stays so a bypass-permissions user can restore it with one models cell.
    models: { trivial: 'sonnet', quick: 'sonnet', standard: 'sonnet', deep: 'opus', max: 'fable' },
    effort: {
      haiku: column(null, null, null, null, null),
      sonnet: column('low', 'low', 'medium', 'high', 'max'),
      opus: column('low', 'low', 'medium', 'xhigh', 'max'),
      fable: column('low', 'low', 'medium', 'high', 'xhigh'),
    },
  },
  codex: {
    models: { trivial: 'gpt-5.6-luna', quick: 'gpt-5.6-terra', standard: 'gpt-5.6-terra', deep: 'gpt-5.6-terra', max: 'gpt-5.6-terra' },
    effort: {
      'gpt-5.6-luna': column('low', 'low', 'medium', 'high', 'high'),
      'gpt-5.6-terra': column('low', 'low', 'medium', 'xhigh', 'max'),
    },
  },
};

export function effortFor(tables: Tables, harness: Harness, model: string, tier: Tier): Effort | null {
  const table = tables[harness];
  const found = table.effort[model] ?? table.effort[claudeAlias(model)] ?? table.effort[table.models[tier]];
  return found ? found[tier] : null;
}

export function firstTarget(tables: Tables, harness: Harness, tier: Tier): Target {
  const model = tables[harness].models[tier];
  return { model, effort: effortFor(tables, harness, model, tier) };
}

// A model id ends up in a launch command a shell reads, so only id characters pass (brackets as in `opus[1m]`).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeTables(base: Tables, override: unknown): Tables | null {
  if (!isObject(override)) return null;
  const result = JSON.parse(JSON.stringify(base)) as Tables;
  for (const [harness, value] of Object.entries(override)) {
    if ((harness !== 'claude' && harness !== 'codex') || !isObject(value)) return null;
    const target = result[harness];
    const { models, effort } = value;
    if (models !== undefined) {
      if (!isObject(models)) return null;
      for (const [tier, model] of Object.entries(models)) {
        if (!isTier(tier) || typeof model !== 'string' || !MODEL_ID.test(model)) return null;
        target.models[tier] = model;
      }
    }
    if (effort !== undefined) {
      if (!isObject(effort)) return null;
      for (const [model, cells] of Object.entries(effort)) {
        if (!isObject(cells)) return null;
        const merged: EffortColumn = { ...(target.effort[model] ?? column(null, null, null, null, null)) };
        for (const [tier, level] of Object.entries(cells)) {
          if (!isTier(tier) || (level !== null && !isEffort(level))) return null;
          merged[tier] = level;
        }
        target.effort[model] = merged;
      }
    }
  }
  return result;
}

export function parseTablesFile(text: string): Tables | null {
  try {
    return mergeTables(DEFAULT_TABLES, JSON.parse(text));
  } catch {
    return null;
  }
}

export function tablesPath(home: string): string {
  return `${home}/.config/tiergear/tables.json`;
}
