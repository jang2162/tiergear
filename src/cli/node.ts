import { homedir } from 'node:os';
import type { Sleep } from '../core/judge.js';
import { MAX_RESPONSE_CHARS, type Transport } from '../core/judges/systemone.js';
import { CLI_TIMEOUT_MS } from './launch.js';

// The judge's deadline only stops waiting; aborting the request is what lets the process exit, and the
// byte limit keeps a runaway body from being read whole.
export function createNodeTransport(deadlineMs: number, maxBytes = MAX_RESPONSE_CHARS): Transport {
  return async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(deadlineMs) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('judge response too large');
      }
      chunks.push(value);
    }
    return { status: response.status, ok: response.ok, text: Buffer.concat(chunks).toString('utf8') };
  };
}

export const nodeTransport: Transport = createNodeTransport(CLI_TIMEOUT_MS + 1000);

// unref so a pending deadline does not keep the CLI alive after the judge answered.
export const nodeSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export function homeDir(): string {
  return process.env['HOME'] ?? homedir();
}

// Reads what is piped in, giving up after timeoutMs so a stdin left open never hangs the command.
export function readStdin(timeoutMs: number): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = '';
    const done = (value: string | null) => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(text || null), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', () => done(text));
    process.stdin.on('error', () => done(null));
  });
}
