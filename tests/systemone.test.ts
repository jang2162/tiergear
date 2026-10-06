import { describe, expect, it } from 'vitest';
import { buildQuestions, createSystemOneJudge, endpoint, parseVerdict, type SystemOneOptions, type Transport } from '../src/core/judges/systemone.js';

const never = () => new Promise<void>(() => {});

function judge(transport: Transport, extra: Partial<SystemOneOptions> = {}) {
  return createSystemOneJudge({ name: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKey: 'k', keyRequired: true, transport, sleep: never, ...extra });
}

const request = { state: { task: 't' }, withStuck: true, timeoutMs: 1000 };

describe('buildQuestions', () => {
  it('asks for a tier choice and, after the first turn, whether the agent is stuck', () => {
    const first = buildQuestions(false);
    expect(Object.keys(first)).toEqual(['tier']);
    expect(first['tier']).toMatchObject({ type: 'choice' });
    expect(Object.keys((first['tier'] as { criteria: object }).criteria)).toEqual(['trivial', 'quick', 'standard', 'deep', 'max']);
    expect(buildQuestions(true)['stuck']).toMatchObject({ type: 'noul' });
  });
});

describe('parseVerdict', () => {
  it('reads the tier choice and the stuck probability', () => {
    const text = JSON.stringify({ answers: { tier: { choice: 'deep', confidence: 0.91, probabilities: {} }, stuck: { noul: 0.2 } } });
    expect(parseVerdict(text)).toEqual({ tier: { tier: 'deep', confidence: 0.91 }, stuck: 0.2 });
  });

  it('treats an unknown tier or a non-numeric confidence as no answer', () => {
    expect(parseVerdict(JSON.stringify({ answers: { tier: { choice: 'huge', confidence: 0.9 } } })).tier).toBeNull();
    expect(parseVerdict(JSON.stringify({ answers: { tier: { choice: 'deep', confidence: 'high' } } })).tier).toBeNull();
    expect(parseVerdict(JSON.stringify({ answers: { stuck: { noul: Number.NaN } } })).stuck).toBeNull();
  });

  it('throws on broken JSON or a missing answers object', () => {
    expect(() => parseVerdict('{')).toThrow('malformed');
    expect(() => parseVerdict('{}')).toThrow('missing answers');
  });
});

describe('systemone judge', () => {
  it('posts the model, state and questions to <baseUrl>/v1/systemone with a bearer key', async () => {
    let sent: { url: string; body: string; auth: string | undefined } | null = null;
    const transport: Transport = async (url, init) => {
      sent = { url, body: init.body, auth: init.headers['authorization'] };
      return { status: 200, ok: true, text: JSON.stringify({ answers: { tier: { choice: 'quick', confidence: 0.7 } } }) };
    };
    const result = await judge(transport).ask({ ...request, withStuck: false });
    expect(result).toEqual({ ok: true, verdict: { tier: { tier: 'quick', confidence: 0.7 }, stuck: null } });
    expect(sent!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(sent!.auth).toBe('Bearer k');
    expect(JSON.parse(sent!.body)).toMatchObject({ model: 'jev-latest', state: { task: 't' } });
  });

  it('works without a key when the preset does not need one', async () => {
    let auth: string | undefined = 'unset';
    const transport: Transport = async (url, init) => {
      auth = init.headers['authorization'];
      expect(url).toBe('http://localhost:11435/v1/systemone');
      return { status: 200, ok: true, text: JSON.stringify({ answers: {} }) };
    };
    const result = await judge(transport, { name: 'laya', baseUrl: 'http://localhost:11435/', apiKey: undefined, keyRequired: false }).ask(request);
    expect(result.ok).toBe(true);
    expect(auth).toBeUndefined();
  });

  it('fails soft without a required key, on HTTP errors, bad bodies, a down server and timeouts', async () => {
    const ok: Transport = async () => ({ status: 200, ok: true, text: '{"answers":{}}' });
    expect(await judge(ok, { apiKey: undefined }).ask(request)).toEqual({ ok: false, reason: 'no API key for jev' });
    expect(await judge(async () => ({ status: 401, ok: false, text: 'no' })).ask(request)).toEqual({ ok: false, reason: 'jev responded 401' });
    expect(await judge(async () => ({ status: 200, ok: true, text: '{' })).ask(request)).toEqual({ ok: false, reason: 'judge returned malformed JSON' });
    expect(await judge(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11435'); }).ask(request)).toEqual({ ok: false, reason: 'connect ECONNREFUSED 127.0.0.1:11435' });
    const slow: Transport = () => new Promise(() => {});
    expect(await judge(slow, { sleep: async () => {} }).ask({ ...request, timeoutMs: 1200 })).toEqual({ ok: false, reason: 'timed out after 1200ms' });
  });

  it('joins the endpoint without doubling slashes', () => {
    expect(endpoint('http://localhost:8009')).toBe('http://localhost:8009/v1/systemone');
    expect(endpoint('http://localhost:8009//')).toBe('http://localhost:8009/v1/systemone');
  });
});
