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
