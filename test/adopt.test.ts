// Adoption's policy half (src/farm.ts): which torrents already in qBittorrent the builder is
// allowed to take into its own index, and what an adopted entry says. The tick that performs
// it - and the end-to-end property that adoption is what makes a rebuilt machine able to free
// disk again - live in test/jobs.test.ts, where the job harness is.
import { expect, test } from 'vitest';
import {
  type AdoptableEntry,
  type AdoptableTorrent,
  adoptedEntry,
  adoptionCandidates,
  HEBITS_TRACKER_HOST,
  isHebitsTracker,
} from '../src/farm';

const GB = 1024 ** 3;
const NOW = new Date(Date.UTC(2026, 8, 18, 12));
// Long before NOW, and long before a machine rebuild would have run adoption: the whole point
// of reading qBittorrent's own completion time rather than stamping "now".
const COMPLETED_ON = Math.floor(Date.UTC(2026, 2, 1, 9, 30) / 1000);

const qt = (over: Partial<AdoptableTorrent> = {}): AdoptableTorrent => ({
  hash: 'aaaa1111',
  name: 'Some.Movie.2026.1080p.WEB-DL.x264-GRP',
  tags: 'hebits:4242, imdb:tt1234567',
  size: 12 * GB,
  progress: 1,
  completion_on: COMPLETED_ON,
  ...over,
});

test('the tracker host must match exactly, or be a subdomain of the tracker', () => {
  expect(isHebitsTracker(['https://tracker.hebits.net/announce?passkey=x'])).toBe(true);
  expect(isHebitsTracker(['https://hebits.net/announce'])).toBe(true);
  // A suffix match on the bare host would accept both of these, and each is a domain anyone
  // can register. Adoption is what hands the cleanup pass permission to delete files, so the
  // check has to be on the host boundary, not on the string ending.
  expect(isHebitsTracker(['https://evil-hebits.net/announce'])).toBe(false);
  expect(isHebitsTracker(['https://hebits.net.example.com/announce'])).toBe(false);
  expect(isHebitsTracker(['https://other-tracker.example/announce'])).toBe(false);
});

test('qBittorrent’s pseudo-trackers are not evidence of anything', () => {
  // These three are in every torrents/trackers response. They are not URLs; if a parse failure
  // counted as a match, every torrent in qBittorrent would look like a Hebits torrent.
  expect(isHebitsTracker(['** [DHT] **', '** [PeX] **', '** [LSD] **'])).toBe(false);
  expect(isHebitsTracker([])).toBe(false);
  // ...and they must not stop a real announce URL alongside them from matching.
  expect(isHebitsTracker(['** [DHT] **', 'https://tracker.hebits.net/announce'])).toBe(true);
});

test('a configured tracker host is honoured, and a blank one falls back to the default', () => {
  expect(isHebitsTracker(['https://announce.example.test/x'], 'example.test')).toBe(true);
  expect(isHebitsTracker(['https://tracker.hebits.net/announce'], 'example.test')).toBe(false);
  // A blank `trackerHost` in config.json must not mean "adopt nothing, silently" - the one
  // failure shape adoption exists to remove.
  expect(isHebitsTracker(['https://tracker.hebits.net/announce'], '  ')).toBe(true);
  expect(HEBITS_TRACKER_HOST).toBe('hebits.net');
});

test('only torrents carrying a hebits id are candidates, and untagged ones are not reported', () => {
  const mine = qt({ hash: 'aaa', tags: 'hebits:1' });
  const theirs = qt({ hash: 'bbb', tags: '' });
  const alsoTheirs = qt({ hash: 'ccc', tags: 'imdb:tt7654321' });
  const survey = adoptionCandidates([mine, theirs, alsoTheirs], {});
  expect(survey.candidates.map((c) => c.hebitsId)).toEqual(['1']);
  expect(survey.candidates[0]?.torrent.hash).toBe('aaa');
  // The owner's own torrents in the same qBittorrent are the normal case. Reporting them would
  // put a permanent complaint on /status about nothing.
  expect(survey.skipped).toEqual([]);
  expect(survey.known).toBe(0);
});

test('a hebits tag that is not a torrent id is reported, not adopted', () => {
  const survey = adoptionCandidates([qt({ hash: 'aaa', tags: 'hebits:not-an-id' })], {});
  expect(survey.candidates).toEqual([]);
  expect(survey.skipped).toEqual([{ hebitsId: 'not-an-id', hash: 'aaa', reason: 'its hebits tag is not a numeric torrent id' }]);
});

test('a torrent the store already records is known, not a candidate - in either hash case', () => {
  const entries: Record<string, AdoptableEntry> = { '4242': { hash: 'AAAA1111' } };
  const survey = adoptionCandidates([qt({ hash: 'aaaa1111' })], entries);
  expect(survey.candidates).toEqual([]);
  expect(survey.skipped).toEqual([]);
  expect(survey.known).toBe(1);
});

test('an entry that has no hash yet is filled in rather than left behind', () => {
  // What a grab that died between recording the metadata and adding the torrent leaves: an
  // entry with a title and no infohash, which `managed` cannot use.
  const entries: Record<string, AdoptableEntry> = { '4242': {} };
  const survey = adoptionCandidates([qt()], entries);
  expect(survey.candidates.map((c) => c.hebitsId)).toEqual(['4242']);
});

test('a hebits id already spoken for by a different infohash is reported, not overwritten', () => {
  const entries: Record<string, AdoptableEntry> = { '4242': { hash: '9999deadbeef' } };
  const survey = adoptionCandidates([qt({ hash: 'aaaa1111' })], entries);
  expect(survey.candidates).toEqual([]);
  expect(survey.known).toBe(0);
  expect(survey.skipped).toHaveLength(1);
  expect(survey.skipped[0]?.reason).toContain('already on record with a different infohash');
});

test('an entry the cleanup pass released is not resurrected by a torrent that is gone', () => {
  // The store keeps released torrents as history (`removedAt`). Adoption only ever walks the
  // list qBittorrent returns, so an entry whose files are gone is not in that list and cannot
  // be revived - asserted here because it is a property of the design, not of one branch.
  const entries: Record<string, AdoptableEntry> = { '4242': { hash: 'aaaa1111' } };
  const survey = adoptionCandidates([], entries);
  expect(survey.candidates).toEqual([]);
  expect(survey.known).toBe(0);
});

test('an adopted entry carries what qBittorrent can evidence and nothing else', () => {
  const entry = adoptedEntry(qt(), NOW);
  expect(entry).toEqual({
    hash: 'aaaa1111',
    name: 'Some.Movie.2026.1080p.WEB-DL.x264-GRP',
    size: 12 * GB,
    imdb: 'tt1234567',
    completedAt: new Date(COMPLETED_ON * 1000).toISOString(),
  });
  // Explicitly absent, not empty: these came from the tracker listing or the .torrent file and
  // are not recoverable from qBittorrent. A later real grab's putTorrent merges them in.
  expect('title' in entry).toBe(false);
  expect('auto' in entry).toBe(false);
  expect('fileCount' in entry).toBe(false);
});

test('a torrent with no imdb tag gets no imdb field', () => {
  const entry = adoptedEntry(qt({ tags: 'hebits:4242' }), NOW);
  expect(entry.imdb).toBeUndefined();
  expect('imdb' in entry).toBe(false);
});

test('completedAt is qBittorrent’s completion time, not the moment adoption ran', () => {
  // The count this feeds is a lifetime figure the tracker never lowers. Stamping `now` would
  // still count the torrent, so a test that only checked for "a string" would pass against it -
  // but it would also claim every torrent on a rebuilt machine completed the day of the
  // rebuild, which is the wrong answer to "when".
  expect(adoptedEntry(qt(), NOW).completedAt).toBe('2026-03-01T09:30:00.000Z');
});

test('a torrent still downloading gets no completion stamp', () => {
  expect(adoptedEntry(qt({ progress: 0.4, completion_on: 0 }), NOW).completedAt).toBeUndefined();
});

test('a missing or impossible completion time falls back to now, never to a sentinel date', () => {
  // qBittorrent reports 0 (and, on some builds, a 32-bit sentinel far in the future) for a
  // completion it does not know. Either would be a lie about when the torrent finished; `now`
  // is at least an honest upper bound, and it keeps the torrent counted.
  expect(adoptedEntry(qt({ completion_on: 0 }), NOW).completedAt).toBe(NOW.toISOString());
  expect(adoptedEntry(qt({ completion_on: undefined }), NOW).completedAt).toBe(NOW.toISOString());
  expect(adoptedEntry(qt({ completion_on: 4294967295 }), NOW).completedAt).toBe(NOW.toISOString());
});

test('an existing completion stamp is kept, so the count can never move backwards', () => {
  const kept = adoptedEntry(qt({ completion_on: Math.floor(NOW.getTime() / 1000) }), NOW, {
    completedAt: '2025-01-05T00:00:00.000Z',
  });
  expect(kept.completedAt).toBe('2025-01-05T00:00:00.000Z');
});
