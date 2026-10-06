import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from '../src/core/config.js';

describe('resolveConfig', () => {
  it('defaults to the jev preset and the spec thresholds', () => {
    expect(DEFAULT_CONFIG).toEqual({
      judge: 'jev',
      judgeBaseUrl: 'https://api.typesafe.ai',
      judgeModel: 'jev-latest',
      switchModelMidSession: false,
      minUpgradeConfidence: 0.5,
      minDowngradeConfidence: 0.85,
      downgradeStreak: 2,
      stuckConfidence: 0.6,
      stuckFailures: 3,
      firstTurnTimeoutMs: 2000,
      turnTimeoutMs: 1200,
      showRecentButton: true,
      showStatusText: true,
      showTierButtons: true,
      showPrefix: true,
      showTier: true,
      showConfidence: true,
      showModelEffort: true,
      showReason: true,
      instantSwitchConfidence: null,
    });
  });

  it('turns the instant switch on only for a confidence above 0', () => {
    expect(resolveConfig({ instantSwitchConfidence: 0.95 }).instantSwitchConfidence).toBe(0.95);
    expect(resolveConfig({ instantSwitchConfidence: 0 }).instantSwitchConfidence).toBeNull();
    expect(resolveConfig({ instantSwitchConfidence: '0.9' }).instantSwitchConfidence).toBeNull();
  });

  it('hides the Recent button only when the option is false', () => {
    expect(resolveConfig({ showRecentButton: false }).showRecentButton).toBe(false);
    expect(resolveConfig({ showRecentButton: 'no' }).showRecentButton).toBe(true);
  });

  it('hides the status text and the tier buttons only when their options are false', () => {
    expect(resolveConfig({ showStatusText: false, showTierButtons: false })).toMatchObject({ showStatusText: false, showTierButtons: false });
    expect(resolveConfig({ showStatusText: 0, showTierButtons: 'no' })).toMatchObject({ showStatusText: true, showTierButtons: true });
  });

  it('takes the address, model and timeouts from the chosen preset', () => {
    expect(resolveConfig({ judge: 'laya' })).toMatchObject({ judge: 'laya', judgeBaseUrl: 'http://localhost:11435', judgeModel: 'laya', firstTurnTimeoutMs: 3000, turnTimeoutMs: 2500 });
    expect(resolveConfig({ judge: 'kev' })).toMatchObject({ judgeBaseUrl: 'http://localhost:8009', judgeModel: 'kev-latest', firstTurnTimeoutMs: 3000, turnTimeoutMs: 2000 });
  });

  it('lets explicit options win and ignores wrong types or an unknown judge', () => {
    const config = resolveConfig({
      judge: 'kev',
      judgeBaseUrl: 'https://me--kev-api.modal.run',
      judgeApiKey: 'k',
      switchModelMidSession: true,
      turnTimeoutMs: 900,
      downgradeStreak: 'three',
      firstTurnTimeoutMs: Number.NaN,
      judgeModel: '',
    });
    expect(config).toMatchObject({ judgeBaseUrl: 'https://me--kev-api.modal.run', judgeApiKey: 'k', switchModelMidSession: true, turnTimeoutMs: 900, downgradeStreak: 2, firstTurnTimeoutMs: 3000, judgeModel: 'kev-latest' });
    expect(resolveConfig({ judge: 'gpt' }).judge).toBe('jev');
  });

  it('clamps judge timeouts to 8000ms, inside the 10s hook budget', () => {
    expect(resolveConfig({ firstTurnTimeoutMs: 20_000, turnTimeoutMs: 9000 })).toMatchObject({ firstTurnTimeoutMs: 8000, turnTimeoutMs: 8000 });
    expect(resolveConfig({ firstTurnTimeoutMs: 7999 }).firstTurnTimeoutMs).toBe(7999);
  });
});
