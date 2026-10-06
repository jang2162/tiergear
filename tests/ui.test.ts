import { describe, expect, it } from 'vitest';
import { register } from '../hooks/tiergear.ts';

type Hook = (...args: unknown[]) => Promise<unknown>;
type Element = { type: string; props: Record<string, unknown> & { children?: unknown } };

// Registers the module against a recording `on`, so each hook can be driven as the engine would.
function load(options: Record<string, unknown> = {}) {
  const hooks: { event: string; matcher: Record<string, unknown> | undefined; hook: Hook }[] = [];
  const on = (event: string, a: unknown, b?: unknown) => {
    hooks.push(b === undefined ? { event, matcher: undefined, hook: a as Hook } : { event, matcher: a as Record<string, unknown>, hook: b as Hook });
    return {};
  };
  register(on as never, options as never);
  return (event: string, match: Record<string, unknown> = {}) =>
    hooks.find((h) => h.event === event && Object.entries(match).every(([k, v]) => h.matcher?.[k] === v))!.hook;
}

function fakeDollar() {
  const files: Record<string, string> = {};
  const store = new Map<string, unknown>();
  const opened: unknown[] = [];
  const closed: unknown[] = [];
  const panes: { id: string }[] = [];
  let clock = 1_800_000_000_000;
  const element = (type: string) => (props: Record<string, unknown>): Element => ({ type, props });
  const $ = {
    session: { messages: async () => [], cwd: async () => '/w/task', id: async () => 's1' },
    store: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    fs: {
      read: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
      write: async (p: string, t: string) => void (files[p] = t),
    },
    env: { get: async (n: string) => (n === 'HOME' ? '/home/u' : n === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
    settings: { read: async () => ({}) },
    http: {
      fetch: async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: { tier: { choice: 'deep', confidence: 0.8, probabilities: {} } } }) }),
    },
    clock: { now: async () => (clock += 10), sleep: () => new Promise<void>(() => {}) },
    ui: {
      status: () => {},
      log: () => {},
      invalidate: () => {},
      open: async (pane: { id: string }) => {
        opened.push(pane);
        panes.push({ id: pane.id });
      },
      close: async (pane: { id: string }) => {
        closed.push(pane);
        panes.splice(panes.findIndex((p) => p.id === pane.id), 1);
      },
      panes: async () => [...panes],
      resolve: () => ({ Box: element('Box'), Text: element('Text'), Button: element('Button') }),
    },
    command: { register: async () => {} },
  };
  return { $, opened, closed };
}

const band = (hasSurvey = false) => ({ component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey } });
const below = async () => 'BELOW';

// The band's own part: one row, the line first and the buttons after it.
async function drawn(hook: (event: string, match?: Record<string, unknown>) => Hook, $: unknown): Promise<{ line: unknown; buttons: Element[] }> {
  const tree = (await hook('ui.render', { component: 'AbovePrompt' })($, band(), below)) as Element;
  const [kept, row, ...rest] = tree.props.children as [string, Element, ...unknown[]];
  expect(kept).toBe('BELOW');
  expect(rest).toEqual([]);
  expect(row.props.flexDirection).toBe('row');
  const [line, ...buttons] = [row.props.children].flat() as Element[];
  expect(line!.type).toBe('Text');
  return { line: line!.props.children, buttons };
}

const labelled = (buttons: Element[], label: string) => buttons.find((b) => b.props.label === label)!;
const tierButton = (buttons: Element[], value: string) => buttons.find((b) => b.props.key === `tiergear-tier-${value}`)!;
const press = (button: Element) => (button.props.onPress as () => Promise<void>)();
// The tier in effect is drawn bracketed at full strength, the others dim.
const current = (buttons: Element[]) => buttons.filter((b) => String(b.props.key).startsWith('tiergear-tier-') && b.props.dimColor !== true).map((b) => b.props.label);

async function decide(hook: (event: string, match?: Record<string, unknown>) => Hook, $: unknown) {
  await hook('prompt.submit')($, { text: 'refactor the parser', origin: { kind: 'composer' } }, async (e: unknown) => e);
}

describe('band above the prompt', () => {
  it('offers a button per tier and off before the first prompt, none of them current', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    const { line, buttons } = await drawn(hook, $);
    expect(line).toBe('tiergear');
    expect(buttons.map((b) => b.props.label)).toEqual(['off', 'trivial', 'quick', 'standard', 'deep', 'max', 'Recent']);
    expect(buttons.slice(0, 6).every((b) => b.props.plain === true && b.props.dimColor === true)).toBe(true);
    expect(current(buttons)).toEqual([]);
  });

  it('repeats the status line, marks the tier in effect, and has a Recent button that opens the pane', async () => {
    const hook = load();
    const { $, opened } = fakeDollar();
    await decide(hook, $);
    const { line, buttons } = await drawn(hook, $);
    expect(line).toBe('tiergear · deep 0.80 → opus/xhigh');
    expect(current(buttons)).toEqual(['[deep]']);
    await press(labelled(buttons, 'Recent'));
    expect(opened).toEqual([{ id: 'tiergear-recent', title: 'tiergear: recent decisions' }]);
  });

  it('picks a tier with one press', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    await decide(hook, $);
    await press(tierButton((await drawn(hook, $)).buttons, 'quick'));
    const { line, buttons } = await drawn(hook, $);
    expect(current(buttons)).toEqual(['[quick]']);
    expect(line).toBe('tiergear · quick n/d → opus/low');
  });

  it('turns routing off with one press, and back on with a tier', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    await decide(hook, $);
    await press(tierButton((await drawn(hook, $)).buttons, 'off'));
    const off = await drawn(hook, $);
    expect(current(off.buttons)).toEqual(['[off]']);
    expect(off.line).toContain('unchanged (paused)');
    await press(tierButton(off.buttons, 'deep'));
    const on = await drawn(hook, $);
    expect(current(on.buttons)).toEqual(['[deep]']);
    expect(on.line).toBe('tiergear · deep n/d → opus/xhigh');
  });

  it('closes the pane on the next press, and opens it again after that', async () => {
    const hook = load();
    const { $, opened, closed } = fakeDollar();
    await decide(hook, $);
    const recent = labelled((await drawn(hook, $)).buttons, 'Recent');
    await press(recent);
    await press(recent);
    expect(closed).toEqual([{ id: 'tiergear-recent' }]);
    await press(recent);
    expect(opened).toHaveLength(2);
  });

  it('leaves the Recent button out when it is turned off', async () => {
    const hook = load({ showRecentButton: false });
    const { $ } = fakeDollar();
    await decide(hook, $);
    const { line, buttons } = await drawn(hook, $);
    expect(buttons.map((b) => b.props.label)).toEqual(['off', 'trivial', 'quick', 'standard', '[deep]', 'max']);
    expect(line).toBe('tiergear · deep 0.80 → opus/xhigh');
  });

  it('yields to a survey', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    await decide(hook, $);
    expect(await hook('ui.render', { component: 'AbovePrompt' })($, band(true), below)).toBe('BELOW');
  });
});

describe('recent decisions pane', () => {
  it("lists the session's decisions, or says there are none", async () => {
    const hook = load();
    const { $ } = fakeDollar();
    const pane = hook('ui.render', { component: 'Pane', requestId: 'tiergear-recent' });
    const event = { component: 'Pane', surface: 'terminal', viewport: { rows: 30, columns: 100 } };
    const empty = (await pane($, event)) as Element;
    expect((empty.props.children as Element).props.children).toBe('No decisions yet in this session.');
    await decide(hook, $);
    const full = (await pane($, event)) as Element;
    const rows = full.props.children as Element[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props.children).toContain('judge deep 0.80 → set deep');
  });

  it('opens from /tiergear', async () => {
    const hook = load();
    const { $, opened } = fakeDollar();
    expect(await hook('command.run', { command: 'tiergear' })($, { command: 'tiergear', args: '' })).toEqual({ text: 'Recent decisions opened.' });
    expect(opened).toEqual([{ id: 'tiergear-recent', title: 'tiergear: recent decisions' }]);
  });
});
