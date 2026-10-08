import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLES, effortFor, firstTarget, mergeTables, parseTablesFile, tablesPath } from '../src/core/tables.js';

describe('table A and B', () => {
  it('gives the first-turn model and effort from the spec', () => {
    const t = (tier: Parameters<typeof firstTarget>[2]) => firstTarget(DEFAULT_TABLES, 'claude', tier);
    expect(t('trivial')).toEqual({ model: 'haiku', effort: 'low' });
    expect(t('quick')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(t('standard')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(t('deep')).toEqual({ model: 'opus', effort: 'high' });
    expect(t('max')).toEqual({ model: 'fable', effort: 'xhigh' });
  });

  it('gives the effort for a fixed model, by alias or id', () => {
    expect(effortFor(DEFAULT_TABLES, 'claude', 'sonnet', 'deep')).toBe('high');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'claude-opus-5-5', 'trivial')).toBe('low');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'fable', 'max')).toBe('xhigh');
  });

  it('falls back to the tier model column for an unknown model', () => {
    expect(effortFor(DEFAULT_TABLES, 'claude', 'mystery', 'standard')).toBe('medium');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'mystery', 'trivial')).toBe('low');
  });
});

describe('overrides', () => {
  it('replaces only the given cells and leaves the defaults untouched', () => {
    const merged = mergeTables(DEFAULT_TABLES, { claude: { models: { max: 'opus' }, effort: { opus: { deep: 'max' } } } });
    expect(merged?.claude.models.max).toBe('opus');
    expect(merged?.claude.effort['opus']?.deep).toBe('max');
    expect(merged?.claude.effort['opus']?.standard).toBe('medium');
    expect(DEFAULT_TABLES.claude.effort['opus']?.deep).toBe('high');
  });

  it('moves trivial back to sonnet from a one-cell override', () => {
    const merged = mergeTables(DEFAULT_TABLES, { claude: { models: { trivial: 'sonnet' } } });
    expect(merged && firstTarget(merged, 'claude', 'trivial')).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('adds a new model column with unset cells as null', () => {
    const merged = mergeTables(DEFAULT_TABLES, { claude: { effort: { 'opus-next': { deep: 'high' } } } });
    expect(merged?.claude.effort['opus-next']).toEqual({ trivial: null, quick: null, standard: null, deep: 'high', max: null });
  });

  it('rejects a model name that is not a plain id, since it ends up in a shell command', () => {
    expect(mergeTables(DEFAULT_TABLES, { claude: { models: { standard: 'sonnet; touch /tmp/pwned #' } } })).toBeNull();
    expect(mergeTables(DEFAULT_TABLES, { claude: { models: { standard: '$(id)' } } })).toBeNull();
    expect(mergeTables(DEFAULT_TABLES, { codex: { models: { deep: 'gpt "x"' } } })).toBeNull();
    for (const model of ['opus[1m]', 'claude-opus-5-5', 'gpt-5.6-terra', 'org/model:v2']) {
      expect(mergeTables(DEFAULT_TABLES, { claude: { models: { deep: model } } })?.claude.models.deep).toBe(model);
    }
  });

  it('rejects the whole file on any bad value', () => {
    expect(mergeTables(DEFAULT_TABLES, { claude: { models: { huge: 'opus' } } })).toBeNull();
    expect(mergeTables(DEFAULT_TABLES, { claude: { effort: { opus: { deep: 'extreme' } } } })).toBeNull();
    expect(mergeTables(DEFAULT_TABLES, { gemini: {} })).toBeNull();
    expect(parseTablesFile('{')).toBeNull();
    expect(parseTablesFile('{}')).toEqual(DEFAULT_TABLES);
  });

  it('keeps the file under ~/.config/tiergear', () => {
    expect(tablesPath('/home/u')).toBe('/home/u/.config/tiergear/tables.json');
  });
});
