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

function fakeDollar(surface: 'terminal' | 'mobile' = 'terminal') {
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
      resolve: () =>
        surface === 'mobile'
          ? { Box: element('Box'), Text: element('Text'), Button: element('Button') }
          : { Box: element('Box'), Text: element('Text'), Button: element('Button'), Select: element('Select') },
    },
    command: { register: async () => {} },
  };
  return { $, opened, closed };
}

const band = (hasSurvey = false) => ({ component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey } });
const below = async () => 'BELOW';

// The band's own row: the line, then the controls.
async function row(hook: (event: string, match?: Record<string, unknown>) => Hook, $: unknown): Promise<Element[]> {
  const tree = (await hook('ui.render', { component: 'AbovePrompt' })($, band(), below)) as Element;
  const [kept, ours] = tree.props.children as [string, Element];
  expect(kept).toBe('BELOW');
  return [ours.props.children].flat() as Element[];
}

const labelled = (parts: Element[], label: string) => parts.find((p) => p.props.label === label)!;

async function decide(hook: (event: string, match?: Record<string, unknown>) => Hook, $: unknown) {
  await hook('prompt.submit')($, { text: 'refactor the parser', origin: { kind: 'composer' } }, async (e: unknown) => e);
}

describe('band above the prompt', () => {
  it('offers the controls before the first prompt, with no tier picked yet', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    const parts = await row(hook, $);
    expect(parts.map((p) => p.type)).toEqual(['Text', 'Select', 'Button', 'Button']);
    expect(parts[0]!.props.children).toBe('tiergear');
    expect(parts[1]!.props).toMatchObject({ label: 'Tier:', options: ['trivial', 'quick', 'standard', 'deep', 'max'].map((value) => ({ value })) });
    expect('value' in parts[1]!.props).toBe(false);
    expect(parts.map((p) => p.props.label)).toEqual([undefined, 'Tier:', 'Pause', 'Recent']);
  });

  it('repeats the status line with the tier picker, Pause and a Recent button that opens the pane', async () => {
    const hook = load();
    const { $, opened } = fakeDollar();
    await decide(hook, $);
    const parts = await row(hook, $);
    expect(parts[0]!.props.children).toBe('tiergear · deep 0.80 → opus/xhigh');
    expect(parts[1]!.props.value).toBe('deep');
    await (labelled(parts, 'Recent').props.onPress as () => Promise<void>)();
    expect(opened).toEqual([{ id: 'tiergear-recent', title: 'tiergear: recent decisions' }]);
  });

  it('picks a tier from the band', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    await decide(hook, $);
    await ((await row(hook, $))[1]!.props.onSelect as (value: string) => Promise<void>)('quick');
    const parts = await row(hook, $);
    expect(parts[1]!.props.value).toBe('quick');
    expect(parts[0]!.props.children).toBe('tiergear · quick n/d → opus/low');
  });

  it('pauses and resumes from the band, the picker empty while paused', async () => {
    const hook = load();
    const { $ } = fakeDollar();
    await decide(hook, $);
    await (labelled(await row(hook, $), 'Pause').props.onPress as () => Promise<void>)();
    const paused = await row(hook, $);
    expect('value' in paused[1]!.props).toBe(false);
    expect(paused[0]!.props.children).toContain('unchanged (paused)');
    await (labelled(paused, 'Resume').props.onPress as () => Promise<void>)();
    const resumed = await row(hook, $);
    expect(resumed[1]!.props.value).toBe('deep');
    expect(labelled(resumed, 'Pause')).toBeDefined();
  });

  it('leaves the picker out on a surface that draws none', async () => {
    const hook = load();
    const { $ } = fakeDollar('mobile');
    await decide(hook, $);
    expect((await row(hook, $)).map((p) => p.props.label)).toEqual([undefined, 'Pause', 'Recent']);
  });

  it('closes the pane on the next press, and opens it again after that', async () => {
    const hook = load();
    const { $, opened, closed } = fakeDollar();
    await decide(hook, $);
    const press = labelled(await row(hook, $), 'Recent').props.onPress as () => Promise<void>;
    await press();
    await press();
    expect(closed).toEqual([{ id: 'tiergear-recent' }]);
    await press();
    expect(opened).toHaveLength(2);
  });

  it('leaves the Recent button out when it is turned off', async () => {
    const hook = load({ showRecentButton: false });
    const { $ } = fakeDollar();
    await decide(hook, $);
    const parts = await row(hook, $);
    expect(parts.map((p) => p.props.label)).toEqual([undefined, 'Tier:', 'Pause']);
    expect(parts[0]!.props.children).toBe('tiergear · deep 0.80 → opus/xhigh');
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
