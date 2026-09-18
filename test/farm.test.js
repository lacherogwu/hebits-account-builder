import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickGrabs, pickRemovals, requiredRatioFor, pointsPerHour, stuckDownloads } from '../lib/farm.js';

const GB = 1024 ** 3;
const HOUR = 3600e3;
const now = Date.UTC(2026, 8, 18, 12);
const it = (id, extra = {}) => ({
  hebitsId: id,
  title: `Show.S01.1080p.WEB-DL-${id}`,
  size: 10 * GB,
  seeders: 3,
  peers: 6,
  downloadFactor: 0,
  uploadFactor: 1,
  pubDate: now - HOUR,
  categories: [5000, 100002],
  ...extra,
});
const stats = { uploaded: 5 * GB, downloaded: 0, dailyUsed: 0, dailyLimit: 10 };
const ctx = (extra = {}) => ({ now, stats, freeBytes: 120 * GB, known: new Set(), ...extra });

test('required ratio table and points formula', () => {
  assert.equal(requiredRatioFor(4 * GB), 0);
  assert.equal(requiredRatioFor(7 * GB), 0.5);
  assert.equal(requiredRatioFor(30 * GB), 0.8);
  // 10 GiB, 1 seeder, fresh: 10*0.2/ln(3)
  assert.ok(Math.abs(pointsPerHour(10 * GB, 1) - 2 / Math.log(3)) < 1e-9);
});

test('grabs fresh freeleech TV/movies, skipping stale, known, adult, remux, oversized', () => {
  const items = [
    it('ok'),
    it('old', { pubDate: now - 10 * HOUR }),
    it('known'),
    it('xxx', { categories: [6000] }),
    it('remux', { title: 'Movie.2020.2160p.BluRay.REMUX' }),
    it('huge', { size: 60 * GB }),
    it('tiny', { size: 0.2 * GB }),
  ];
  const picks = pickGrabs(items, ctx({ known: new Set(['known']) }));
  assert.deepEqual(picks.map((p) => p.item.hebitsId), ['ok']);
  assert.equal(picks[0].reason, 'freeleech');
});

test('always leaves slots for the user and respects per-run cap', () => {
  const items = [it('a'), it('b'), it('c')];
  assert.equal(pickGrabs(items, ctx()).length, 2);
  assert.equal(pickGrabs(items, ctx({ stats: { ...stats, dailyUsed: 6 } })).length, 1);
  assert.equal(pickGrabs(items, ctx({ stats: { ...stats, dailyUsed: 7 } })).length, 0);
});

test('paces grabs per hour and skips older releases nobody is downloading', () => {
  const items = [it('a'), it('b'), it('c')];
  assert.equal(pickGrabs(items, ctx({ grabbedLastHour: 1 })).length, 1);
  assert.equal(pickGrabs(items, ctx({ grabbedLastHour: 2 })).length, 0);
  const quiet = [
    it('fresh', { pubDate: now - 0.5 * HOUR, peers: 3, seeders: 3 }),
    it('stale', { pubDate: now - 3 * HOUR, peers: 3, seeders: 3 }),
    it('wanted', { pubDate: now - 3 * HOUR, peers: 5, seeders: 3 }),
  ];
  assert.deepEqual(pickGrabs(quiet, ctx()).map((p) => p.item.hebitsId).sort(), ['fresh', 'wanted']);
});

test('x2 upload counts double when ranking demand', () => {
  const picks = pickGrabs([it('plain', { seeders: 2, peers: 6 }), it('double', { seeders: 2, peers: 5, uploadFactor: 2 })], ctx({ opts: { maxPerRun: 1 } }));
  assert.equal(picks[0].item.hebitsId, 'double');
});

test('stuckDownloads flags managed torrents unfinished after a day', () => {
  const sec = now / 1000;
  const list = [
    { hash: 'new', progress: 0.5, added_on: sec - 3600 },
    { hash: 'stuck', progress: 0.5, added_on: sec - 30 * 3600 },
    { hash: 'done', progress: 1, added_on: sec - 30 * 3600 },
    { hash: 'other', progress: 0.1, added_on: sec - 30 * 3600 },
  ];
  const managed = new Set(['new', 'stuck', 'done']);
  assert.deepEqual(stuckDownloads(list, { now, managed }).map((t) => t.hash), ['stuck']);
});

test('keeps the disk reserve', () => {
  const picks = pickGrabs([it('a', { size: 25 * GB }), it('b', { size: 25 * GB })], ctx({ freeBytes: 85 * GB }));
  assert.deepEqual(picks.map((p) => p.item.hebitsId), ['a']);
});

test('prefers more downloaders per seeder', () => {
  const picks = pickGrabs([it('quiet', { peers: 3 }), it('busy', { seeders: 2, peers: 12 })], ctx());
  assert.equal(picks[0].item.hebitsId, 'busy');
});

test('counted downloads only when cheap, needed, and ratio-safe', () => {
  const half = it('half', { downloadFactor: 0.5, size: 8 * GB });
  const bigHalf = it('bigHalf', { downloadFactor: 0.5, size: 11 * GB });
  const full = it('full', { downloadFactor: 1, size: 5 * GB });
  const x2 = it('x2', { downloadFactor: 1, uploadFactor: 2, size: 4 * GB });
  // 5 GB uploaded: half-leech 8 GB counts 4 -> ratio 1.25 ok; 11 GB would drop below
  // the Heb User ratio; full paid 5 GB is not "cheap"
  let picks = pickGrabs([bigHalf, half, full], ctx());
  assert.deepEqual(picks.map((p) => p.item.hebitsId), ['half']);
  assert.match(picks[0].reason, /counts 4\.0 GB/);
  // x2 upload qualifies as cheap
  assert.deepEqual(pickGrabs([x2], ctx()).map((p) => p.item.hebitsId), ['x2']);
  // not safe: little upload left relative to download
  const poor = { ...stats, uploaded: 3 * GB, downloaded: 4 * GB };
  assert.equal(pickGrabs([x2], ctx({ stats: poor })).length, 0);
  // target reached: no more counted downloads, freeleech still fine
  const done = { ...stats, uploaded: 40 * GB, downloaded: 25 * GB };
  assert.deepEqual(pickGrabs([x2, it('free')], ctx({ stats: done })).map((p) => p.item.hebitsId), ['free']);
});

const t = (hash, extra = {}) => ({
  hash,
  size: 20 * GB,
  progress: 1,
  state: 'uploading',
  seeding_time: 9 * 86400,
  num_complete: 30,
  category: 'seed-auto',
  completion_on: now / 1000 - 20 * 86400,
  ...extra,
});

test('cleanup does nothing while there is room', () => {
  assert.deepEqual(pickRemovals([t('a')], { now, freeBytes: 60 * GB, managed: new Set(['a']) }), []);
});

test('a deletion pass fails closed on a non-numeric free space reading', () => {
  const torrents = [t('a'), t('b'), t('c'), t('d')];
  const managed = new Set(['a', 'b', 'c', 'd']);
  // A normal, low reading releases only enough to reach the target...
  assert.equal(pickRemovals(torrents, { now, freeBytes: 5 * GB, managed }).length, 3);
  // ...but undefined/NaN must never be treated as "plenty of room" (which would fall
  // through every "not enough free space" guard and release everything eligible).
  assert.deepEqual(pickRemovals(torrents, { now, freeBytes: undefined, managed }), []);
  assert.deepEqual(pickRemovals(torrents, { now, freeBytes: NaN, managed }), []);
});

test('a grab pass also fails closed on a non-numeric free space reading', () => {
  const items = [it('a'), it('b')];
  // A normal reading grabs as usual...
  assert.equal(pickGrabs(items, ctx({ freeBytes: 120 * GB })).length, 2);
  // ...but undefined/NaN must not be treated as "plenty of room".
  assert.deepEqual(pickGrabs(items, ctx({ freeBytes: undefined })), []);
  assert.deepEqual(pickGrabs(items, ctx({ freeBytes: NaN })), []);
});

test('cleanup removes only finished, long-seeded, well-seeded, managed torrents; cheapest first', () => {
  const torrents = [
    t('crowded', { num_complete: 80 }),
    t('mid', { num_complete: 20 }),
    t('rare', { num_complete: 2 }),
    t('young', { seeding_time: 3 * 86400 }),
    t('partial', { progress: 0.9 }),
    t('foreign'),
    t('newwatch', { category: 'watch', completion_on: now / 1000 - 9 * 86400 }),
  ];
  const managed = new Set(['crowded', 'mid', 'rare', 'young', 'partial', 'newwatch']);
  const out = pickRemovals(torrents, { now, freeBytes: 20 * GB, managed });
  assert.deepEqual(out.map((x) => x.hash), ['crowded', 'mid']);
});

test('emergency cleanup may release rare torrents too', () => {
  const out = pickRemovals([t('rare', { num_complete: 2 })], { now, freeBytes: 5 * GB, managed: new Set(['rare']) });
  assert.deepEqual(out.map((x) => x.hash), ['rare']);
});

test('the minWatchAgeDays guard follows a configured watchCategory, not the hardcoded default', () => {
  const torrents = [
    // Labeled with the site's default 'watch' category, but this deployment renamed it,
    // so with the option threaded through it must NOT get the on-demand protection.
    t('renamed-default', { category: 'watch', completion_on: now / 1000 - 9 * 86400 }),
    // Labeled with the configured on-demand category: too young, must be protected.
    t('on-demand-young', { category: 'on-demand', completion_on: now / 1000 - 9 * 86400 }),
    // Labeled with the configured on-demand category and old enough: eligible.
    t('on-demand-old', { category: 'on-demand', completion_on: now / 1000 - 20 * 86400 }),
  ];
  const managed = new Set(['renamed-default', 'on-demand-young', 'on-demand-old']);
  const out = pickRemovals(torrents, { now, freeBytes: 20 * GB, managed, opts: { watchCategory: 'on-demand' } });
  assert.deepEqual(out.map((x) => x.hash).sort(), ['on-demand-old', 'renamed-default']);
});
