import type { Tier } from './tiers.js';

export interface TierAnswer {
  tier: Tier;
  confidence: number;
}

export interface Verdict {
  tier: TierAnswer | null;
  stuck: number | null;
}

export type AskResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

export interface JudgeRequest {
  state: object;
  withStuck: boolean;
  timeoutMs: number;
}

/** A decision model that picks a tier. Add a judge by implementing this; core never calls a backend directly. */
export interface Judge {
  name: string;
  ask(request: JudgeRequest): Promise<AskResult>;
}

export type Sleep = (ms: number) => Promise<void>;

const TIMED_OUT = Symbol('timed out');

/** Runs a judge call under a deadline and turns every failure into a result, so a turn never waits or throws. */
export async function guarded(work: () => Promise<Verdict>, sleep: Sleep, timeoutMs: number): Promise<AskResult> {
  try {
    const result = await Promise.race<Verdict | typeof TIMED_OUT>([work(), sleep(timeoutMs).then(() => TIMED_OUT)]);
    if (result === TIMED_OUT) return { ok: false, reason: `timed out after ${timeoutMs}ms` };
    return { ok: true, verdict: result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
