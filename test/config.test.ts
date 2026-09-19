import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'hebits-cfg-'));
  process.env.HEBITS_BUILDER_DIR = dir;
});
afterEach(() => {
  delete process.env.HEBITS_BUILDER_DIR;
});

function writeConfig(contents: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(contents), { mode: 0o600 });
}

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

test('a valid config.json passes through untouched', async () => {
  writeConfig({
    port: 9001,
    lanHost: '192.0.2.1',
    minFreeGB: 25,
    farm: { enabled: false, intervalMin: 5, maxPerRun: 1 },
    notify: { webhookUrl: 'http://example.invalid/webhook' },
  });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.port).toBe(9001);
  expect(cfg.lanHost).toBe('192.0.2.1');
  expect(cfg.minFreeGB).toBe(25);
  expect(cfg.farm).toEqual({ enabled: false, intervalMin: 5, maxPerRun: 1 });
  expect(cfg.notify).toEqual({ webhookUrl: 'http://example.invalid/webhook' });
  expect(cfg.configIssues).toEqual([]);
});

test('a bad field falls back to its default without discarding the rest of the file', async () => {
  writeConfig({ minFreeGB: '20', lanHost: '192.0.2.1', port: 9001 });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.minFreeGB).toBe(20); // DEFAULTS.minFreeGB, the string was rejected
  expect(cfg.lanHost).toBe('192.0.2.1'); // untouched, valid field survives
  expect(cfg.port).toBe(9001);
  expect(cfg.configIssues).toHaveLength(1);
  expect(cfg.configIssues[0]).toContain('minFreeGB');
});

test('a bad nested farm key falls back while sibling farm keys survive', async () => {
  writeConfig({ farm: { enabled: true, intervalMin: '10', maxPerRun: 1 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.farm).toEqual({ enabled: true, intervalMin: 10, maxPerRun: 1 }); // intervalMin: DEFAULTS.farm.intervalMin
  expect(cfg.configIssues.some((i) => i.includes('farm.intervalMin'))).toBe(true);
});

test('unknown top-level and nested keys are preserved, not rejected', async () => {
  writeConfig({ futureKey: 'kept', farm: { enabled: true, futureFarmKnob: 42 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect((cfg as unknown as Record<string, unknown>).futureKey).toBe('kept');
  expect((cfg.farm as Record<string, unknown>).futureFarmKnob).toBe(42);
  expect(cfg.configIssues).toEqual([]);
});

test('multiple bad fields are all collected in configIssues', async () => {
  writeConfig({ minFreeGB: '20', port: 'nope', notify: { webhookUrl: 5 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.configIssues.length).toBeGreaterThanOrEqual(3);
  expect(cfg.minFreeGB).toBe(20);
  expect(cfg.port).toBe(7001);
  expect(cfg.notify).toEqual({ webhookUrl: '' });
});
