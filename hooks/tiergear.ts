import type { On, PluginOptions, Register } from 'claude-code';

import { resolveConfig, type Config } from '../src/core/config.js';
import {
  RECORD_TTL_MS,
  canAskJudge,
  decideFirstTurn,
  decideNextTurn,
  isPinPrompt,
  newRecord,
  noteJudgeOutcome,
  parseRecord,
  statusText,
  stripPin,
  type Applied,
  type Decision,
  type SessionRecord,
} from '../src/core/decide.js';
import { EMPTY_TRACKER, failureSignature, recordFailure, recordSuccess, type FailureTracker } from '../src/core/failures.js';
import { floorPath, parseFloor, type FloorRecord } from '../src/core/floor.js';
import type { AskResult, Judge, Verdict } from '../src/core/judge.js';
import { JUDGE_PRESETS } from '../src/core/judges/presets.js';
import { createSystemOneJudge } from '../src/core/judges/systemone.js';
import { appendLogLine, decisionLogPath, type LogEntry } from '../src/core/log.js';
import { firstTurnState, nextTurnState, type ContextMessage } from '../src/core/state.js';
import { DEFAULT_TABLES, parseTablesFile, tablesPath, type Tables } from '../src/core/tables.js';
import { claudeAlias, claudeModelId } from '../src/core/tiers.js';

interface SessionMessageLike {
  role: string;
  text: string;
  toolUses?: readonly { tool: string; input?: unknown }[];
}

/** The part of `$` this hook uses, so tests can drive it without an engine. */
export interface HookHost {
  session: {
    messages(): Promise<readonly SessionMessageLike[]>;
    cwd(): Promise<string>;
    id(): Promise<string>;
  };
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  fs: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void> };
  env: { get(name: string): Promise<string | undefined> };
  settings: { read(): Promise<Readonly<Record<string, unknown>>> };
  http: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{ status: number; ok: boolean; text: string }>;
  };
  clock: { now(): Promise<number>; sleep(ms: number): Promise<void> };
  ui: { status(text: string | undefined): void; log(text: string): void };
}

export interface StepLike {
  model: string;
  effort?: string | number;
  agentId?: string;
}

export function stepOverride<T extends StepLike>(applied: Applied | null, step: T): T {
  if (!applied || step.agentId !== undefined) return step;
  const next: StepLike = { ...step };
  if (applied.model) next.model = claudeModelId(applied.model);
  if (applied.effort === null) delete next.effort;
  else next.effort = applied.effort;
  return next as T;
}

async function resolveApiKey(host: HookHost, config: Config): Promise<string | undefined> {
  if (config.judgeApiKey) return config.judgeApiKey;
  const keyEnv = JUDGE_PRESETS[config.judge].keyEnv;
  const fromEnv = await host.env.get(keyEnv);
  if (fromEnv) return fromEnv;
  const env = (await host.settings.read())['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)[keyEnv];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function toContext(message: SessionMessageLike): ContextMessage {
  return { role: message.role === 'assistant' ? 'assistant' : 'user', text: message.text, toolUses: message.toolUses ?? [] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTiergear(options: Readonly<Record<string, unknown>>) {
  const config = resolveConfig(options);
  let applied: Applied | null = null;
  let failures: FailureTracker = EMPTY_TRACKER;
  let tables: Tables | null = null;
  let sessionModel: string | null = null;

  async function loadTables(host: HookHost): Promise<Tables> {
    if (tables) return tables;
    tables = DEFAULT_TABLES;
    const home = await host.env.get('HOME');
    if (!home) return tables;
    let text: string;
    try {
      text = await host.fs.read(tablesPath(home));
    } catch {
      return tables;
    }
    const parsed = parseTablesFile(text);
    if (parsed) tables = parsed;
    else host.ui.log('[tiergear] tables.json ignored: invalid JSON or values; using the default tables');
    return tables;
  }

  async function judge(host: HookHost): Promise<Judge> {
    return createSystemOneJudge({
      name: config.judge,
      baseUrl: config.judgeBaseUrl,
      model: config.judgeModel,
      apiKey: await resolveApiKey(host, config),
      keyRequired: JUDGE_PRESETS[config.judge].keyRequired,
      transport: (url, init) => host.http.fetch(url, init),
      sleep: (ms) => host.clock.sleep(ms),
    });
  }

  async function readFloor(host: HookHost, now: number): Promise<FloorRecord | null> {
    const home = await host.env.get('HOME');
    if (!home) return null;
    const cwd = await host.session.cwd();
    try {
      return parseFloor(await host.fs.read(floorPath(home, cwd)), cwd, now);
    } catch {
      return null;
    }
  }

  async function pruneRecords(host: HookHost, now: number): Promise<void> {
    for (const key of await host.store.keys()) {
      if (!key.startsWith('session:')) continue;
      const record = parseRecord(await host.store.get(key));
      if (!record || now - record.updatedAt > RECORD_TTL_MS) await host.store.delete(key);
    }
  }

  async function writeLog(host: HookHost, session: string, entry: LogEntry): Promise<void> {
    try {
      const home = await host.env.get('HOME');
      if (!home) return;
      const path = decisionLogPath(home, session);
      const existing = await host.fs.read(path).catch(() => '');
      await host.fs.write(path, appendLogLine(existing, JSON.stringify(entry)));
    } catch (error) {
      host.ui.log(`[tiergear] log not written: ${errorText(error)}`);
    }
  }

  async function promptSubmit(host: HookHost, text: string): Promise<string> {
    if (text.trim().startsWith('/')) return text;
    const pin = isPinPrompt(text);
    const prompt = pin ? stripPin(text) : text;
    try {
      const now = await host.clock.now();
      const session = await host.session.id();
      const key = `session:${session}`;
      const tableSet = await loadTables(host);
      const stored = parseRecord(await host.store.get(key));
      const first = stored === null;
      let record: SessionRecord = stored ?? newRecord(prompt, now);
      if (pin) record = { ...record, pinned: true };

      let verdict: Verdict | null = null;
      let outcome = 'skipped';
      let ms: number | null = null;
      const ask = async (state: object, withStuck: boolean, timeoutMs: number) => {
        const started = await host.clock.now();
        const result: AskResult = await (await judge(host)).ask({ state, withStuck, timeoutMs });
        ms = (await host.clock.now()) - started;
        if (result.ok) {
          verdict = result.verdict;
          outcome = 'ok';
        } else {
          outcome = result.reason;
          host.ui.log(`[tiergear] ${config.judge}: ${result.reason}`);
        }
        record = noteJudgeOutcome(record, result.ok, now);
      };

      let decision: Decision;
      if (first) {
        await pruneRecords(host, now);
        const floor = await readFloor(host, now);
        if (!floor && !record.pinned) await ask(firstTurnState(prompt), false, config.firstTurnTimeoutMs);
        decision = decideFirstTurn({ record, floor, verdict, config, tables: tableSet });
      } else {
        if (!record.pinned && canAskJudge(record, now)) {
          const messages = (await host.session.messages()).map(toContext);
          const state = nextTurnState({
            firstPrompt: record.firstPrompt,
            prompt,
            messages,
            repeatedFailures: failures.count,
            tier: record.tier,
            effort: record.applied?.effort ?? null,
          });
          await ask(state, true, config.turnTimeoutMs);
        }
        decision = decideNextTurn({ record, verdict, repeatedFailures: failures.count, sessionModel, config, tables: tableSet });
        if (decision.change === 'up') failures = EMPTY_TRACKER;
      }

      const saved: SessionRecord = { ...decision.record, updatedAt: now };
      await host.store.set(key, saved);
      applied = saved.applied;
      host.ui.status(statusText({ ...decision, record: saved }));
      await writeLog(host, session, {
        at: now,
        source: 'hook',
        session,
        phase: first ? 'first' : 'next',
        judge: config.judge,
        tier: saved.tier,
        change: decision.change,
        confidence: decision.confidence,
        stuck: (verdict as Verdict | null)?.stuck ?? null,
        outcome,
        ms,
        applied: saved.applied,
        reason: decision.reason,
      });
    } catch (error) {
      host.ui.log(`[tiergear] left the turn alone: ${errorText(error)}`);
    }
    return prompt;
  }

  return {
    promptSubmit,
    toolResult(tool: string, isError: boolean, text: string | undefined): void {
      failures = isError ? recordFailure(failures, failureSignature(tool, text ?? '')) : recordSuccess(failures, tool);
    },
    applied: () => applied,
    observeModel(model: string): void {
      sessionModel = claudeAlias(model);
    },
  };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const tiergear = createTiergear(options);

  on('prompt.submit', async ($, e, next) => {
    // The plugin validator needs `$` spelled `$.noun.event(...)` at every use, so each call is forwarded.
    const host: HookHost = {
      session: { messages: () => $.session.messages(), cwd: () => $.session.cwd(), id: () => $.session.id() },
      store: {
        get: (k) => $.store.get(k),
        set: (k, v) => $.store.set(k, v),
        delete: (k) => $.store.delete(k),
        keys: () => $.store.keys(),
      },
      fs: { read: (path) => $.fs.read(path), write: (path, text) => $.fs.write(path, text) },
      env: {
        // `$.env.get` takes literal names, so only the variables this hook reads are forwarded.
        get: async (name) => {
          if (name === 'HOME') return await $.env.get('HOME');
          if (name === 'TYPESAFE_API_KEY') return await $.env.get('TYPESAFE_API_KEY');
          if (name === 'OLLAYA_API_KEY') return await $.env.get('OLLAYA_API_KEY');
          if (name === 'KEV_API_KEY') return await $.env.get('KEV_API_KEY');
          return undefined;
        },
      },
      settings: { read: () => $.settings.read() },
      http: { fetch: (url, init) => $.http.fetch(url, init) },
      clock: { now: () => $.clock.now(), sleep: (ms) => $.clock.sleep(ms) },
      ui: { status: (t) => $.ui.status(t), log: (t) => $.ui.log(t) },
    };
    const text = await tiergear.promptSubmit(host, e.text);
    return next(text === e.text ? e : { ...e, text });
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) tiergear.observeModel(e.model);
    return yield* next(stepOverride(tiergear.applied(), e));
  });

  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const r = result as { deny?: string; isError?: boolean; text?: unknown };
    if (e.agentId === undefined && !r.deny) {
      tiergear.toolResult(e.tool, r.isError === true, typeof r.text === 'string' ? r.text : undefined);
    }
    return result;
  });
};
