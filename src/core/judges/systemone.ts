import { guarded, type Judge, type Sleep, type TierAnswer, type Verdict } from '../judge.js';
import { TIER_ORDER, isTier, type Tier } from '../tiers.js';

export interface HttpResult {
  status: number;
  ok: boolean;
  text: string;
}

export type Transport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<HttpResult>;

export interface SystemOneOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  keyRequired: boolean;
  transport: Transport;
  sleep: Sleep;
}

const TIER_CRITERIA: Record<Tier, string> = {
  trivial: 'A lookup or mechanical edit: read a value, rename, format, run one known command. No reasoning needed.',
  quick: 'A small, clear change in one place with an obvious approach.',
  standard: 'Ordinary engineering: implement or fix something with a clear spec across a few files.',
  deep: 'Hard work: unclear cause, design decisions, many files, or high stakes such as production, money, credentials or data loss.',
  max: 'The hardest problems: repeated failed attempts, debugging across systems, or architecture with lasting consequences.',
};

export function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/systemone`;
}

export function buildQuestions(withStuck: boolean): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    tier: {
      type: 'choice',
      instructions:
        'Which tier of model and reasoning effort does the next step of this coding-agent session need? ' +
        'Judge the work the next step requires within the whole task, not how short the latest message is.',
      criteria: Object.fromEntries(TIER_ORDER.map((tier) => [tier, TIER_CRITERIA[tier]])),
    },
  };
  if (withStuck) {
    questions['stuck'] = {
      type: 'noul',
      instructions: 'Is the agent stuck on this task?',
      criteria: {
        true: 'The same approach keeps failing, or the user says it still does not work.',
        false: 'Work is progressing, or it has just started.',
      },
    };
  }
  return questions;
}

function readTier(answer: unknown): TierAnswer | null {
  if (!answer || typeof answer !== 'object') return null;
  const { choice, confidence } = answer as { choice?: unknown; confidence?: unknown };
  if (!isTier(choice) || typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  return { tier: choice, confidence };
}

function readNoul(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const { noul } = answer as { noul?: unknown };
  return typeof noul === 'number' && Number.isFinite(noul) ? noul : null;
}

export function parseVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('judge returned malformed JSON');
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') throw new Error('judge response is missing answers');
  const record = answers as Record<string, unknown>;
  return { tier: readTier(record['tier']), stuck: readNoul(record['stuck']) };
}

/** Jev, Laya (Ollaya) and Kev all serve this contract; a preset only changes the address, model and key. */
export function createSystemOneJudge(options: SystemOneOptions): Judge {
  return {
    name: options.name,
    async ask({ state, withStuck, timeoutMs }) {
      if (options.keyRequired && !options.apiKey) return { ok: false, reason: `no API key for ${options.name}` };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey) headers['authorization'] = `Bearer ${options.apiKey}`;
      const body = JSON.stringify({ model: options.model, state, questions: buildQuestions(withStuck) });
      return guarded(
        async () => {
          const response = await options.transport(endpoint(options.baseUrl), { method: 'POST', headers, body });
          if (!response.ok) throw new Error(`${options.name} responded ${response.status}`);
          return parseVerdict(response.text);
        },
        options.sleep,
        timeoutMs,
      );
    },
  };
}
