import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeAlias } from '../core/tiers.js';
import { formatStatus, parseStatus, statusDir, statusField, statusPath, type StatusField, type StatusRecord } from '../core/status.js';

interface SessionInfo {
  id: string | undefined;
  // The session's own model (alias) and effort, before tiergear's override.
  model: string | null;
  effort: string | null;
}

// A status line command gets Claude Code's status JSON on stdin: the session, its model and effort.
function sessionFromStdin(text: string | null): SessionInfo | null {
  if (!text) return null;
  let parsed: { session_id?: unknown; model?: { id?: unknown }; effort?: { level?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const id = parsed.session_id;
  const model = parsed.model?.id;
  const effort = parsed.effort?.level;
  return {
    id: typeof id === 'string' && id ? id : undefined,
    model: typeof model === 'string' && model ? claudeAlias(model) : null,
    effort: typeof effort === 'string' && effort ? effort : null,
  };
}

// Until tiergear has a value, the session's own stands in; there is no tier then.
function withSession(status: StatusRecord | null, info: SessionInfo | null): StatusRecord | null {
  if (!info || (info.model === null && info.effort === null)) return status;
  if (status) return { ...status, model: status.model ?? info.model, effort: status.effort ?? info.effort };
  return { session: info.id ?? '', tier: null, model: info.model, effort: info.effort, paused: false, reason: 'session', line: '', updatedAt: 0 };
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
  const info = p.session === undefined ? sessionFromStdin(await p.stdin()) : null;
  const session = p.session ?? info?.id;
  const stored = session === undefined ? await newestStatus(p.home) : await readStatus(statusPath(p.home, session));
  const status = withSession(stored, info);
  if (p.field) return status ? statusField(status, p.field) : '';
  if (p.json) return JSON.stringify(status);
  return status ? formatStatus(status, p.format) : '';
}
