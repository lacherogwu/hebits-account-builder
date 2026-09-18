// Account-building policy: which new Hebits uploads to grab, which old seeds to release.
// Pure functions; the server supplies live data.
import { isDiscOrRemux, seasonInfo } from './parse.js';

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;

// Hebits required-ratio table (0% seeding column, the conservative one).
export function requiredRatioFor(downloaded) {
  if (downloaded < 5 * GB) return 0;
  if (downloaded < 10 * GB) return 0.5;
  if (downloaded < 15 * GB) return 0.7;
  return 0.8;
}

// Hebits bonus points per hour for one torrent.
export function pointsPerHour(sizeBytes, seeders, seedMonths = 0) {
  return ((sizeBytes / GB) * (0.2 + 0.4 * Math.log(1 + seedMonths))) / Math.log(2 + Math.max(0, seeders) ** 0.7);
}

const WANTED_CATEGORIES = [2000, 5000]; // Torznab movies / TV (no XXX, software, music, books)

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

// items: Jackett results; ctx: { now, stats, freeBytes, known:Set<hebitsId>, grabbedLastHour, opts }
// stats: { uploaded, downloaded, dailyUsed, dailyLimit }
export function pickGrabs(items, ctx) {
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
    .filter((it) => !ctx.known.has(it.hebitsId))
    .filter((it) => it.pubDate && ctx.now - it.pubDate <= o.maxAgeHours * HOUR)
    .filter((it) => it.categories?.some((c) => WANTED_CATEGORIES.includes(c)))
    .filter((it) => it.size >= o.minSizeGB * GB && it.size <= o.maxSizeGB * GB)
    .filter((it) => !isDiscOrRemux(it.title))
    .filter((it) => ctx.now - it.pubDate <= o.quietAfterHours * HOUR || leechers(it) > 0)
    // More downloaders per seeder = more upload, and x2/x3 upload multiplies it; newest
    // first as a tiebreak.
    .sort((a, b) => demand(b) - demand(a) || b.pubDate - a.pubDate);

  const picks = [];
  for (const it of fresh) {
    if (slots <= 0) break;
    if (free - it.size < o.reserveGB * GB) continue;
    const counted = it.size * it.downloadFactor;
    let reason;
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

const leechers = (it) => Math.max(0, (it.peers ?? 0) - (it.seeders ?? 0));
const demand = (it) => ((leechers(it) + 1) / ((it.seeders ?? 0) + 1)) * (it.uploadFactor || 1);

export const CLEANUP_DEFAULTS = {
  reserveGB: 40,
  targetGB: 50,
  minSeedDays: 8, // Hebits packs need 168 h; one extra day of margin
  keepIfSeedersBelow: 5, // rare torrents: best points, and the site needs them
  emergencyGB: 10,
  minWatchAgeDays: 14,
  watchCategory: 'watch',
};

// torrents: qBittorrent info objects; managed: Map<hash, {category}> of torrents the
// addon knows about. Returns the torrents to delete (with files), cheapest first.
export function pickRemovals(torrents, ctx) {
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

  const out = [];
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
export function stuckDownloads(torrents, { now, managed, hours = 24 }) {
  const nowSec = now / 1000;
  return torrents.filter(
    (t) => managed.has(t.hash) && t.progress < 1 && nowSec - (t.added_on || nowSec) >= hours * 3600,
  );
}

// Season packs etc. are fine to farm; this is only used for log text.
export function describe(it) {
  const info = seasonInfo(it.title);
  return `${it.title} (${(it.size / GB).toFixed(1)} GB${info ? `, ${info.kind}` : ''})`;
}
