import { describe, expect, it } from 'vitest';
import { createTiergear, stepOverride, type HookHost } from '../hooks/tiergear.ts';
import { RECORD_TTL_MS } from '../src/core/decide.js';
import { floorPath, serializeFloor } from '../src/core/floor.js';
import { abridge } from '../src/core/state.js';
import { parseStatus, statusPath } from '../src/core/status.js';
import { tablesPath } from '../src/core/tables.js';

type Reply = { tier?: [string, number]; stuck?: number } | 'fail' | 'down';

type SettingsBySource = Partial<Record<'user' | 'project' | 'local', Record<string, unknown>>>;

function fakeHost(replies: Reply[], files: Record<string, string> = {}, env: Record<string, string> = { TYPESAFE_API_KEY: 'k' }, settings: SettingsBySource = {}) {
  const store = new Map<string, unknown>();
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const logs: string[] = [];
  const session = { id: 's1', messageReads: 0, refreshes: 0, history: [] as { role: string; text: string; toolUses?: { tool: string }[]; toolResults?: unknown[] }[] };
  let clock = 1_800_000_000_000;
  const host: HookHost = {
    session: {
      messages: async () => {
        session.messageReads++;
        return session.history;
      },
      cwd: async () => '/w/task',
      id: async () => session.id,
    },
    store: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    fs: {
      read: async (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
      write: async (p, t) => void (files[p] = t),
    },
    env: { get: async (n) => (n === 'HOME' ? '/home/u' : env[n]) },
    settings: {
      read: async (args?: { source?: string }) =>
        args?.source ? (settings[args.source as keyof SettingsBySource] ?? {}) : { ...settings.user, ...settings.project, ...settings.local },
    },
    http: {
      fetch: async (url, init) => {
        requests.push({ url, headers: init?.headers ?? {}, body: init?.body ?? '' });
        const reply = replies.shift();
        if (reply === 'down') throw new Error('connect ECONNREFUSED');
        if (!reply || reply === 'fail') return { status: 500, ok: false, text: '' };
        const answers: Record<string, unknown> = {};
        if (reply.tier) answers['tier'] = { choice: reply.tier[0], confidence: reply.tier[1], probabilities: {} };
        if (reply.stuck !== undefined) answers['stuck'] = { noul: reply.stuck };
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    },
    clock: { now: async () => (clock += 10), sleep: () => new Promise<void>(() => {}) },
    ui: { status: (t) => void statuses.push(t), log: (t) => void logs.push(t), refresh: () => void session.refreshes++ },
  };
  return { host, store, requests, statuses, logs, files, session };
}

const typed = (text: string, kind = 'composer', turnId?: string) => (turnId === undefined ? { text, origin: { kind } } : { text, origin: { kind }, turnId });

const engineStep = (turnId: string, model = 'claude-sonnet-5-5', effort: 'medium' | 'high' | undefined = 'medium', index = 0) =>
  effort === undefined ? { turnId, index, model, messageCount: 1 } : { turnId, index, model, effort, messageCount: 1 };

describe('stepOverride', () => {
  const step = { model: 'claude-sonnet-5-5', effort: 'high' as const, turnId: 't', index: 0, messageCount: 1 };

  it('rewrites main-loop steps with the model id and effort', () => {
    expect(stepOverride({ model: 'opus', effort: 'xhigh' }, step)).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(stepOverride({ effort: 'low' }, step)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('drops the effort for a model without one', () => {
    const out = stepOverride({ model: 'haiku', effort: null }, step);
    expect(out.model).toBe('claude-haiku-4-5');
    expect('effort' in out).toBe(false);
  });

  it('keeps the engine id of a held model, so a dated or [1m] id is not narrowed', () => {
    const out = stepOverride({ model: 'opus', effort: 'high' }, { ...step, model: 'claude-opus-5-5[1m]' });
    expect(out).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'high' });
  });

  it('leaves subagent steps and an unset session alone', () => {
    expect(stepOverride({ effort: 'low' }, { ...step, agentId: 'a1' })).toEqual({ ...step, agentId: 'a1' });
    expect(stepOverride(null, step)).toBe(step);
  });
});

describe('promptSubmit', () => {
  it('decides on the first prompt and applies model and effort from the tables', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    expect(await tiergear.promptSubmit(host, typed('refactor the parser'))).toBe('refactor the parser');
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(tiergear.statusLine('s1')).toBe('tiergear · deep 0.80 → opus/xhigh');
  });

  it('sends context after the first prompt and needs two confident turns to lower', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['trivial', 0.9], stuck: 0.1 }, { tier: ['trivial', 0.9], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.promptSubmit(host, typed('ok'));
    expect(JSON.parse(requests[1]!.body).state).toMatchObject({ task: 'refactor the parser', next_prompt: 'ok' });
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    await tiergear.promptSubmit(host, typed('ok'));
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'medium' });
  });

  it('uses a launch floor without asking the judge', async () => {
    const files = { [floorPath('/home/u', '/w/task')]: serializeFloor({ worktree: '/w/task', tier: 'max', createdAt: 1_800_000_000_000 }) };
    const { host, requests } = fakeHost([], files);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('go'));
    expect(requests).toHaveLength(0);
    expect(tiergear.applied('s1')).toEqual({ model: 'fable', effort: 'xhigh' });
  });

  it('reads table overrides and ignores a broken tables file', async () => {
    const good = fakeHost([{ tier: ['deep', 0.8] }], { [tablesPath('/home/u')]: JSON.stringify({ claude: { effort: { opus: { deep: 'max' } } } }) });
    const a = createTiergear({});
    await a.promptSubmit(good.host, typed('refactor'));
    expect(a.applied('s1')).toEqual({ model: 'opus', effort: 'max' });

    const bad = fakeHost([{ tier: ['deep', 0.8] }], { [tablesPath('/home/u')]: '{"claude":{"effort":{"opus":{"deep":"extreme"}}}}' });
    const b = createTiergear({});
    await b.promptSubmit(bad.host, typed('refactor'));
    expect(b.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(bad.logs.some((l) => l.includes('tables.json ignored'))).toBe(true);
  });

  it('talks to the chosen preset: Laya on localhost without a key', async () => {
    const { host, requests } = fakeHost([{ tier: ['quick', 0.7] }], {}, {});
    const tiergear = createTiergear({ judge: 'laya' });
    await tiergear.promptSubmit(host, typed('rename a variable'));
    expect(requests[0]!.url).toBe('http://localhost:11435/v1/systemone');
    expect(requests[0]!.headers['authorization']).toBeUndefined();
    expect(JSON.parse(requests[0]!.body).model).toBe('laya');
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('keeps the session when the judge fails or a local server is down', async () => {
    const { host } = fakeHost(['fail']);
    const a = createTiergear({});
    await a.promptSubmit(host, typed('do it'));
    expect(a.applied('s1')).toBeNull();

    const down = fakeHost(['down'], {}, {});
    const b = createTiergear({ judge: 'kev' });
    await b.promptSubmit(down.host, typed('do it'));
    expect(b.applied('s1')).toBeNull();
    expect(down.logs.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
  });

  it('passes a prompt starting with !pin to the model as typed and keeps judging', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('do it'));
    expect(await tiergear.promptSubmit(host, typed('!pin keep going'))).toBe('!pin keep going');
    expect(requests).toHaveLength(2);
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('restores the applied target in a fresh process from the stored record', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }]);
    await createTiergear({}).promptSubmit(host, typed('refactor'));
    const resumed = createTiergear({});
    expect(resumed.applied('s1')).toBeNull();
    await resumed.promptSubmit(host, typed('continue'));
    expect(resumed.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('raises one step after three identical tool failures', async () => {
    const { host } = fakeHost([{ tier: ['standard', 0.8] }, { tier: ['standard', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('fix the test'));
    for (let i = 0; i < 3; i++) tiergear.toolResult('s1', 'Bash', true, 'FAIL a.test.ts');
    await tiergear.promptSubmit(host, typed('try again'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('leaves slash commands alone', async () => {
    const { host, requests } = fakeHost([]);
    expect(await createTiergear({}).promptSubmit(host, typed('/compact'))).toBe('/compact');
    expect(requests).toHaveLength(0);
  });

  it('uses the observed session model when the first turn held', async () => {
    const { host } = fakeHost(['fail', { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor'));
    expect(tiergear.applied('s1')).toBeNull();
    await tiergear.step(host, engineStep('t1'));
    await tiergear.promptSubmit(host, typed('continue'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('keeps a launched session under the ceiling its floor file names, by the judge or when stuck', async () => {
    const files = { [floorPath('/home/u', '/w/task')]: serializeFloor({ worktree: '/w/task', tier: 'quick', createdAt: 1_800_000_000_000, ceiling: 'standard' }) };
    const { host } = fakeHost([{ tier: ['max', 0.9], stuck: 0 }, { tier: ['max', 0.9], stuck: 0 }, { tier: ['standard', 0.9], stuck: 0 }], files);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('go'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'low' });
    await tiergear.promptSubmit(host, typed('this needs a deep redesign'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'medium' });
    await tiergear.promptSubmit(host, typed('even deeper'));
    expect(tiergear.statusLine('s1')).toBe('tiergear · standard 0.90 · sonnet/medium · unchanged (at ceiling)');
    for (let i = 0; i < 3; i++) tiergear.toolResult('s1', 'Bash', true, 'FAIL a.test.ts');
    await tiergear.promptSubmit(host, typed('try again'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(tiergear.statusLine('s1')).toContain('unchanged (at ceiling)');
  });

  it('reads a floor file written before ceilings and raises above it as before', async () => {
    const files = { [floorPath('/home/u', '/w/task')]: JSON.stringify({ worktree: '/w/task', tier: 'quick', createdAt: 1_800_000_000_000 }) };
    const { host } = fakeHost([{ tier: ['max', 0.9], stuck: 0 }], files);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('go'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'low' });
    await tiergear.promptSubmit(host, typed('this needs a deep redesign'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'max' });
  });

  it('does not raise to max again after a harder-step raise reset the failure count', async () => {
    const { host } = fakeHost([{ tier: ['standard', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }, { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('fix the test'));
    for (let i = 0; i < 3; i++) tiergear.toolResult('s1', 'Bash', true, 'FAIL');
    await tiergear.promptSubmit(host, typed('harder'));
    await tiergear.promptSubmit(host, typed('again'));
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'high' });
  });
});

describe('which prompts are judged (R17)', () => {
  it('passes a task notification through with no judge call and applied unchanged', async () => {
    const { host, requests, store } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    const before = store.get('session:s1');
    expect(await tiergear.promptSubmit(host, typed('!pin build finished', 'task-notification'))).toBe('!pin build finished');
    expect(requests).toHaveLength(1);
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(store.get('session:s1')).toEqual(before);
  });

  it('judges composer, bridge and sdk prompts', async () => {
    for (const kind of ['composer', 'bridge', 'sdk']) {
      const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }]);
      const tiergear = createTiergear({});
      await tiergear.promptSubmit(host, typed('refactor the parser', kind));
      expect(requests).toHaveLength(1);
      expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    }
  });

  it('leaves other origins and prompts delivered into a running turn alone', async () => {
    const { host, requests, store } = fakeHost([]);
    const tiergear = createTiergear({});
    for (const kind of ['scheduled-trigger', 'peer', 'peer-send-message', 'observer', 'auto-continuation', 'unclassified', 'plugin', 'coordinator']) {
      await tiergear.promptSubmit(host, typed('go on', kind));
    }
    await tiergear.promptSubmit(host, typed('also this', 'composer', 'turn-1'));
    expect(requests).toHaveLength(0);
    expect(store.size).toBe(0);
  });
});

describe('status line', () => {
  it('shows the model and effort in effect when the tier holds', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.7], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    await tiergear.promptSubmit(host, typed('keep going'));
    expect(tiergear.statusLine('s1')).toBe('tiergear · deep 0.70 · opus/xhigh · unchanged (same tier)');
  });

  it("fills in the session's own model and effort once its turn starts", async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.3] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('look around'));
    expect(tiergear.statusLine('s1')).toBe('tiergear · unset 0.30 · unchanged (low confidence)');
    await tiergear.step(host, engineStep('t1', 'claude-sonnet-5-5', 'medium'));
    expect(tiergear.statusLine('s1')).toBe('tiergear · unset 0.30 · sonnet/medium · unchanged (low confidence)');
  });

  it('updates once per turn, not on every step or for subagents', async () => {
    const { host, session } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    const count = session.refreshes;
    await tiergear.step(host, engineStep('t1', 'claude-sonnet-5-5', 'medium', 1));
    await tiergear.step(host, { ...engineStep('t2'), agentId: 'a1' });
    expect(session.refreshes).toBe(count);
  });

  it('leaves the line below the prompt empty, clearing one an earlier load left once', async () => {
    const { host, statuses } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.7], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    await tiergear.promptSubmit(host, typed('keep going'));
    expect(statuses).toEqual([undefined]);
  });

  it("shows the user's own model and effort after a manual change", async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    // Built by hand: engineStep's default would turn an undefined effort into medium.
    await tiergear.step(host, { turnId: 't2', index: 0, model: 'claude-haiku-4-5', messageCount: 1 });
    expect(tiergear.statusLine('s1')).toBe('tiergear · deep n/d · haiku/- · unchanged (paused)');
  });
});

describe('judge context', () => {
  it("sends exchanges built from the engine's messages, telling tool results from prompts", async () => {
    const { host, requests, session } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    session.history = [
      { role: 'user', text: 'refactor the parser' },
      { role: 'assistant', text: 'reading', toolUses: [{ tool: 'Read' }] },
      // The engine can join text blocks (a reminder) onto a tool-result message; it is still no prompt.
      { role: 'user', text: 'reminder', toolResults: [{ tool_use_id: 't', text: 'file body' }] },
      { role: 'assistant', text: 'Done. Commit it?' },
    ];
    await tiergear.promptSubmit(host, typed('yes'));
    expect(JSON.parse(requests[1]!.body).state.recent).toEqual([
      { role: 'user', text: 'refactor the parser', tools: [] },
      { role: 'assistant', text: 'Done. Commit it?', tools: ['Read'] },
    ]);
  });
});

describe('judge key and address', () => {
  it("does not send the preset's key to another address", async () => {
    const { host, requests, logs } = fakeHost([{ tier: ['deep', 0.8] }]);
    await createTiergear({ judgeBaseUrl: 'https://judge.example' }).promptSubmit(host, typed('refactor'));
    expect(requests).toHaveLength(0);
    expect(logs.some((l) => l.includes('no API key for jev'))).toBe(true);
  });

  it('sends an explicitly set key to any https address', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }]);
    await createTiergear({ judgeBaseUrl: 'https://judge.example', judgeApiKey: 'mine' }).promptSubmit(host, typed('refactor'));
    expect(requests[0]!.headers['authorization']).toBe('Bearer mine');
  });

  it('refuses plain http to another machine', async () => {
    const { host, requests, logs } = fakeHost([{ tier: ['deep', 0.8] }], {}, {});
    await createTiergear({ judge: 'kev', judgeBaseUrl: 'http://gpu-box:8009' }).promptSubmit(host, typed('refactor'));
    expect(requests).toHaveLength(0);
    expect(logs.some((l) => l.includes('https'))).toBe(true);
  });

  it("ignores a key the repository's project settings supply, in settings or in the environment", async () => {
    const project = { env: { TYPESAFE_API_KEY: 'theirs' } };
    const fromEnv = fakeHost([{ tier: ['deep', 0.8] }], {}, { TYPESAFE_API_KEY: 'theirs' }, { project });
    await createTiergear({}).promptSubmit(fromEnv.host, typed('refactor'));
    expect(fromEnv.requests).toHaveLength(0);
    const fromSettings = fakeHost([{ tier: ['deep', 0.8] }], {}, {}, { project });
    await createTiergear({}).promptSubmit(fromSettings.host, typed('refactor'));
    expect(fromSettings.requests).toHaveLength(0);
  });

  it('takes a key from user settings or the shell', async () => {
    const user = fakeHost([{ tier: ['deep', 0.8] }], {}, {}, { user: { env: { TYPESAFE_API_KEY: 'mine' } } });
    await createTiergear({}).promptSubmit(user.host, typed('refactor'));
    expect(user.requests[0]!.headers['authorization']).toBe('Bearer mine');
    const shell = fakeHost([{ tier: ['deep', 0.8] }], {}, { TYPESAFE_API_KEY: 'mine' });
    await createTiergear({}).promptSubmit(shell.host, typed('refactor'));
    expect(shell.requests[0]!.headers['authorization']).toBe('Bearer mine');
  });

  it("ignores a key from settings.local.json, which a cloned repository can commit too", async () => {
    const local = { env: { TYPESAFE_API_KEY: 'theirs' } };
    const fromEnv = fakeHost([{ tier: ['deep', 0.8] }], {}, { TYPESAFE_API_KEY: 'theirs' }, { local, user: { env: { TYPESAFE_API_KEY: 'mine' } } });
    await createTiergear({}).promptSubmit(fromEnv.host, typed('refactor'));
    expect(fromEnv.requests[0]!.headers['authorization']).toBe('Bearer mine');
    const fromSettings = fakeHost([{ tier: ['deep', 0.8] }], {}, { TYPESAFE_API_KEY: 'theirs' }, { local });
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(fromSettings.host, typed('refactor'));
    expect(fromSettings.requests).toHaveLength(0);
    // Said where the user looks, instead of a bare "no API key".
    const said = "TYPESAFE_API_KEY from this repository's .claude settings ignored";
    expect(fromSettings.logs.some((l) => l.includes(said))).toBe(true);
    expect((await tiergear.recent(fromSettings.host, 5))[0]).toContain(said);
  });
});

describe('recent decisions', () => {
  it('logs the tier the judge proposed, even when it is not applied', async () => {
    const { host, files } = fakeHost([{ tier: ['deep', 0.3] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('look around'));
    const log = Object.entries(files).find(([p]) => p.includes('/decisions/'))![1];
    expect(JSON.parse(log.trim())).toMatchObject({ tier: null, proposed: 'deep', confidence: 0.3, reason: 'low confidence' });
  });

  it('keeps the status line for the band and asks the surfaces to redraw', async () => {
    const { host, session } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    expect(tiergear.statusLine('s1')).toBeNull();
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    expect(tiergear.statusLine('s1')).toBe('tiergear · deep 0.80 → opus/xhigh');
    const after = session.refreshes;
    expect(after).toBeGreaterThan(0);
    await tiergear.step(host, engineStep('t1'));
    expect(session.refreshes).toBeGreaterThan(after);
  });

  it("lists this session's decisions newest first", async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['quick', 0.4], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    expect(await tiergear.recent(host, 10)).toEqual([]);
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.promptSubmit(host, typed('ok'));
    const lines = await tiergear.recent(host, 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('judge quick 0.40 → hold deep (low confidence) · opus/xhigh');
    expect(lines[1]).toContain('judge deep 0.80 → set deep');
  });
});

describe('user control wins (R18)', () => {
  it('keeps no first prompt for a paused session, which asks the judge nothing until resumed', async () => {
    const paused = fakeHost([{ tier: ['deep', 0.8] }]);
    const a = createTiergear({});
    await a.promptSubmit(paused.host, typed('refactor the parser'));
    await a.pause(paused.host);
    expect(paused.store.get('session:s1')).toMatchObject({ pinned: true, firstPrompt: '' });

    const manual = fakeHost([{ tier: ['deep', 0.8] }]);
    const b = createTiergear({});
    await b.promptSubmit(manual.host, typed('refactor the parser'));
    await b.step(manual.host, engineStep('t1'));
    await b.step(manual.host, engineStep('t2', 'claude-haiku-4-5'));
    expect(manual.store.get('session:s1')).toMatchObject({ pinned: true, firstPrompt: '' });
  });

  it('clears applied when turned off so the session runs on its own model and effort', async () => {
    const { host, store } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.pause(host);
    expect(tiergear.applied('s1')).toBeNull();
    expect(store.get('session:s1')).toMatchObject({ pinned: true, applied: null });
    expect(tiergear.statusLine('s1')).toContain('unchanged (paused)');
    const step = engineStep('t1');
    expect(await tiergear.step(host, step)).toBe(step);
  });

  it('treats a manual model change between turns as a pause', async () => {
    const { host, store, logs, requests } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    // tiergear's own override never shows up as an engine-reported change.
    expect(await tiergear.step(host, engineStep('t1'))).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(await tiergear.step(host, engineStep('t2'))).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(logs.filter((l) => l.includes('manual'))).toHaveLength(0);

    const manual = engineStep('t3', 'claude-haiku-4-5', undefined);
    expect(await tiergear.step(host, manual)).toBe(manual);
    expect(tiergear.applied('s1')).toBeNull();
    expect(store.get('session:s1')).toMatchObject({ pinned: true, applied: null });
    // A later change of a paused session logs nothing new.
    await tiergear.step(host, engineStep('t4', 'claude-opus-5-5'));
    expect(logs.filter((l) => l.includes('manual model/effort change — routing paused for this session'))).toHaveLength(1);

    await tiergear.promptSubmit(host, typed('continue'));
    expect(requests).toHaveLength(1);
    expect(tiergear.applied('s1')).toBeNull();
  });

  it('treats a manual effort change as a pause, but not a change inside one turn', async () => {
    const { host, store } = fakeHost([{ tier: ['standard', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('fix the test'));
    await tiergear.step(host, engineStep('t1', 'claude-sonnet-5-5', 'medium'));
    // A fallback inside a running turn is the engine's, not the user's.
    await tiergear.step(host, engineStep('t1', 'claude-opus-5-5', 'medium', 1));
    expect(store.get('session:s1')).toMatchObject({ pinned: false });
    await tiergear.step(host, engineStep('t2', 'claude-sonnet-5-5', 'high'));
    expect(store.get('session:s1')).toMatchObject({ pinned: true, applied: null });
  });
});

describe('band controls', () => {
  it('applies a picked tier from the next request, even inside a running turn, and the judge carries on from it', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['quick', 0.6], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    await tiergear.pick(host, 'quick');
    expect(await tiergear.step(host, engineStep('t1', 'claude-sonnet-5-5', 'medium', 1))).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    expect(tiergear.statusLine('s1')).toBe('tiergear · quick n/d → opus/low');
    expect(await tiergear.controls(host)).toMatchObject({ tier: 'quick', paused: false });
    expect((await tiergear.recent(host, 1))[0]).toContain('manual → set quick (manual tier) · opus/low');
    await tiergear.promptSubmit(host, typed('next'));
    expect(requests).toHaveLength(2);
  });

  it('uses a tier picked before the first prompt for that turn, then asks the judge', async () => {
    const { host, store, requests } = fakeHost([{ tier: ['trivial', 0.9], stuck: 0 }]);
    const tiergear = createTiergear({});
    expect(await tiergear.controls(host)).toMatchObject({ tier: null, paused: false });
    await tiergear.pick(host, 'deep');
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    expect(requests).toHaveLength(0);
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(store.get('session:s1')).toMatchObject({ started: true, firstPrompt: 'refactor the parser', tier: 'deep' });
    await tiergear.promptSubmit(host, typed('ok'));
    expect(requests).toHaveLength(1);
  });

  it('keeps the launch ceiling under a tier picked before the first prompt', async () => {
    const files = { [floorPath('/home/u', '/w/task')]: serializeFloor({ worktree: '/w/task', tier: 'standard', createdAt: 1_800_000_000_000, ceiling: 'deep' }) };
    const { host, store } = fakeHost([{ tier: ['max', 0.9], stuck: 0 }], files);
    const tiergear = createTiergear({});
    await tiergear.pick(host, 'quick');
    await tiergear.promptSubmit(host, typed('go'));
    expect(store.get('session:s1')).toMatchObject({ tier: 'quick', floor: 'quick', ceiling: 'deep' });
    await tiergear.promptSubmit(host, typed('now the hard part'));
    expect(store.get('session:s1')).toMatchObject({ tier: 'deep' });
  });

  it('turns off, and a picked tier turns it back on, the judge back on the next prompt with that prompt as the task', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.pause(host);
    expect(await tiergear.controls(host)).toMatchObject({ tier: 'deep', paused: true });
    await tiergear.promptSubmit(host, typed('keep going'));
    expect(requests).toHaveLength(1);
    await tiergear.pick(host, 'deep');
    expect(await tiergear.controls(host)).toMatchObject({ tier: 'deep', paused: false });
    expect(tiergear.applied('s1')).toEqual({ model: 'opus', effort: 'xhigh' });
    await tiergear.promptSubmit(host, typed('now the tests'));
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.body).state.task).toBe('now the tests');
    const lines = await tiergear.recent(host, 4);
    expect(lines[1]).toContain('manual → set deep (manual tier)');
    expect(lines[3]).toContain('manual → hold deep (paused) · session');
  });

  it("turns back on after a manual change on the session's own model, its effort from the picked tier", async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.step(host, engineStep('t1'));
    await tiergear.step(host, engineStep('t2', 'claude-sonnet-5-5', 'high'));
    expect(await tiergear.controls(host)).toMatchObject({ tier: 'deep', paused: true });
    await tiergear.pick(host, 'deep');
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('sets the floor from the band, raising the tier to it, and shows it in the controls', async () => {
    const { host, store } = fakeHost([{ tier: ['quick', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('rename it'));
    expect(await tiergear.controls(host)).toEqual({ tier: 'quick', paused: false, floor: 'trivial' });
    await tiergear.setFloor(host, 'deep');
    expect(await tiergear.controls(host)).toEqual({ tier: 'deep', paused: false, floor: 'deep' });
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(store.get('session:s1')).toMatchObject({ floor: 'deep', tier: 'deep' });
    expect((await tiergear.recent(host, 1))[0]).toContain('manual → up deep (floor set)');
  });

  it('logs nothing new when off is picked again', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    await tiergear.pause(host);
    await tiergear.pause(host);
    expect(await tiergear.recent(host, 10)).toHaveLength(2);
  });

  it('reads the controls of a session from the store after a reload', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }]);
    await createTiergear({}).promptSubmit(host, typed('refactor the parser'));
    const reloaded = createTiergear({});
    expect(await reloaded.controls(host)).toMatchObject({ tier: 'deep', paused: false });
    await reloaded.pause(host);
    expect(await reloaded.controls(host)).toMatchObject({ tier: 'deep', paused: true });
  });
});

describe('status for status-line tools', () => {
  it('writes what the band shows, and rewrites it when the engine reports its values', async () => {
    const { host, files } = fakeHost([{ tier: ['deep', 0.3] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('look around'));
    const path = statusPath('/home/u', 's1');
    expect(parseStatus(files[path]!)).toMatchObject({ session: 's1', tier: null, model: null, effort: null, paused: false, reason: 'low confidence' });
    await tiergear.step(host, engineStep('t1'));
    expect(parseStatus(files[path]!)).toMatchObject({ model: 'sonnet', effort: 'medium', line: 'tiergear · unset 0.30 · sonnet/medium · unchanged (low confidence)' });
  });

  it('finds the home through USERPROFILE when HOME is not set, as on Windows', async () => {
    const { host, files } = fakeHost([{ tier: ['deep', 0.8] }]);
    host.env.get = async (n) => (n === 'USERPROFILE' ? 'C:\\Users\\u' : n === 'TYPESAFE_API_KEY' ? 'k' : undefined);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    expect(parseStatus(files[statusPath('C:\\Users\\u', 's1')]!)).toMatchObject({ tier: 'deep', model: 'opus', effort: 'xhigh' });
    expect(await tiergear.recent(host, 5)).toHaveLength(1);
  });

  it('writes the applied model and effort, and the pause', async () => {
    const { host, files } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor the parser'));
    const path = statusPath('/home/u', 's1');
    expect(parseStatus(files[path]!)).toMatchObject({ tier: 'deep', model: 'opus', effort: 'xhigh', paused: false, line: 'tiergear · deep 0.80 → opus/xhigh' });
    await tiergear.step(host, engineStep('t1'));
    await tiergear.pause(host);
    expect(parseStatus(files[path]!)).toMatchObject({ tier: 'deep', model: 'sonnet', effort: 'medium', paused: true });
  });
});

describe('store size (R19)', () => {
  it('stores the first prompt abridged to 2000 chars', async () => {
    const { host, store } = fakeHost([{ tier: ['deep', 0.8] }]);
    const long = 'x'.repeat(5000);
    await createTiergear({}).promptSubmit(host, typed(long));
    expect(store.get('session:s1')).toMatchObject({ firstPrompt: abridge(long, 2000) });
  });

  it('keeps at most the newest 200 session records and drops expired ones', async () => {
    const { host, store } = fakeHost([{ tier: ['deep', 0.8] }]);
    const now = 1_800_000_000_000;
    const record = (updatedAt: number) => ({ firstPrompt: 'p', tier: null, floor: null, model: null, applied: null, downStreak: 0, pinned: false, judgeFailures: 0, judgePausedUntil: 0, updatedAt });
    for (let i = 0; i < 210; i++) store.set(`session:old-${i}`, record(now - 1000 - i));
    store.set('session:expired', record(now - RECORD_TTL_MS - 1));
    store.set('other', 1);
    await createTiergear({}).promptSubmit(host, typed('refactor'));
    const sessions = [...store.keys()].filter((k) => k.startsWith('session:'));
    expect(sessions).toHaveLength(200);
    expect(sessions).toContain('session:s1');
    expect(sessions).toContain('session:old-0');
    expect(sessions).not.toContain('session:old-199');
    expect(sessions).not.toContain('session:expired');
    expect(store.get('other')).toBe(1);
  });
});

describe('minor fixes (R21)', () => {
  it('logs once when an unknown judge name falls back to jev', async () => {
    const { host, logs } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({ judge: 'gpt' });
    await tiergear.promptSubmit(host, typed('refactor'));
    await tiergear.promptSubmit(host, typed('continue'));
    expect(logs.filter((l) => l.includes('unknown judge "gpt"'))).toHaveLength(1);
  });

  it('fails fast without a required key, before reading the session', async () => {
    const { host, requests, logs, session, store } = fakeHost([], {}, {});
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('refactor'));
    await tiergear.promptSubmit(host, typed('continue'));
    expect(requests).toHaveLength(0);
    expect(session.messageReads).toBe(0);
    expect(logs.filter((l) => l.includes('no API key for jev'))).toHaveLength(2);
    expect(store.get('session:s1')).toMatchObject({ judgeFailures: 2 });
  });

  it('never carries applied, the session model or failures into a new session', async () => {
    const { host, session } = fakeHost([{ tier: ['standard', 0.8] }, { tier: ['standard', 0.8] }, { tier: ['standard', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, typed('fix the test'));
    await tiergear.step(host, engineStep('t1'));
    for (let i = 0; i < 3; i++) tiergear.toolResult('s1', 'Bash', true, 'FAIL a.test.ts');
    // /clear: the process goes on under a new session id.
    session.id = 's2';
    expect(tiergear.applied('s2')).toBeNull();
    const step = engineStep('t2');
    expect(await tiergear.step(host, step)).toBe(step);
    await tiergear.promptSubmit(host, typed('fix the test'));
    await tiergear.promptSubmit(host, typed('try again'));
    // Three failures carried over from s1 would have raised s2 to deep (sonnet/high).
    expect(tiergear.applied('s2')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(tiergear.applied('s1')).toEqual({ model: 'sonnet', effort: 'medium' });
  });
});
