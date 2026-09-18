// Turning a Hebits id into a running torrent: download the .torrent through Jackett,
// add it to qBittorrent, and write the identity down as tags.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readTorrent } from './bencode.js';
import { buildTags } from './tags.js';

const GB = 1024 ** 3;

export class UserError extends Error {}

export function makeGrabber({ cfg, store, jackett, qbit, site, log }) {
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    // Track cleanup on its own swallowed chain: `run` itself must still reject for the
    // caller, but the map's bookkeeping promise must never reject unobserved or a failed
    // grab becomes an unhandledRejection on top of the error the caller already sees.
    const cleanup = run.catch(() => {}).finally(() => locks.get(key) === cleanup && locks.delete(key));
    locks.set(key, cleanup);
    return run;
  }

  // Downloads used/allowed today: Hebits' own counter when reachable, else local count.
  async function daily({ fresh = false } = {}) {
    try {
      const s = await site.stats({ fresh });
      if (s.dailyLimit !== undefined) return { used: s.dailyUsed, limit: s.dailyLimit, stats: s };
    } catch (e) {
      log(`hebits stats: ${e.message}`);
    }
    return { used: store.grabsToday(), limit: store.limitToday(cfg) };
  }

  async function ensureTorrent(hebitsId, meta, { category = cfg.watchCategory, savePath = cfg.watchPath } = {}) {
    return withLock(hebitsId, async () => {
      let entry = store.torrent(hebitsId);
      if (entry?.hash && (await qbit.torrent(entry.hash))) {
        if (meta.imdb && !entry.imdb) {
          store.putTorrent(hebitsId, meta);
          await qbit.addTags(entry.hash, buildTags({ imdb: meta.imdb })).catch((e) => log(`tag ${hebitsId}: ${e.message}`));
        }
        return store.torrent(hebitsId);
      }

      const file = join(cfg.torrentDir, `hebits-${hebitsId}.torrent`);
      let buf;
      if (existsSync(file)) {
        buf = readFileSync(file); // re-adding a torrent we already have doesn't touch Hebits
      } else {
        const d = await daily({ fresh: true });
        if (d.used >= d.limit) throw new UserError('daily download limit reached');
        const free = await qbit.freeSpace();
        if (meta.size && free !== undefined && meta.size > free - cfg.minFreeGB * GB) throw new UserError('not enough disk space');
        buf = await jackett.downloadTorrent(hebitsId);
        let parsed;
        try {
          parsed = readTorrent(buf);
        } catch {
          throw new UserError(`Hebits refused the download: ${buf.toString('utf8', 0, 200).replace(/\s+/g, ' ')}`);
        }
        if (!parsed.private) throw new UserError('torrent is not private; refusing');
        writeFileSync(file, buf, { mode: 0o600 });
        store.recordGrab(hebitsId);
        site.cached = null;
        log(`grabbed hebits ${hebitsId} (${meta.title}) into ${category}`);
      }

      const t = readTorrent(buf);
      await qbit.ensureCategory(category, savePath);
      if (!(await qbit.torrent(t.infoHash))) {
        await qbit.add(buf, `hebits-${hebitsId}.torrent`, { category, savePath });
      }
      store.putTorrent(hebitsId, { ...meta, hash: t.infoHash, name: t.name, files: t.files, pieceLength: t.pieceLength });
      for (let i = 0; i < 40 && !(await qbit.torrent(t.infoHash)); i++) await sleep(250);
      // Identity for anything reading qBittorrent later, including the Stremio addon.
      await qbit.addTags(t.infoHash, buildTags({ hebitsId, imdb: meta.imdb })).catch((e) => log(`tag ${hebitsId}: ${e.message}`));
      return store.torrent(hebitsId);
    });
  }

  return { ensureTorrent, daily, withLock };
}
