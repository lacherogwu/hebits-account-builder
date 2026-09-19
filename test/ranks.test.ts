import { expect, test } from 'vitest';
import { dailyLimitFor, demotionRatioFor, FALLBACK_DAILY_LIMIT, nextRankAfter, RANKS, rankByName } from '../src/farm';

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

test('the ladder knows what comes next, and that nothing comes after the top', () => {
  expect(nextRankAfter('Heb Rookie')?.name).toBe('Heb User');
  expect(nextRankAfter('Heb Fanatic')?.name).toBe('Heb Elite');
  expect(nextRankAfter('Heb Prophet')).toBeUndefined();
  expect(nextRankAfter('Donor')).toBeUndefined();
});
