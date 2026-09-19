import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { readTorrent } from '../src/bencode';
import { type GrabConfig, type GrabHebits, type GrabQBit, makeGrabber, UserError } from '../src/grab';
import { Store } from '../src/store';

// A one-file private torrent, bencoded by hand. Real bencode (not `hash: 'HASH'`): readTorrent
// computes its infohash from these bytes, and the qbit fake below computes the same infohash
// from what it was given `add`ed, so the two agree the way qBittorrent and ensureTorrent's own
// parse would. A fixture whose infohash never matched burned all 40 * 250ms retries waiting
// for the torrent to "appear" and once took this suite from 0.12s to 30.3s.
function torrentBuf(name = 'Some.Movie.2020.1080p-GRP') {
  const info = `d6:lengthi1024e4:name${name.length}:${name}12:piece lengthi16384e6:pieces0:7:privatei1ee`;
  return Buffer.from(`d4:info${info}e`);
}

function harness(cfgOver: Partial<GrabConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grab-'));
  const added: { filename: string; category: string; savePath: string; hash: string }[] = [];
  const tagged: { hash: string; tags: string[] }[] = [];
  // A real qBittorrent only returns a torrent for the hash it actually holds, so the fake
  // checks hash equality rather than "something was added" - a fake that answered any hash
  // truthily after one add() would hide a wrong infohash computation instead of catching it.
  const qbit: GrabQBit = {
    async torrent(hash) {
      return added.some((a) => a.hash === hash) ? { hash, progress: 0 } : undefined;
    },
    async ensureCategory() {},
    async add(buf, filename, opts) {
      added.push({ filename, ...opts, hash: readTorrent(buf).infoHash });
    },
    async addTags(hash, tags) {
      tagged.push({ hash, tags });
    },
    async freeSpace() {
      return 500 * 1024 ** 3;
    },
  };
  const cfg: GrabConfig = {
    torrentDir: dir,
    watchCategory: 'watch',
    watchPath: '/tmp/watch',
    minFreeGB: 20,
    dailyLimit: 10,
    ...cfgOver,
  };
  const store = new Store(dir, 'UTC');
  const hebits: GrabHebits = {
    downloadTorrent: vi.fn(async () => torrentBuf()),
    dailyDownloads: vi.fn(async () => ({ used: 0, limit: 10 })),
  };
  const grabber = makeGrabber({ cfg, store, qbit, hebits, log: () => {} });
  return { grabber, added, tagged, dir, store, hebits, qbit, cfg };
}

// Matches makeGrabber's deps shape for the withLock test below, which doesn't touch qbit/hebits.
function deps() {
  return harness().grabber;
}

test('a new grab is tagged with its Hebits id and IMDb id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1234567', title: 'Some Movie' });
  expect(tagged.length).toBe(1);
  expect(tagged[0]?.tags).toEqual(['hebits:12345', 'imdb:tt1234567']);
});

test('a grab with no IMDb id is still tagged with the Hebits id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('777', { title: 'Unknown' });
  expect(tagged[0]?.tags).toEqual(['hebits:777']);
});

test('the torrent is added to the requested category', async () => {
  const { grabber, added } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1' }, { category: 'seed-auto', savePath: '/tmp/seed' });
  expect(added[0]?.category).toBe('seed-auto');
  expect(added[0]?.savePath).toBe('/tmp/seed');
});

test('the daily limit is refused before a download is spent', async () => {
  const { grabber, hebits } = harness({ dailyLimit: 1 });
  hebits.dailyDownloads = vi.fn(async () => ({ used: 10, limit: 10 }));
  const result = grabber.ensureTorrent('1', {});
  await expect(result).rejects.toThrow(UserError);
  await expect(result).rejects.toThrow(/daily download limit/);
  expect(hebits.downloadTorrent).not.toHaveBeenCalled();
});

test('withLock serialises by key and a rejection does not leak', async () => {
  const { withLock } = deps();
  // The historical bug (storing `run.finally(...)` - a different promise from the one
  // returned - as the map's bookkeeping entry) let that entry's rejection go unobserved,
  // which is exactly what crashed the service in production. Asserting on process-level
  // 'unhandledRejection' events directly - not just on `bad`/`good` settling correctly -
  // is what actually protects against that regression; the serialisation/rejection
  // assertions below can pass even when the bug is present.
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const order: string[] = [];
    const bad = withLock('k', async () => {
      order.push('a');
      throw new Error('boom');
    });
    const good = withLock('k', async () => {
      order.push('b');
      return 'ok';
    });
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
    expect(order).toEqual(['a', 'b']);

    // The `bad`/`good` pair above doesn't actually stress the leak: `good`'s own
    // `prev.catch(() => {})` attaches a handler to whatever's in the map for 'k' - which,
    // under the historical bug, IS the orphaned bookkeeping promise - so it gets observed
    // as a side effect of the second call, buggy or not. The real production case is a key
    // with no follow-up call at all (the last, or only, grab for that hebitsId), so only a
    // lonely rejecting call on a key nobody else touches actually proves the bookkeeping
    // promise doesn't leak.
    const lonely = withLock('solo-key', async () => {
      throw new Error('boom, alone');
    });
    await expect(lonely).rejects.toThrow('boom, alone');

    // Node reports an unhandled rejection asynchronously (after the microtask queue that
    // settled the promises above has drained), not within the same microtask turn as the
    // awaits above - so give the event loop a couple of macrotask turns to let it fire
    // before checking `unhandled`.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  expect(unhandled).toEqual([]);
});

// qbit.freeSpace() returns NaN when qBittorrent's maindata carries no free_space_on_disk (see
// src/qbit.ts), and NaN compares false against every threshold - so the old `free !== undefined`
// guard skipped the disk check exactly when the disk state was unknown, and kept grabbing.
// farm.ts's pickGrabs/pickRemovals already fail closed on the same reading; this makes the
// third one consistent.
test('an unreadable free-space reading refuses the grab instead of downloading blind', async () => {
  const { grabber, hebits, qbit, added } = harness();
  qbit.freeSpace = async () => NaN;

  await expect(grabber.ensureTorrent('7', { size: 5 * 1024 ** 3, title: 'X' })).rejects.toThrow(UserError);
  // The post-state, not just the throw: nothing was fetched from Hebits (so no daily-allowance
  // slot was spent) and nothing was handed to qBittorrent.
  expect(hebits.downloadTorrent).not.toHaveBeenCalled();
  expect(added).toEqual([]);
});

// The control: the same call with a readable reading and room to spare goes through. Without
// it, an implementation that refused every grab would pass the test above.
test('control: a readable free-space reading with room to spare still grabs', async () => {
  const { grabber, hebits, added } = harness();
  await grabber.ensureTorrent('8', { size: 5 * 1024 ** 3, title: 'X' });
  expect(hebits.downloadTorrent).toHaveBeenCalled();
  expect(added).toHaveLength(1);
});

// And the guard the new one must not have displaced: a readable reading that genuinely leaves
// too little room still refuses, with the message that says so.
test('control: a readable reading with too little room still refuses, for the original reason', async () => {
  const { grabber, hebits, qbit } = harness({ minFreeGB: 20 });
  qbit.freeSpace = async () => 21 * 1024 ** 3; // 21 GB free, 20 GB reserve, 5 GB wanted
  await expect(grabber.ensureTorrent('9', { size: 5 * 1024 ** 3, title: 'X' })).rejects.toThrow(/not enough disk space/);
  expect(hebits.downloadTorrent).not.toHaveBeenCalled();
});
