// The two background jobs: grab to build the account, release to keep the disk free.
import { networkInterfaces } from 'node:os';
import { pickGrabs, pickRemovals, describe, stuckDownloads } from './farm.js';

const GB = 1024 ** 3;

export function makeJobs({ cfg, store, jackett, qbit, site, notifier, ensureTorrent, farmLog, log }) {
  // Login health: set by every call that talks to Hebits.
  const health = { hebitsLogin: 'unknown', checkedAt: null, error: null };
  function noteLogin(ok, err) {
    const was = health.hebitsLogin;
    Object.assign(health, { hebitsLogin: ok ? 'ok' : 'failing', checkedAt: new Date().toISOString(), error: ok ? null : err });
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
  function alertProblem(kind, title, message) {
    notifier.send(kind, title, message);
  }

  function lanAddress() {
    for (const list of Object.values(networkInterfaces())) {
      const hit = list?.find((a) => a.family === 'IPv4' && !a.internal);
      if (hit) return hit.address;
    }
    return 'localhost';
  }
  const cookiePageUrl = () => `http://${cfg.lanHost || lanAddress()}:${cfg.port}/${cfg.token}/cookie`;

  let farmBusy = false;
  async function farmTick() {
    if (farmBusy || !cfg.farm?.enabled) return;
    farmBusy = true;
    try {
      let stats;
      try {
        stats = await site.stats({ fresh: true });
        if (stats.dailyLimit === undefined) throw new Error('daily download counter not found on profile page');
        noteLogin(true);
      } catch (e) {
        noteLogin(false, e.message);
        throw e;
      }
      const items = await jackett.search({ t: 'search', q: '' });
      const freeBytes = await qbit.freeSpace();
      if (!Number.isFinite(freeBytes)) throw new Error('qBittorrent returned a non-numeric free space value');
      const picks = pickGrabs(items, {
        now: Date.now(),
        stats: { uploaded: stats.uploaded, downloaded: stats.downloaded, dailyUsed: stats.dailyUsed, dailyLimit: stats.dailyLimit },
        freeBytes,
        known: new Set(Object.keys(store.data.torrents)),
        grabbedLastHour: (store.data.farmLog || []).filter((e) => e.action === 'grab' && Date.now() - Date.parse(e.at) < 3600e3).length,
        opts: cfg.farm,
      });
      log(
        `farm: ${items.length} latest, ${picks.length} to grab; daily ${stats.dailyUsed}/${stats.dailyLimit}, ` +
          `free ${(freeBytes / GB).toFixed(0)} GB, up ${(stats.uploaded / GB).toFixed(2)} GB, down ${(stats.downloaded / GB).toFixed(2)} GB`,
      );
      for (const { item, reason } of picks) {
        try {
          await ensureTorrent(
            item.hebitsId,
            { imdb: item.imdb, title: item.title, size: item.size, fileCount: item.files, cover: item.cover, auto: true },
            { category: cfg.seedCategory, savePath: cfg.seedPath },
          );
          farmLog('grab', `${describe(item)} - ${reason}`);
        } catch (e) {
          farmLog('grab-failed', `${item.title}: ${e.message}`);
        }
      }
    } catch (e) {
      log(`farm: ${e.message}`);
      if (/qBittorrent|ECONNREFUSED|fetch failed/i.test(e.message)) {
        alertProblem('service', 'Hebits builder: a service is down', `Auto-grab failed: ${e.message}`);
      }
    } finally {
      farmBusy = false;
    }
  }

  let cleanupBusy = false;
  async function cleanupTick() {
    if (cleanupBusy || !cfg.cleanup?.enabled) return;
    cleanupBusy = true;
    try {
      const managed = new Set(Object.values(store.data.torrents).map((t) => t.hash).filter(Boolean));
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
        const id = Object.keys(store.data.torrents).find((k) => store.data.torrents[k].hash === t.hash);
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
      log(`cleanup: ${e.message}`);
      alertProblem('service', 'Hebits builder: a service is down', `Cleanup failed: ${e.message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  return { farmTick, cleanupTick, health, noteLogin, cookiePageUrl };
}
