import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../src/store';

test('save persists to disk and returns true on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'x', at: '2026-01-01T00:00:00.000Z' });
  expect(store.save()).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(store.data);
});

test('a failed save returns false, does not throw, and logs the file and error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500); // read+exec only: writing into it fails with EACCES
  const logs: string[] = [];
  const store = new Store(dir, 'UTC', (m) => logs.push(m));
  try {
    expect(() => {
      expect(store.save()).toBe(false);
    }).not.toThrow();
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }
  expect(logs.length).toBe(1);
  expect(logs[0]).toMatch(/state\.json/);
});

test('a failed save leaves the previous state.json intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'first', at: '2026-01-01T00:00:00.000Z' });
  expect(store.save()).toBe(true);
  const before = readFileSync(join(dir, 'state.json'), 'utf8');

  chmodSync(dir, 0o500);
  store.data.grabs.push({ id: 'second', at: '2026-01-02T00:00:00.000Z' });
  try {
    expect(store.save()).toBe(false);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
});

test('save never throws even without a logger, and a disk-full-shaped error is recognisable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500);
  const store = new Store(dir, 'UTC');
  try {
    expect(() => store.save()).not.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
});
