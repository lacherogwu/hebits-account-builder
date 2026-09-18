import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGrabber } from '../lib/grab.js';
import { Store } from '../lib/store.js';

// A one-file private torrent, bencoded by hand.
function torrentBuf(name = 'Some.Movie.2020.1080p-GRP') {
  const info = `d6:lengthi1024e4:name${name.length}:${name}12:piece lengthi16384e6:pieces0:7:privatei1ee`;
  return Buffer.from(`d4:info${info}e`);
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'grab-'));
  const added = [];
  const tagged = [];
  const qbit = {
    async torrent(hash) { return added.find((a) => a.hash === hash) ? { hash, progress: 0 } : undefined; },
    async ensureCategory() {},
    async add(buf, filename, opts) { added.push({ filename, ...opts, hash: 'HASH' }); },
    async addTags(hash, tags) { tagged.push({ hash, tags }); },
    async freeSpace() { return 500 * 1024 ** 3; },
  };
  const cfg = {
    torrentDir: dir, watchCategory: 'watch', watchPath: '/tmp/watch',
    minFreeGB: 20, dailyLimit: 10, timezone: 'UTC',
  };
  const store = new Store(dir, 'UTC');
  const grabber = makeGrabber({
    cfg, store, qbit,
    jackett: { async downloadTorrent() { return torrentBuf(); } },
    site: { async stats() { return { dailyUsed: 0, dailyLimit: 10 }; } },
    log: () => {},
  });
  return { grabber, added, tagged, dir, store };
}

test('a new grab is tagged with its Hebits id and IMDb id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1234567', title: 'Some Movie' });
  assert.equal(tagged.length, 1);
  assert.deepEqual(tagged[0].tags, ['hebits:12345', 'imdb:tt1234567']);
});

test('a grab with no IMDb id is still tagged with the Hebits id', async () => {
  const { grabber, tagged } = harness();
  await grabber.ensureTorrent('777', { title: 'Unknown' });
  assert.deepEqual(tagged[0].tags, ['hebits:777']);
});

test('the torrent is added to the requested category', async () => {
  const { grabber, added } = harness();
  await grabber.ensureTorrent('12345', { imdb: 'tt1' }, { category: 'seed-auto', savePath: '/tmp/seed' });
  assert.equal(added[0].category, 'seed-auto');
  assert.equal(added[0].savePath, '/tmp/seed');
});

test('the daily limit is refused before a download is spent', async () => {
  const { grabber } = harness();
  grabber.site = undefined;
  await assert.rejects(
    () => makeGrabber({
      cfg: { torrentDir: '/nonexistent', minFreeGB: 20, dailyLimit: 1, timezone: 'UTC' },
      store: new Store(mkdtempSync(join(tmpdir(), 'grab2-')), 'UTC'),
      qbit: { async torrent() {}, async freeSpace() { return 1e12; } },
      jackett: {}, log: () => {},
      site: { async stats() { return { dailyUsed: 10, dailyLimit: 10 }; } },
    }).ensureTorrent('1', {}),
    /daily download limit/,
  );
});
