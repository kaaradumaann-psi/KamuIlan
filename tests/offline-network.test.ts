import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { get as httpsGet } from 'node:https';
import { describe, expect, it } from 'vitest';
import { Agent } from 'undici';
import { HttpClient } from '../src/sources/fetcher';

describe('offline network guard', () => {
  it('blocks raw HTTPS and TCP attempts before they can open an external socket', () => {
    expect(() => httpsGet('https://example.invalid/path')).toThrow(/offline guard blocked raw external HTTP/);
    expect(() => connect(443, 'example.invalid')).toThrow(/offline guard blocked an external socket/);
  });

  it('blocks an externally injected real Undici Agent before its dispatcher can connect', async () => {
    const agent = new Agent();
    const http = new HttpClient({ dispatcher: agent });
    try {
      await expect(http.fetchText('https://example.invalid/')).rejects.toThrow(/Vitest offline guard/);
    } finally {
      await agent.close();
    }
  });

  it('blocks external global fetch without contacting the host', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(/offline guard blocked external HTTP/);
  });

  it('allows loopback HTTP fixture servers', async () => {
    const server = createServer((_request, response) => response.end('loopback-ok'));
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('loopback-ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
