import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';

test('save persists to disk and returns true on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'x', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(store.save(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), store.data);
});

test('a failed save returns false, does not throw, and logs the file and error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500); // read+exec only: writing into it fails with EACCES
  const logs = [];
  const store = new Store(dir, 'UTC', (m) => logs.push(m));
  try {
    assert.doesNotThrow(() => {
      assert.equal(store.save(), false);
    });
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /state\.json/);
});

test('a failed save leaves the previous state.json intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.data.grabs.push({ id: 'first', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(store.save(), true);
  const before = readFileSync(join(dir, 'state.json'), 'utf8');

  chmodSync(dir, 0o500);
  store.data.grabs.push({ id: 'second', at: '2026-01-02T00:00:00.000Z' });
  try {
    assert.equal(store.save(), false);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before);
});

test('save never throws even without a logger, and a disk-full-shaped error is recognisable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  chmodSync(dir, 0o500);
  const store = new Store(dir, 'UTC');
  try {
    assert.doesNotThrow(() => store.save());
  } finally {
    chmodSync(dir, 0o700);
  }
});
