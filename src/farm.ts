// Account-building policy: which new Hebits uploads to grab, which old seeds to release.
// Pure functions; the server supplies live data.
import type { HebitsTorrent } from 'hebits-client';
import { isDiscOrRemux, seasonInfo } from './parse';
import { parseTags } from './tags';

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;

// --- The rank ladder ----------------------------------------------------------------------
// From the tracker's own wiki ("userclasses"). Of the requirements a rank lists, three can be
// farmed - download volume, ratio, and the number of torrents downloaded in full - and one
// cannot: time on site. Time is carried here so progress can be REPORTED honestly; nothing
// below is allowed to steer a decision by it.
//
// Two footnotes the table flattens, both toward the conservative reading, because
// over-grabbing on a private tracker is not a cosmetic mistake:
//   - Heb Rookie is allowed 5 downloads on the account's first day and 10 after that. The
//     first day is what `dailyLimitByDay` in config.json exists for; 10 is the steady state.
//   - Heb User's allowance rises from 25 to 30 after six months. Nothing here knows the join
//     date, so the entry value is what is carried.
//
// Only the eight ranks an account can climb are listed. Donor, V.I.P and the staff classes
// are not farmable and are deliberately absent: an account in one of them reads as an unknown
// rank, which every function below handles by falling back rather than by guessing.
export interface Rank {
  name: string;
  /** Days on the site. The one requirement no policy can farm - report it, never chase it. */
  days: number;
  /** GB that count as downloaded. Freeleech bytes never count toward this. */
  volumeGB: number;
  /** The ratio the rank requires. */
  ratio: number;
  /** Torrents the TRACKER considers fully downloaded. See countCompleted() for why this
   *  service can only ever report a lower bound on that. */
  torrents: number;
  /** Hold this rank, let the ratio fall below this, and the rank is revoked. */
  demotedBelow: number;
  /** Downloads allowed per day while holding this rank. */
  dailyLimit: number;
}

// Named individually so the two that are referenced directly below need no index lookup
// (noUncheckedIndexedAccess would type `RANKS[1]` as possibly undefined).
const HEB_ROOKIE: Rank = { name: 'Heb Rookie', days: 0, volumeGB: 0, ratio: 0, torrents: 0, demotedBelow: 0, dailyLimit: 10 };
const HEB_USER: Rank = { name: 'Heb User', days: 30, volumeGB: 20, ratio: 1.25, torrents: 0, demotedBelow: 0.8, dailyLimit: 25 };

export const RANKS: readonly Rank[] = [
  HEB_ROOKIE,
  HEB_USER,
  { name: 'Heb Lover', days: 42, volumeGB: 75, ratio: 1.5, torrents: 50, demotedBelow: 1.45, dailyLimit: 50 },
  { name: 'Heb Veteran', days: 84, volumeGB: 250, ratio: 2.05, torrents: 100, demotedBelow: 1.95, dailyLimit: 50 },
  { name: 'Heb Fanatic', days: 112, volumeGB: 500, ratio: 2.5, torrents: 150, demotedBelow: 2.45, dailyLimit: 65 },
  { name: 'Heb Elite', days: 364, volumeGB: 1024, ratio: 3, torrents: 350, demotedBelow: 2.95, dailyLimit: 65 },
  { name: 'Heb Supreme', days: 574, volumeGB: 2048, ratio: 4, torrents: 500, demotedBelow: 3.95, dailyLimit: 80 },
  { name: 'Heb Prophet', days: 910, volumeGB: 3584, ratio: 5, torrents: 700, demotedBelow: 4.95, dailyLimit: 100 },
];

/** Every rank name, plus AUTO_TARGET, is what `farm.targetRank` accepts. */
export const RANK_NAMES: readonly string[] = RANKS.map((r) => r.name);

/** The default `farm.targetRank`: aim one rung above wherever the account actually is. */
export const AUTO_TARGET = 'auto';

// The tracker's own spelling of the class arrives in AccountStats.userClass, so match
// leniently on whitespace and case rather than on an exact string.
const normaliseName = (name: string | undefined): string =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const BY_NAME = new Map(RANKS.map((r) => [normaliseName(r.name), r]));

export function rankByName(name: string | undefined): Rank | undefined {
  return BY_NAME.get(normaliseName(name));
}

/** The next rank up, or undefined for an unknown rank and for the top of the ladder. */
export function nextRankAfter(name: string | undefined): Rank | undefined {
  const i = RANKS.findIndex((r) => normaliseName(r.name) === normaliseName(name));
  return i < 0 ? undefined : RANKS[i + 1];
}

/** The ratio that costs an account the rank it currently holds. 0 when the rank is unknown,
 *  which is the fail-open direction: an unknown rank adds no floor of its own, and the
 *  volume-based floor in requiredRatioFor() still applies. */
export function demotionRatioFor(rank: string | undefined): number {
  return rankByName(rank)?.demotedBelow ?? 0;
}

// Pacing, not a quota. The point of an hourly ceiling is that the day's allowance is not
// spent in the first hour, so a better release six hours from now still finds a slot. A
// constant did that at Heb Rookie and quietly stopped doing it further up: at 2 per hour an
// account can take 48 a day, which is under the allowance of every rank from Heb Lover (50)
// upward and less than half of Heb Prophet's 100. Pacing that costs you downloads is not
// pacing, it is a cap.
//
// So: spread the farmable allowance across roughly half a day, which leaves the ceiling at
// least twice what 24 hours of grabbing needs - it paces bursts without ever being the
// binding constraint. The floor of 2 keeps the low ranks behaving exactly as before, where
// the daily limit binds first anyway and this number never mattered.
export const PACE_HOURS = 12;
export function pacePerHour(farmableToday: number): number {
  return Math.max(2, Math.ceil(Math.max(0, farmableToday) / PACE_HOURS));
}

/** Downloads per day at this rank, or undefined when the rank is unknown. */
export function dailyLimitFor(rank: string | undefined): number | undefined {
  return rankByName(rank)?.dailyLimit;
}

/** The allowance to assume when the rank is not known at all: the bottom of the ladder, which
 *  is the only value that cannot be an over-estimate. */
export const FALLBACK_DAILY_LIMIT = HEB_ROOKIE.dailyLimit;

// Resolves `farm.targetRank` against the live class. An unrecognised value is treated as
// AUTO_TARGET rather than rejected here - config.ts validates the name and reports a typo as
// a configIssue, and this function must stay total for a pure policy call.
export function resolveTargetRank(target: string | undefined, currentRank?: string): Rank {
  const named = rankByName(target);
  if (named) return named;
  const next = nextRankAfter(currentRank);
  if (next) return next;
  // Either the current rank is unknown (no stats yet, or a class outside the ladder), in
  // which case Heb User is where a new account is headed, or the account is already at the
  // top and its own numbers are what has to be maintained.
  return rankByName(currentRank) ?? HEB_USER;
}

// Aim slightly past the requirement: the tracker checks it during a nightly sweep, and
// stopping dead on the exact figure risks missing a promotion over rounding. 20 GB -> 22.
export const TARGET_VOLUME_HEADROOM = 1.1;

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

// --- Completed torrents ---------------------------------------------------------------------
// The rank ladder counts torrents THE TRACKER considers fully downloaded: a lifetime figure
// that never falls, including torrents released years ago and torrents grabbed by hand before
// this service existed. Nothing available here reports that number.
//
//   - hebits-client's AccountStats carries userId, uploaded, downloaded, ratio, requiredRatio
//     and userClass, and its ajax.php?action=index schema parses nothing else. No snatch or
//     completed count is exposed, so there is no tracker-side number to read.
//   - store.data.torrents indexes what THIS service grabbed, from the day its state.json was
//     created. It is documented as a cache, not a source of truth, and a machine rebuild
//     starts it empty.
//   - qBittorrent knows what is complete ON DISK RIGHT NOW, which the cleanup pass reduces
//     every time it releases a seed.
//
// So the honest answer is a lower bound, and every consumer of this is required to render it
// as one. `completedAt` (stamped on the store entry the first time a managed torrent is seen
// at 100%) is what keeps the bound from falling again when cleanup releases that torrent.
export interface CompletedTally {
  /** A LOWER BOUND on the tracker's count, never the tracker's count. */
  count: number;
  /** Always false: see the block comment above. Kept as a field so callers must decide what
   *  to print rather than silently rendering a bound as a fact. */
  exact: boolean;
  /** Where the number came from, for /status. */
  basis: string;
}

/** The store's side of the count. Deliberately narrower than TorrentEntry. */
export interface CompletedEntry {
  hash?: string;
  completedAt?: string;
}

/** The qBittorrent side of the count. Deliberately narrower than QbitTorrent. */
export interface CompletedTorrent {
  hash: string;
  progress: number;
}

const completeHashes = (torrents: readonly CompletedTorrent[] | undefined): Set<string> =>
  new Set((torrents ?? []).filter((t) => t.progress >= 1).map((t) => String(t.hash).toLowerCase()));

// entries: store.data.torrents; torrents: qbit.all(), or undefined when qBittorrent could not
// be read - in which case the stamped history still gives a (staler) bound rather than none.
//
// Returns undefined - "not determined" - when there is no basis for a number at all:
// qBittorrent unreadable AND nothing ever stamped. That case has to be distinguishable from
// a grounded zero, because `0` steers the recommendation straight at the count dimension and
// a figure nobody could determine must steer nothing. See the `known` flag in rankProgress().
export function countCompleted(
  entries: Record<string, CompletedEntry>,
  torrents?: readonly CompletedTorrent[],
): CompletedTally | undefined {
  const complete = completeHashes(torrents);
  let count = 0;
  for (const entry of Object.values(entries)) {
    if (entry === undefined) continue;
    if (entry.completedAt || (entry.hash && complete.has(entry.hash.toLowerCase()))) count++;
  }
  if (torrents === undefined && count === 0) return undefined;
  return {
    count,
    exact: false,
    basis: torrents === undefined ? 'the local index only (qBittorrent unreadable)' : 'qBittorrent plus the local index',
  };
}

// The ids whose store entry should be stamped `completedAt` now: managed, complete in
// qBittorrent, not stamped yet. Pure, so the caller does the writing.
export function newlyCompleted(entries: Record<string, CompletedEntry>, torrents: readonly CompletedTorrent[]): string[] {
  const complete = completeHashes(torrents);
  const out: string[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (entry === undefined || entry.completedAt || !entry.hash) continue;
    if (complete.has(entry.hash.toLowerCase())) out.push(id);
  }
  return out;
}

// --- Weights and presets ----------------------------------------------------------------
// A preset is a weighting across the four dimensions. It decides WHICH candidates
// win the day's scarce slots; it never decides whether a candidate is allowed at all. Every
// filter and every safety check in pickGrabs runs identically under every preset.
//
// The three pull against each other, which is the point:
//   ratio  - high-demand, seeder-scarce torrents that earn upload without costing much
//            counted download.
//   volume - big COUNTED torrents, because the volume requirement is measured in GB
//            downloaded and freeleech bytes do not count toward it at all.
//   count  - small torrents, because the requirement counts torrents completed and a 40 GB
//            remux counts exactly as much as a 1 GB episode.
// `volume` and `count` are close to opposites; `ratio` constrains both.
export interface FarmWeights {
  ratio: number;
  volume: number;
  count: number;
  points: number;
}

export const PRESETS = {
  // The safety preset, and what recommendPreset() forces whenever the ratio is at or below
  // the floor. Everything else is worthless from a demoted or download-blocked account.
  'ratio-first': { ratio: 1, volume: 0, count: 0, points: 0 },
  // Nothing is the binding constraint: keep earning on every dimension at once.
  balanced: { ratio: 0.4, volume: 0.2, count: 0.2, points: 0.2 },
  // GB downloaded is what is missing. Still ratio-aware, because spending the ratio to get
  // there is how an account ends up demoted one rung below where it started.
  'volume-first': { ratio: 0.25, volume: 0.75, count: 0, points: 0 },
  // The torrent count is what is missing - the dimension an account can sit at target ratio
  // and target volume and still fail on forever.
  'count-first': { ratio: 0.25, volume: 0, count: 0.75, points: 0 },
  // Bonus points, not rank. The rank ladder asks for ratio, GB and completed torrents;
  // points are a separate currency that buys upload credit, freeleech tokens and HnR
  // removals from Heb User upwards. An account that has met every farmable requirement of
  // the rank it is chasing has nothing left to farm FOR - this is what it does instead.
  // Still ratio-aware, like every other focused preset: points are worthless on an account
  // that has been demoted or blocked from downloading.
  'points-first': { ratio: 0.25, volume: 0, count: 0, points: 0.75 },
} as const satisfies Record<string, FarmWeights>;

export type PresetName = keyof typeof PRESETS;

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function isPresetName(name: string | undefined): name is PresetName {
  return name !== undefined && Object.hasOwn(PRESETS, name);
}

// --- Progress against the target rank -----------------------------------------------------

export interface DimensionProgress {
  have: number;
  need: number;
  met: boolean;
  /** False when the figure could not be determined (the torrent count, always; time on site,
   *  until something supplies a join date). An unknown dimension never steers policy. */
  known: boolean;
}

export interface RankProgress {
  /** The tracker's spelling of the current class, or null when it is not known. */
  currentRank: string | null;
  /** The resolved target. */
  targetRank: string;
  /** Set only when `farm.targetRank` named something this ladder does not know, so /status
   *  can say which rank is actually being chased instead of silently substituting one. */
  targetRankRequested?: string;
  ratio: DimensionProgress;
  volumeGB: DimensionProgress;
  torrents: DimensionProgress;
  /** Cannot be farmed and is never `known` today: nothing exposes the account's join date. */
  days: DimensionProgress;
  /** The farmable dimension furthest from its requirement, or null when all are met. */
  binding: 'ratio' | 'volume' | 'torrents' | null;
  /** What recommendPreset() says for this state. */
  preset: PresetName;
  summary: string;
}

export interface ProgressInput {
  uploaded: number;
  downloaded: number;
  /** AccountStats.userClass. */
  currentRank?: string;
  /** farm.targetRank. */
  targetRank?: string;
  /** farm.targetRatio, when an operator pinned one. */
  targetRatio?: number;
  completed?: CompletedTally;
  /** No caller has one today - AccountStats carries no join date - so time on site reports
   *  as unknown. Threaded through so that stays a missing input rather than a missing idea. */
  accountAgeDays?: number;
}

/** Infinity for an account that has downloaded nothing: no download, no ratio problem. The
 *  tracker's own `ratio` field is not used, so this stays deterministic under test. */
export function ratioOf(uploaded: number, downloaded: number): number {
  if (!Number.isFinite(uploaded) || !Number.isFinite(downloaded)) return 0; // fail closed
  return downloaded > 0 ? uploaded / downloaded : Number.POSITIVE_INFINITY;
}

const fmtRatio = (r: number): string => (Number.isFinite(r) ? r.toFixed(2) : '∞');

// Fraction of the way to a requirement. A requirement of 0 is already met, so it must never
// come last in the "which dimension is furthest behind" comparison.
const fraction = (have: number, need: number): number => (need <= 0 ? Number.POSITIVE_INFINITY : have / need);

export function rankProgress(input: ProgressInput): RankProgress {
  const { uploaded, downloaded, currentRank, completed } = input;
  const target = resolveTargetRank(input.targetRank, currentRank);
  const ratio = ratioOf(uploaded, downloaded);
  const downloadedGB = downloaded / GB;
  // An explicit farm.targetRatio pins the GOAL, not a floor - see pickGrabs, where the only
  // thing that can block a grab is requiredRatioFor()/demotionRatioFor().
  const needRatio = Number.isFinite(input.targetRatio) && (input.targetRatio ?? 0) > 0 ? (input.targetRatio as number) : target.ratio;

  const dims = {
    ratio: { have: ratio, need: needRatio, met: ratio >= needRatio, known: true },
    volumeGB: { have: downloadedGB, need: target.volumeGB, met: downloadedGB >= target.volumeGB, known: true },
    torrents: {
      have: completed?.count ?? 0,
      need: target.torrents,
      // A lower bound that already clears the requirement is still a proof that it is met;
      // one that does not is not a proof that it is unmet, hence `known: false` below.
      met: (completed?.count ?? 0) >= target.torrents,
      known: completed !== undefined,
    },
    days: {
      have: input.accountAgeDays ?? 0,
      need: target.days,
      met: (input.accountAgeDays ?? 0) >= target.days,
      known: input.accountAgeDays !== undefined,
    },
  } satisfies Record<string, DimensionProgress>;

  // Which farmable dimension is furthest behind. The torrent count only joins the comparison
  // when it is known: steering on a number nobody could determine is how every decision ends
  // up quietly mis-aimed. A requirement of 0 (Heb User has no torrent count) scores Infinity
  // through fraction() and so can never be the binding one.
  const candidates: { name: 'ratio' | 'volume' | 'torrents'; at: number }[] = [
    { name: 'ratio', at: fraction(ratio, needRatio) },
    { name: 'volume', at: fraction(downloadedGB, target.volumeGB) },
  ];
  if (dims.torrents.known && target.torrents > 0) candidates.push({ name: 'torrents', at: fraction(dims.torrents.have, target.torrents) });
  const worst = candidates.reduce((a, b) => (b.at < a.at ? b : a));
  const binding = worst.at >= 1 ? null : worst.name;

  // The one rule here that is not a preference: at or below the floor, ratio wins outright,
  // whatever the target rank is and whatever the other dimensions say. The floor is the
  // stricter of the site's volume-based required ratio and the demotion line of the rank the
  // account currently holds - both are ways to lose the ability to download at all.
  const floor = Math.max(requiredRatioFor(downloaded), demotionRatioFor(currentRank));
  let preset: PresetName;
  if (ratio <= floor) preset = 'ratio-first';
  else if (binding === 'ratio') preset = 'ratio-first';
  else if (binding === 'volume') preset = 'volume-first';
  else if (binding === 'torrents') preset = 'count-first';
  // Nothing farmable is behind. Chasing rank requirements that are already met earns
  // nothing, so earn the other currency instead - see the 'points-first' note above.
  else preset = 'points-first';

  const parts = [
    `ratio ${fmtRatio(ratio)}/${needRatio}${dims.ratio.met ? ' ✓' : ''}`,
    `volume ${downloadedGB.toFixed(1)}/${target.volumeGB} GB${dims.volumeGB.met ? ' ✓' : ''}`,
  ];
  if (target.torrents > 0) {
    // "≥" is not decoration: it is the difference between reporting a bound and asserting a
    // number this service cannot stand behind.
    parts.push(
      dims.torrents.known
        ? `torrents ≥${dims.torrents.have}/${target.torrents}${dims.torrents.met ? ' ✓' : ''}`
        : `torrents unknown/${target.torrents}`,
    );
  }
  // Time on site is worth a word only once nothing farmable is left to do - which is exactly
  // when "why am I not ranking up?" has no other answer.
  if (binding === null && target.days > 0) parts.push(`${target.days} days on site still required (not tracked here)`);

  const progress: RankProgress = {
    currentRank: currentRank ?? null,
    targetRank: target.name,
    ratio: dims.ratio,
    volumeGB: dims.volumeGB,
    torrents: dims.torrents,
    days: dims.days,
    binding,
    preset,
    summary: parts.join(', '),
  };
  if (input.targetRank !== undefined && input.targetRank !== AUTO_TARGET && !rankByName(input.targetRank))
    progress.targetRankRequested = input.targetRank;
  return progress;
}

/** The preset this account should be farming under. See rankProgress() for the rules. */
export function recommendPreset(input: ProgressInput): PresetName {
  return rankProgress(input).preset;
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
  /** Unset: paced from the rank's own allowance by pacePerHour(). Set: an operator pinning
   *  the hourly ceiling. It exists to spread the day's slots so later, better releases still
   *  get one - as a constant it stopped doing that job at the top of the ladder and became a
   *  cap instead. */
  maxPerHour: undefined as number | undefined,
  quietAfterHours: 1, // older than this with nobody downloading: no upload to be had
  ratioMargin: 0.2,
  /** A rank name from RANKS, or AUTO_TARGET for "one rung above where the account is". */
  targetRank: AUTO_TARGET as string,
  /** Unset: derived from targetRank (its volume requirement plus TARGET_VOLUME_HEADROOM).
   *  Set: an operator pinning the number of counted GB worth chasing. */
  countedTargetGB: undefined as number | undefined,
  /** Unset: derived from targetRank. Set: an operator pinning the ratio GOAL. Either way it
   *  is a goal and never blocks a grab - see the safety floor in pickGrabs. */
  targetRatio: undefined as number | undefined,
  /** Unset: whatever recommendPreset() says for the live stats. Set: a pinned preset. */
  preset: undefined as PresetName | string | undefined,
  /** Per-dimension overrides, merged over the preset's weights. */
  weights: undefined as Partial<FarmWeights> | undefined,
};

// cfg.farm / cfg.cleanup carry `enabled` and `intervalMin` alongside the policy knobs and are
// passed through as `opts` whole, so the option types admit them.
export type GrabOptions = Partial<typeof GRAB_DEFAULTS> & { enabled?: boolean; intervalMin?: number };

export interface GrabContext {
  now: number;
  // userClass: AccountStats.userClass, the rank the account currently holds. Absent when the
  // tracker could not be read; every use of it falls back rather than guessing.
  stats: { uploaded: number; downloaded: number; dailyUsed: number; dailyLimit: number; userClass?: string };
  freeBytes: number;
  // Object.keys(store.data.torrents): Hebits ids as strings. See H1 in pickGrabs.
  known: Set<string>;
  grabbedLastHour?: number;
  // A lower bound on torrents completed - see countCompleted(). Absent means "not determined",
  // which keeps the count dimension out of the recommendation entirely.
  completed?: CompletedTally;
  opts?: GrabOptions;
}

/** What the policy is actually weighting, so the log and /status can report the same thing
 *  pickGrabs used rather than recomputing a guess. */
export interface ResolvedWeights {
  preset: PresetName | 'custom';
  weights: FarmWeights;
}

const weightsTotal = (w: FarmWeights): number => w.ratio + w.volume + w.count + w.points;

// Precedence: explicit per-dimension weights, then a pinned preset name, then the
// recommendation. A pinned name this build does not know falls through to the recommendation
// rather than to an arbitrary preset - config.ts reports the typo as a configIssue.
export function resolveWeights(opts: GrabOptions | undefined, progress: RankProgress): ResolvedWeights {
  const pinned = opts?.preset;
  const base = isPresetName(pinned) ? pinned : progress.preset;
  const weights: FarmWeights = { ...PRESETS[base] };
  const over = opts?.weights;
  if (over) {
    if (Number.isFinite(over.ratio)) weights.ratio = over.ratio as number;
    if (Number.isFinite(over.volume)) weights.volume = over.volume as number;
    if (Number.isFinite(over.count)) weights.count = over.count as number;
    if (Number.isFinite(over.points)) weights.points = over.points as number;
    // A weighting that sums to nothing expresses no preference at all, which would leave the
    // order of the day's grabs to whatever the tracker happened to list first. Fall back to
    // the preset it was meant to modify.
    if (!(weightsTotal(weights) > 0)) return { preset: base, weights: { ...PRESETS[base] } };
    return { preset: 'custom', weights };
  }
  return { preset: base, weights };
}

// The raw, un-normalised value of one candidate on each dimension. Higher is better on all
// three. Normalisation happens across the candidate set in scoreCandidates().
function rawDimensions(it: HebitsTorrent): FarmWeights {
  const sizeGB = it.size / GB;
  const countedGB = (it.size * it.downloadFactor) / GB;
  return {
    // Upload pull per unit of ratio damage. A freeleech torrent costs nothing and keeps its
    // full demand; a counted one is discounted by exactly what it will cost the ratio.
    ratio: demand(it) / (1 + countedGB),
    // Only counted bytes move the volume requirement, so freeleech scores zero here. That is
    // not a bug in the scoring; it is what the requirement measures.
    volume: countedGB,
    // One completed torrent is one completed torrent whatever it weighs, so prefer the ones
    // that finish soonest and cost the least disk.
    count: 1 / (1 + sizeGB),
    // Bonus points earned per hour of seeding, per unit of ratio damage - the same
    // per-unit-of-cost shape as `ratio` above, so the two are comparable. seedMonths is 0
    // because this scores the torrent on the day it is grabbed; the age multiplier applies
    // equally to every candidate and so cannot change their order.
    //
    // This pulls AGAINST `ratio` and `count` on purpose, which is the whole reason it is a
    // separate dimension rather than a relabelling: points want large and few-seeded, demand
    // wants many leechers, and count wants small. A preset decides that trade.
    points: pointsPerHour(it.size, it.seeders ?? 0) / (1 + countedGB),
  };
}

// Min-max across the candidates, so the three weights are commensurable. A dimension on which
// every candidate is identical discriminates nothing and contributes nothing, rather than
// contributing a constant that depends on the arbitrary scale of its raw values.
function normalise(values: number[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const raw of values) {
    // Fail closed on a non-numeric reading the same way the rest of this file does: it scores
    // zero and sorts last rather than poisoning every comparison with NaN.
    const v = Number.isFinite(raw) ? raw : 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return values.map(() => 0);
  return values.map((raw) => ((Number.isFinite(raw) ? raw : 0) - min) / span);
}

function scoreCandidates(items: HebitsTorrent[], weights: FarmWeights): Map<HebitsTorrent, number> {
  const raw = items.map(rawDimensions);
  const ratio = normalise(raw.map((r) => r.ratio));
  const volume = normalise(raw.map((r) => r.volume));
  const count = normalise(raw.map((r) => r.count));
  const points = normalise(raw.map((r) => r.points));
  const scores = new Map<HebitsTorrent, number>();
  items.forEach((it, i) => {
    scores.set(
      it,
      weights.ratio * (ratio[i] ?? 0) + weights.volume * (volume[i] ?? 0) + weights.count * (count[i] ?? 0) + weights.points * (points[i] ?? 0),
    );
  });
  return scores;
}

// items: hebits-client browse results; ctx: { now, stats, freeBytes, known:Set<hebitsId>, grabbedLastHour, completed, opts }
// stats: { uploaded, downloaded, dailyUsed, dailyLimit, userClass }
export function pickGrabs(items: HebitsTorrent[], ctx: GrabContext): { item: HebitsTorrent; reason: string }[] {
  // Fail closed: an unreadable free-space reading must never be treated as "plenty of
  // room" (undefined/NaN compare false against every "not enough" guard below).
  if (!Number.isFinite(ctx.freeBytes)) return [];
  const o = { ...GRAB_DEFAULTS, ...ctx.opts };
  const { stats } = ctx;
  const farmable = Math.max(0, stats.dailyLimit - o.keepForUser);
  const perHour = Number.isFinite(o.maxPerHour) ? (o.maxPerHour as number) : pacePerHour(farmable);
  let slots = Math.min(o.maxPerRun, perHour - (ctx.grabbedLastHour ?? 0), stats.dailyLimit - o.keepForUser - stats.dailyUsed);
  if (slots <= 0) return [];
  let free = ctx.freeBytes;
  let downloaded = stats.downloaded;

  const progress = rankProgress({
    uploaded: stats.uploaded,
    downloaded: stats.downloaded,
    currentRank: stats.userClass,
    targetRank: o.targetRank,
    targetRatio: o.targetRatio,
    completed: ctx.completed,
  });
  const { weights } = resolveWeights(ctx.opts, progress);
  const target = resolveTargetRank(o.targetRank, stats.userClass);
  // The ONLY ratio number that can block a grab. Not the target: the target is the rank goal,
  // and a goal that blocks grabs throttles the account to defend a threshold it was never
  // required to hold. `demotionRatioFor` is the current rank's revocation line, which is a
  // real floor for the same reason requiredRatioFor is - below either, the account stops
  // being able to farm anything at all.
  const demotionFloor = demotionRatioFor(stats.userClass) + o.ratioMargin;
  const countedTargetBytes =
    (Number.isFinite(o.countedTargetGB) ? (o.countedTargetGB as number) : target.volumeGB * TARGET_VOLUME_HEADROOM) * GB;

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
    .filter((it) => ctx.now - it.uploadedAt.getTime() <= o.quietAfterHours * HOUR || leechers(it) > 0);

  // The preset decides the ORDER, and so which candidates win the day's scarce slots. It
  // decides nothing else: every filter above and every check below runs the same way under
  // every preset. Newest first as a tiebreak, as before.
  const scores = scoreCandidates(fresh, weights);
  fresh.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || b.uploadedAt.getTime() - a.uploadedAt.getTime());

  const picks: { item: HebitsTorrent; reason: string }[] = [];
  for (const it of fresh) {
    if (slots <= 0) break;
    if (free - it.size < o.reserveGB * GB) continue;
    const counted = it.size * it.downloadFactor;
    let reason: string;
    if (counted === 0) reason = it.uploadFactor > 1 ? `freeleech x${it.uploadFactor}` : 'freeleech';
    else {
      const wantCounted = downloaded < countedTargetBytes;
      const cheapish = it.downloadFactor <= 0.5 || it.uploadFactor >= 2;
      const projected = stats.uploaded / (downloaded + counted);
      const safe = projected >= Math.max(requiredRatioFor(downloaded + counted) + o.ratioMargin, demotionFloor);
      if (!(wantCounted && cheapish && it.size <= o.maxCountedSizeGB * GB && safe)) continue;
      reason = `counts ${(counted / GB).toFixed(1)} GB toward ${target.name}`;
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
  return torrents.filter((t) => managed.has(t.hash) && t.progress < 1 && nowSec - (t.added_on || nowSec) >= hours * 3600);
}

// --- Adoption ---------------------------------------------------------------------------
// `managed` above is built from state.json alone, and state.json is documented as a cache
// rather than a source of truth (see store.ts). That gap is harmless while the file is
// intact and total when it is not: a torrent missing from it is never eligible for release,
// so the disk fills with files the service does not believe it may touch, and the
// completed-torrent count that steers the preset restarts near zero. A rebuilt machine
// starts in exactly that state - qBittorrent's data directory survives, the config dir does
// not - and nothing about it looks wrong until the disk runs out.
//
// What qBittorrent still knows is what grab.ts wrote there when it added the torrent: the
// identity tags (`hebits:<id>`, and usually `imdb:tt...` - see tags.ts) and the tracker it
// announces to. The two together are what makes a torrent adoptable back into the store.
//
// Deliberately on the strict side. Adopting a torrent hands the cleanup pass permission to
// delete it with its files, so a false positive is a torrent the owner added by hand being
// released out from under them; a false negative is a torrent that stays unmanaged, which is
// what happens today anyway. Both identity tests must pass, and anything ambiguous is
// reported rather than adopted.
export const HEBITS_TRACKER_HOST = 'hebits.net';

// The `hebits:` tag value grab.ts writes is always a tracker torrent id - digits. A tag with
// anything else in it was not written by this service's buildTags() against a real id, so it
// is not evidence of anything and does not adopt.
const HEBITS_ID = /^\d+$/;

// One announce URL host against the tracker's. Exact host or a subdomain of it, so
// `tracker.hebits.net` matches and neither `evil-hebits.net` nor `hebits.net.example.com`
// does. qBittorrent's tracker list also carries the pseudo-entries `** [DHT] **`,
// `** [PeX] **` and `** [LSD] **`, which are not URLs at all - they parse as failures and
// count as no evidence, never as a match.
export function isHebitsTracker(urls: readonly string[], host: string = HEBITS_TRACKER_HOST): boolean {
  // Trim before the fallback, not after: a `trackerHost` of "" or "   " in config.json is
  // truthy-or-not trivia that would otherwise decide between the tracker's host and no host
  // at all, and "no host at all" adopts nothing - the silent dead end this whole file exists
  // to close. A host nobody set means the default.
  const want = (host ?? '').trim().toLowerCase().replace(/^\.+/, '') || HEBITS_TRACKER_HOST;
  return urls.some((raw) => {
    let hostname: string;
    try {
      hostname = new URL(String(raw)).hostname.toLowerCase();
    } catch {
      return false;
    }
    return hostname === want || hostname.endsWith(`.${want}`);
  });
}

/** The qBittorrent side of adoption. Wider than QbitTorrent: the tags carry the identity. */
export interface AdoptableTorrent {
  hash: string;
  name: string;
  tags: string;
  size: number;
  progress: number;
  completion_on?: number;
}

/** The store's side of adoption. Deliberately narrower than TorrentEntry. */
export interface AdoptableEntry {
  hash?: string;
  completedAt?: string;
}

/** A torrent that carries a usable Hebits id and no store entry claiming its infohash. */
export interface AdoptionCandidate<T> {
  hebitsId: string;
  torrent: T;
}

/** A torrent that looked adoptable and was not adopted, with the sentence saying why. */
export interface AdoptionSkip {
  hebitsId: string;
  hash: string;
  reason: string;
}

export interface AdoptionSurvey<T> {
  candidates: AdoptionCandidate<T>[];
  /** Torrents whose infohash the store already holds - the steady state once converged. */
  known: number;
  skipped: AdoptionSkip[];
}

// The half of adoption that needs no I/O: which torrents the store has never heard of.
// Torrents with no `hebits:` tag are not candidates and are not reported - the owner's own
// torrents sharing this qBittorrent are the normal case, not a problem to surface.
//
// Idempotence lives here. A torrent whose infohash any entry already records is `known`, so
// a second pass over the same qBittorrent produces no candidates and writes nothing; and
// because only torrents PRESENT in qBittorrent are ever considered, an entry the cleanup
// pass marked `removedAt` can never be resurrected by this.
export function adoptionCandidates<T extends AdoptableTorrent>(
  torrents: readonly T[],
  entries: Record<string, AdoptableEntry>,
): AdoptionSurvey<T> {
  const recorded = new Set(
    Object.values(entries)
      .map((e) => e?.hash)
      .filter((h): h is string => Boolean(h))
      .map((h) => h.toLowerCase()),
  );
  const survey: AdoptionSurvey<T> = { candidates: [], known: 0, skipped: [] };
  for (const t of torrents) {
    const { hebitsId } = parseTags(t.tags);
    if (hebitsId === undefined) continue;
    if (recorded.has(String(t.hash).toLowerCase())) {
      survey.known++;
      continue;
    }
    if (!HEBITS_ID.test(hebitsId)) {
      survey.skipped.push({ hebitsId, hash: t.hash, reason: 'its hebits tag is not a numeric torrent id' });
      continue;
    }
    // The id is spoken for by a DIFFERENT infohash: the same Hebits torrent re-uploaded, a
    // hand-edited tag, two torrents tagged alike. Overwriting would silently drop whichever
    // entry is real, so neither is touched and the divergence is reported instead.
    const claimed = entries[hebitsId];
    if (claimed?.hash) {
      survey.skipped.push({
        hebitsId,
        hash: t.hash,
        reason: `hebits:${hebitsId} is already on record with a different infohash (${claimed.hash.slice(0, 8)})`,
      });
      continue;
    }
    survey.candidates.push({ hebitsId, torrent: t });
  }
  return survey;
}

// What an adopted torrent is worth writing down. Only fields qBittorrent can actually
// evidence: the infohash and name (the same values grab.ts takes from the .torrent), the
// size on disk, and the IMDb id if the tag carries one. `title`, `cover`, `fileCount`,
// `files`, `pieceLength` and `auto` came from the tracker listing or the .torrent file and
// are not recoverable here - they are left absent rather than guessed, which is also what
// keeps them recoverable later: grab.ts's putTorrent merges, so a real grab still fills them.
//
// `completedAt` is the one that has to be right. It is what keeps the rank ladder's
// completed count from falling when cleanup releases the files, so it is taken from
// qBittorrent's own `completion_on` rather than stamped "now" - the true completion time,
// which for a machine rebuild is months before adoption ran. A missing, zero or
// still-in-the-future value (qBittorrent uses sentinels for "not completed") falls back to
// `now`, and an entry that already carries a stamp keeps it: the count may never move
// backwards. See countCompleted().
export function adoptedEntry(
  t: AdoptableTorrent,
  now: Date,
  existing?: AdoptableEntry,
): { hash: string; name: string; size: number; imdb?: string; completedAt?: string } {
  const entry: { hash: string; name: string; size: number; imdb?: string; completedAt?: string } = {
    // Stored exactly as qBittorrent spells it (lower-case hex), because cleanupTick matches
    // `managed` against t.hash with ===, not case-insensitively.
    hash: t.hash,
    name: t.name,
    size: t.size,
  };
  const { imdb } = parseTags(t.tags);
  if (imdb) entry.imdb = imdb;
  if (existing?.completedAt) {
    entry.completedAt = existing.completedAt;
  } else if (t.progress >= 1) {
    const ms = (t.completion_on ?? 0) * 1000;
    entry.completedAt = new Date(ms > 0 && ms <= now.getTime() ? ms : now.getTime()).toISOString();
  }
  return entry;
}

// Season packs etc. are fine to farm; this is only used for log text.
export function describe(it: HebitsTorrent): string {
  const info = seasonInfo(it.name);
  return `${it.name} (${(it.size / GB).toFixed(1)} GB${info ? `, ${info.kind}` : ''})`;
}
