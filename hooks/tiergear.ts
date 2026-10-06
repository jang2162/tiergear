import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';

import { resolveConfig, type Config } from '../src/core/config.js';
import {
  MAX_RECORDS,
  RECORD_TTL_MS,
  canAskJudge,
  decideFirstTurn,
  decideNextTurn,
  inEffect,
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
import { JUDGE_PRESETS, isJudgeName } from '../src/core/judges/presets.js';
import { createSystemOneJudge } from '../src/core/judges/systemone.js';
import { appendLogLine, decisionLogPath, recentDecisionLines, type LogEntry } from '../src/core/log.js';
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
  // refresh redraws the band and the recent-decisions pane.
  ui: { status(text: string | undefined): void; log(text: string): void; refresh(): void };
}

export interface StepLike {
  turnId: string;
  model: string;
  effort?: string | number;
  agentId?: string;
}

/** The part of `prompt.submit`'s input that decides whether the prompt is judged. */
export interface PromptLike {
  text: string;
  origin: { kind: string };
  turnId?: string;
}

// Only what the user wrote is judged; notifications, schedules, peers and the like keep the tier as it is.
const JUDGED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk']);

export function isJudgedPrompt(prompt: PromptLike): boolean {
  return prompt.turnId === undefined && JUDGED_ORIGINS.has(prompt.origin.kind);
}

export function stepOverride<T extends StepLike>(applied: Applied | null, step: T): T {
  if (!applied || step.agentId !== undefined) return step;
  const next: StepLike = { ...step };
  // A held model keeps the engine's id, so a dated or `[1m]` id is not narrowed to the plain one.
  if (applied.model && claudeAlias(step.model) !== applied.model) next.model = claudeModelId(applied.model);
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

/** What the hook remembers about one session between events; a new session id (/clear, resume) starts empty. */
interface SessionMemory {
  applied: Applied | null;
  failures: FailureTracker;
  // The alias of the main-loop model the engine reports, before any override.
  sessionModel: string | null;
  // The engine-reported model (alias) and effort of the last main-loop turn seen.
  engine: { turnId: string; model: string; effort: string | number | null } | null;
  // The last decision on the status line, re-shown with the engine's values when a turn starts.
  shown: Decision | null;
  // The text last put on the status line, which the band above the prompt repeats.
  statusLine: string | null;
}

const REMEMBERED_SESSIONS = 8;

export function createTiergear(options: Readonly<Record<string, unknown>>) {
  const config = resolveConfig(options);
  let judgeNameWarning: string | null =
    options['judge'] === undefined || isJudgeName(options['judge']) ? null : `[tiergear] unknown judge "${String(options['judge'])}"; using jev`;
  let tables: Tables | null = null;
  const sessions = new Map<string, SessionMemory>();

  function memory(session: string): SessionMemory {
    let found = sessions.get(session);
    if (!found) {
      found = { applied: null, failures: EMPTY_TRACKER, sessionModel: null, engine: null, shown: null, statusLine: null };
      sessions.set(session, found);
      if (sessions.size > REMEMBERED_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    return found;
  }

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

  function judge(host: HookHost, apiKey: string | undefined): Judge {
    return createSystemOneJudge({
      name: config.judge,
      baseUrl: config.judgeBaseUrl,
      model: config.judgeModel,
      apiKey,
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
    const kept: { key: string; updatedAt: number }[] = [];
    for (const key of await host.store.keys()) {
      if (!key.startsWith('session:')) continue;
      const record = parseRecord(await host.store.get(key));
      if (!record || now - record.updatedAt > RECORD_TTL_MS) await host.store.delete(key);
      else kept.push({ key, updatedAt: record.updatedAt });
    }
    kept.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const { key } of kept.slice(MAX_RECORDS)) await host.store.delete(key);
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

  async function promptSubmit(host: HookHost, submitted: PromptLike): Promise<string> {
    const text = submitted.text;
    if (!isJudgedPrompt(submitted) || text.trim().startsWith('/')) return text;
    const pin = isPinPrompt(text);
    const prompt = pin ? stripPin(text) : text;
    if (judgeNameWarning) {
      host.ui.log(judgeNameWarning);
      judgeNameWarning = null;
    }
    try {
      const now = await host.clock.now();
      const session = await host.session.id();
      const mem = memory(session);
      const key = `session:${session}`;
      const tableSet = await loadTables(host);
      const stored = parseRecord(await host.store.get(key));
      const first = stored === null;
      let record: SessionRecord = stored ?? newRecord(prompt, now);
      if (pin) record = { ...record, pinned: true };

      let verdict: Verdict | null = null;
      let outcome = 'skipped';
      let ms: number | null = null;
      const noteOutcome = (result: AskResult) => {
        if (result.ok) {
          verdict = result.verdict;
          outcome = 'ok';
        } else {
          outcome = result.reason;
          host.ui.log(`[tiergear] ${config.judge}: ${result.reason}`);
        }
        record = noteJudgeOutcome(record, result.ok, now);
      };
      // The state is built only when the judge can be asked: a missing required key fails before the session is read.
      const ask = async (state: () => Promise<object>, withStuck: boolean, timeoutMs: number) => {
        const apiKey = await resolveApiKey(host, config);
        if (JUDGE_PRESETS[config.judge].keyRequired && !apiKey) {
          noteOutcome({ ok: false, reason: `no API key for ${config.judge}` });
          return;
        }
        const request = { state: await state(), withStuck, timeoutMs };
        const started = await host.clock.now();
        const result = await judge(host, apiKey).ask(request);
        ms = (await host.clock.now()) - started;
        noteOutcome(result);
      };

      let decision: Decision;
      if (first) {
        const floor = await readFloor(host, now);
        if (!floor && !record.pinned) await ask(async () => firstTurnState(prompt), false, config.firstTurnTimeoutMs);
        decision = decideFirstTurn({ record, floor, verdict, config, tables: tableSet });
      } else {
        if (!record.pinned && canAskJudge(record, now)) {
          const state = async () =>
            nextTurnState({
              firstPrompt: record.firstPrompt,
              prompt,
              messages: (await host.session.messages()).map(toContext),
              repeatedFailures: mem.failures.count,
              tier: record.tier,
              effort: record.applied?.effort ?? null,
            });
          await ask(state, true, config.turnTimeoutMs);
        }
        decision = decideNextTurn({ record, verdict, repeatedFailures: mem.failures.count, sessionModel: mem.sessionModel, config, tables: tableSet });
        if (decision.change === 'up') mem.failures = EMPTY_TRACKER;
      }

      const saved: SessionRecord = { ...decision.record, updatedAt: now };
      await host.store.set(key, saved);
      mem.applied = saved.applied;
      // Pruned after the save, so the cap counts this session's record as the newest.
      if (first) await pruneRecords(host, now);
      mem.shown = { ...decision, record: saved };
      mem.statusLine = statusText(mem.shown, inEffect(saved.applied, mem.engine));
      host.ui.status(mem.statusLine);
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
        proposed: (verdict as Verdict | null)?.tier?.tier ?? null,
      });
      // After the log line, so an open pane redraws with it.
      host.ui.refresh();
    } catch (error) {
      host.ui.log(`[tiergear] left the turn alone: ${errorText(error)}`);
    }
    return prompt;
  }

  // A change of the engine-reported model or effort between turns is the user's (/model, /effort): routing stops.
  async function pauseForManualChange(host: HookHost, session: string, mem: SessionMemory): Promise<void> {
    mem.applied = null;
    if (mem.shown) mem.shown = { ...mem.shown, change: 'hold', reason: 'pinned' };
    try {
      const key = `session:${session}`;
      const now = await host.clock.now();
      const record = parseRecord(await host.store.get(key)) ?? newRecord('', now);
      if (record.pinned) return;
      host.ui.log('[tiergear] manual model/effort change — routing paused for this session');
      await host.store.set(key, { ...record, pinned: true, applied: null, updatedAt: now });
    } catch (error) {
      host.ui.log(`[tiergear] pause not saved: ${errorText(error)}`);
    }
  }

  async function step<T extends StepLike>(host: HookHost, e: T): Promise<T> {
    if (e.agentId !== undefined) return e;
    let session: string;
    try {
      session = await host.session.id();
    } catch (error) {
      host.ui.log(`[tiergear] left the step alone: ${errorText(error)}`);
      return e;
    }
    const mem = memory(session);
    // e is the engine's request before this hook's override, so tiergear's own changes never count.
    const model = claudeAlias(e.model);
    const effort = e.effort ?? null;
    mem.sessionModel = model;
    const seen = mem.engine;
    if (seen === null || seen.turnId !== e.turnId) {
      mem.engine = { turnId: e.turnId, model, effort };
      if (seen !== null && (seen.model !== model || seen.effort !== effort)) await pauseForManualChange(host, session, mem);
      if (mem.shown) {
        mem.statusLine = statusText(mem.shown, inEffect(mem.applied, { model, effort }));
        host.ui.status(mem.statusLine);
        host.ui.refresh();
      }
    }
    return stepOverride(mem.applied, e);
  }

  return {
    promptSubmit,
    step,
    toolResult(session: string, tool: string, isError: boolean, text: string | undefined): void {
      const mem = memory(session);
      mem.failures = isError ? recordFailure(mem.failures, failureSignature(tool, text ?? '')) : recordSuccess(mem.failures, tool);
    },
    applied: (session: string): Applied | null => sessions.get(session)?.applied ?? null,
    statusLine: (session: string): string | null => sessions.get(session)?.statusLine ?? null,
    async recent(host: HookHost, limit: number): Promise<string[]> {
      try {
        const home = await host.env.get('HOME');
        if (!home) return [];
        return recentDecisionLines(await host.fs.read(decisionLogPath(home, await host.session.id())), limit);
      } catch {
        // No log yet for this session.
        return [];
      }
    },
  };
}

// The plugin validator needs `$` spelled `$.noun.event(...)` at every use, so each call is forwarded.
function hostOf($: EngineInterface): HookHost {
  return {
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
    ui: { status: (t) => $.ui.status(t), log: (t) => $.ui.log(t), refresh: () => $.ui.invalidate('ui.render') },
  };
}

const RECENT_PANE = 'tiergear-recent';
const RECENT_TITLE = 'tiergear: recent decisions';
const RECENT_MAX = 50;

export const register: Register = (on: On, options: PluginOptions) => {
  const tiergear = createTiergear(options);

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tiergear', description: "Show tiergear's recent decisions for this session" });
    return next(e);
  });

  on('command.run', { command: 'tiergear' }, async ($) => {
    await $.ui.open({ id: RECENT_PANE, title: RECENT_TITLE });
    return { text: 'tiergear: recent decisions opened.' };
  });

  // The status line itself cannot be pressed, so the band above the prompt repeats it with a button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e);
    if (e.props.hasSurvey) return below;
    const session = await $.session.id().catch(() => null);
    const line = session === null ? null : tiergear.statusLine(session);
    if (line === null) return below;
    const { Box, Text, Button } = $.ui.resolve(e);
    const ours = Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ dimColor: true, children: line }),
        Button({ label: 'Recent', onPress: () => void $.ui.open({ id: RECENT_PANE, title: RECENT_TITLE }) }),
      ],
    });
    return Box({ flexDirection: 'column', children: [below, ours] });
  });

  on('ui.render', { component: 'Pane', requestId: RECENT_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const room = Math.min(RECENT_MAX, Math.max(1, (e.viewport?.rows ?? 24) - 4));
    const lines = await tiergear.recent(hostOf($), room);
    return Box({
      flexDirection: 'column',
      children: lines.length === 0 ? Text({ dimColor: true, children: 'No decisions yet in this session.' }) : lines.map((l) => Text({ children: l })),
    });
  });

  on('prompt.submit', async ($, e, next) => {
    const text = await tiergear.promptSubmit(hostOf($), e);
    return next(text === e.text ? e : { ...e, text });
  });

  on('turn.step', async function* ($, e, next) {
    return yield* next(await tiergear.step(hostOf($), e));
  });

  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const r = result as { deny?: string; isError?: boolean; text?: unknown };
    if (e.agentId === undefined && !r.deny) {
      const session = await $.session.id().catch(() => null);
      if (session !== null) tiergear.toolResult(session, e.tool, r.isError === true, typeof r.text === 'string' ? r.text : undefined);
    }
    return result;
  });
};
