import { ApiError, LoginExpiredError } from 'hebits-client';
import { expect, test, vi } from 'vitest';
import { makeJobs } from '../src/jobs';
import type { EnsureTorrent, JobsConfig, JobsHebits, JobsNotifier, JobsQBit, JobsStore, MakeJobsDeps } from '../src/jobs';

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

test('browse is called without a categories filter', async () => {
  const browse = vi.fn().mockResolvedValue([]);
  const { farmTick } = makeJobs(deps({ hebits: { browse } }));
  await farmTick();
  expect(browse.mock.calls[0]?.[0]).not.toHaveProperty('categories');
});
