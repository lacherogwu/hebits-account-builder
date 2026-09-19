// Account-building policy: which new Hebits uploads to grab, which old seeds to release.
// Pure functions; the server supplies live data.
import type { HebitsTorrent } from 'hebits-client';
import { isDiscOrRemux, seasonInfo } from './parse';

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;

// Hebits required-ratio table (0% seeding column, the conservative one).
export function requiredRatioFor(downloaded: number): number {
  if (downloaded < 5 * GB) return 0;
  if (downloaded < 10 * GB) return 0.5;
  if (downloaded < 15 * GB) return 0.7;
  return 0.8;
}

// Hebits bonus points per hour for one torrent.
export function pointsPerHour(sizeBytes: number, seeders: number, seedMonths = 0): number {
  return ((sizeBytes / GB) * (0.2 + 0.4 * Math.log(1 + seedMonths))) / Math.log(2 + Math.max(0, seeders) ** 0.7);
}

// Movies and TV only. Category 8 (movie packs) looks like it belongs here and does not: packs
// are large and change what the daily allowance is spent on.
const WANTED_CATEGORY_IDS = [1, 2]; // Movies, TV

export const GRAB_DEFAULTS = {
  maxAgeHours: 6,
  minSizeGB: 1,
  maxSizeGB: 40,
  maxCountedSizeGB: 15,
  reserveGB: 40,
  keepForUser: 3,
  maxPerRun: 2,
  maxPerHour: 2, // spread the day's slots so later, better releases still get one
  quietAfterHours: 1, // older than this with nobody downloading: no upload to be had
  countedTargetGB: 22, // Heb User needs 20 GB downloaded
  ratioMargin: 0.2,
  targetRatio: 1.25, // Heb User ratio; counted downloads never push below it
};

// cfg.farm / cfg.cleanup carry `enabled` and `intervalMin` alongside the policy knobs and are
// passed through as `opts` whole, so the option types admit them.
export type GrabOptions = Partial<typeof GRAB_DEFAULTS> & { enabled?: boolean; intervalMin?: number };

export interface GrabContext {
  now: number;
  stats: { uploaded: number; downloaded: number; dailyUsed: number; dailyLimit: number };
  freeBytes: number;
  // Object.keys(store.data.torrents): Hebits ids as strings. See H1 in pickGrabs.
  known: Set<string>;
  grabbedLastHour?: number;
  opts?: GrabOptions;
}

// items: hebits-client browse results; ctx: { now, stats, freeBytes, known:Set<hebitsId>, grabbedLastHour, opts }
// stats: { uploaded, downloaded, dailyUsed, dailyLimit }
export function pickGrabs(items: HebitsTorrent[], ctx: GrabContext): { item: HebitsTorrent; reason: string }[] {
  // Fail closed: an unreadable free-space reading must never be treated as "plenty of
  // room" (undefined/NaN compare false against every "not enough" guard below).
  if (!Number.isFinite(ctx.freeBytes)) return [];
  const o = { ...GRAB_DEFAULTS, ...ctx.opts };
  const { stats } = ctx;
  let slots = Math.min(o.maxPerRun, o.maxPerHour - (ctx.grabbedLastHour ?? 0), stats.dailyLimit - o.keepForUser - stats.dailyUsed);
  if (slots <= 0) return [];
  let free = ctx.freeBytes;
  let downloaded = stats.downloaded;

  const fresh = items
    // `known` holds store keys, which are strings, and `id` is a number - without the
    // conversion nothing ever matches and every torrent looks new.
    .filter((it) => !ctx.known.has(String(it.id)))
    // Keep this arithmetic in milliseconds; the qBittorrent timestamps further down this
    // file are in seconds, so the units must not drift.
    .filter((it) => ctx.now - it.uploadedAt.getTime() <= o.maxAgeHours * HOUR)
    .filter((it) => WANTED_CATEGORY_IDS.includes(it.categoryId))
    .filter((it) => it.size >= o.minSizeGB * GB && it.size <= o.maxSizeGB * GB)
    .filter((it) => !isDiscOrRemux(it.name))
    .filter((it) => ctx.now - it.uploadedAt.getTime() <= o.quietAfterHours * HOUR || leechers(it) > 0)
    // More downloaders per seeder = more upload, and x2/x3 upload multiplies it; newest
    // first as a tiebreak.
    .sort((a, b) => demand(b) - demand(a) || b.uploadedAt.getTime() - a.uploadedAt.getTime());

  const picks: { item: HebitsTorrent; reason: string }[] = [];
  for (const it of fresh) {
    if (slots <= 0) break;
    if (free - it.size < o.reserveGB * GB) continue;
    const counted = it.size * it.downloadFactor;
    let reason: string;
    if (counted === 0) reason = it.uploadFactor > 1 ? `freeleech x${it.uploadFactor}` : 'freeleech';
    else {
      const wantCounted = downloaded < o.countedTargetGB * GB;
      const cheapish = it.downloadFactor <= 0.5 || it.uploadFactor >= 2;
      const projected = stats.uploaded / (downloaded + counted);
      const safe = projected >= Math.max(requiredRatioFor(downloaded + counted) + o.ratioMargin, o.targetRatio);
      if (!(wantCounted && cheapish && it.size <= o.maxCountedSizeGB * GB && safe)) continue;
      reason = `counts ${(counted / GB).toFixed(1)} GB toward Heb User`;
      downloaded += counted;
    }
    picks.push({ item: it, reason });
    free -= it.size;
    slots--;
  }
  return picks;
}

// `leechers` is already the leecher count, not a total - do not subtract seeders from it, or
// `demand` clamps to 0 for most healthy torrents and stops ranking anything.
const leechers = (it: HebitsTorrent) => Math.max(0, it.leechers ?? 0);
const demand = (it: HebitsTorrent) => ((leechers(it) + 1) / ((it.seeders ?? 0) + 1)) * (it.uploadFactor || 1);

export const CLEANUP_DEFAULTS = {
  reserveGB: 40,
  targetGB: 50,
  minSeedDays: 8, // Hebits packs need 168 h; one extra day of margin
  keepIfSeedersBelow: 5, // rare torrents: best points, and the site needs them
  emergencyGB: 10,
  minWatchAgeDays: 14,
  watchCategory: 'watch',
};

export type CleanupOptions = Partial<typeof CLEANUP_DEFAULTS> & { enabled?: boolean; intervalMin?: number };

// The slice of a qBittorrent torrents/info object this policy reads.
export interface QbitTorrent {
  hash: string;
  size: number;
  progress: number;
  state: string;
  seeding_time?: number;
  num_complete?: number;
  category?: string;
  completion_on?: number;
  added_on?: number;
}

export interface CleanupContext {
  now: number;
  freeBytes: number;
  managed: Set<string>;
  opts?: CleanupOptions;
}

// torrents: qBittorrent info objects; managed: Set<hash> of the torrents the addon knows
// about. Returns the torrents to delete (with files), cheapest first.
export function pickRemovals<T extends QbitTorrent>(torrents: T[], ctx: CleanupContext): T[] {
  // Fail closed: this pass deletes files, so an unreadable free-space reading must never
  // be treated as "plenty of room" (undefined/NaN compare false against every "not enough"
  // guard below, which would otherwise fall through to releasing everything eligible).
  if (!Number.isFinite(ctx.freeBytes)) return [];
  const o = { ...CLEANUP_DEFAULTS, ...ctx.opts };
  if (ctx.freeBytes >= o.reserveGB * GB) return [];
  const emergency = ctx.freeBytes < o.emergencyGB * GB;
  const nowSec = ctx.now / 1000;

  const eligible = torrents
    .filter((t) => ctx.managed.has(t.hash))
    .filter((t) => t.progress >= 1 && !/^(checking|moving|error|missing)/i.test(t.state))
    .filter((t) => (t.seeding_time ?? 0) >= o.minSeedDays * 86400)
    .filter((t) => t.category !== o.watchCategory || nowSec - (t.completion_on || nowSec) >= o.minWatchAgeDays * 86400)
    .filter((t) => emergency || (t.num_complete ?? 0) >= o.keepIfSeedersBelow)
    .map((t) => {
      const months = (t.seeding_time ?? 0) / (30 * 86400);
      return { t, value: pointsPerHour(t.size, t.num_complete ?? 0, months) / (t.size / GB) };
    })
    .sort((a, b) => a.value - b.value);

  const out: T[] = [];
  let free = ctx.freeBytes;
  for (const { t } of eligible) {
    if (free >= o.targetGB * GB) break;
    out.push(t);
    free += t.size;
  }
  return out;
}

// Hit-and-run guard: seeding time only counts once a torrent is 100% downloaded, so an
// unfinished torrent must not sit stuck. Returns managed torrents added more than
// `hours` ago that still aren't complete.
// Only three fields are read here, so the constraint stays narrower than QbitTorrent.
export function stuckDownloads<T extends { hash: string; progress: number; added_on?: number }>(
  torrents: T[],
  { now, managed, hours = 24 }: { now: number; managed: Set<string>; hours?: number },
): T[] {
  const nowSec = now / 1000;
  return torrents.filter(
    (t) => managed.has(t.hash) && t.progress < 1 && nowSec - (t.added_on || nowSec) >= hours * 3600,
  );
}

// Season packs etc. are fine to farm; this is only used for log text.
export function describe(it: HebitsTorrent): string {
  const info = seasonInfo(it.name);
  return `${it.name} (${(it.size / GB).toFixed(1)} GB${info ? `, ${info.kind}` : ''})`;
}
