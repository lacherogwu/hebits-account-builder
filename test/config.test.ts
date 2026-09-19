import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'hebits-cfg-'));
  process.env.HEBITS_BUILDER_DIR = dir;
});
afterEach(() => { delete process.env.HEBITS_BUILDER_DIR; });

test('loadConfig generates a token on first run and keeps it on the second', async () => {
  const { loadConfig } = await import('../src/config');
  const a = loadConfig();
  expect(a.token).toMatch(/^[0-9a-f]{32}$/);
  expect(loadConfig().token).toBe(a.token);
});

test('loadConfig writes config.json with owner-only permissions', async () => {
  const { loadConfig } = await import('../src/config');
  loadConfig();
  expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
});

test('a missing cookie is undefined, not a throw', async () => {
  const { readCookie } = await import('../src/config');
  expect(readCookie()).toBeUndefined();
});

test('a written cookie round-trips and is owner-only', async () => {
  const { readCookie, writeCookie } = await import('../src/config');
  writeCookie('  session=abc123  ');
  expect(readCookie()).toBe('session=abc123');
  expect(statSync(join(dir, 'cookie.txt')).mode & 0o777).toBe(0o600);
});

test('the cookie is never written into config.json', async () => {
  const { loadConfig, writeCookie } = await import('../src/config');
  loadConfig();
  writeCookie('session=secret');
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('secret');
});
