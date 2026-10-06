import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';

import { resolveConfig, type Config } from '../src/core/config.js';
import {
  FIRST_PROMPT_CHARS,
  MAX_RECORDS,
  RECORD_TTL_MS,
  canAskJudge,
  decideFirstTurn,
  decideNextTurn,
  decidePause,
  decidePick,
  inEffect,
  newRecord,
  noteJudgeOutcome,
  parseRecord,
  statusText,
  type Applied,
  type Decision,
  type SessionRecord,
} from '../src/core/decide.js';
import { EMPTY_TRACKER, failureSignature, recordFailure, recordSuccess, type FailureTracker } from '../src/core/failures.js';
import { floorPath, parseFloor, type FloorRecord } from '../src/core/floor.js';
import type { AskResult, Judge, Verdict } from '../src/core/judge.js';
import { JUDGE_PRESETS, isAllowedJudgeUrl, isJudgeName, presetKeyApplies } from '../src/core/judges/presets.js';
import { createSystemOneJudge } from '../src/core/judges/systemone.js';
import { appendLogLine, decisionLogPath, recentDecisionLines, type LogEntry } from '../src/core/log.js';
import { abridge, firstTurnState, nextTurnState, type ContextMessage } from '../src/core/state.js';
import { statusPath, type StatusRecord } from '../src/core/status.js';
import { DEFAULT_TABLES, parseTablesFile, tablesPath, type Tables } from '../src/core/tables.js';
import { TIER_ORDER, claudeAlias, claudeModelId, isTier, type Tier } from '../src/core/tiers.js';

interface SessionMessageLike {
  role: string;
  text: string;
  toolUses?: readonly { tool: string; input?: unknown }[];
  toolResults?: readonly unknown[];
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
  settings: { read(args?: { source: 'user' | 'project' | 'local' }): Promise<Readonly<Record<string, unknown>>> };
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

function settingsEnv(settings: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const env = settings['env'];
  const value = env && typeof env === 'object' ? (env as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

async function resolveApiKey(host: HookHost, config: Config): Promise<string | undefined> {
  if (config.judgeApiKey) return config.judgeApiKey;
  const preset = JUDGE_PRESETS[config.judge];
  if (!presetKeyApplies(preset, config.judgeBaseUrl)) return undefined;
  // A cloned repository's .claude/settings.json can set env too; its key would send prompts to someone else's account.
  const fromProject = settingsEnv(await host.settings.read({ source: 'project' }), preset.keyEnv);
  const fromEnv = await host.env.get(preset.keyEnv);
  if (fromEnv && fromEnv !== fromProject) return fromEnv;
  return settingsEnv(await host.settings.read({ source: 'user' }), preset.keyEnv) ?? settingsEnv(await host.settings.read({ source: 'local' }), preset.keyEnv);
}

export function toContext(message: SessionMessageLike): ContextMessage {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: message.text,
    toolUses: message.toolUses ?? [],
    isToolResult: (message.toolResults?.length ?? 0) > 0,
  };
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
  // The session's record as last saved, for the band's controls; undefined until read from the store.
  record: SessionRecord | null | undefined;
}

/** What the band's controls show: the tier, and whether routing is paused. */
export interface Controls {
  tier: Tier | null;
  paused: boolean;
}

type LogDetail = Pick<LogEntry, 'phase' | 'outcome' | 'ms' | 'stuck' | 'proposed'>;

const MANUAL: LogDetail = { phase: 'manual', outcome: 'skipped', ms: null, stuck: null, proposed: null };

const REMEMBERED_SESSIONS = 8;

export function createTiergear(options: Readonly<Record<string, unknown>>) {
  const config = resolveConfig(options);
  let judgeNameWarning: string | null =
    options['judge'] === undefined || isJudgeName(options['judge']) ? null : `[tiergear] unknown judge "${String(options['judge'])}"; using jev`;
  let tables: Tables | null = null;
  const sessions = new Map<string, SessionMemory>();
  let statusCleared = false;

  function memory(session: string): SessionMemory {
    let found = sessions.get(session);
    if (!found) {
      found = { applied: null, failures: EMPTY_TRACKER, sessionModel: null, engine: null, shown: null, statusLine: null, record: undefined };
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

  // Puts the last decision on the band with the engine's values, and writes it for status-line tools when it changed.
  async function show(host: HookHost, session: string, mem: SessionMemory): Promise<void> {
    if (!mem.shown) return;
    const current = inEffect(mem.applied, mem.engine);
    const line = statusText(mem.shown, current);
    if (line === mem.statusLine) return;
    mem.statusLine = line;
    try {
      const home = await host.env.get('HOME');
      if (!home) return;
      const { record, reason } = mem.shown;
      const status: StatusRecord = {
        session,
        tier: record.tier,
        model: current?.model ?? null,
        effort: current?.effort ?? null,
        paused: record.pinned,
        reason,
        line,
        updatedAt: await host.clock.now(),
      };
      await host.fs.write(statusPath(home, session), JSON.stringify(status));
    } catch (error) {
      host.ui.log(`[tiergear] status not written: ${errorText(error)}`);
    }
  }

  // Saves a decision and shows it: the store, what turn.step applies, the band, the status file and the log.
  async function commit(host: HookHost, session: string, mem: SessionMemory, decision: Decision, now: number, detail: LogDetail): Promise<void> {
    // A paused session asks the judge nothing, so its first prompt has no use until it resumes.
    const saved: SessionRecord = { ...decision.record, ...(decision.record.pinned ? { firstPrompt: '' } : {}), updatedAt: now };
    await host.store.set(`session:${session}`, saved);
    mem.applied = saved.applied;
    mem.record = saved;
    mem.shown = { ...decision, record: saved };
    await show(host, session, mem);
    await writeLog(host, session, {
      at: now,
      source: 'hook',
      session,
      judge: config.judge,
      tier: saved.tier,
      change: decision.change,
      confidence: decision.confidence,
      applied: saved.applied,
      reason: decision.reason,
      ...detail,
    });
    // After the log line, so an open pane redraws with it.
    host.ui.refresh();
  }

  async function promptSubmit(host: HookHost, submitted: PromptLike): Promise<string> {
    const prompt = submitted.text;
    if (!isJudgedPrompt(submitted) || prompt.trim().startsWith('/')) return prompt;
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
      // A record a control made before the first prompt still leaves this the first turn.
      const first = stored === null || !stored.started;
      let record: SessionRecord = stored ?? newRecord(prompt, now);
      // Such a record, or one resumed after a pause, takes its task from this prompt.
      if (!record.pinned && record.firstPrompt === '') record = { ...record, firstPrompt: abridge(prompt, FIRST_PROMPT_CHARS) };

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
        if (!isAllowedJudgeUrl(config.judgeBaseUrl)) {
          noteOutcome({ ok: false, reason: `judge URL ${config.judgeBaseUrl} must be https, or http to localhost` });
          return;
        }
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
        if (!floor && !record.pinned && record.tier === null) await ask(async () => firstTurnState(prompt), false, config.firstTurnTimeoutMs);
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

      await commit(host, session, mem, { ...decision, record: { ...decision.record, started: true } }, now, {
        phase: first ? 'first' : 'next',
        stuck: (verdict as Verdict | null)?.stuck ?? null,
        outcome,
        ms,
        proposed: (verdict as Verdict | null)?.tier?.tier ?? null,
      });
      // Pruned after the save, so the cap counts this session's record as the newest.
      if (stored === null) await pruneRecords(host, now);
      // The band above the prompt shows the line now; clear the one an earlier version left below it.
      if (!statusCleared) {
        host.ui.status(undefined);
        statusCleared = true;
      }
    } catch (error) {
      host.ui.log(`[tiergear] left the turn alone: ${errorText(error)}`);
    }
    return prompt;
  }

  // A change of the engine-reported model or effort between turns is the user's (/model, /effort): routing stops.
  async function pauseForManualChange(host: HookHost, session: string, mem: SessionMemory): Promise<void> {
    mem.applied = null;
    try {
      const now = await host.clock.now();
      const record = parseRecord(await host.store.get(`session:${session}`)) ?? newRecord('', now);
      if (record.pinned) return;
      host.ui.log('[tiergear] manual model/effort change — routing paused for this session');
      await commit(host, session, mem, decidePause(record), now, MANUAL);
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
        await show(host, session, mem);
        host.ui.refresh();
      }
    }
    return stepOverride(mem.applied, e);
  }

  // The band's controls act on the stored record; a session without one (no prompt yet) starts one.
  async function control(host: HookHost, what: string, decide: (record: SessionRecord, mem: SessionMemory, tables: Tables) => Decision | null): Promise<void> {
    try {
      const now = await host.clock.now();
      const session = await host.session.id();
      const mem = memory(session);
      const stored = parseRecord(await host.store.get(`session:${session}`));
      const record = stored ?? { ...newRecord('', now), started: false };
      const decision = decide(record, mem, await loadTables(host));
      if (decision === null) return;
      await commit(host, session, mem, decision, now, MANUAL);
      if (stored === null) await pruneRecords(host, now);
    } catch (error) {
      host.ui.log(`[tiergear] ${what} not done: ${errorText(error)}`);
    }
  }

  return {
    promptSubmit,
    step,
    /** A tier picked in the band: applied from the next main-loop request, then moved by the judge as usual. */
    pick: (host: HookHost, tier: Tier): Promise<void> =>
      control(host, 'tier pick', (record, mem, t) => decidePick({ record, tier, sessionModel: mem.sessionModel, config, tables: t })),
    /** Tier: off withdraws everything tiergear applies and stops the judge, until a tier is picked. */
    pause: (host: HookHost): Promise<void> => control(host, 'pause', (record) => (record.pinned ? null : decidePause(record))),
    async controls(host: HookHost): Promise<Controls> {
      try {
        const session = await host.session.id();
        const mem = memory(session);
        if (mem.record === undefined) mem.record = parseRecord(await host.store.get(`session:${session}`));
        return { tier: mem.record?.tier ?? null, paused: mem.record?.pinned ?? false };
      } catch {
        return { tier: null, paused: false };
      }
    },
    toolResult(session: string, tool: string, isError: boolean, text: string | undefined): void {
      const mem = memory(session);
      mem.failures = isError ? recordFailure(mem.failures, failureSignature(tool, text ?? '')) : recordSuccess(mem.failures, tool);
    },
    config,
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
    settings: { read: (args) => $.settings.read(args) },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    clock: { now: () => $.clock.now(), sleep: (ms) => $.clock.sleep(ms) },
    ui: { status: (t) => $.ui.status(t), log: (t) => $.ui.log(t), refresh: () => $.ui.invalidate('ui.render') },
  };
}

const RECENT_PANE = 'tiergear-recent';
const OFF = 'off';
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
    return { text: 'Recent decisions opened.' };
  });

  // The status line itself cannot be pressed, so the band above the prompt repeats it with the controls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e);
    if (e.props.hasSurvey) return below;
    const session = await $.session.id().catch(() => null);
    if (session === null) return below;
    const { showStatusText, showTierButtons, showRecentButton } = tiergear.config;
    if (!showStatusText && !showTierButtons && !showRecentButton) return below;
    const { Box, Text, Button } = $.ui.resolve(e);
    const parts = showStatusText ? [Text({ dimColor: true, children: tiergear.statusLine(session) ?? 'tiergear' })] : [];
    if (showTierButtons) {
      const { tier, paused } = await tiergear.controls(hostOf($));
      const chosen = paused ? OFF : tier;
      // One plain button per choice, so a single click picks; the one in effect bracketed at full strength.
      const buttons = [OFF, ...TIER_ORDER].map((value) =>
        Button({
          key: `tiergear-tier-${value}`,
          label: value === chosen ? `[${value}]` : value,
          plain: true,
          dimColor: value !== chosen,
          onPress: async () => {
            if (value === OFF) await tiergear.pause(hostOf($));
            else if (isTier(value)) await tiergear.pick(hostOf($), value);
          },
        }),
      );
      // Fenced off from the line and from Recent: | Tier: off … max |
      const bar = Text({ dimColor: true, children: '|' });
      parts.push(
        Box({
          flexDirection: 'row',
          gap: 1,
          children: [bar, Text({ dimColor: true, children: 'Tier:' }), Box({ flexDirection: 'row', gap: 2, children: buttons }), bar],
        }),
      );
    }
    if (showRecentButton) {
      parts.push(
        Button({
          label: 'Recent',
          onPress: async () => {
            if ((await $.ui.panes()).some((pane) => pane.id === RECENT_PANE)) await $.ui.close({ id: RECENT_PANE });
            else await $.ui.open({ id: RECENT_PANE, title: RECENT_TITLE });
          },
        }),
      );
    }
    return Box({ flexDirection: 'column', children: [below, Box({ flexDirection: 'row', gap: 2, children: parts })] });
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
