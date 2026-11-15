import { expect, it } from 'vitest';
import { StageServer } from '../../src/body/server';
import { Stage } from '../../src/body/stage';
import type { Packs } from '../../src/body/packs';

it('advertises the actual loopback port after start and restart', async () => {
  const server = new StageServer({
    port: 0,
    token: 'fixture-token',
    packageDir: process.cwd(),
    packs: {} as Packs,
    stage: new Stage(),
    current: () => ({ character: '', template: '' }),
  });
  expect(new URL(server.url).port).toBe('0');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await server.start();
      const address = (server as any).server.address();
      expect(address.address).toBe('127.0.0.1');
      const url = new URL(server.url);
      expect(Number(url.port)).toBe(address.port);
      expect(address.port).toBeGreaterThan(0);
      expect([3080, 3081, 7390, 8757]).not.toContain(address.port);
      expect((await fetch(url)).status).toBe(200);
      url.searchParams.set('token', 'incorrect');
      expect((await fetch(url)).status).toBe(401);
      server.stop();
      expect(new URL(server.url).port).toBe('0');
    }
  } finally {
    server.stop();
  }
});

it('keeps the configured port before a listener starts', () => {
  const server = new StageServer({
    port: 42424,
    token: 'fixture-token',
    packageDir: process.cwd(),
    packs: {} as Packs,
    stage: new Stage(),
    current: () => ({ character: '', template: '' }),
  });
  expect(new URL(server.url).port).toBe('42424');
  server.stop();
  expect(new URL(server.url).port).toBe('42424');
});
