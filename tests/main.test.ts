import { chmod, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { floorPath, parseFloor } from '../src/core/floor.js';

// A local judge that always answers with one tier, counting the questions it gets.
async function startJudge(tier: string, confidence: number) {
  let asked = 0;
  const server = createServer((_request, response) => {
    asked++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: { tier: { choice: tier, confidence, probabilities: {} } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked: () => asked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// An orca stand-in that answers the calls orca-spawn makes and records them, one JSON line each.
async function fakeOrcaBinary(dir: string): Promise<string> {
  const path = join(dir, 'orca');
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).filter((a) => a !== '--json');
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(args) + '\\n');
const [group, action] = args;
const reply = (result) => process.stdout.write(JSON.stringify({ id: 'x', ok: true, result }));
if (group === 'orchestration' && action === 'run-current') reply({ run: process.env.FAKE_ORCA_RUN ? { id: process.env.FAKE_ORCA_RUN } : null });
else if (group === 'worktree' && action === 'create') reply({ worktree: { id: 'r1::' + process.env.FAKE_ORCA_WORKTREE } });
else if (group === 'orchestration' && action === 'worker-start') reply({ runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [{ kind: 'terminal', role: 'agent', id: 'term_w' }] });
else if (group === 'terminal' && action === 'create') reply({ terminal: { handle: 'h1' } });
else if (group === 'terminal' && action === 'wait') reply({ wait: { satisfied: true } });
else if (group === 'terminal' && action === 'send') reply({ send: { accepted: true } });
else { process.stderr.write('unexpected ' + args.join(' ')); process.exit(1); }
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function readFloorOf(home: string, worktree: string) {
  const real = await realpath(worktree);
  return parseFloor(await readFile(floorPath(home, real), 'utf8'), real, Date.now());
}

describe('main', () => {
  const home = process.env['HOME'];
  afterEach(() => {
    process.env['HOME'] = home;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('notes that floors are Claude-only when --worktree is given with codex', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    process.env['HOME'] = tmp;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Port 9 refuses at once, so the judge falls back without waiting.
    const code = await main(['launch', 'fix it', '--agent', 'codex', '--worktree', tmp, '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9']);
    expect(code).toBe(0);
    expect(errors.filter((l) => l.includes('floors are Claude-only'))).toHaveLength(1);
    expect(await readdir(join(tmp, '.local/state/tiergear'))).not.toContain('floors');
  });

  it('refuses a brief a worker would run as a shell command, before asking the judge', async () => {
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    vi.stubEnv('ORCA_CLI_COMMAND', '/nonexistent/orca');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['orca-spawn', '!rm -rf ~', '--name', 't', '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9'])).toBe(2);
    expect(errors.join('\n')).toContain('brief');
    expect(await readdir(process.env['HOME'])).toEqual([]);
  });

  function capture() {
    const errors: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    return { errors, logs };
  }

  it.each([
    [['launch', 'review it', '--min-tier', 'huge'], '--min-tier must be one of trivial|quick|standard|deep|max, not "huge"'],
    [['orca-spawn', 'review it', '--name', 't', '--max-tier', 'Deep'], '--max-tier must be one of trivial|quick|standard|deep|max, not "Deep"'],
    [['orca-spawn', 'review it', '--name', 't', '--min-tier', 'deep', '--max-tier', 'quick'], '--min-tier deep is above --max-tier quick'],
    [['launch', 'review it', '--min-tier', 'max', '--max-tier', 'trivial'], '--min-tier max is above --max-tier trivial'],
  ])('refuses a bad tier range before asking the judge or creating a worktree: %j', async (args, message) => {
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    vi.stubEnv('ORCA_CLI_COMMAND', '/nonexistent/orca');
    const judge = await startJudge('deep', 0.9);
    const { errors } = capture();
    try {
      expect(await main([...args, '--judge', 'laya', '--judge-url', judge.url])).toBe(2);
    } finally {
      await judge.close();
    }
    expect(errors).toContain(`tiergear: ${message}`);
    expect(judge.asked()).toBe(0);
    expect(await readdir(process.env['HOME'])).toEqual([]);
  });

  it('launches at the clamped tier, prints both tiers on one line and floors the range', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    process.env['HOME'] = home;
    const judge = await startJudge('quick', 0.9);
    const { errors, logs } = capture();
    try {
      expect(await main(['launch', 'review the diff', '--worktree', worktree, '--min-tier', 'deep', '--max-tier', 'max', '--judge', 'laya', '--judge-url', judge.url])).toBe(0);
    } finally {
      await judge.close();
    }
    expect(logs).toEqual(['claude --model opus --effort xhigh']);
    expect(errors).toContain('tiergear: judged quick, applied deep');
    expect(await readFloorOf(home, worktree)).toMatchObject({ tier: 'deep', ceiling: 'max' });
  });

  it('floors the range of a launch even when the judge is down', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    process.env['HOME'] = home;
    const { errors, logs } = capture();
    expect(await main(['launch', 'review the diff', '--worktree', worktree, '--min-tier', 'deep', '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9'])).toBe(0);
    expect(logs).toEqual(['claude --model opus --effort xhigh']);
    expect(errors).toContain('tiergear: judged none, applied deep');
    expect(errors.some((l) => l.includes('no floor written'))).toBe(false);
    expect(await readFloorOf(home, worktree)).toMatchObject({ tier: 'deep' });
  });

  it('writes no floor after a judge fallback without a range, as before', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    process.env['HOME'] = home;
    const { errors, logs } = capture();
    expect(await main(['launch', 'review the diff', '--worktree', worktree, '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9'])).toBe(0);
    expect(logs).toEqual(['claude --model sonnet --effort medium']);
    expect(errors).toContain('tiergear: no floor written (judge fallback)');
    expect(await readdir(join(home, '.local/state/tiergear'))).not.toContain('floors');
  });

  it.each([[['--worktree', '.']], [[]]])('starts Codex inside the range with one note that floors are Claude-only (%j)', async (extra) => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    process.env['HOME'] = home;
    const { errors, logs } = capture();
    expect(await main(['launch', 'review the diff', '--agent', 'codex', ...extra, '--min-tier', 'deep', '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9'])).toBe(0);
    expect(logs).toEqual(['codex --model gpt-5.6-terra -c model_reasoning_effort="xhigh"']);
    expect(errors.filter((l) => l.includes('floors are Claude-only'))).toHaveLength(1);
    expect(await readdir(join(home, '.local/state/tiergear'))).not.toContain('floors');
  });

  it.each([[''], ['run_1']])('orca-spawn reports the judged and the applied tier and floors the range (run: %j)', async (run) => {
    const home = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    const scratch = await mkdtemp(join(tmpdir(), 'tiergear-orca-'));
    const worktree = await mkdtemp(join(tmpdir(), 'tiergear-wt-'));
    process.env['HOME'] = home;
    vi.stubEnv('ORCA_CLI_COMMAND', await fakeOrcaBinary(scratch));
    vi.stubEnv('FAKE_ORCA_LOG', join(scratch, 'calls.jsonl'));
    vi.stubEnv('FAKE_ORCA_WORKTREE', worktree);
    vi.stubEnv('FAKE_ORCA_RUN', run);
    const judge = await startJudge('quick', 0.9);
    const { logs } = capture();
    try {
      expect(await main(['orca-spawn', 'review the diff', '--name', 'review', '--min-tier', 'deep', '--max-tier', 'max', '--judge', 'laya', '--judge-url', judge.url])).toBe(0);
    } finally {
      await judge.close();
    }
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: 'sent', tier: 'deep', judgedTier: 'quick', command: 'claude --model opus --effort xhigh' });
    expect(await readFloorOf(home, worktree)).toMatchObject({ tier: 'deep', ceiling: 'max' });
    const calls = (await readFile(join(scratch, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as string[]).join(' '));
    expect(calls.some((c) => c.includes(run ? '--model opus --effort xhigh' : 'claude --model opus --effort xhigh'))).toBe(true);
  });

  it('names the Orca command orca-spawn and no longer accepts spawn', async () => {
    // Isolate everything spawn could reach, so a regression fails here instead of starting a real worker.
    process.env['HOME'] = await mkdtemp(join(tmpdir(), 'tiergear-home-'));
    vi.stubEnv('ORCA_CLI_COMMAND', '/nonexistent/orca');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['spawn', 'fix it', '--name', 't', '--judge', 'laya', '--judge-url', 'http://127.0.0.1:9'])).toBe(2);
    expect(errors.join('\n')).toContain('tiergear orca-spawn "<brief>" --name <task>');
  });
});
