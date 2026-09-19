// Turning a Hebits id into a running torrent: download the .torrent through hebits-client,
// add it to qBittorrent, and write the identity down as tags.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readTorrent, type Torrent } from './bencode';
import { dailyLimitFor, FALLBACK_DAILY_LIMIT } from './farm';
import type { Store, TorrentEntry } from './store';
import { buildTags } from './tags';

const GB = 1024 ** 3;

export class UserError extends Error {}

// The slice of Config that ensureTorrent/daily need.
export interface GrabConfig {
  dailyLimit: number;
  dailyLimitByDay?: Record<string, number>;
  minFreeGB: number;
  torrentDir: string;
  watchCategory: string;
  watchPath: string;
}

// The slice of hebits-client's Hebits that ensureTorrent/daily read. Kept narrow (rather
// than importing the class) so a test fake needs no `as any` to stand in for it.
export interface GrabHebits {
  downloadTorrent(id: number): Promise<Uint8Array>;
  dailyDownloads(): Promise<{ used: number; limit: number }>;
}

// The slice of QBit that ensureTorrent reads. The resolved value of `torrent()` is only
// ever used for its truthiness here, so it stays `unknown`.
export interface GrabQBit {
  torrent(hash: string): Promise<unknown>;
  ensureCategory(name: string, savePath: string): Promise<void>;
  add(buf: Buffer, filename: string, opts: { category: string; savePath: string }): Promise<unknown>;
  addTags(hash: string, tags: string[]): Promise<unknown>;
  freeSpace(): Promise<number>;
}

export interface GrabDeps {
  cfg: GrabConfig;
  store: Store;
  hebits: GrabHebits;
  qbit: GrabQBit;
  log: (message: string) => void;
}

export interface EnsureTorrentOptions {
  category?: string;
  savePath?: string;
}

export function makeGrabber({ cfg, store, hebits, qbit, log }: GrabDeps) {
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
  async function daily(): Promise<{ used: number; limit: number }> {
    try {
      // dailyDownloads() always reads through to the tracker - hebits-client marks it
      // freshness-critical precisely so a cached count cannot overspend the allowance. The
      // old `{ fresh: true }` argument is therefore gone, not forgotten.
      return await hebits.dailyDownloads();
    } catch (e) {
      log(`hebits daily downloads: ${(e as Error).message}`);
      // The tracker is unreachable, so its own counter and its own rank reading are both
      // gone. The last rank it reported is what is left; the ladder gives that rank's
      // allowance, and an account whose rank was never seen falls back to the bottom of the
      // ladder rather than to a number picked once and left behind by every promotion.
      return { used: store.grabsToday(), limit: store.limitToday(cfg, dailyLimitFor(store.data.lastRank) ?? FALLBACK_DAILY_LIMIT) };
    }
  }

  async function ensureTorrent(
    hebitsId: string,
    meta: Partial<TorrentEntry>,
    { category = cfg.watchCategory, savePath = cfg.watchPath }: EnsureTorrentOptions = {},
  ) {
    return withLock(hebitsId, async () => {
      const entry = store.torrent(hebitsId);
      if (entry?.hash && (await qbit.torrent(entry.hash))) {
        if (meta.imdb && !entry.imdb) {
          store.putTorrent(hebitsId, meta);
          await qbit.addTags(entry.hash, buildTags({ imdb: meta.imdb })).catch((e: Error) => log(`tag ${hebitsId}: ${e.message}`));
        }
        return store.torrent(hebitsId);
      }

      const file = join(cfg.torrentDir, `hebits-${hebitsId}.torrent`);
      let buf: Buffer | Uint8Array;
      if (existsSync(file)) {
        buf = readFileSync(file); // re-adding a torrent we already have doesn't touch Hebits
      } else {
        const d = await daily();
        if (d.used >= d.limit) throw new UserError('daily download limit reached');
        const free = await qbit.freeSpace();
        // Fail closed, the same way farm.ts's pickGrabs/pickRemovals do. qbit.freeSpace()
        // returns NaN when qBittorrent's maindata has no free_space_on_disk, and the old
        // `free !== undefined` guard let that straight through: every comparison against NaN
        // is false, so the one check standing between a grab and a full disk was skipped
        // exactly when the disk state was unknown. Refusing costs one grab; the daily
        // allowance is small and the next tick retries.
        if (!Number.isFinite(free)) throw new UserError('qBittorrent did not report free disk space');
        if (meta.size && meta.size > free - cfg.minFreeGB * GB) throw new UserError('not enough disk space');
        buf = await hebits.downloadTorrent(Number(hebitsId));
        let parsed: Torrent;
        try {
          parsed = readTorrent(buf);
        } catch {
          throw new UserError(`Hebits refused the download: ${Buffer.from(buf).toString('utf8', 0, 200).replace(/\s+/g, ' ')}`);
        }
        if (!parsed.private) throw new UserError('torrent is not private; refusing');
        writeFileSync(file, buf, { mode: 0o600 });
        store.recordGrab(hebitsId);
        log(`grabbed hebits ${hebitsId} (${meta.title}) into ${category}`);
      }

      const t = readTorrent(buf);
      await qbit.ensureCategory(category, savePath);
      if (!(await qbit.torrent(t.infoHash))) {
        await qbit.add(Buffer.from(buf), `hebits-${hebitsId}.torrent`, { category, savePath });
      }
      store.putTorrent(hebitsId, { ...meta, hash: t.infoHash, name: t.name, files: t.files, pieceLength: t.pieceLength });
      for (let i = 0; i < 40 && !(await qbit.torrent(t.infoHash)); i++) await sleep(250);
      // Identity for anything reading qBittorrent later, including the Stremio addon.
      await qbit.addTags(t.infoHash, buildTags({ hebitsId, imdb: meta.imdb })).catch((e: Error) => log(`tag ${hebitsId}: ${e.message}`));
      return store.torrent(hebitsId);
    });
  }

  return { ensureTorrent, daily, withLock };
}
