import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatStatus, parseStatus, statusDir, statusField, statusPath, type StatusField, type StatusRecord } from '../core/status.js';

// A status line command gets Claude Code's status JSON on stdin, which names the session.
function sessionFromStdin(text: string | null): string | undefined {
  if (!text) return undefined;
  try {
    const id = (JSON.parse(text) as { session_id?: unknown }).session_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function readStatus(path: string): Promise<StatusRecord | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? null : parseStatus(text);
}

async function newestStatus(home: string): Promise<StatusRecord | null> {
  let newest: StatusRecord | null = null;
  for (const name of await readdir(statusDir(home)).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const status = await readStatus(join(statusDir(home), name));
    if (status && (newest === null || status.updatedAt > newest.updatedAt)) newest = status;
  }
  return newest;
}

/** What `tiergear status` prints: the session named by --session, else by stdin, else the one updated last. */
export async function statusCommand(p: {
  home: string;
  session: string | undefined;
  stdin: () => Promise<string | null>;
  json: boolean;
  format?: string;
  // One value alone; it wins over --json and --format.
  field?: StatusField;
}): Promise<string> {
  const session = p.session ?? sessionFromStdin(await p.stdin());
  const status = session === undefined ? await newestStatus(p.home) : await readStatus(statusPath(p.home, session));
  if (p.field) return status ? statusField(status, p.field) : '';
  if (p.json) return JSON.stringify(status);
  return status ? formatStatus(status, p.format) : '';
}
