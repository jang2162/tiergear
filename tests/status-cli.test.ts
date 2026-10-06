import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { statusCommand } from '../src/cli/status.js';
import { statusPath, type StatusRecord } from '../src/core/status.js';

const record = (session: string, over: Partial<StatusRecord> = {}): StatusRecord => ({
  session, tier: 'deep', model: 'opus', effort: 'xhigh', paused: false, reason: 'first turn', line: 'tiergear · deep 0.80 → opus/xhigh', updatedAt: 1, ...over,
});

async function homeWith(...records: StatusRecord[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
  for (const r of records) {
    await mkdir(dirname(statusPath(home, r.session)), { recursive: true });
    await writeFile(statusPath(home, r.session), JSON.stringify(r));
  }
  return home;
}

const stdin = (text: string | null) => async () => text;
const run = (home: string, over: Partial<Parameters<typeof statusCommand>[0]> = {}) =>
  statusCommand({ home, session: undefined, stdin: stdin(null), json: false, ...over });

describe('statusCommand', () => {
  it('prints the session a status line tool names on stdin', async () => {
    const home = await homeWith(record('s1', { updatedAt: 5 }), record('s2', { tier: 'quick', effort: 'low', updatedAt: 1 }));
    const input = JSON.stringify({ session_id: 's2', model: { id: 'claude-sonnet-5-5' }, terminal_width: 120 });
    expect(await run(home, { stdin: stdin(input) })).toBe('quick · opus/low');
  });

  it('prefers --session to stdin', async () => {
    const home = await homeWith(record('s1'), record('s2', { paused: true, model: 'sonnet', effort: 'medium' }));
    expect(await run(home, { session: 's2', stdin: stdin(JSON.stringify({ session_id: 's1' })) })).toBe('paused · sonnet/medium');
  });

  it('falls back to the session updated last when none is named', async () => {
    const home = await homeWith(record('old', { tier: 'trivial', updatedAt: 1 }), record('new', { tier: 'max', updatedAt: 9 }));
    expect(await run(home, { stdin: stdin('not json') })).toBe('max · opus/xhigh');
  });

  it('prints nothing for a session with no status yet, and null as JSON', async () => {
    const home = await homeWith(record('s1'));
    expect(await run(home, { session: 'other' })).toBe('');
    expect(await run(home, { session: 'other', json: true })).toBe('null');
    expect(await run(await homeWith())).toBe('');
  });

  it('prints the whole record as JSON, or fills a template', async () => {
    const home = await homeWith(record('s1'));
    expect(JSON.parse(await run(home, { session: 's1', json: true }))).toEqual(record('s1'));
    expect(await run(home, { session: 's1', format: '{model}·{effort} ({tier})' })).toBe('opus·xhigh (deep)');
  });
});

describe('tiergear status', () => {
  const home = process.env['HOME'];
  afterEach(() => {
    process.env['HOME'] = home;
    vi.restoreAllMocks();
  });

  it('prints the named session and exits 0, printing nothing when there is none', async () => {
    process.env['HOME'] = await homeWith(record('s1'));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    expect(await main(['status', '--session', 's1'])).toBe(0);
    expect(await main(['status', '--session', 'nope'])).toBe(0);
    expect(logs).toEqual(['deep · opus/xhigh']);
  });
});
