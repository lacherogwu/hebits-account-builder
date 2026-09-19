// The two background jobs: grab to build the account, release to keep the disk free.
import { networkInterfaces } from 'node:os';
import type { BrowseOptions, HebitsTorrent } from 'hebits-client';
import { ApiError, HebitsError, LoginExpiredError, RateLimitedError } from 'hebits-client';
import type { AdoptionSkip, CleanupOptions, GrabOptions } from './farm';
import {
  adoptedEntry,
  adoptionCandidates,
  countCompleted,
  describe,
  HEBITS_TRACKER_HOST,
  isHebitsTracker,
  newlyCompleted,
  pickGrabs,
  pickRemovals,
  rankProgress,
  resolveWeights,
  stuckDownloads,
} from './farm';
import type { EnsureTorrentOptions } from './grab';
import type { SendOptions } from './notify';
import type { Torrent } from './qbit';
import type { TorrentEntry } from './store';

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
  // The tracker host an adoptable torrent must announce to. See adoptTick.
  trackerHost?: string;
}

// The slice of hebits-client's Hebits the jobs read.
export interface JobsHebits {
  stats(): Promise<{ userId: number; uploaded: number; downloaded: number; userClass?: string }>;
  dailyDownloads(userId?: number): Promise<{ used: number; limit: number }>;
  browse(options?: BrowseOptions): Promise<HebitsTorrent[]>;
}

// The slice of QBit the jobs read.
export interface JobsQBit {
  all(): Promise<Torrent[]>;
  freeSpace(): Promise<number>;
  remove(hash: string): Promise<unknown>;
  trackers(hash: string): Promise<{ url: string }[]>;
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
    lastRank?: string;
  };
  putTorrent(hebitsId: string, entry: Partial<TorrentEntry>): void;
  noteRank(rank: string): void;
}

export type EnsureTorrent = (
  hebitsId: string,
  meta: Partial<TorrentEntry>,
  options?: EnsureTorrentOptions,
) => Promise<TorrentEntry | undefined>;

// What the last adoption pass did, for /status. Adoption changes which torrents the cleanup
// job is allowed to delete, so it is not something that should only ever happen in a log
// line nobody was tailing - it sits beside configIssues and storeIssue.
export interface Adoption {
  checkedAt: string | null;
  /** Adopted since this process started. */
  adopted: number;
  /** What the last pass adopted, and what the last pass declined to adopt and why. Both are
   *  the state as of `checkedAt`, not a running log - the farm log keeps the history. */
  lastAdopted: { hebitsId: string; name: string }[];
  skipped: AdoptionSkip[];
  /** Why the last pass could not run at all (qBittorrent unreachable, typically). */
  error: string | null;
}

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
  // `torrents` lets cleanupTick reuse the list it has already fetched; called with nothing
  // (from its own timer) it fetches its own.
  adoptTick: (torrents?: Torrent[]) => Promise<void>;
  health: Health;
  adoption: Adoption;
  // Exposed so the cookie page can report a successful save immediately, instead of the
  // status only catching up on the next scheduled farmTick (up to cfg.farm.intervalMin
  // later). The `was === 'failing'` guard inside stays untouched either way.
  noteLogin: (ok: boolean, err?: string) => void;
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

  // Total by construction: every path ends in a notification, so nothing fails quietly. A
  // hung tracker surfaces as ky's TimeoutError, which the transport rethrows unwrapped and no
  // message-matching would catch.
  //
  // LoginExpiredError is checked first because it must route to the login path only and never
  // also raise a service alert. The HebitsError branch catches the rest, including whatever
  // the package adds later.
  function handleTickError(e: unknown): void {
    if (e instanceof LoginExpiredError) {
      noteLogin(false, e.message);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError || e instanceof RateLimitedError) {
      alertProblem('service', 'Hebits builder: the tracker API changed or is unhappy', message);
      return;
    }
    if (e instanceof HebitsError) {
      alertProblem('service', 'Hebits builder: the tracker is unhappy', message);
      return;
    }
    alertProblem('service', 'Hebits builder: a service is down', `Auto-grab failed: ${message}`);
  }

  let farmBusy = false;
  async function farmTick(): Promise<void> {
    if (farmBusy || !cfg.farm?.enabled) return;
    farmBusy = true;
    try {
      const stats = await hebits.stats();
      const daily = await hebits.dailyDownloads(stats.userId);
      // Only after a call has actually reached the tracker. dailyDownloads() bypasses the
      // response cache unconditionally, stats() need not, so declaring the login healthy on
      // stats() alone could announce "login works again" off a cached read moments before
      // dailyDownloads() throws LoginExpiredError on the very same dead cookie.
      noteLogin(true);
      // No `categories` here: filtering server-side would change which results come back
      // and so which torrents the policy ever sees. The category filter stays in farm.ts.
      // Remembered for the daily-allowance fallback in grab.ts, which only runs when the
      // tracker is unreachable and so cannot ask for the rank itself.
      if (stats.userClass) store.noteRank(stats.userClass);
      const items = await hebits.browse({ orderBy: 'time', orderWay: 'desc' });
      const freeBytes = await qbit.freeSpace();
      if (!Number.isFinite(freeBytes)) throw new Error('qBittorrent returned a non-numeric free space value');
      // The completed-torrent count. Not fatal if it fails: it steers PREFERENCE only, and a
      // tick that refuses to grab anything because one local HTTP call failed is worse than a
      // tick that grabs under the recommendation minus one dimension.
      const all = await qbit.all().catch((e: Error) => {
        log(`farm: qBittorrent's torrent list could not be read (${e.message}) - the completed-torrent count is from the local index only`);
        return undefined;
      });
      // Stamp what is complete now, so the count survives the cleanup pass releasing it.
      if (all) {
        const at = new Date().toISOString();
        for (const id of newlyCompleted(store.data.torrents, all)) store.putTorrent(id, { completedAt: at });
      }
      const completed = countCompleted(store.data.torrents, all);
      const progress = rankProgress({
        uploaded: stats.uploaded,
        downloaded: stats.downloaded,
        currentRank: stats.userClass,
        targetRank: cfg.farm?.targetRank,
        targetRatio: cfg.farm?.targetRatio,
        completed,
      });
      const picks = pickGrabs(items, {
        now: Date.now(),
        stats: {
          uploaded: stats.uploaded,
          downloaded: stats.downloaded,
          dailyUsed: daily.used,
          dailyLimit: daily.limit,
          userClass: stats.userClass,
        },
        freeBytes,
        known: new Set(Object.keys(store.data.torrents)),
        grabbedLastHour: (store.data.farmLog || []).filter((e) => e.action === 'grab' && Date.now() - Date.parse(e.at) < 3600e3).length,
        completed,
        opts: cfg.farm,
      });
      log(
        `farm: ${items.length} latest, ${picks.length} to grab; daily ${daily.used}/${daily.limit}, ` +
          `free ${(freeBytes / GB).toFixed(0)} GB, up ${(stats.uploaded / GB).toFixed(2)} GB, down ${(stats.downloaded / GB).toFixed(2)} GB`,
      );
      // The line that answers "why am I not ranking up?". Without it, an account can sit at
      // target ratio and target volume and stall on the torrent count with nothing saying so.
      log(`farm: toward ${progress.targetRank} - ${progress.summary}; preset ${resolveWeights(cfg.farm, progress).preset}`);
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

  // --- Adoption -------------------------------------------------------------------------
  // Puts torrents qBittorrent is already holding back into the store, so the cleanup pass can
  // see them. See the block comment above adoptionCandidates() in farm.ts for why this has to
  // exist at all and why it is strict.
  //
  // WHERE IT RUNS, and why not at startup. The obvious place is once at boot, and that is the
  // one place it must not be: this service runs under launchd with KeepAlive, so anything that
  // throws before the Notifier exists is a silent ten-second restart loop - the exact failure
  // the config and store hardening exists to prevent - and the single thing adoption depends
  // on is a local qBittorrent, which is down for minutes at a time on a machine that has just
  // rebooted. A one-shot at boot would then either take the process with it or, guarded, run
  // exactly once at the only moment it was guaranteed to fail and never again. So it is a tick:
  // it converges instead of getting one chance, and a qBittorrent that comes back an hour later
  // is adopted an hour later with nobody involved. cleanupTick calls it with the torrent list
  // it has already fetched, which makes the ordering explicit - nothing is released in a pass
  // whose store this pass could have corrected - and its own timer covers `cleanup.enabled`
  // being off, where the completed-torrent count still depends on it.
  //
  // Bounded on purpose: one trackers() call per candidate, and candidates are by definition
  // torrents that are not in the store yet, so a converged machine makes zero calls per pass.
  const MAX_PER_PASS = 50;
  const adoption: Adoption = { checkedAt: null, adopted: 0, lastAdopted: [], skipped: [], error: null };
  let adoptBusy = false;
  async function adoptTick(torrents?: Torrent[]): Promise<void> {
    if (adoptBusy) return;
    adoptBusy = true;
    try {
      const all = torrents ?? (await qbit.all());
      const survey = adoptionCandidates(all, store.data.torrents);
      const host = cfg.trackerHost?.trim() || HEBITS_TRACKER_HOST;
      const skipped: AdoptionSkip[] = [...survey.skipped];
      const lastAdopted: { hebitsId: string; name: string }[] = [];
      let wrongTracker = 0;
      for (const { hebitsId, torrent } of survey.candidates.slice(0, MAX_PER_PASS)) {
        let urls: string[];
        try {
          urls = (await qbit.trackers(torrent.hash)).map((t) => t.url);
        } catch (e) {
          // Identity unproven, so no adoption - but not a divergence either, so it is reported
          // and retried next pass rather than alerted on.
          skipped.push({ hebitsId, hash: torrent.hash, reason: `its tracker list could not be read (${(e as Error).message})` });
          continue;
        }
        if (!isHebitsTracker(urls, host)) {
          wrongTracker++;
          skipped.push({ hebitsId, hash: torrent.hash, reason: `it does not announce to ${host}` });
          continue;
        }
        store.putTorrent(hebitsId, adoptedEntry(torrent, new Date(), store.data.torrents[hebitsId]));
        lastAdopted.push({ hebitsId, name: torrent.name });
        farmLog(
          'adopt',
          `${torrent.name} (hebits ${hebitsId}) was already in qBittorrent - now managed, so it can be released when the disk fills`,
        );
      }
      Object.assign(adoption, {
        checkedAt: new Date().toISOString(),
        adopted: adoption.adopted + lastAdopted.length,
        lastAdopted,
        skipped,
        error: null,
      });
      if (lastAdopted.length || skipped.length)
        log(
          `adopt: ${lastAdopted.length} adopted, ${skipped.length} left alone, ${survey.known} already managed of ${all.length} in qBittorrent`,
        );
      // The one skip reason that is a misconfiguration rather than an oddity, and the one that
      // silently reproduces the bug adoption exists to fix: every tagged torrent left unmanaged,
      // a disk that fills anyway, and a /status page that looks healthy. A wrong `trackerHost`
      // is the likely cause and only the owner can fix it, so it gets an alert and not just a
      // line on a page nobody is looking at.
      if (wrongTracker)
        alertProblem(
          'adopt-tracker',
          'Hebits builder: tagged torrents left unmanaged',
          `${wrongTracker} torrent(s) in qBittorrent carry a hebits tag but do not announce to ${host}, so they can never be released. Check "trackerHost" in config.json.`,
        );
    } catch (e) {
      // Never rethrow: cleanupTick awaits this before deciding what to release, and a
      // qBittorrent hiccup here must cost the store an update, not the release pass.
      adoption.error = (e as Error).message;
      adoption.checkedAt = new Date().toISOString();
      log(`adopt: ${adoption.error}`);
    } finally {
      adoptBusy = false;
    }
  }

  let cleanupBusy = false;
  async function cleanupTick(): Promise<void> {
    if (cleanupBusy || !cfg.cleanup?.enabled) return;
    cleanupBusy = true;
    try {
      const all = await qbit.all();
      // Before `managed` is built from it: a torrent qBittorrent is holding that the store has
      // never heard of is not releasable, and on a rebuilt machine that is every torrent there
      // is. adoptTick never throws, so a failure here costs this pass its adoptions and not the
      // release it was called ahead of.
      await adoptTick(all);
      const managed = new Set(
        Object.values(store.data.torrents)
          .map((t) => t.hash)
          .filter((h): h is string => Boolean(h)),
      );
      const freeBytes = await qbit.freeSpace();
      if (!Number.isFinite(freeBytes)) throw new Error('qBittorrent returned a non-numeric free space value');
      // Before anything is released: a torrent that reached 100% counts toward the rank
      // ladder for good, so the stamp has to be taken while the files are still here. The
      // farm tick stamps too; this pass is what covers a tracker outage keeping it away.
      const completedAt = new Date().toISOString();
      for (const id of newlyCompleted(store.data.torrents, all)) store.putTorrent(id, { completedAt });
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
      // Fail closed: qbit.freeSpace() returns NaN when qBittorrent's maindata carries no
      // free_space_on_disk, and `NaN < threshold` is false - so the unguarded comparison
      // stayed silent exactly when the disk state was unknown, which is the one case the
      // owner most needs to hear about. This is the only alert that says a release pass
      // could not free enough, so "unknown" gets its own alert rather than no alert.
      if (!Number.isFinite(freeAfter)) {
        alertProblem(
          'disk',
          'Hebits builder: free disk space unknown',
          'qBittorrent did not report free disk space, so the low-disk check could not run.',
        );
      } else if (freeAfter < (cfg.lowDiskAlertGB ?? 15) * GB) {
        alertProblem(
          'disk',
          'Hebits builder: disk almost full',
          `${(freeAfter / GB).toFixed(1)} GB free and nothing safe left to release.`,
        );
      }
      notifier.prune();
    } catch (e) {
      log(`cleanup: ${(e as Error).message}`);
      alertProblem('service', 'Hebits builder: a service is down', `Cleanup failed: ${(e as Error).message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  return { farmTick, cleanupTick, adoptTick, health, adoption, noteLogin };
}
