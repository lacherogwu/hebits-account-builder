import { ApiError, LoginExpiredError } from 'hebits-client';
import { expect, test, vi } from 'vitest';
import type { EnsureTorrent, JobsConfig, JobsHebits, JobsNotifier, JobsQBit, JobsStore, MakeJobsDeps } from '../src/jobs';
import { makeJobs } from '../src/jobs';

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
