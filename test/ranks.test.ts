import type { HebitsTorrent } from 'hebits-client';
import { expect, test } from 'vitest';
import {
  AUTO_TARGET,
  countCompleted,
  dailyLimitFor,
  demotionRatioFor,
  FALLBACK_DAILY_LIMIT,
  type GrabContext,
  type GrabOptions,
  newlyCompleted,
  nextRankAfter,
  PRESET_NAMES,
  PRESETS,
  pacePerHour,
  pickGrabs,
  RANKS,
  rankByName,
  rankProgress,
  ratioOf,
  recommendPreset,
  requiredRatioFor,
  resolveTargetRank,
  resolveWeights,
} from '../src/farm';
import { torrent } from './factory';

const GB = 1024 ** 3;
const HOUR = 3600e3;
const now = Date.UTC(2026, 8, 18, 12);

const item = (over: Partial<HebitsTorrent> = {}): HebitsTorrent =>
  torrent({
    size: 5 * GB,
    seeders: 3,
    leechers: 3,
    downloadFactor: 0,
    uploadFactor: 1,
    uploadedAt: new Date(now - HOUR),
    categoryId: 2,
    ...over,
  });

const baseStats = { uploaded: 5 * GB, downloaded: 0, dailyUsed: 0, dailyLimit: 10 };
const ctx = (over: Partial<GrabContext> = {}): GrabContext => ({
  now,
  stats: baseStats,
  freeBytes: 120 * GB,
  known: new Set<string>(),
  ...over,
});

// --- The ladder ---------------------------------------------------------------------------

// Restated independently from the tracker's wiki ("userclasses"), rather than derived from
// RANKS, so this compares two readings of the same source instead of comparing the table to
// itself. Weeks are converted here: 6w=42, 12w=84, 16w=112, 52w=364, 82w=574, 130w=910 days.
const WIKI = [
  { name: 'Heb Rookie', days: 0, volumeGB: 0, ratio: 0, torrents: 0, demotedBelow: 0, dailyLimit: 10 },
  { name: 'Heb User', days: 30, volumeGB: 20, ratio: 1.25, torrents: 0, demotedBelow: 0.8, dailyLimit: 25 },
  { name: 'Heb Lover', days: 42, volumeGB: 75, ratio: 1.5, torrents: 50, demotedBelow: 1.45, dailyLimit: 50 },
  { name: 'Heb Veteran', days: 84, volumeGB: 250, ratio: 2.05, torrents: 100, demotedBelow: 1.95, dailyLimit: 50 },
  { name: 'Heb Fanatic', days: 112, volumeGB: 500, ratio: 2.5, torrents: 150, demotedBelow: 2.45, dailyLimit: 65 },
  { name: 'Heb Elite', days: 364, volumeGB: 1024, ratio: 3, torrents: 350, demotedBelow: 2.95, dailyLimit: 65 },
  { name: 'Heb Supreme', days: 574, volumeGB: 2048, ratio: 4, torrents: 500, demotedBelow: 3.95, dailyLimit: 80 },
  { name: 'Heb Prophet', days: 910, volumeGB: 3584, ratio: 5, torrents: 700, demotedBelow: 4.95, dailyLimit: 100 },
];

test('the rank ladder matches the tracker wiki, row for row', () => {
  expect(RANKS).toEqual(WIKI);
});

test('a rank is found by its name however the tracker spells it, and unknown names stay unknown', () => {
  expect(rankByName('Heb Lover')?.volumeGB).toBe(75);
  // AccountStats.userClass is scraped text: case and spacing must not decide whether the
  // ladder applies at all.
  expect(rankByName('heb  lover')?.volumeGB).toBe(75);
  expect(rankByName(' HEB LOVER ')?.volumeGB).toBe(75);
  // Donor / V.I.P / staff are real classes and deliberately absent: unknown, not guessed.
  expect(rankByName('Donor')).toBeUndefined();
  expect(rankByName('V.I.P')).toBeUndefined();
  expect(rankByName(undefined)).toBeUndefined();
});

test('the daily allowance comes from the rank held, and falls back to the bottom of the ladder', () => {
  expect(dailyLimitFor('Heb Rookie')).toBe(10);
  expect(dailyLimitFor('Heb User')).toBe(25);
  expect(dailyLimitFor('Heb Fanatic')).toBe(65);
  expect(dailyLimitFor('Donor')).toBeUndefined();
  // The value a caller with no rank has to assume can never be an over-estimate.
  expect(FALLBACK_DAILY_LIMIT).toBe(10);
  expect(FALLBACK_DAILY_LIMIT).toBe(Math.min(...RANKS.map((r) => r.dailyLimit)));
});

test('the demotion line belongs to the rank currently held, and is 0 when it is unknown', () => {
  expect(demotionRatioFor('Heb Veteran')).toBe(1.95);
  expect(demotionRatioFor('Heb Rookie')).toBe(0);
  expect(demotionRatioFor('Donor')).toBe(0);
});

test('auto targets one rung up; a named rank wins; the top of the ladder stays put', () => {
  expect(nextRankAfter('Heb Rookie')?.name).toBe('Heb User');
  expect(nextRankAfter('Heb Prophet')).toBeUndefined();
  expect(resolveTargetRank(AUTO_TARGET, 'Heb Rookie').name).toBe('Heb User');
  expect(resolveTargetRank(AUTO_TARGET, 'Heb Lover').name).toBe('Heb Veteran');
  // No stats yet, or a class outside the ladder: Heb User, where a new account is headed.
  expect(resolveTargetRank(AUTO_TARGET, undefined).name).toBe('Heb User');
  expect(resolveTargetRank(AUTO_TARGET, 'Donor').name).toBe('Heb User');
  // Already at the top: its own numbers are what has to be maintained.
  expect(resolveTargetRank(AUTO_TARGET, 'Heb Prophet').name).toBe('Heb Prophet');
  // A named rank overrides the current one in BOTH directions - the whole point is that an
  // operator at Heb Lover is not stuck being tuned for Heb User.
  expect(resolveTargetRank('Heb Fanatic', 'Heb Rookie').name).toBe('Heb Fanatic');
  expect(resolveTargetRank('Heb User', 'Heb Fanatic').name).toBe('Heb User');
  // A name this table does not know behaves as auto rather than as some arbitrary rank.
  expect(resolveTargetRank('Heb Fanatik', 'Heb Lover').name).toBe('Heb Veteran');
});

// --- Progress against the target ----------------------------------------------------------

test('progress reports every farmable dimension against the target rank', () => {
  const p = rankProgress({
    uploaded: 15.7 * GB,
    downloaded: 10.4 * GB,
    currentRank: 'Heb Rookie',
    targetRank: 'Heb Lover',
    completed: { count: 12, exact: false, basis: 'test' },
  });
  expect(p.targetRank).toBe('Heb Lover');
  expect(p.ratio.need).toBe(1.5);
  expect(p.ratio.met).toBe(true);
  expect(p.volumeGB.need).toBe(75);
  expect(p.volumeGB.met).toBe(false);
  expect(p.torrents).toEqual({ have: 12, need: 50, met: false, known: true });
  expect(p.summary).toContain('ratio 1.51/1.5 ✓');
  expect(p.summary).toContain('volume 10.4/75 GB');
  // The bound is rendered as a bound. Dropping the "≥" would state a number this service
  // cannot stand behind - see countCompleted().
  expect(p.summary).toContain('torrents ≥12/50');
  // Volume is 14% of the way there and the torrent count 24%, so volume is what is actually
  // holding this account back - which is the whole question /status now answers.
  expect(p.binding).toBe('volume');
});

test('a requirement the target rank does not have never becomes the binding constraint', () => {
  // Heb User asks for no torrent count at all. An account with zero completed torrents must
  // still report volume as the constraint, not a requirement of 0 it has already met.
  const p = rankProgress({
    uploaded: 30 * GB,
    downloaded: 2 * GB,
    targetRank: 'Heb User',
    completed: { count: 0, exact: false, basis: 'test' },
  });
  expect(p.torrents.need).toBe(0);
  expect(p.torrents.met).toBe(true);
  expect(p.summary).not.toContain('torrents');
  expect(p.binding).toBe('volume');
});

test('an undetermined torrent count is reported as unknown and steers nothing', () => {
  const input = { uploaded: 300 * GB, downloaded: 100 * GB, targetRank: 'Heb Lover' };
  const unknown = rankProgress(input);
  expect(unknown.torrents.known).toBe(false);
  expect(unknown.summary).toContain('torrents unknown/50');
  // Ratio 3.0/1.5 and volume 100/75 are both met, so with no count to go on there is nothing
  // binding - and, crucially, the recommendation is not count-first. With no rank requirement
  // outstanding the answer is points-first: there is nothing left to farm FOR, so earn the
  // other currency.
  expect(unknown.binding).toBeNull();
  expect(unknown.preset).toBe('points-first');
  // The control: the SAME account with the count actually determined does steer by it. If
  // this said 'points-first' too, the assertion above would be pinning nothing.
  const known = rankProgress({ ...input, completed: { count: 3, exact: false, basis: 'test' } });
  expect(known.binding).toBe('torrents');
  expect(known.preset).toBe('count-first');
});

test('time on site is carried, never farmed, and mentioned only when nothing farmable is left', () => {
  const stalled = rankProgress({
    uploaded: 300 * GB,
    downloaded: 100 * GB,
    targetRank: 'Heb Lover',
    completed: { count: 60, exact: false, basis: 'test' },
  });
  expect(stalled.binding).toBeNull();
  expect(stalled.days).toEqual({ have: 0, need: 42, met: false, known: false });
  expect(stalled.summary).toContain('42 days on site still required');
  // Still unmet, and still not the binding constraint: nothing this service does can farm it.
  expect(stalled.binding).not.toBe('days');
});

test('an unrecognised targetRank is reported rather than silently substituted', () => {
  const p = rankProgress({ uploaded: 10 * GB, downloaded: 10 * GB, currentRank: 'Heb Rookie', targetRank: 'Heb Fanatik' });
  expect(p.targetRank).toBe('Heb User');
  expect(p.targetRankRequested).toBe('Heb Fanatik');
  // A rank that IS recognised leaves no such note, so the field means what it says.
  expect(rankProgress({ uploaded: 10 * GB, downloaded: 10 * GB, targetRank: 'Heb Lover' }).targetRankRequested).toBeUndefined();
  expect(rankProgress({ uploaded: 10 * GB, downloaded: 10 * GB, targetRank: AUTO_TARGET }).targetRankRequested).toBeUndefined();
});

test('an account that has downloaded nothing has no ratio problem', () => {
  expect(ratioOf(5 * GB, 0)).toBe(Number.POSITIVE_INFINITY);
  expect(ratioOf(5 * GB, 10 * GB)).toBe(0.5);
  // Fail closed, as everywhere else in this file: an unreadable figure is not "fine".
  expect(ratioOf(Number.NaN, 10 * GB)).toBe(0);
  const p = rankProgress({ uploaded: 5 * GB, downloaded: 0, targetRank: 'Heb User' });
  expect(p.summary).toContain('ratio ∞/1.25 ✓');
  expect(p.binding).toBe('volume');
});

// --- The recommendation ---------------------------------------------------------------------

test('below the required ratio, ratio wins whatever the target rank and whatever else is behind', () => {
  // requiredRatioFor(20 GB) is 0.8; this account is at 0.15 and has NOTHING else going for it
  // either - zero volume progress toward every rank above Heb User, zero torrents completed -
  // so every dimension is a candidate and only the floor rule can explain the answer.
  const sunk = { uploaded: 3 * GB, downloaded: 20 * GB, completed: { count: 0, exact: false, basis: 'test' } };
  expect(requiredRatioFor(20 * GB)).toBe(0.8);
  for (const rank of RANKS) {
    expect(recommendPreset({ ...sunk, targetRank: rank.name })).toBe('ratio-first');
  }
  expect(recommendPreset({ ...sunk, targetRank: AUTO_TARGET })).toBe('ratio-first');

  // The control. Same volume, same torrent count, same targets - only the ratio changes - and
  // the answer must stop being ratio-first, or the loop above passes for no reason at all.
  const healthy = { uploaded: 100 * GB, downloaded: 20 * GB, completed: { count: 0, exact: false, basis: 'test' } };
  // Toward Heb Lover: 0 of 50 torrents is further behind than 20 of 75 GB, so the count wins.
  expect(recommendPreset({ ...healthy, targetRank: 'Heb Lover' })).toBe('count-first');
  // Toward Heb User, which asks for no torrent count: ratio and volume are both met already,
  // so nothing is binding and the answer is points-first rather than any rank dimension.
  expect(recommendPreset({ ...healthy, targetRank: 'Heb User' })).toBe('points-first');
});

test('the demotion line of the rank held is a floor of its own', () => {
  // Ratio 1.5, downloaded 20 GB: comfortably above requiredRatioFor(20 GB) = 0.8, and volume
  // toward Heb Fanatic is barely started, so nothing but the demotion line can force ratio.
  const account = { uploaded: 30 * GB, downloaded: 20 * GB, targetRank: 'Heb Fanatic' };
  // Heb Veteran is revoked below 1.95 - this account is one bad grab from losing its rank.
  expect(recommendPreset({ ...account, currentRank: 'Heb Veteran' })).toBe('ratio-first');
  // The identical account one rung lower has nothing to lose, and chases volume instead.
  expect(recommendPreset({ ...account, currentRank: 'Heb Rookie' })).toBe('volume-first');
});

test('the recommendation follows whichever dimension is furthest behind', () => {
  const common = { uploaded: 200 * GB, downloaded: 100 * GB, targetRank: 'Heb Veteran' }; // ratio 2.0, need 2.05
  // volume 100/250 = 0.40, torrents 90/100 = 0.90, ratio 2.0/2.05 = 0.98 -> volume.
  expect(recommendPreset({ ...common, completed: { count: 90, exact: false, basis: 'test' } })).toBe('volume-first');
  // Same account, same ratio, far fewer torrents: 5/100 = 0.05 -> the count becomes binding.
  expect(recommendPreset({ ...common, completed: { count: 5, exact: false, basis: 'test' } })).toBe('count-first');
  // Same volume and count as the first case, but the ratio target moved out of reach:
  // 2.0/2.5 = 0.80 is still above volume's 0.40 for Heb Fanatic... so raise the volume too.
  expect(
    recommendPreset({
      uploaded: 200 * GB,
      downloaded: 100 * GB,
      targetRank: 'Heb Veteran',
      targetRatio: 10,
      completed: { count: 90, exact: false, basis: 'test' },
    }),
  ).toBe('ratio-first');
});

// --- Weights and presets --------------------------------------------------------------------

// A fixture where the three dimensions genuinely disagree, so a preset that picked the same
// torrent as every other preset would be visible as such:
//   ratioPick  - freeleech, no ratio cost at all, and far and away the most demand.
//   volumePick - the only real counted volume on offer, and almost no demand.
//   countPick  - much the smallest, so the cheapest completed torrent, and little demand.
//   bulkFree   - by far the biggest, and freeleech, so not a gram of counted volume. It is
//                here so that "big" and "moves the volume requirement" cannot be confused:
//                the requirement is measured in GB the tracker counts, which this is none of.
const ratioPick = item({ id: 9001, size: 5 * GB, seeders: 1, leechers: 30 });
const volumePick = item({ id: 9002, size: 14 * GB, downloadFactor: 0.5, seeders: 10, leechers: 1 });
const countPick = item({ id: 9003, size: 1.2 * GB, seeders: 10, leechers: 1 });
const bulkFree = item({ id: 9004, size: 30 * GB, seeders: 20, leechers: 0 });
const conflicted = [ratioPick, volumePick, countPick, bulkFree];

// Enough upload that volumePick's 7 counted GB is ratio-safe: the point of this fixture is
// preference, so no candidate may be excluded by a safety rule instead.
const rich = { ...baseStats, uploaded: 50 * GB, downloaded: 0 };
const onePick = (opts: GrabOptions) => pickGrabs(conflicted, ctx({ stats: rich, opts: { maxPerRun: 1, ...opts } })).map((p) => p.item.id);

test('each preset wins a different torrent when the dimensions conflict', () => {
  expect(onePick({ preset: 'ratio-first' })).toEqual([ratioPick.id]);
  expect(onePick({ preset: 'volume-first' })).toEqual([volumePick.id]);
  expect(onePick({ preset: 'count-first' })).toEqual([countPick.id]);
  // All three candidates are individually grabbable, so each result above is a choice between
  // available options and not the last one standing after a filter.
  for (const candidate of conflicted) {
    expect(pickGrabs([candidate], ctx({ stats: rich, opts: { maxPerRun: 1 } })).map((p) => p.item.id)).toEqual([candidate.id]);
  }
});

test('balanced is its own preset, not a relabelling of ratio-first', () => {
  // ratioBest is small, freeleech and in demand, so it leads BOTH ratio and count. blended is
  // a big counted grab with far more leechers but a real ratio cost, so it leads volume and
  // points while placing second on ratio - a counted torrent's demand is divided by what it
  // will cost, which is the whole meaning of that dimension.
  //
  // ratio-first therefore takes ratioBest. balanced weighs four dimensions, wins three of
  // them on blended, and trades the demand away. If balanced ever picked ratioBest here it
  // would be ratio-first under another name.
  const ratioBest = item({ id: 9101, size: 1.5 * GB, seeders: 2, leechers: 60 });
  const blended = item({ id: 9102, size: 14 * GB, downloadFactor: 0.5, seeders: 1, leechers: 200 });
  const filler = item({ id: 9103, size: 4 * GB, seeders: 30, leechers: 1 });
  const set = [ratioBest, blended, filler];
  const pick = (preset: string) => pickGrabs(set, ctx({ stats: rich, opts: { maxPerRun: 1, preset } })).map((p) => p.item.id);
  // Each is individually grabbable, so every pick above is a choice between live options
  // rather than the last one standing after a filter.
  for (const c of set) expect(pickGrabs([c], ctx({ stats: rich, opts: { maxPerRun: 1 } })).map((p) => p.item.id)).toEqual([c.id]);
  expect(pick('ratio-first')).toEqual([ratioBest.id]);
  expect(pick('balanced')).toEqual([blended.id]);
});

test('explicit weights override the preset, and a weighting that expresses nothing falls back', () => {
  const progress = rankProgress({ uploaded: 50 * GB, downloaded: 0, targetRank: 'Heb User' });
  // A pinned preset is used as given.
  expect(resolveWeights({ preset: 'count-first' }, progress)).toEqual({ preset: 'count-first', weights: PRESETS['count-first'] });
  // Per-dimension overrides are merged over it and rename the result, so /status never claims
  // a preset whose weights are not the ones in force.
  expect(resolveWeights({ preset: 'count-first', weights: { ratio: 9 } }, progress)).toEqual({
    preset: 'custom',
    weights: { ratio: 9, volume: 0, count: 0.75, points: 0 },
  });
  // All-zero weights express no preference at all, which would leave the day's grabs in
  // whatever order the tracker happened to list them. Fall back to the preset being modified.
  expect(resolveWeights({ preset: 'volume-first', weights: { ratio: 0, volume: 0, count: 0 } }, progress)).toEqual({
    preset: 'volume-first',
    weights: PRESETS['volume-first'],
  });
  // A preset name this build does not know falls through to the recommendation rather than to
  // an arbitrary preset; config.ts reports the typo as a configIssue.
  expect(resolveWeights({ preset: 'ratio-fist' }, progress).preset).toBe(progress.preset);
  // Nothing pinned at all: the recommendation.
  expect(resolveWeights(undefined, progress).preset).toBe(progress.preset);
});

test('overridden weights actually change the chosen set, not just the reported name', () => {
  // ratio-first's own weights pick the freeleech torrent; the same preset with the weights
  // turned over to volume must pick the counted one.
  expect(onePick({ preset: 'ratio-first' })).toEqual([ratioPick.id]);
  expect(onePick({ preset: 'ratio-first', weights: { ratio: 0, volume: 1, count: 0 } })).toEqual([volumePick.id]);
});

test('with nothing configured the policy farms the recommended preset', () => {
  // 5 GB uploaded, nothing downloaded, no rank known: volume is the dimension at zero, so the
  // recommendation is volume-first - and the chosen torrent must be volume-first's, not the
  // one a fixed default would have taken.
  expect(recommendPreset({ uploaded: 50 * GB, downloaded: 0 })).toBe('volume-first');
  expect(onePick({})).toEqual([volumePick.id]);
  // Once the volume target is met the recommendation moves, and so does the pick. Heb User
  // asks for no torrent count, so with ratio and volume both met nothing is binding at all,
  // and the answer is points-first.
  const done = { ...baseStats, uploaded: 200 * GB, downloaded: 30 * GB };
  expect(recommendPreset({ uploaded: 200 * GB, downloaded: 30 * GB, targetRank: 'Heb User' })).toBe('points-first');
  // ...and points-first takes bulkFree: much the biggest torrent on offer and freeleech, so
  // it earns the most bonus points per hour at no ratio cost at all. That is a different
  // torrent from the one every rank-chasing preset wants, which is the point of the preset
  // existing - ratioPick leads demand, countPick is cheapest to complete, and neither earns
  // points like 30 GB of freeleech does.
  expect(pickGrabs(conflicted, ctx({ stats: done, opts: { maxPerRun: 1, targetRank: 'Heb User' } })).map((p) => p.item.id)).toEqual([
    bulkFree.id,
  ]);
});

// --- Safety is not a preference ---------------------------------------------------------------

test('no preset - not even an absurd one - takes a counted grab that breaches the ratio floor', () => {
  // 12 counted GB against 5 GB uploaded: projected 0.42, under requiredRatioFor(12 GB) + 0.2.
  const unsafe = item({ id: 9201, size: 12 * GB, downloadFactor: 1, uploadFactor: 2, seeders: 1, leechers: 50 });
  expect(requiredRatioFor(12 * GB)).toBe(0.7);
  const weightings: GrabOptions[] = [
    ...PRESET_NAMES.map((preset) => ({ preset })),
    { weights: { ratio: 0, volume: 1000, count: 0, points: 0 } },
    { weights: { ratio: 0, volume: 0, count: 0, points: 1000 } },
    { weights: { ratio: 0, volume: 0, count: 1000 } },
    { weights: { ratio: -50, volume: 1e9, count: 1e9 } },
  ];
  for (const opts of weightings) {
    expect(pickGrabs([unsafe], ctx({ opts }))).toEqual([]);
  }
  // The control: the identical torrent with enough upload behind it IS taken, under every one
  // of those weightings. Without this the loop above would pass against a policy that had
  // simply stopped grabbing anything.
  const solvent = { ...baseStats, uploaded: 200 * GB };
  for (const opts of weightings) {
    expect(pickGrabs([unsafe], ctx({ stats: solvent, opts })).map((p) => p.item.id)).toEqual([unsafe.id]);
  }
});

test('every pick under every preset leaves the projected ratio above the floor', () => {
  const candidates = [
    item({ id: 9301, size: 4 * GB, downloadFactor: 0.5, seeders: 1, leechers: 20 }),
    item({ id: 9302, size: 9 * GB, downloadFactor: 0.5, seeders: 2, leechers: 9 }),
    item({ id: 9303, size: 14 * GB, downloadFactor: 0.5, seeders: 8, leechers: 2 }),
    item({ id: 9304, size: 6 * GB, downloadFactor: 1, uploadFactor: 2, seeders: 3, leechers: 6 }),
    item({ id: 9305, size: 2 * GB, seeders: 4, leechers: 4 }),
  ];
  const uploaded = 9 * GB;
  let everPicked = 0;
  for (const preset of PRESET_NAMES) {
    const stats = { ...baseStats, uploaded, downloaded: 2 * GB };
    const picks = pickGrabs(candidates, ctx({ stats, opts: { preset, maxPerRun: 5, maxPerHour: 5 } }));
    everPicked += picks.length;
    // Replay the run the way pickGrabs did, so the check is against the state at the moment
    // of each decision rather than against the total at the end.
    let downloaded = stats.downloaded;
    for (const { item: it } of picks) {
      const counted = it.size * it.downloadFactor;
      if (counted === 0) continue;
      expect(uploaded / (downloaded + counted)).toBeGreaterThanOrEqual(requiredRatioFor(downloaded + counted) + 0.2);
      downloaded += counted;
    }
  }
  // The property above is vacuously true of a policy that picks nothing. It does not.
  expect(everPicked).toBeGreaterThan(0);
});

test('the target ratio is a goal and never blocks a grab; only the floor does', () => {
  // 6 counted GB against 5 GB uploaded: projected 0.83. Above requiredRatioFor(6 GB) + 0.2 =
  // 0.7, and far below the old hardcoded 1.25 that used to refuse it.
  const affordable = item({ id: 9401, size: 6 * GB, downloadFactor: 1, uploadFactor: 2 });
  expect(pickGrabs([affordable], ctx()).map((p) => p.item.id)).toEqual([affordable.id]);
  // Pinning the goal out of reach must not turn it back into a blocker - that conflation is
  // exactly what was throttling the live account.
  expect(pickGrabs([affordable], ctx({ opts: { targetRatio: 5 } })).map((p) => p.item.id)).toEqual([affordable.id]);
  expect(pickGrabs([affordable], ctx({ opts: { targetRank: 'Heb Prophet' } })).map((p) => p.item.id)).toEqual([affordable.id]);
  // The floor still refuses: one more counted GB puts the projection under 0.7.
  const tooDear = item({ id: 9402, size: 8 * GB, downloadFactor: 1, uploadFactor: 2 });
  expect(pickGrabs([tooDear], ctx())).toEqual([]);
});

test('the current rank’s demotion line blocks a grab the ladder-less policy would take', () => {
  // 4 counted GB against 6 GB uploaded: projected 1.5. requiredRatioFor(4 GB) is 0, so the
  // volume-based floor is 0.2 and this is fine...
  const grab = item({ id: 9501, size: 4 * GB, downloadFactor: 1, uploadFactor: 2 });
  const stats = { ...baseStats, uploaded: 6 * GB, downloaded: 0 };
  expect(pickGrabs([grab], ctx({ stats })).map((p) => p.item.id)).toEqual([grab.id]);
  // ...but an account holding Heb Lover is revoked below 1.45, and 1.5 is inside the margin.
  // A demoted account cannot farm anything, so this is a floor, not a preference.
  expect(pickGrabs([grab], ctx({ stats: { ...stats, userClass: 'Heb Lover' } }))).toEqual([]);
  // A rank with nothing to lose does not get the extra floor.
  expect(pickGrabs([grab], ctx({ stats: { ...stats, userClass: 'Heb Rookie' } })).map((p) => p.item.id)).toEqual([grab.id]);
});

test('the counted-volume target follows the target rank', () => {
  // 30 GB already downloaded: past Heb User's 20 GB (plus headroom), nowhere near Heb Lover's
  // 75. The same torrent, the same account, the same safety - only the target rank differs.
  const counted = item({ id: 9601, size: 4 * GB, downloadFactor: 1, uploadFactor: 2 });
  const stats = { ...baseStats, uploaded: 80 * GB, downloaded: 30 * GB };
  expect(pickGrabs([counted], ctx({ stats, opts: { targetRank: 'Heb User' } }))).toEqual([]);
  expect(pickGrabs([counted], ctx({ stats, opts: { targetRank: 'Heb Lover' } })).map((p) => p.item.id)).toEqual([counted.id]);
  // An explicit countedTargetGB still pins the number, over the rank's.
  expect(pickGrabs([counted], ctx({ stats, opts: { targetRank: 'Heb Lover', countedTargetGB: 25 } }))).toEqual([]);
  // The reason line names the rank being chased, not a rank compiled in years ago.
  expect(pickGrabs([counted], ctx({ stats, opts: { targetRank: 'Heb Lover' } }))[0]?.reason).toContain('toward Heb Lover');
});

// --- The completed-torrent count ----------------------------------------------------------

const qbit = (hash: string, progress: number) => ({ hash, progress });

test('the completed count is a lower bound built from qBittorrent and the local index', () => {
  const entries = {
    '1': { hash: 'AAA' },
    '2': { hash: 'bbb' },
    '3': { hash: 'ccc' },
  };
  const tally = countCompleted(entries, [qbit('aaa', 1), qbit('bbb', 0.4), qbit('ccc', 1)]);
  // Hash case must not decide whether a torrent counts: the store writes what bencode
  // produced and qBittorrent returns its own spelling.
  expect(tally?.count).toBe(2);
  // Never claimed as the tracker's own figure, which no caller can read.
  expect(tally?.exact).toBe(false);
});

test('a released torrent keeps counting, because the tracker never takes it back', () => {
  // The whole reason completedAt exists: without it this count falls every time the cleanup
  // pass frees disk, and the rank dimension it feeds would walk backwards.
  const entries = { '1': { hash: 'aaa', completedAt: '2026-09-01T00:00:00.000Z' }, '2': { hash: 'bbb' } };
  expect(countCompleted(entries, [qbit('bbb', 1)])?.count).toBe(2);
  // 'aaa' is gone from qBittorrent entirely - deleted with its files - and still counts.
  expect(countCompleted(entries, [])?.count).toBe(1);
  expect(countCompleted(entries, [])).toMatchObject({ count: 1 });
});

test('a count with no basis at all is undetermined, not zero', () => {
  // qBittorrent unreadable and nothing ever stamped: there is no observation to report, and
  // a `0` here would steer every decision at the count dimension.
  expect(countCompleted({ '1': { hash: 'aaa' } }, undefined)).toBeUndefined();
  expect(countCompleted({}, undefined)).toBeUndefined();
  // A readable qBittorrent with nothing complete IS an observation, and reports zero.
  expect(countCompleted({ '1': { hash: 'aaa' } }, [qbit('aaa', 0.5)])).toMatchObject({ count: 0 });
  // So is a stamped history with qBittorrent down.
  expect(countCompleted({ '1': { completedAt: '2026-09-01T00:00:00.000Z' } }, undefined)?.count).toBe(1);
});

test('only unstamped, complete, known torrents are put forward for stamping', () => {
  const entries = {
    fresh: { hash: 'aaa' },
    already: { hash: 'bbb', completedAt: '2026-09-01T00:00:00.000Z' },
    partial: { hash: 'ccc' },
    noHash: {},
  };
  const list = [qbit('aaa', 1), qbit('bbb', 1), qbit('ccc', 0.9), qbit('ddd', 1)];
  expect(newlyCompleted(entries, list)).toEqual(['fresh']);
  // 'ddd' is complete in qBittorrent and is not this service's torrent, so it is not counted
  // and not stamped: the index is what decides membership.
  expect(countCompleted(entries, list)?.count).toBe(2);
});

// --- points-first ---------------------------------------------------------------------------
// Bonus points are not a rank requirement; they are the other currency, and they pull against
// the rank dimensions. A preset that picked the same torrent as the rank presets would be a
// relabelling, so these prove it picks differently and for the documented reason.

test('points-first takes the torrent every rank preset passes over', () => {
  // bulkFree is much the biggest and freeleech: the most points per hour, at no ratio cost.
  // Every rank-chasing preset wants something else - demand, counted GB, or a cheap finish.
  expect(onePick({ preset: 'points-first' })).toEqual([bulkFree.id]);
  expect(onePick({ preset: 'ratio-first' })).toEqual([ratioPick.id]);
  expect(onePick({ preset: 'volume-first' })).toEqual([volumePick.id]);
  expect(onePick({ preset: 'count-first' })).toEqual([countPick.id]);
});

test('the points dimension prefers big and rarely seeded, which is what the formula pays for', () => {
  // Same freeleech cost, same demand: only size and seeder count differ, which is exactly
  // what pointsPerHour is a function of. Without a points weight nothing here separates them.
  const bigRare = item({ id: 9401, size: 20 * GB, seeders: 2, leechers: 4 });
  const bigCommon = item({ id: 9402, size: 20 * GB, seeders: 60, leechers: 4 });
  const smallRare = item({ id: 9403, size: 3 * GB, seeders: 2, leechers: 4 });
  const set = [bigCommon, smallRare, bigRare];
  const pick = (opts: GrabOptions) => pickGrabs(set, ctx({ stats: rich, opts: { maxPerRun: 1, ...opts } })).map((p) => p.item.id);

  expect(pick({ preset: 'points-first' })).toEqual([bigRare.id]);

  // The controls isolate the formula's two inputs with a PURE points weighting. Using the
  // points-first preset here would not isolate anything: it still carries ratio 0.25, and
  // demand is itself a function of the seeder count - so a points term that ignored seeders
  // entirely would still pick bigRare, through the ratio dimension, and the assertion would
  // pass while proving nothing.
  const purePoints = { weights: { ratio: 0, volume: 0, count: 0, points: 1 } };
  expect(pick({ ...purePoints })).toEqual([bigRare.id]);
  // Seeders alone, at equal size.
  expect(pickGrabs([bigCommon, bigRare], ctx({ stats: rich, opts: { maxPerRun: 1, ...purePoints } })).map((p) => p.item.id)).toEqual([
    bigRare.id,
  ]);
  // Size alone, at equal rarity.
  expect(pickGrabs([smallRare, bigRare], ctx({ stats: rich, opts: { maxPerRun: 1, ...purePoints } })).map((p) => p.item.id)).toEqual([
    bigRare.id,
  ]);
  // And count-first, which weighs the opposite way, takes the small one - so the set really
  // does discriminate rather than having one obvious winner.
  expect(pick({ preset: 'count-first' })).toEqual([smallRare.id]);
});

test('a points weight can be overridden on its own, like every other dimension', () => {
  const progress = rankProgress({ uploaded: 50 * GB, downloaded: 0, targetRank: 'Heb User' });
  expect(resolveWeights({ preset: 'ratio-first', weights: { points: 5 } }, progress)).toEqual({
    preset: 'custom',
    weights: { ratio: 1, volume: 0, count: 0, points: 5 },
  });
  // A points-only weighting still expresses a preference, so it is not the all-zero fallback.
  expect(resolveWeights({ preset: 'ratio-first', weights: { ratio: 0, points: 1 } }, progress).preset).toBe('custom');
});

// --- hourly pacing ---------------------------------------------------------------------------
// maxPerHour exists so the day's allowance is not spent in the first hour. As the constant 2
// it did that at the bottom of the ladder and became a CAP further up: 2 an hour is 48 a day,
// under Heb Lover's 50 and less than half of Heb Prophet's 100.

test('pacing never costs a download, at any rank on the ladder', () => {
  const KEEP = 3; // GRAB_DEFAULTS.keepForUser
  for (const rank of RANKS) {
    const farmable = Math.max(0, rank.dailyLimit - KEEP);
    const reachable = pacePerHour(farmable) * 24;
    expect(reachable, `${rank.name}: ${reachable} reachable vs ${farmable} allowed`).toBeGreaterThanOrEqual(farmable);
  }
  // The control: the old constant DID cost downloads, so the loop above is not vacuous.
  const topAllowance = Math.max(...RANKS.map((r) => r.dailyLimit));
  expect(2 * 24).toBeLessThan(topAllowance - KEEP);
});

test('pacing still paces: it is well under the whole allowance in one hour', () => {
  for (const rank of RANKS) {
    const farmable = Math.max(0, rank.dailyLimit - KEEP_FOR_USER);
    if (farmable <= 2) continue; // the floor of 2 is the whole allowance at the very bottom
    expect(pacePerHour(farmable)).toBeLessThan(farmable);
  }
});
const KEEP_FOR_USER = 3;

test('the low ranks are paced exactly as they were before', () => {
  // Heb Rookie: 10/day - 3 = 7 farmable. The floor keeps this at 2, unchanged.
  expect(pacePerHour(7)).toBe(2);
  // ...and the top of the ladder is no longer stuck there.
  expect(pacePerHour(97)).toBeGreaterThan(2);
});

test('a high rank keeps grabbing after the old ceiling would have stopped it', () => {
  // Two already taken this hour. Under the old constant maxPerHour of 2 this left 0 slots and
  // returned nothing, whatever the rank allowed.
  const rich = { uploaded: 500 * GB, downloaded: 0, dailyUsed: 2, dailyLimit: 100, userClass: 'Heb Prophet' };
  const picks = pickGrabs(conflicted, ctx({ stats: rich, grabbedLastHour: 2, opts: { maxPerRun: 1 } }));
  expect(picks.length).toBe(1);

  // The control: at Heb Rookie's allowance the same situation still stops, because there the
  // floor of 2 is the pace and two have already gone.
  const poor = { uploaded: 500 * GB, downloaded: 0, dailyUsed: 2, dailyLimit: 10, userClass: 'Heb Rookie' };
  expect(pickGrabs(conflicted, ctx({ stats: poor, grabbedLastHour: 2, opts: { maxPerRun: 1 } }))).toEqual([]);
});

test('an explicit maxPerHour still overrides the pacing', () => {
  const rich = { uploaded: 500 * GB, downloaded: 0, dailyUsed: 0, dailyLimit: 100, userClass: 'Heb Prophet' };
  expect(pickGrabs(conflicted, ctx({ stats: rich, grabbedLastHour: 1, opts: { maxPerRun: 1, maxPerHour: 1 } }))).toEqual([]);
});
