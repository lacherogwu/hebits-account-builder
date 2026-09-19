import { ApiError, LoginExpiredError } from 'hebits-client';
import { expect, test, vi } from 'vitest';
import { countCompleted } from '../src/farm';
import type { EnsureTorrent, JobsConfig, JobsHebits, JobsNotifier, JobsQBit, JobsStore, MakeJobsDeps } from '../src/jobs';
import { makeJobs } from '../src/jobs';
import type { Torrent } from '../src/qbit';
import type { TorrentEntry } from '../src/store';

// Fakes only - nothing here touches the network, a real qBittorrent, or the filesystem.
// JobsStore is narrow specifically so this fake never calls a real Store.putTorrent, which
// would hit the filesystem via save().
function deps(
  over: {
    cfg?: Partial<JobsConfig>;
    store?: Partial<JobsStore>;
    hebits?: Partial<JobsHebits>;
    qbit?: Partial<JobsQBit>;
    notifier?: Partial<JobsNotifier>;
    ensureTorrent?: EnsureTorrent;
    farmLog?: MakeJobsDeps['farmLog'];
    log?: MakeJobsDeps['log'];
  } = {},
): MakeJobsDeps {
  const cfg: JobsConfig = {
    farm: { enabled: true },
    cleanup: { enabled: true },
    watchCategory: 'watch',
    seedCategory: 'seed-auto',
    seedPath: '/tmp/seed',
    lanHost: 'builder.test',
    port: 7001,
    token: 'tok',
    lowDiskAlertGB: 15,
    ...over.cfg,
  };
  const store: JobsStore = {
    data: { torrents: {}, farmLog: [] },
    putTorrent: vi.fn(),
    noteRank: vi.fn(),
    ...over.store,
  };
  const hebits: JobsHebits = {
    stats: vi.fn().mockResolvedValue({ userId: 1, uploaded: 0, downloaded: 0 }),
    dailyDownloads: vi.fn().mockResolvedValue({ used: 0, limit: 10 }),
    browse: vi.fn().mockResolvedValue([]),
    ...over.hebits,
  };
  const qbit: JobsQBit = {
    all: vi.fn().mockResolvedValue([]),
    freeSpace: vi.fn().mockResolvedValue(500 * 1024 ** 3),
    remove: vi.fn().mockResolvedValue(undefined),
    // The Hebits announce URL, so a fixture only has to carry a `hebits:` tag to be
    // adoptable. Tests about the tracker half of the identity check override it.
    trackers: vi.fn().mockResolvedValue([{ url: 'https://tracker.hebits.net/announce' }]),
    ...over.qbit,
  };
  const notifier: JobsNotifier = {
    send: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    prune: vi.fn(),
    ...over.notifier,
  };
  return {
    cfg,
    store,
    hebits,
    qbit,
    notifier,
    ensureTorrent: over.ensureTorrent ?? vi.fn().mockResolvedValue(undefined),
    farmLog: over.farmLog ?? vi.fn(),
    log: over.log ?? vi.fn(),
  };
}

test('an expired login notifies the cookie page and raises no service alert', async () => {
  const notifier: Partial<JobsNotifier> = { send: vi.fn().mockResolvedValue(true), reset: vi.fn() };
  const hebits: Partial<JobsHebits> = { stats: vi.fn().mockRejectedValue(new LoginExpiredError('cookie dead')) };
  const { farmTick, health } = makeJobs(deps({ hebits, notifier }));
  await farmTick();
  expect(health.hebitsLogin).toBe('failing');
  const kinds = (notifier.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
  expect(kinds).toContain('login');
  expect(kinds).not.toContain('service');
});

test('an ApiError raises a service alert', async () => {
  const notifier: Partial<JobsNotifier> = { send: vi.fn().mockResolvedValue(true), reset: vi.fn() };
  const hebits: Partial<JobsHebits> = { stats: vi.fn().mockRejectedValue(new ApiError('unexpected shape')) };
  const { farmTick } = makeJobs(deps({ hebits, notifier }));
  await farmTick();
  const kinds = (notifier.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
  expect(kinds).toContain('service');
});

test('login-ok fires on failing -> ok, but not on unknown -> ok', async () => {
  const send = vi.fn().mockResolvedValue(true);
  const notifier: Partial<JobsNotifier> = { send, reset: vi.fn() };
  const stats = vi.fn().mockResolvedValue({ userId: 1, uploaded: 0, downloaded: 0 });
  const { farmTick } = makeJobs(deps({ hebits: { stats }, notifier }));

  await farmTick(); // unknown -> ok: must stay quiet
  expect(send.mock.calls.map((c) => c[0])).not.toContain('login-ok');

  stats.mockRejectedValueOnce(new LoginExpiredError('cookie dead'));
  await farmTick(); // ok -> failing
  stats.mockResolvedValueOnce({ userId: 1, uploaded: 0, downloaded: 0 });
  await farmTick(); // failing -> ok: must notify
  expect(send.mock.calls.map((c) => c[0])).toContain('login-ok');
});

// ky's shape when the tracker hangs. hebits-client's transport rethrows anything that is not
// an HTTPError unwrapped, so this arrives at the jobs as a plain Error - no HebitsError, and a
// message the deleted regex never matched.
class TimeoutError extends Error {}

test('a tracker timeout - not a HebitsError at all - still raises a service alert', async () => {
  const send = vi.fn().mockResolvedValue(true);
  const hebits: Partial<JobsHebits> = {
    stats: vi.fn().mockRejectedValue(new TimeoutError('Request timed out: GET https://hebits.net/ajax.php?action=index')),
  };
  const { farmTick } = makeJobs(deps({ hebits, notifier: { send } }));
  await farmTick();
  expect(send.mock.calls.map((c) => c[0])).toEqual(['service']);
});

test('a dead cookie never announces "login works again" before the failure it is about to hit', async () => {
  const send = vi.fn().mockResolvedValue(true);
  const notifier: Partial<JobsNotifier> = { send, reset: vi.fn() };
  // The cookie is dead throughout. stats() may still answer - it is the one call that can come
  // from a cache - while dailyDownloads() always reaches the tracker and so always fails.
  const stats = vi
    .fn()
    .mockRejectedValueOnce(new LoginExpiredError('cookie dead'))
    .mockResolvedValue({ userId: 1, uploaded: 0, downloaded: 0 });
  const dailyDownloads = vi.fn().mockRejectedValue(new LoginExpiredError('cookie dead'));
  const { farmTick } = makeJobs(deps({ hebits: { stats, dailyDownloads }, notifier }));

  await farmTick(); // unknown -> failing: the operator is told the login broke
  send.mockClear();
  await farmTick(); // stats answers, dailyDownloads does not
  expect(send.mock.calls.map((c) => c[0])).toEqual(['login']);
});

test('browse is called without a categories filter', async () => {
  const browse = vi.fn().mockResolvedValue([]);
  const { farmTick } = makeJobs(deps({ hebits: { browse } }));
  await farmTick();
  expect(browse.mock.calls[0]?.[0]).not.toHaveProperty('categories');
});

// The low-disk alert is the only thing that says a release pass could not free enough. Its
// threshold comparison ran against qbit.freeSpace(), which returns NaN when qBittorrent's
// maindata carries no free_space_on_disk (see src/qbit.ts) - and `NaN < threshold` is false, so
// the alert stayed silent exactly when the disk state was unknown. The first freeSpace() call
// in cleanupTick is the one pickRemovals uses and already fails closed; these fakes answer it
// normally and make only the post-release reading unreadable, so this test reaches the
// comparison under test rather than stopping at the earlier guard.
const GB = 1024 ** 3;
const diskAlerts = (notifier: Partial<JobsNotifier>): string[] =>
  (notifier.send as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[0] === 'disk').map((c: unknown[]) => String(c[1]));

test('an unreadable free-space reading after a release pass alerts instead of staying silent', async () => {
  const notifier: Partial<JobsNotifier> = { send: vi.fn().mockResolvedValue(true), reset: vi.fn(), prune: vi.fn() };
  const qbit: Partial<JobsQBit> = {
    freeSpace: vi
      .fn()
      .mockResolvedValueOnce(500 * GB)
      .mockResolvedValueOnce(NaN),
  };
  const { cleanupTick } = makeJobs(deps({ qbit, notifier }));
  await cleanupTick();
  expect(diskAlerts(notifier)).toEqual(['Hebits builder: free disk space unknown']);
});

// Control 1: a readable reading below the threshold still raises the ordinary alert, so the
// branch above didn't swallow the real one.
test('control: a readable reading below the threshold still raises the disk-almost-full alert', async () => {
  const notifier: Partial<JobsNotifier> = { send: vi.fn().mockResolvedValue(true), reset: vi.fn(), prune: vi.fn() };
  const qbit: Partial<JobsQBit> = {
    freeSpace: vi
      .fn()
      .mockResolvedValueOnce(500 * GB)
      .mockResolvedValueOnce(5 * GB),
  };
  const { cleanupTick } = makeJobs(deps({ qbit, notifier }));
  await cleanupTick();
  expect(diskAlerts(notifier)).toEqual(['Hebits builder: disk almost full']);
});

// Control 2: a healthy disk raises nothing. Without this, an implementation that alerted on
// every tick would pass both tests above.
test('control: a readable reading above the threshold raises no disk alert at all', async () => {
  const notifier: Partial<JobsNotifier> = { send: vi.fn().mockResolvedValue(true), reset: vi.fn(), prune: vi.fn() };
  const qbit: Partial<JobsQBit> = { freeSpace: vi.fn().mockResolvedValue(500 * GB) };
  const { cleanupTick } = makeJobs(deps({ qbit, notifier }));
  await cleanupTick();
  expect(diskAlerts(notifier)).toEqual([]);
});

// --- Rank progress, the completed-torrent count, and the remembered rank --------------------

test('the farm tick remembers the rank the tracker reported', async () => {
  const noteRank = vi.fn();
  const stats = vi.fn().mockResolvedValue({ userId: 1, uploaded: 30 * GB, downloaded: 10 * GB, userClass: 'Heb Rookie' });
  const { farmTick } = makeJobs(deps({ hebits: { stats }, store: { data: { torrents: {}, farmLog: [] }, putTorrent: vi.fn(), noteRank } }));
  await farmTick();
  // grab.ts's daily() falls back to this when the tracker is unreachable, which is exactly
  // when it cannot ask for the rank itself.
  expect(noteRank).toHaveBeenCalledWith('Heb Rookie');
});

test('a tracker that reports no class leaves the remembered rank alone', async () => {
  const noteRank = vi.fn();
  const stats = vi.fn().mockResolvedValue({ userId: 1, uploaded: 0, downloaded: 0 });
  const { farmTick } = makeJobs(deps({ hebits: { stats }, store: { data: { torrents: {}, farmLog: [] }, putTorrent: vi.fn(), noteRank } }));
  await farmTick();
  expect(noteRank).not.toHaveBeenCalled();
});

test('the farm tick stamps torrents that have reached 100%, and stamps each one once', async () => {
  const putTorrent = vi.fn();
  const torrents = {
    done: { hash: 'aaa' },
    running: { hash: 'bbb' },
    stamped: { hash: 'ccc', completedAt: '2026-09-01T00:00:00.000Z' },
  };
  const all = vi.fn().mockResolvedValue([
    { hash: 'aaa', progress: 1 },
    { hash: 'bbb', progress: 0.5 },
    { hash: 'ccc', progress: 1 },
  ]);
  const { farmTick } = makeJobs(deps({ qbit: { all }, store: { data: { torrents, farmLog: [] }, putTorrent, noteRank: vi.fn() } }));
  await farmTick();
  expect(putTorrent).toHaveBeenCalledTimes(1);
  expect(putTorrent.mock.calls[0]?.[0]).toBe('done');
  expect(putTorrent.mock.calls[0]?.[1]).toMatchObject({ completedAt: expect.any(String) });
});

test('the cleanup pass stamps completions before it releases anything', async () => {
  // Seeding time only counts once a torrent is complete, so the pass that deletes files is
  // the last chance to record that it ever was - the tracker's own count never goes back down.
  const putTorrent = vi.fn();
  const all = vi
    .fn()
    .mockResolvedValue([{ hash: 'aaa', progress: 1, size: GB, state: 'uploading', seeding_time: 0, num_complete: 9, ratio: 1 }]);
  const { cleanupTick } = makeJobs(
    deps({ qbit: { all }, store: { data: { torrents: { '5': { hash: 'aaa' } }, farmLog: [] }, putTorrent, noteRank: vi.fn() } }),
  );
  await cleanupTick();
  expect(putTorrent).toHaveBeenCalledWith('5', expect.objectContaining({ completedAt: expect.any(String) }));
});

test('the farm log says which dimension is holding the account back', async () => {
  const log = vi.fn();
  // The live account's shape: Heb Rookie, ratio just over 1.5, 10.4 GB of the 75 Heb Lover
  // needs, and a dozen torrents seeding.
  const seeded = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), { hash: `hash${i}` }]));
  const stats = vi.fn().mockResolvedValue({ userId: 1, uploaded: 15.7 * GB, downloaded: 10.4 * GB, userClass: 'Heb Rookie' });
  const { farmTick } = makeJobs(
    deps({
      hebits: { stats },
      log,
      cfg: { farm: { enabled: true, targetRank: 'Heb Lover' } },
      store: { data: { torrents: seeded, farmLog: [] }, putTorrent: vi.fn(), noteRank: vi.fn() },
      qbit: { all: vi.fn().mockResolvedValue(Object.values(seeded).map((t) => ({ hash: t.hash, progress: 1 }))) },
    }),
  );
  await farmTick();
  const line = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes('toward Heb Lover'));
  // The question nothing used to answer: ratio is fine, volume is the constraint, and the
  // torrent count is reported as the bound it is rather than as a number.
  expect(line).toContain('ratio 1.51/1.5 ✓');
  expect(line).toContain('volume 10.4/75 GB');
  expect(line).toContain('torrents ≥12/50');
  // 10.4 of 75 GB is 14% of the way there against 24% on the torrent count, so volume is what
  // is actually binding - and the preset in force follows it.
  expect(line).toContain('preset volume-first');
});

test('an unreadable qBittorrent list costs the count, not the grab', async () => {
  const log = vi.fn();
  const all = vi.fn().mockRejectedValue(new Error('connection refused'));
  const ensureTorrent = vi.fn().mockResolvedValue(undefined);
  const browse = vi.fn().mockResolvedValue([
    {
      id: 77,
      groupId: 1,
      name: 'Some.Movie.2026.1080p.WEB-DL',
      groupName: 'Some Movie',
      categoryId: 1,
      tags: [],
      size: 5 * GB,
      fileCount: 1,
      seeders: 1,
      leechers: 9,
      snatches: 0,
      uploadedAt: new Date(),
      downloadFactor: 0,
      uploadFactor: 1,
      canUseToken: true,
      hasSnatched: false,
    },
  ]);
  const { farmTick } = makeJobs(
    deps({
      hebits: { browse },
      qbit: { all },
      ensureTorrent,
      log,
      store: { data: { torrents: {}, farmLog: [] }, putTorrent: vi.fn(), noteRank: vi.fn() },
    }),
  );
  await farmTick();
  // The count steers preference only. A tick that refused to grab because one local HTTP call
  // failed would be strictly worse than a tick that grabs with one dimension unknown.
  expect(ensureTorrent).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.map((c) => String(c[0])).some((m) => m.includes('torrent list could not be read'))).toBe(true);
});

// --- Adoption ------------------------------------------------------------------------------
// state.json is the only record of which torrents this service may release, and it is not
// derivable from anything else - so a machine rebuild that keeps qBittorrent's data and loses
// the config dir leaves a service that can never free a byte, while looking healthy. These
// cover the rule that closes that, and the end-to-end property that is the actual bug.

// A store fake that actually stores, because these tests assert what the store CONTAINS after
// a tick - not that putTorrent was called. It merges the way the real Store.putTorrent does,
// without its save() touching the filesystem.
function liveStore(torrents: Record<string, TorrentEntry> = {}): JobsStore {
  const data = { torrents, farmLog: [] as { action: string; text: string; at: string }[] };
  return {
    data,
    putTorrent(hebitsId, entry) {
      data.torrents[hebitsId] = { ...data.torrents[hebitsId], ...entry };
    },
    noteRank: vi.fn(),
  };
}

// A finished Hebits torrent as qBittorrent reports it: seeded well past minSeedDays, plenty of
// seeders, in the auto-seed category, tagged by whichever service added it.
const seeding = (over: Partial<Torrent> = {}): Torrent =>
  ({
    hash: 'aaa',
    name: 'Some.Pack.2026.1080p.WEB-DL',
    tags: 'hebits:4242, imdb:tt1234567',
    size: 60 * GB,
    progress: 1,
    state: 'uploading',
    category: 'seed-auto',
    seeding_time: 20 * 86400,
    completion_on: Math.floor(Date.UTC(2026, 2, 1) / 1000),
    added_on: Math.floor(Date.UTC(2026, 1, 20) / 1000),
    num_complete: 10,
    num_incomplete: 0,
    ratio: 1.2,
    save_path: '/seed',
    ...over,
  }) as Torrent;

// The rebuilt-machine fixture: an empty store, a qBittorrent full of Hebits torrents, and a
// disk with 5 GB left - under both the 40 GB reserve and the 10 GB emergency line.
const rebuilt = (torrents: Torrent[], over: Parameters<typeof deps>[0] = {}): MakeJobsDeps =>
  deps({
    ...over,
    store: over.store ?? liveStore(),
    // Merged, not replaced: an override that only cares about `trackers` must not quietly
    // take the empty default torrent list with it and turn the test into a no-op.
    qbit: { all: vi.fn().mockResolvedValue(torrents), freeSpace: vi.fn().mockResolvedValue(5 * GB), ...over.qbit },
  });

const threeSeeds = (): Torrent[] => [
  seeding({ hash: 'aaa', tags: 'hebits:1, imdb:tt1234567', num_complete: 40 }),
  seeding({ hash: 'bbb', tags: 'hebits:2', num_complete: 10 }),
  seeding({ hash: 'ccc', tags: 'hebits:3', num_complete: 6 }),
];

test('a rebuilt machine: an empty store plus a populated qBittorrent ends with those torrents releasable', async () => {
  // THE bug. Nothing else here matters if this passes for the wrong reason, so it asserts the
  // whole chain by its post-state: the store learns the torrents, and the release pass - which
  // reads `managed` from that store - actually deletes one.
  const d = rebuilt(threeSeeds());
  const { cleanupTick } = makeJobs(d);
  await cleanupTick();

  expect(Object.keys(d.store.data.torrents).sort()).toEqual(['1', '2', '3']);
  expect(d.store.data.torrents['1']).toMatchObject({ hash: 'aaa', name: 'Some.Pack.2026.1080p.WEB-DL', imdb: 'tt1234567' });
  expect(d.store.data.torrents['1']?.completedAt).toBe('2026-03-01T00:00:00.000Z');
  // 5 GB free, 60 GB torrents, a 50 GB target: exactly one release, and the cheapest per GB
  // (most seeders, so the fewest bonus points to lose) is the one that goes.
  const removed = (d.qbit.remove as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
  expect(removed).toEqual(['aaa']);
});

test('the same disk pressure frees nothing when the torrents carry no hebits tag', async () => {
  // The control that makes the test above mean something: identical fixture, identical
  // pressure, one field different. Without it, "one torrent was released" could equally be a
  // cleanup pass that ignores `managed` altogether and deletes whatever qBittorrent holds -
  // which is the failure that would cost the owner someone else's torrents.
  const d = rebuilt(threeSeeds().map((t) => ({ ...t, tags: 'imdb:tt1234567' })));
  const { cleanupTick } = makeJobs(d);
  await cleanupTick();
  expect(d.store.data.torrents).toEqual({});
  expect(d.qbit.remove).not.toHaveBeenCalled();
});

test('a tagged torrent that does not announce to the tracker is left alone, and says so', async () => {
  const d = rebuilt(threeSeeds(), {
    qbit: { trackers: vi.fn().mockResolvedValue([{ url: 'https://tracker.example.invalid/announce' }]) },
  });
  const { cleanupTick, adoption } = makeJobs(d);
  await cleanupTick();
  expect(d.store.data.torrents).toEqual({});
  expect(d.qbit.remove).not.toHaveBeenCalled();
  expect(adoption.skipped.map((s) => s.reason)).toEqual(Array(3).fill('it does not announce to hebits.net'));
  // The one skip reason that is a misconfiguration: silently, it reproduces the exact bug
  // adoption exists to fix, so it has to reach the owner.
  const kinds = (d.notifier.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
  expect(kinds).toContain('adopt-tracker');
});

test('a torrent tagged with something that is not a torrent id is not adopted', async () => {
  const d = rebuilt([seeding({ tags: 'hebits:latest' })]);
  const { cleanupTick, adoption } = makeJobs(d);
  await cleanupTick();
  expect(d.store.data.torrents).toEqual({});
  expect(d.qbit.remove).not.toHaveBeenCalled();
  expect(adoption.skipped[0]?.reason).toBe('its hebits tag is not a numeric torrent id');
});

test('adoption is idempotent: a second pass adopts nothing and asks the tracker nothing', async () => {
  const d = rebuilt(threeSeeds());
  const { adoptTick, adoption } = makeJobs(d);
  await adoptTick();
  const afterFirst = structuredClone(d.store.data.torrents);
  expect(adoption.adopted).toBe(3);

  await adoptTick();
  expect(d.store.data.torrents).toEqual(afterFirst);
  expect(adoption.adopted).toBe(3);
  expect(adoption.lastAdopted).toEqual([]);
  // A converged machine reports nothing at all. Recognising an already-adopted torrent by the
  // infohash on record is what makes that true; matching it by id alone would leave every one
  // of them on /status forever as "already on record with a different infohash".
  expect(adoption.skipped).toEqual([]);
  // Once converged the pass costs nothing: every torrent's infohash is already on record, so
  // there is no candidate to check a tracker for.
  expect((d.qbit.trackers as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
});

test('adoption never moves a completion stamp backwards', async () => {
  // An entry that knows the torrent finished in January, and a qBittorrent that has been
  // re-checked since and reports March. The rank ladder counts torrents the tracker considers
  // downloaded in full and never lowers that count, so neither may this.
  const d = rebuilt([seeding({ hash: 'aaa', tags: 'hebits:1', completion_on: Math.floor(Date.UTC(2026, 2, 1) / 1000) })]);
  d.store.data.torrents['1'] = { completedAt: '2026-01-05T00:00:00.000Z' };
  const { adoptTick } = makeJobs(d);
  await adoptTick();
  expect(d.store.data.torrents['1']).toMatchObject({ hash: 'aaa', completedAt: '2026-01-05T00:00:00.000Z' });
});

test('adoption does not resurrect a torrent the owner removed from qBittorrent', async () => {
  const released: Record<string, TorrentEntry> = {
    '7': { hash: 'ddd', name: 'Gone.For.Good', removedAt: '2026-05-01T00:00:00.000Z' },
  };
  const d = deps({
    store: liveStore(released),
    qbit: { all: vi.fn().mockResolvedValue([seeding({ hash: 'eee', tags: '' })]), freeSpace: vi.fn().mockResolvedValue(5 * GB) },
  });
  const { adoptTick } = makeJobs(d);
  await adoptTick();
  expect(d.store.data.torrents).toEqual(released);
});

test('adopted torrents count toward the completed-torrent total', async () => {
  // The second half of the rebuild problem: the count that steers the preset restarts near
  // zero on a fresh state.json, which over-prioritises count-first. Asserted through the real
  // tally function rather than by inspecting fields.
  const all = threeSeeds();
  const d = rebuilt(all);
  const { adoptTick } = makeJobs(d);
  await adoptTick();
  expect(countCompleted(d.store.data.torrents, all)?.count).toBe(3);
  // ...and it survives the files being released, which is the whole point of the stamp.
  expect(countCompleted(d.store.data.torrents, [])?.count).toBe(3);
});

test('one unreadable tracker list costs one torrent, not the pass', async () => {
  const trackers = vi
    .fn()
    .mockRejectedValueOnce(new Error('HTTP 500'))
    .mockResolvedValue([{ url: 'https://tracker.hebits.net/announce' }]);
  const d = rebuilt(threeSeeds(), { qbit: { trackers } });
  const { adoptTick, adoption } = makeJobs(d);
  await adoptTick();
  expect(Object.keys(d.store.data.torrents).sort()).toEqual(['2', '3']);
  expect(adoption.skipped[0]?.reason).toContain('HTTP 500');
  expect(adoption.error).toBeNull();
});

test('a qBittorrent that cannot be read degrades the pass instead of throwing out of it', async () => {
  // adoptTick runs inside cleanupTick, ahead of the release decision. If it threw, a
  // qBittorrent hiccup would cost the release pass rather than the adoptions.
  const d = deps({ store: liveStore(), qbit: { all: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } });
  const { adoptTick, adoption } = makeJobs(d);
  await expect(adoptTick()).resolves.toBeUndefined();
  expect(adoption.error).toBe('ECONNREFUSED');
  expect(adoption.checkedAt).toEqual(expect.any(String));
});

test('an adoption is written to the farm log, where /status shows it', async () => {
  const farmLog = vi.fn();
  const d = rebuilt([seeding({ hash: 'aaa', tags: 'hebits:1' })], { farmLog });
  const { adoptTick } = makeJobs(d);
  await adoptTick();
  const entry = farmLog.mock.calls.find((c: unknown[]) => c[0] === 'adopt');
  expect(entry?.[1]).toContain('hebits 1');
});

test('a very large backlog is adopted across passes rather than in one burst', async () => {
  // One tracker call per candidate, so the first pass on a machine holding hundreds of
  // torrents is capped. The cap must only defer work: what it leaves behind is adopted next
  // pass, which is the difference between a bound and a ceiling.
  const many = Array.from({ length: 60 }, (_, i) => seeding({ hash: `hash${i}`, tags: `hebits:${i}` }));
  const d = rebuilt(many);
  const { adoptTick } = makeJobs(d);
  await adoptTick();
  expect(Object.keys(d.store.data.torrents)).toHaveLength(50);
  await adoptTick();
  expect(Object.keys(d.store.data.torrents)).toHaveLength(60);
});
