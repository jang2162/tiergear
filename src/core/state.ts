import type { Effort, Tier } from './tiers.js';

export interface ContextMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses?: readonly { tool: string; input?: unknown }[];
  // A user message carrying tool results: part of the assistant's work, not a prompt.
  isToolResult?: boolean;
}

export interface StateInput {
  firstPrompt: string;
  prompt: string;
  messages: readonly ContextMessage[];
  repeatedFailures: number;
  tier: Tier | null;
  effort: Effort | null;
}

// Exchanges, not raw messages: a tool call is two messages, so a busy turn would fill any message window.
export const RECENT_EXCHANGES = 3;
// The reply the next prompt answers gets the most room, its end most of all, where a question sits.
export const LAST_REPLY_CHARS = 1500;
export const LAST_REPLY_HEAD_SHARE = 0.3;
export const OLDER_TEXT_CHARS = 400;
// The first prompt says less about the current work the longer a session runs.
export const TASK_CHARS = 500;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function abridge(text: string, max: number, headShare = 0.6): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * headShare);
  const tail = max - head;
  return `${text.slice(0, head)} […${text.length - max} chars omitted…] ${text.slice(text.length - tail)}`;
}

export function countChangedFiles(messages: readonly ContextMessage[]): number {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      if (!EDIT_TOOLS.has(use.tool)) continue;
      const input = use.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
      const path = input?.file_path ?? input?.notebook_path;
      if (typeof path === 'string') paths.add(path);
    }
  }
  return paths.size;
}

export function firstTurnState(prompt: string): object {
  return { task: abridge(prompt, 4000) };
}

interface Exchange {
  prompt: string;
  reply: string;
  tools: string[];
}

// Each prompt with the assistant's last words before the next one, and the tools it used on the way.
export function toExchanges(messages: readonly ContextMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (!message.isToolResult && message.text.trim()) exchanges.push({ prompt: message.text, reply: '', tools: [] });
      continue;
    }
    if (exchanges.length === 0) exchanges.push({ prompt: '', reply: '', tools: [] });
    const current = exchanges[exchanges.length - 1]!;
    if (message.text.trim()) current.reply = message.text;
    for (const use of message.toolUses ?? []) if (!current.tools.includes(use.tool)) current.tools.push(use.tool);
  }
  return exchanges;
}

function recentMessages(messages: readonly ContextMessage[]): object[] {
  const exchanges = toExchanges(messages).slice(-RECENT_EXCHANGES);
  return exchanges.flatMap((exchange, i) => {
    const isLast = i === exchanges.length - 1;
    const reply = isLast ? abridge(exchange.reply, LAST_REPLY_CHARS, LAST_REPLY_HEAD_SHARE) : abridge(exchange.reply, OLDER_TEXT_CHARS);
    const prompt = exchange.prompt ? [{ role: 'user', text: abridge(exchange.prompt, OLDER_TEXT_CHARS), tools: [] }] : [];
    return [...prompt, { role: 'assistant', text: reply, tools: exchange.tools }];
  });
}

// The task and the recent exchanges travel with every question, so a terse follow-up is judged in context.
export function nextTurnState(input: StateInput): object {
  return {
    task: abridge(input.firstPrompt, TASK_CHARS),
    recent: recentMessages(input.messages),
    next_prompt: abridge(input.prompt, 2000),
    stats: { files_changed: countChangedFiles(input.messages), repeated_failures: input.repeatedFailures },
    current: { tier: input.tier, effort: input.effort },
  };
}
