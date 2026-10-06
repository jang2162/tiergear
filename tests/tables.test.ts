import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLES, effortFor, firstTarget, mergeTables, parseTablesFile, tablesPath } from '../src/core/tables.js';

describe('table A and B', () => {
  it('gives the first-turn model and effort from the spec', () => {
    const t = (tier: Parameters<typeof firstTarget>[2]) => firstTarget(DEFAULT_TABLES, 'claude', tier);
    expect(t('trivial')).toEqual({ model: 'haiku', effort: null });
    expect(t('quick')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(t('standard')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(t('deep')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(t('max')).toEqual({ model: 'fable', effort: 'xhigh' });
  });

  it('gives the effort for a fixed model, by alias or id', () => {
    expect(effortFor(DEFAULT_TABLES, 'claude', 'sonnet', 'deep')).toBe('high');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'claude-opus-5-5', 'trivial')).toBe('low');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'fable', 'max')).toBe('xhigh');
  });

  it('falls back to the tier model column for an unknown model', () => {
    expect(effortFor(DEFAULT_TABLES, 'claude', 'mystery', 'standard')).toBe('medium');
    expect(effortFor(DEFAULT_TABLES, 'claude', 'mystery', 'trivial')).toBeNull();
  });
});

describe('overrides', () => {
  it('replaces only the given cells and leaves the defaults untouched', () => {
    const merged = mergeTables(DEFAULT_TABLES, { claude: { models: { max: 'opus' }, effort: { opus: { deep: 'max' } } } });
    expect(merged?.claude.models.max).toBe('opus');
    expect(merged?.claude.effort['opus']?.deep).toBe('max');
    expect(merged?.claude.effort['opus']?.standard).toBe('medium');
    expect(DEFAULT_TABLES.claude.effort['opus']?.deep).toBe('xhigh');
  });

  it('adds a new model column with unset cells as null', () => {
    const merged = mergeTables(DEFAULT_TABLES, { claude: { effort: { 'opus-next': { deep: 'high' } } } });
    expect(merged?.claude.effort['opus-next']).toEqual({ trivial: null, quick: null, standard: null, deep: 'high', max: null });
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
