import type { HebitsTorrent } from 'hebits-client';
import { expect, test } from 'vitest';
import {
  pickGrabs,
  pickRemovals,
  pointsPerHour,
  requiredRatioFor,
  stuckDownloads,
  type GrabContext,
  type QbitTorrent,
} from '../src/farm';
import { torrent } from './factory';

const GB = 1024 ** 3;
const HOUR = 3600e3;
const now = Date.UTC(2026, 8, 18, 12);

// The Torznab fixture this replaces defaulted to 10 GB / 3 seeders / 6 peers (= 3 leechers),
// freeleech, an hour old, in Hebits category 2 (Torznab 5000).
const item = (over: Partial<HebitsTorrent> = {}): HebitsTorrent =>
  torrent({
    name: 'Show.S01.1080p.WEB-DL',
    size: 10 * GB,
    seeders: 3,
    leechers: 3,
    downloadFactor: 0,
    uploadFactor: 1,
    uploadedAt: new Date(now - HOUR),
    categoryId: 2,
    ...over,
  });

const stats = { uploaded: 5 * GB, downloaded: 0, dailyUsed: 0, dailyLimit: 10 };
const ctx = (over: Partial<GrabContext> = {}): GrabContext => ({
  now,
  stats,
  freeBytes: 120 * GB,
  known: new Set<string>(),
  ...over,
});

test('required ratio table and points formula', () => {
  expect(requiredRatioFor(4 * GB)).toBe(0);
  expect(requiredRatioFor(7 * GB)).toBe(0.5);
  expect(requiredRatioFor(30 * GB)).toBe(0.8);
  // 10 GiB, 1 seeder, fresh: 10*0.2/ln(3)
  expect(Math.abs(pointsPerHour(10 * GB, 1) - 2 / Math.log(3))).toBeLessThan(1e-9);
});

test('grabs fresh freeleech TV/movies, skipping stale, known, adult, remux, oversized', () => {
  const ok = item();
  const stale = item({ uploadedAt: new Date(now - 10 * HOUR) });
  const seen = item();
  const adult = item({ categoryId: 9 }); // Porn; Torznab 6000
  const remux = item({ name: 'Movie.2020.2160p.BluRay.REMUX' });
  const huge = item({ size: 60 * GB });
  const tiny = item({ size: 0.2 * GB });
  const picks = pickGrabs([ok, stale, seen, adult, remux, huge, tiny], ctx({ known: new Set([String(seen.id)]) }));
  expect(picks.map((p) => p.item.id)).toEqual([ok.id]);
  expect(picks[0]?.reason).toBe('freeleech');
});

test('always leaves slots for the user and respects per-run cap', () => {
  const items = [item(), item(), item()];
  expect(pickGrabs(items, ctx()).length).toBe(2);
  expect(pickGrabs(items, ctx({ stats: { ...stats, dailyUsed: 6 } })).length).toBe(1);
  expect(pickGrabs(items, ctx({ stats: { ...stats, dailyUsed: 7 } })).length).toBe(0);
});

test('paces grabs per hour and skips older releases nobody is downloading', () => {
  const items = [item(), item(), item()];
  expect(pickGrabs(items, ctx({ grabbedLastHour: 1 })).length).toBe(1);
  expect(pickGrabs(items, ctx({ grabbedLastHour: 2 })).length).toBe(0);
  const fresh = item({ uploadedAt: new Date(now - 0.5 * HOUR), seeders: 3, leechers: 0 });
  const stale = item({ uploadedAt: new Date(now - 3 * HOUR), seeders: 3, leechers: 0 });
  const wanted = item({ uploadedAt: new Date(now - 3 * HOUR), seeders: 3, leechers: 2 });
  const picked = pickGrabs([fresh, stale, wanted], ctx()).map((p) => p.item.id);
  expect(picked.slice().sort()).toEqual([fresh.id, wanted.id].sort());
});

test('x2 upload counts double when ranking demand', () => {
  const plain = item({ seeders: 2, leechers: 4 });
  const double = item({ seeders: 2, leechers: 3, uploadFactor: 2 });
  const picks = pickGrabs([plain, double], ctx({ opts: { maxPerRun: 1 } }));
  expect(picks[0]?.item.id).toBe(double.id);
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
  expect(stuckDownloads(list, { now, managed }).map((t) => t.hash)).toEqual(['stuck']);
});

test('keeps the disk reserve', () => {
  const a = item({ size: 25 * GB });
  const b = item({ size: 25 * GB });
  const picks = pickGrabs([a, b], ctx({ freeBytes: 85 * GB }));
  expect(picks.map((p) => p.item.id)).toEqual([a.id]);
});

test('prefers more downloaders per seeder', () => {
  const quiet = item({ leechers: 0 });
  const busy = item({ seeders: 2, leechers: 10 });
  const picks = pickGrabs([quiet, busy], ctx());
  expect(picks[0]?.item.id).toBe(busy.id);
});

test('counted downloads only when cheap, needed, and ratio-safe', () => {
  const half = item({ downloadFactor: 0.5, size: 8 * GB });
  const bigHalf = item({ downloadFactor: 0.5, size: 11 * GB });
  const full = item({ downloadFactor: 1, size: 5 * GB });
  const x2 = item({ downloadFactor: 1, uploadFactor: 2, size: 4 * GB });
  // 5 GB uploaded: half-leech 8 GB counts 4 -> ratio 1.25 ok; 11 GB would drop below
  // the Heb User ratio; full paid 5 GB is not "cheap"
  const picks = pickGrabs([bigHalf, half, full], ctx());
  expect(picks.map((p) => p.item.id)).toEqual([half.id]);
  expect(picks[0]?.reason).toMatch(/counts 4\.0 GB/);
  // x2 upload qualifies as cheap
  expect(pickGrabs([x2], ctx()).map((p) => p.item.id)).toEqual([x2.id]);
  // not safe: little upload left relative to download
  const poor = { ...stats, uploaded: 3 * GB, downloaded: 4 * GB };
  expect(pickGrabs([x2], ctx({ stats: poor })).length).toBe(0);
  // target reached: no more counted downloads, freeleech still fine
  const done = { ...stats, uploaded: 40 * GB, downloaded: 25 * GB };
  const free = item();
  expect(pickGrabs([x2, free], ctx({ stats: done })).map((p) => p.item.id)).toEqual([free.id]);
});

const t = (hash: string, over: Partial<QbitTorrent> = {}): QbitTorrent => ({
  hash,
  size: 20 * GB,
  progress: 1,
  state: 'uploading',
  seeding_time: 9 * 86400,
  num_complete: 30,
  category: 'seed-auto',
  completion_on: now / 1000 - 20 * 86400,
  ...over,
});

test('cleanup does nothing while there is room', () => {
  expect(pickRemovals([t('a')], { now, freeBytes: 60 * GB, managed: new Set(['a']) })).toEqual([]);
});

test('a deletion pass fails closed on a non-numeric free space reading', () => {
  const torrents = [t('a'), t('b'), t('c'), t('d')];
  const managed = new Set(['a', 'b', 'c', 'd']);
  // A normal, low reading releases only enough to reach the target...
  expect(pickRemovals(torrents, { now, freeBytes: 5 * GB, managed }).length).toBe(3);
  // ...but undefined/NaN must never be treated as "plenty of room" (which would fall
  // through every "not enough free space" guard and release everything eligible).
  expect(pickRemovals(torrents, { now, freeBytes: undefined as unknown as number, managed })).toEqual([]);
  expect(pickRemovals(torrents, { now, freeBytes: NaN, managed })).toEqual([]);
});

test('a grab pass also fails closed on a non-numeric free space reading', () => {
  const items = [item(), item()];
  // A normal reading grabs as usual...
  expect(pickGrabs(items, ctx({ freeBytes: 120 * GB })).length).toBe(2);
  // ...but undefined/NaN must not be treated as "plenty of room".
  expect(pickGrabs(items, ctx({ freeBytes: undefined }))).toEqual([]);
  expect(pickGrabs(items, ctx({ freeBytes: NaN }))).toEqual([]);
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
  expect(out.map((x) => x.hash)).toEqual(['crowded', 'mid']);
});

test('emergency cleanup may release rare torrents too', () => {
  const out = pickRemovals([t('rare', { num_complete: 2 })], { now, freeBytes: 5 * GB, managed: new Set(['rare']) });
  expect(out.map((x) => x.hash)).toEqual(['rare']);
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
  expect(out.map((x) => x.hash).sort()).toEqual(['on-demand-old', 'renamed-default']);
});

// --- The four HebitsTorrent field mappings that change behaviour silently (spec §4) ---

test('H1: a numeric id matches a string key in `known`', () => {
  const it = torrent({ id: 12345, uploadedAt: new Date(now - HOUR) });
  // `known` holds Object.keys(...) — strings. Without String(it.id) this torrent looks new
  // and the builder re-grabs what it already has, every run.
  const picks = pickGrabs([it], ctx({ known: new Set(['12345']) }));
  expect(picks).toEqual([]);
});

test('H2: uploadedAt is a Date, and age filtering uses its epoch value', () => {
  const young = torrent({ uploadedAt: new Date(now - 2 * HOUR) });
  const old = torrent({ uploadedAt: new Date(now - 8 * HOUR) });
  // maxAgeHours is 6. The hazard is the unit, not the syntax: ctx.now is epoch ms while the
  // qBittorrent timestamps elsewhere in farm.ts are seconds, and getting it wrong admits every
  // stale release or drops every candidate. Asserting only that `old` is absent would pass
  // against the drop-everything half, so assert `young` is present.
  const picked = pickGrabs([young, old], ctx()).map((p) => p.item.id);
  expect(picked).toEqual([young.id]);
});

test('H3: only Hebits categories 1 and 2 are farmed', () => {
  const mk = (categoryId: number) => torrent({ categoryId, uploadedAt: new Date(now - HOUR) });
  const picked = (c: number) => pickGrabs([mk(c)], ctx()).length;
  expect(picked(1)).toBe(1); // Movies
  expect(picked(2)).toBe(1); // TV
  expect(picked(3)).toBe(0); // Theater/TV-Other -> Torznab 5050, never matched
  expect(picked(5)).toBe(0); // Games
  expect(picked(8)).toBe(0); // Movie packs -> Torznab 2090; excluded on purpose, not by oversight
  expect(picked(9)).toBe(0); // Porn
});

test('H4: leechers is the leecher count, so demand ranks by real demand', () => {
  const busy = torrent({ seeders: 10, leechers: 3, uploadedAt: new Date(now - HOUR) });
  const quiet = torrent({ seeders: 10, leechers: 1, uploadedAt: new Date(now - HOUR) });
  // Under the buggy `leechers - seeders` both clamp to 0 and tie, so this must assert strict
  // ordering rather than a difference in score.
  const order = pickGrabs([quiet, busy], ctx()).map((p) => p.item.id);
  expect(order).toEqual([busy.id, quiet.id]);
});
