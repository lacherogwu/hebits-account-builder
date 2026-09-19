// The two background jobs: grab to build the account, release to keep the disk free.
import { networkInterfaces } from 'node:os';
import { ApiError, LoginExpiredError, RateLimitedError } from 'hebits-client';
import type { BrowseOptions, HebitsTorrent } from 'hebits-client';
import { pickGrabs, pickRemovals, describe, stuckDownloads } from './farm';
import type { GrabOptions, CleanupOptions } from './farm';
import type { Torrent } from './qbit';
import type { TorrentEntry } from './store';
import type { EnsureTorrentOptions } from './grab';
import type { SendOptions } from './notify';

const GB = 1024 ** 3;

// The slice of Config the jobs need. Narrow (rather than importing Config) so a test fake
// needs no `as any` to stand in for it.
export interface JobsConfig {
  farm?: GrabOptions;
  cleanup?: CleanupOptions;
  watchCategory: string;
  seedCategory: string;
  seedPath: string;
  lanHost: string;
  port: number;
  token: string;
  lowDiskAlertGB?: number;
}

// The slice of hebits-client's Hebits the jobs read.
export interface JobsHebits {
  stats(): Promise<{ userId: number; uploaded: number; downloaded: number }>;
  dailyDownloads(userId?: number): Promise<{ used: number; limit: number }>;
  browse(options?: BrowseOptions): Promise<HebitsTorrent[]>;
}

// The slice of QBit the jobs read.
export interface JobsQBit {
  all(): Promise<Torrent[]>;
  freeSpace(): Promise<number>;
  remove(hash: string): Promise<unknown>;
}

// The slice of Notifier the jobs read.
export interface JobsNotifier {
  send(kind: string, title: string, message: string, options?: SendOptions): Promise<boolean>;
  reset(kind: string): void;
  prune(maxAgeMs?: number, now?: number): void;
}

// The slice of Store the jobs read/write. Narrow so a test fake never touches the filesystem
// the way a real Store (whose putTorrent calls save()) would.
export interface JobsStore {
  data: {
    torrents: Record<string, TorrentEntry>;
    farmLog?: { action: string; text: string; at: string }[];
  };
  putTorrent(hebitsId: string, entry: Partial<TorrentEntry>): void;
}

export type EnsureTorrent = (
  hebitsId: string,
  meta: Partial<TorrentEntry>,
  options?: EnsureTorrentOptions,
) => Promise<TorrentEntry | undefined>;

export interface Health {
  hebitsLogin: 'unknown' | 'ok' | 'failing';
  checkedAt: string | null;
  error: string | null;
}

export interface MakeJobsDeps {
  cfg: JobsConfig;
  store: JobsStore;
  hebits: JobsHebits;
  qbit: JobsQBit;
  notifier: JobsNotifier;
  ensureTorrent: EnsureTorrent;
  farmLog: (action: string, text: string) => void;
  log: (message: string) => void;
}

export interface Jobs {
  farmTick: () => Promise<void>;
  cleanupTick: () => Promise<void>;
  health: Health;
}

export function makeJobs({ cfg, store, hebits, qbit, notifier, ensureTorrent, farmLog, log }: MakeJobsDeps): Jobs {
  // Login health: set by every call that talks to Hebits.
  const health: Health = { hebitsLogin: 'unknown', checkedAt: null, error: null };
  function noteLogin(ok: boolean, err?: string): void {
    const was = health.hebitsLogin;
    Object.assign(health, { hebitsLogin: ok ? 'ok' : 'failing', checkedAt: new Date().toISOString(), error: ok ? null : (err ?? null) });
    if (was !== health.hebitsLogin) farmLog(ok ? 'login-ok' : 'login-failing', ok ? 'Hebits login works' : `Hebits login problem: ${err}`);
    if (!ok) {
      notifier.send(
        'login',
        'Hebits login stopped working',
        `Searching and auto-grab are paused. Update the cookie at ${cookiePageUrl()} (${err})`,
      );
    } else if (was === 'failing') {
      notifier.reset('login');
      notifier.send('login-ok', 'Hebits login works again', 'Searching and auto-grab resumed.', { force: true });
    }
  }

  // Alerts about the host's services, at most every 6 hours each.
  function alertProblem(kind: string, title: string, message: string): void {
    notifier.send(kind, title, message);
  }

  function lanAddress(): string {
    for (const list of Object.values(networkInterfaces())) {
      const hit = list?.find((a) => a.family === 'IPv4' && !a.internal);
      if (hit) return hit.address;
    }
    return 'localhost';
  }
  const cookiePageUrl = () => `http://${cfg.lanHost || lanAddress()}:${cfg.port}/${cfg.token}/cookie`;

  // The old alert regex (`/qBittorrent|ECONNREFUSED|fetch failed/i.test(e.message)`) matched
  // Jackett's error strings and matches none of hebits-client's typed errors. Left unchanged,
  // a tracker-side API change would stop all grabbing while the log filled and no alert ever
  // fired. LoginExpiredError, ApiError and RateLimitedError are siblings (all extend
  // HebitsError directly, per hebits-client's errors.d.ts) so no ordering between them can
  // swallow another, but LoginExpiredError is still checked first since it must route to the
  // login path only and never also raise a service alert.
  function handleTickError(e: unknown): void {
    if (e instanceof LoginExpiredError) {
      noteLogin(false, e.message);
      return;
    }
    if (e instanceof ApiError || e instanceof RateLimitedError) {
      alertProblem('service', 'Hebits builder: the tracker API changed or is unhappy', e.message);
      return;
    }
    const message = (e as Error).message;
    if (/qBittorrent|ECONNREFUSED|fetch failed/i.test(message)) {
      alertProblem('service', 'Hebits builder: a service is down', `Auto-grab failed: ${message}`);
    }
  }

  let farmBusy = false;
  async function farmTick(): Promise<void> {
    if (farmBusy || !cfg.farm?.enabled) return;
    farmBusy = true;
    try {
      const stats = await hebits.stats();
      noteLogin(true);
      const daily = await hebits.dailyDownloads(stats.userId);
      // No `categories` here: filtering server-side would change which results come back
      // and so which torrents the policy ever sees. The category filter stays in farm.ts.
      const items = await hebits.browse({ orderBy: 'time', orderWay: 'desc' });
      const freeBytes = await qbit.freeSpace();
      if (!Number.isFinite(freeBytes)) throw new Error('qBittorrent returned a non-numeric free space value');
      const picks = pickGrabs(items, {
        now: Date.now(),
        stats: { uploaded: stats.uploaded, downloaded: stats.downloaded, dailyUsed: daily.used, dailyLimit: daily.limit },
        freeBytes,
        known: new Set(Object.keys(store.data.torrents)),
        grabbedLastHour: (store.data.farmLog || []).filter((e) => e.action === 'grab' && Date.now() - Date.parse(e.at) < 3600e3).length,
        opts: cfg.farm,
      });
      log(
        `farm: ${items.length} latest, ${picks.length} to grab; daily ${daily.used}/${daily.limit}, ` +
          `free ${(freeBytes / GB).toFixed(0)} GB, up ${(stats.uploaded / GB).toFixed(2)} GB, down ${(stats.downloaded / GB).toFixed(2)} GB`,
      );
      for (const { item, reason } of picks) {
        try {
          await ensureTorrent(
            String(item.id),
            { imdb: item.imdb, title: item.name, size: item.size, fileCount: item.fileCount, cover: item.cover, auto: true },
            { category: cfg.seedCategory, savePath: cfg.seedPath },
          );
          farmLog('grab', `${describe(item)} - ${reason}`);
        } catch (e) {
          farmLog('grab-failed', `${item.name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      log(`farm: ${(e as Error).message}`);
      handleTickError(e);
    } finally {
      farmBusy = false;
    }
  }

  let cleanupBusy = false;
  async function cleanupTick(): Promise<void> {
    if (cleanupBusy || !cfg.cleanup?.enabled) return;
    cleanupBusy = true;
    try {
      const managed = new Set(Object.values(store.data.torrents).map((t) => t.hash).filter((h): h is string => Boolean(h)));
      const all = await qbit.all();
      const freeBytes = await qbit.freeSpace();
      if (!Number.isFinite(freeBytes)) throw new Error('qBittorrent returned a non-numeric free space value');
      const removals = pickRemovals(all, {
        now: Date.now(),
        freeBytes,
        managed,
        opts: { ...cfg.cleanup, watchCategory: cfg.watchCategory },
      });
      const errored = all.filter((t) => /^(error|missingFiles)/.test(t.state));
      log(`cleanup: ${all.length} torrents, free ${(freeBytes / GB).toFixed(0)} GB, ${removals.length} to release`);
      for (const t of errored) {
        farmLog('torrent-error', `${t.name} is in state ${t.state}`);
        alertProblem(`torrent-${t.hash}`, 'Hebits builder: torrent error', `${t.name} is in state ${t.state}`);
      }
      for (const t of stuckDownloads(all, { now: Date.now(), managed })) {
        const pct = (t.progress * 100).toFixed(0);
        log(`stuck: ${t.name} is still at ${pct}% after a day (${t.state})`);
        alertProblem(
          `stuck-${t.hash}`,
          'Hebits builder: download stuck',
          `${t.name} is at ${pct}%. Seeding time only counts after 100%, so leave it running; if it has no seeders, ask for a reseed on Hebits.`,
        );
      }
      for (const t of removals) {
        await qbit.remove(t.hash);
        // t.hash matched an entry to build `managed` above, but noUncheckedIndexedAccess
        // still types this lookup as TorrentEntry | undefined, so narrow for real.
        const id = Object.keys(store.data.torrents).find((k) => {
          const entry = store.data.torrents[k];
          return entry !== undefined && entry.hash === t.hash;
        });
        if (id) store.putTorrent(id, { removedAt: new Date().toISOString() });
        // The delete already happened above; this is only a log line, so it must not throw
        // on a torrent with a missing/non-numeric ratio field.
        const ratio = Number.isFinite(t.ratio) ? t.ratio.toFixed(2) : 'n/a';
        farmLog(
          'release',
          `${t.name} (${(t.size / GB).toFixed(1)} GB, ${t.num_complete} seeders, ratio ${ratio}, seeded ${(t.seeding_time / 86400).toFixed(1)} days)`,
        );
      }
      const freeAfter = await qbit.freeSpace();
      if (freeAfter < (cfg.lowDiskAlertGB ?? 15) * GB) {
        alertProblem('disk', 'Hebits builder: disk almost full', `${(freeAfter / GB).toFixed(1)} GB free and nothing safe left to release.`);
      }
      notifier.prune();
    } catch (e) {
      log(`cleanup: ${(e as Error).message}`);
      alertProblem('service', 'Hebits builder: a service is down', `Cleanup failed: ${(e as Error).message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  return { farmTick, cleanupTick, health };
}
