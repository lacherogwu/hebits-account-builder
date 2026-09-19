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
