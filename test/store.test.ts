import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// --- a corrupt state.json must not throw at construction ----------------------------------
// The Store is built in server.ts one line after loadConfig() and before the Notifier exists,
// so an uncaught throw here is the same silent launchd restart loop config.ts guards against.
// It must also not be silently clobbered by the next save(): the grab ledger, the managed
// torrent index and the recent-activity log are the owner's only record of what this service
// has done, so a broken file is moved aside intact.
//
// Safe against the live host, checked rather than assumed: every version of this class back to
// the original lib/store.js initialised `{ grabs: [], torrents: {} }` and save() serialises
// this.data whole, so both required keys have always been present in any state.json this
// service wrote. The test below is the positive control for that.

test('malformed state.json is moved aside and construction falls back to an empty store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const original = '{ "grabs": [{"id":"123","at":"2026-01-01T00:00:00.000Z"}], "torrents": {';
  writeFileSync(file, original);
  const logs: string[] = [];

  let store: Store | undefined;
  expect(() => {
    store = new Store(dir, 'UTC', (m) => logs.push(m));
  }).not.toThrow();

  expect(store?.data).toEqual({ grabs: [], torrents: {} });

  // The broken original must survive under a renamed path, not be gone.
  const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);
  expect(existsSync(file)).toBe(false); // moved, not copied - nothing writes a fresh one until save()

  expect(logs.length).toBe(1);
  expect(logs[0]).toContain(badFile);
  // Kept, not just logged: /status renders this beside configIssues, because a reset ledger is
  // what grab.ts's daily() falls back to when Hebits' own counter is unreachable - one line in
  // builder.log is not enough trace for a daily limit that can then be exceeded silently.
  expect(store?.loadIssue).toBe(logs[0]);
});

test('a state.json that cannot even be moved aside runs from an empty in-memory store without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const original = '{ this is not valid json';
  writeFileSync(file, original);
  chmodSync(dir, 0o500); // read+exec only: renameSync into/out of it fails with EACCES
  const logs: string[] = [];

  let store: Store | undefined;
  try {
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();
    expect(store?.data).toEqual({ grabs: [], torrents: {} });
  } finally {
    chmodSync(dir, 0o700);
  }

  expect(readFileSync(file, 'utf8')).toBe(original); // left exactly as it was
  expect(logs.length).toBe(1);
  expect(logs[0]).toMatch(/could not be moved aside/);
  expect(store?.loadIssue).toBe(logs[0]);
});

// The same hole as config.ts's, one line further on: `null` and `42` parse cleanly, so a catch
// on JSON.parse alone never fires, and then server.ts's `store.data.notified ??= {}` throws at
// module load - before the Notifier exists. An array parses too and silently loses every
// property written to it.
for (const [label, body] of [
  ['null', 'null'],
  ['a number', '42'],
  ['an array', '[1,2]'],
] as const) {
  test(`a state.json holding ${label} is moved aside and falls back to an empty store`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, body);
    const logs: string[] = [];

    let store: Store | undefined;
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();

    expect(store?.data).toEqual({ grabs: [], torrents: {} });
    // The statement that actually threw (server.ts, at module load), run here against the
    // recovered store.
    expect(() => {
      (store as Store).data.notified ??= {};
    }).not.toThrow();

    const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(body);
    expect(existsSync(file)).toBe(false);

    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/not an object/);
    expect(store?.loadIssue).toBe(logs[0]);
  });
}

// The same class of hole one level in: these all parse, and all are objects, so every guard
// above passes them through - and then the missing key throws from wherever it is first
// touched. `grabs` throws out of grabsToday(), which daily() only reaches once Hebits' own
// counter is unreachable (so /status 500s at the exact moment the builder is already
// degraded); `torrents` throws out of store.torrent() on every grab and out of /status's own
// torrent list, with the tracker perfectly healthy.
for (const [label, body, expected] of [
  ['no "grabs" key', '{"torrents":{}}', /no "grabs" array/],
  ['no "torrents" key', '{"grabs":[]}', /no "torrents" object/],
  ['a "grabs" object instead of an array', '{"grabs":{},"torrents":{}}', /"grabs" is a JSON object/],
  ['a "torrents" array instead of an object', '{"grabs":[],"torrents":[]}', /"torrents" is a JSON array/],
] as const) {
  test(`a state.json with ${label} is moved aside and falls back to an empty store`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, body);
    const logs: string[] = [];

    let store: Store | undefined;
    expect(() => {
      store = new Store(dir, 'UTC', (m) => logs.push(m));
    }).not.toThrow();

    // The post-state, not just that a guard fired: both statements below are the ones that
    // threw, run here against the recovered store.
    expect(store?.data).toEqual({ grabs: [], torrents: {} });
    expect((store as Store).grabsToday()).toBe(0);
    expect((store as Store).torrent('12345')).toBeUndefined();

    const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(body); // recoverable, not destroyed
    expect(existsSync(file)).toBe(false);

    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(expected);
    expect(store?.loadIssue).toBe(logs[0]);
  });
}

// The negative control for everything above, and the one that says the live host's existing
// state.json is safe: a file carrying both keys with the right shapes - including the optional
// farmLog/notified this service writes, and an unknown key a future version might - is loaded
// as-is, not "recovered". Without this, an implementation that rejected every state.json would
// pass the whole block.
test('a well-shaped state.json is loaded untouched, with no move-aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  const data = {
    grabs: [{ id: '12345', at: '2026-09-19T00:00:00.000Z' }],
    torrents: { '12345': { hash: 'abc', imdb: 'tt1', auto: true } },
    farmLog: [{ action: 'grab', text: 'something', at: '2026-09-19T00:00:00.000Z' }],
    notified: { disk: 1_700_000_000_000 },
    futureFeature: { untouched: true },
  };
  writeFileSync(file, JSON.stringify(data));
  const store = new Store(dir, 'UTC');
  expect(store.data).toEqual(data);
  expect(store.loadIssue).toBeNull();
  expect(readdirSync(dir).find((f) => f.startsWith('state.json.bad-'))).toBeUndefined();
});

// A fresh store has neither farmLog nor notified, so requiring them would move aside every
// state.json the very first time the service ran with this code.
test('a minimal state.json with only the two required keys is loaded untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ grabs: [], torrents: {} }));
  const store = new Store(dir, 'UTC');
  expect(store.loadIssue).toBeNull();
  expect(readdirSync(dir).find((f) => f.startsWith('state.json.bad-'))).toBeUndefined();
});

// /status must not show a stale or invented store problem on a healthy run, or the field is
// noise the owner learns to ignore.
test('loadIssue is null when state.json is absent', () => {
  expect(new Store(mkdtempSync(join(tmpdir(), 'store-')), 'UTC').loadIssue).toBeNull();
});

test('the daily allowance prefers the per-day override, then a pinned limit, then the rank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  const day = new Date('2026-09-18T12:00:00.000Z');
  // The whole point of the sentinel: 0 means "the ladder decides", so a promotion raises the
  // fallback allowance without anyone editing config.json. Heb User's 25 is the rank value.
  expect(store.limitToday({ dailyLimit: 0 }, 25, day)).toBe(25);
  // A pinned non-zero value still wins over the rank - an operator who wrote a number down
  // did so to hold it.
  expect(store.limitToday({ dailyLimit: 5 }, 25, day)).toBe(5);
  // And the per-day override wins over both, which is how an account's first day gets its 5.
  expect(store.limitToday({ dailyLimit: 5, dailyLimitByDay: { '2026-09-18': 2 } }, 25, day)).toBe(2);
  expect(store.limitToday({ dailyLimit: 0, dailyLimitByDay: { '2026-09-18': 2 } }, 25, day)).toBe(2);
  // On any other day that override is not in force.
  expect(store.limitToday({ dailyLimit: 0, dailyLimitByDay: { '2026-09-17': 2 } }, 25, day)).toBe(25);
  // Nothing pinned and no rank to go on: fail closed rather than invent an allowance.
  expect(store.limitToday({ dailyLimit: 0 }, 0, day)).toBe(0);
});

test('the last rank seen is persisted, and rewritten only when it changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = new Store(dir, 'UTC');
  store.noteRank('Heb Rookie', new Date('2026-09-18T12:00:00.000Z'));
  expect(store.data.lastRank).toBe('Heb Rookie');
  expect(store.data.lastRankAt).toBe('2026-09-18T12:00:00.000Z');
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).lastRank).toBe('Heb Rookie');

  // Called on every farm tick: the same rank must not rewrite state.json every ten minutes.
  store.noteRank('Heb Rookie', new Date('2026-09-19T12:00:00.000Z'));
  expect(store.data.lastRankAt).toBe('2026-09-18T12:00:00.000Z');
  // A promotion does get written, timestamp and all.
  store.noteRank('Heb User', new Date('2026-09-20T12:00:00.000Z'));
  expect(store.data.lastRank).toBe('Heb User');
  expect(store.data.lastRankAt).toBe('2026-09-20T12:00:00.000Z');
  // An empty reading is not a rank and must not erase the one that is known.
  store.noteRank('');
  expect(store.data.lastRank).toBe('Heb User');
});
