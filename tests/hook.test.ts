import { describe, expect, it } from 'vitest';
import { createTiergear, stepOverride, type HookHost } from '../hooks/tiergear.ts';
import { floorPath, serializeFloor } from '../src/core/floor.js';
import { tablesPath } from '../src/core/tables.js';

type Reply = { tier?: [string, number]; stuck?: number } | 'fail' | 'down';

function fakeHost(replies: Reply[], files: Record<string, string> = {}, env: Record<string, string> = { TYPESAFE_API_KEY: 'k' }) {
  const store = new Map<string, unknown>();
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const logs: string[] = [];
  let clock = 1_800_000_000_000;
  const host: HookHost = {
    session: { messages: async () => [], cwd: async () => '/w/task', id: async () => 's1' },
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
    settings: { read: async () => ({}) },
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
    ui: { status: (t) => void statuses.push(t), log: (t) => void logs.push(t) },
  };
  return { host, store, requests, statuses, logs, files };
}

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

  it('leaves subagent steps and an unset session alone', () => {
    expect(stepOverride({ effort: 'low' }, { ...step, agentId: 'a1' })).toEqual({ ...step, agentId: 'a1' });
    expect(stepOverride(null, step)).toBe(step);
  });
});

describe('promptSubmit', () => {
  it('decides on the first prompt and applies model and effort from the tables', async () => {
    const { host, statuses } = fakeHost([{ tier: ['deep', 0.8] }]);
    const tiergear = createTiergear({});
    expect(await tiergear.promptSubmit(host, 'refactor the parser')).toBe('refactor the parser');
    expect(tiergear.applied()).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(statuses.at(-1)).toBe('tiergear · deep 0.80 → opus/xhigh');
  });

  it('sends context after the first prompt and needs two confident turns to lower', async () => {
    const { host, requests } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['trivial', 0.9], stuck: 0.1 }, { tier: ['trivial', 0.9], stuck: 0.1 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'refactor the parser');
    await tiergear.promptSubmit(host, 'ok');
    expect(JSON.parse(requests[1]!.body).state).toMatchObject({ task: 'refactor the parser', next_prompt: 'ok' });
    expect(tiergear.applied()).toEqual({ model: 'opus', effort: 'xhigh' });
    await tiergear.promptSubmit(host, 'ok');
    expect(tiergear.applied()).toEqual({ model: 'opus', effort: 'medium' });
  });

  it('uses a launch floor without asking the judge', async () => {
    const files = { [floorPath('/home/u', '/w/task')]: serializeFloor({ worktree: '/w/task', tier: 'max', createdAt: 1_800_000_000_000 }) };
    const { host, requests } = fakeHost([], files);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'go');
    expect(requests).toHaveLength(0);
    expect(tiergear.applied()).toEqual({ model: 'fable', effort: 'xhigh' });
  });

  it('reads table overrides and ignores a broken tables file', async () => {
    const good = fakeHost([{ tier: ['deep', 0.8] }], { [tablesPath('/home/u')]: JSON.stringify({ claude: { effort: { opus: { deep: 'max' } } } }) });
    const a = createTiergear({});
    await a.promptSubmit(good.host, 'refactor');
    expect(a.applied()).toEqual({ model: 'opus', effort: 'max' });

    const bad = fakeHost([{ tier: ['deep', 0.8] }], { [tablesPath('/home/u')]: '{"claude":{"effort":{"opus":{"deep":"extreme"}}}}' });
    const b = createTiergear({});
    await b.promptSubmit(bad.host, 'refactor');
    expect(b.applied()).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(bad.logs.some((l) => l.includes('tables.json ignored'))).toBe(true);
  });

  it('talks to the chosen preset: Laya on localhost without a key', async () => {
    const { host, requests } = fakeHost([{ tier: ['quick', 0.7] }], {}, {});
    const tiergear = createTiergear({ judge: 'laya' });
    await tiergear.promptSubmit(host, 'rename a variable');
    expect(requests[0]!.url).toBe('http://localhost:11435/v1/systemone');
    expect(requests[0]!.headers['authorization']).toBeUndefined();
    expect(JSON.parse(requests[0]!.body).model).toBe('laya');
    expect(tiergear.applied()).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('keeps the session when the judge fails or a local server is down', async () => {
    const { host } = fakeHost(['fail']);
    const a = createTiergear({});
    await a.promptSubmit(host, 'do it');
    expect(a.applied()).toBeNull();

    const down = fakeHost(['down'], {}, {});
    const b = createTiergear({ judge: 'kev' });
    await b.promptSubmit(down.host, 'do it');
    expect(b.applied()).toBeNull();
    expect(down.logs.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
  });

  it('pins on !pin, passing the rest of the prompt', async () => {
    const { host } = fakeHost([{ tier: ['standard', 0.8] }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'do it');
    expect(await tiergear.promptSubmit(host, '!pin keep going')).toBe('keep going');
    expect(await tiergear.promptSubmit(host, '!pin')).toBe('!pin');
  });

  it('restores the applied target in a fresh process from the stored record', async () => {
    const { host } = fakeHost([{ tier: ['deep', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }]);
    await createTiergear({}).promptSubmit(host, 'refactor');
    const resumed = createTiergear({});
    expect(resumed.applied()).toBeNull();
    await resumed.promptSubmit(host, 'continue');
    expect(resumed.applied()).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('raises one step after three identical tool failures', async () => {
    const { host } = fakeHost([{ tier: ['standard', 0.8] }, { tier: ['standard', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'fix the test');
    for (let i = 0; i < 3; i++) tiergear.toolResult('Bash', true, 'FAIL a.test.ts');
    await tiergear.promptSubmit(host, 'try again');
    expect(tiergear.applied()).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('leaves slash commands alone', async () => {
    const { host, requests } = fakeHost([]);
    expect(await createTiergear({}).promptSubmit(host, '/compact')).toBe('/compact');
    expect(requests).toHaveLength(0);
  });

  it('uses the observed session model when the first turn held', async () => {
    const { host } = fakeHost(['fail', { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'refactor');
    expect(tiergear.applied()).toBeNull();
    tiergear.observeModel('claude-sonnet-5-5');
    await tiergear.promptSubmit(host, 'continue');
    expect(tiergear.applied()).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('does not raise to max again after a harder-step raise reset the failure count', async () => {
    const { host } = fakeHost([{ tier: ['standard', 0.8] }, { tier: ['deep', 0.8], stuck: 0 }, { tier: ['deep', 0.8], stuck: 0 }]);
    const tiergear = createTiergear({});
    await tiergear.promptSubmit(host, 'fix the test');
    for (let i = 0; i < 3; i++) tiergear.toolResult('Bash', true, 'FAIL');
    await tiergear.promptSubmit(host, 'harder');
    await tiergear.promptSubmit(host, 'again');
    expect(tiergear.applied()).toEqual({ model: 'sonnet', effort: 'high' });
  });
});
