import type { Effort, Tier } from './tiers.js';

export interface ContextMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses?: readonly { tool: string; input?: unknown }[];
}

export interface StateInput {
  firstPrompt: string;
  prompt: string;
  messages: readonly ContextMessage[];
  repeatedFailures: number;
  tier: Tier | null;
  effort: Effort | null;
}

export const RECENT_MESSAGES = 6;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function abridge(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
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

// The task and the recent turns travel with every question, so a terse follow-up is judged in context.
export function nextTurnState(input: StateInput): object {
  return {
    task: abridge(input.firstPrompt, 2000),
    recent: input.messages.slice(-RECENT_MESSAGES).map((message) => ({
      role: message.role,
      text: abridge(message.text, 600),
      tools: (message.toolUses ?? []).map((use) => use.tool),
    })),
    next_prompt: abridge(input.prompt, 2000),
    stats: { files_changed: countChangedFiles(input.messages), repeated_failures: input.repeatedFailures },
    current: { tier: input.tier, effort: input.effort },
  };
}
