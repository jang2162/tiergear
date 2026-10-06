import { describe, expect, it } from 'vitest';
import { claudeAlias, claudeModelId, isEffort, isTier, launchCommand, maxTier, stepDown, stepUp, tierRank } from '../src/core/tiers.js';

describe('tiers', () => {
  it('orders tiers and steps one at a time, stopping at the ends', () => {
    expect(tierRank('trivial')).toBe(0);
    expect(tierRank('max')).toBe(4);
    expect(stepUp('standard')).toBe('deep');
    expect(stepUp('max')).toBe('max');
    expect(stepDown('quick')).toBe('trivial');
    expect(stepDown('trivial')).toBe('trivial');
  });

  it('keeps the higher tier and ignores a null floor', () => {
    expect(maxTier('quick', 'standard')).toBe('standard');
    expect(maxTier('deep', 'standard')).toBe('deep');
    expect(maxTier('quick', null)).toBe('quick');
  });

  it('recognizes tiers and efforts', () => {
    expect(isTier('deep')).toBe(true);
    expect(isTier('huge')).toBe(false);
    expect(isEffort('xhigh')).toBe(true);
    expect(isEffort(3)).toBe(false);
  });

  it('maps aliases to ids and back, leaving unknown names alone', () => {
    expect(claudeModelId('opus')).toBe('claude-opus-5-5');
    expect(claudeModelId('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(claudeAlias('claude-opus-5-5')).toBe('opus');
    expect(claudeAlias('mystery')).toBe('mystery');
    expect(claudeAlias('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeAlias('claude-opus-5-5[1m]')).toBe('opus');
    expect(claudeAlias('claude-sonnet-5-50')).toBe('claude-sonnet-5-50');
    expect(claudeAlias('sonnet')).toBe('sonnet');
  });

  it('builds launch commands and leaves out a null effort', () => {
    expect(launchCommand('claude', { model: 'opus', effort: 'xhigh' })).toBe('claude --model opus --effort xhigh');
    expect(launchCommand('claude', { model: 'haiku', effort: null })).toBe('claude --model haiku');
    expect(launchCommand('codex', { model: 'gpt-5.6-sol', effort: 'high' })).toBe('codex --model gpt-5.6-sol -c model_reasoning_effort="high"');
    expect(launchCommand('codex', { model: 'gpt-5.6-luna', effort: null })).toBe('codex --model gpt-5.6-luna');
  });
});
