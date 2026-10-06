import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeTransport } from '../src/cli/node.js';

describe('createNodeTransport', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`));
    });

  it('aborts a judge that never answers, so the CLI can exit', async () => {
    const url = await listen(() => {});
    const started = Date.now();
    await expect(createNodeTransport(200)(url, { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops reading a body past the size limit', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      const chunk = 'x'.repeat(64 * 1024);
      const write = () => {
        while (res.write(chunk)) {}
        res.once('drain', write);
      };
      write();
    });
    await expect(createNodeTransport(5000, 100_000)(url, { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow('too large');
  });
});
