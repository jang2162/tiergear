import { homedir } from 'node:os';
import type { Sleep } from '../core/judge.js';
import type { Transport } from '../core/judges/systemone.js';

export const nodeTransport: Transport = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, ok: response.ok, text: await response.text() };
};

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
