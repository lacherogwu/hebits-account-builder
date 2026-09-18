// Hebits account builder: grabs freeleech uploads, seeds them, and releases them when the disk fills.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, copyFileSync, truncateSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { loadConfig, CONFIG_DIR } from './lib/config.js';
import { Store } from './lib/store.js';
import { Jackett, setIndexerCookie } from './lib/jackett.js';
import { Notifier } from './lib/notify.js';
import { QBit } from './lib/qbit.js';
import { HebitsSite } from './lib/hebits.js';
import { pickGrabs, pickRemovals, describe, stuckDownloads } from './lib/farm.js';
import { makeGrabber, UserError } from './lib/grab.js';

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone);
const jackett = new Jackett(cfg);
const qbit = new QBit(cfg);
const site = new HebitsSite(cfg.jackettIndexerConfig);
const notifier = new Notifier(cfg.notify || {}, (store.data.notified ??= {}), () => store.save(), (m) => log(m));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const GB = 1024 ** 3;
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;

const { ensureTorrent, daily } = makeGrabber({ cfg, store, jackett, qbit, site, log });

function farmLog(action, text) {
  const list = (store.data.farmLog ??= []);
  list.push({ at: new Date().toISOString(), action, text });
  store.data.farmLog = list.slice(-100);
  store.save();
  log(`${action}: ${text}`);
}

// ---- account building -----------------------------------------------------

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
    const removals = pickRemovals(all, { now: Date.now(), freeBytes, managed, opts: cfg.cleanup });
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
      farmLog(
        'release',
        `${t.name} (${(t.size / GB).toFixed(1)} GB, ${t.num_complete} seeders, ratio ${t.ratio.toFixed(2)}, seeded ${(t.seeding_time / 86400).toFixed(1)} days)`,
      );
    }
    const freeAfter = await qbit.freeSpace();
    if (freeAfter < (cfg.lowDiskAlertGB ?? 15) * GB) {
      alertProblem('disk', 'Hebits builder: disk almost full', `${(freeAfter / GB).toFixed(1)} GB free and nothing safe left to release.`);
    }
  } catch (e) {
    log(`cleanup: ${e.message}`);
    alertProblem('service', 'Hebits builder: a service is down', `Cleanup failed: ${e.message}`);
  } finally {
    cleanupBusy = false;
  }
}

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cookiePage(message, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hebits cookie</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#d2d2d7;--ok:#1a7f37;--bad:#c62828;--accent:#0a66c2}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f2;--muted:#a1a1a6;--card:#1c1c1e;--line:#3a3a3c;--ok:#4cc26a;--bad:#ff6b6b;--accent:#4c9fff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}p,li{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
textarea{width:100%;box-sizing:border-box;min-height:110px;font:13px ui-monospace,monospace;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{margin-top:12px;padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:15px}
.msg{font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><main>
<h1>Update the Hebits login</h1>
<p>Status: <b>${esc(health.hebitsLogin)}</b>${health.error ? ` — ${esc(health.error)}` : ''}</p>
${message ? `<p class="msg ${ok ? 'ok' : 'bad'}">${esc(message)}</p>` : ''}
<div class="card"><ol>
<li>On a computer, log in to hebits.net in Chrome.</li>
<li>Open DevTools (⌥⌘I) → <b>Network</b>, reload the page, click the first <code>index.php</code>.</li>
<li>Under <b>Request Headers</b>, copy the whole value of <code>cookie</code>.</li>
<li>Paste it below. Don't log out of Hebits in that browser afterwards.</li>
</ol>
<form method="post"><textarea name="cookie" required placeholder="PHPSESSID=…; session=…"></textarea>
<button type="submit">Save and test</button></form></div>
</main></body></html>`;
}

async function handleCookiePage(req, res) {
  const send = (code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  };
  if (req.method !== 'POST') return send(200, cookiePage());
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_000) return send(413, cookiePage('Too long.', false));
  }
  const cookie = new URLSearchParams(body).get('cookie')?.replace(/^cookie:\s*/i, '').trim();
  if (!cookie || !cookie.includes('=')) return send(400, cookiePage('That does not look like a cookie value.', false));
  try {
    await setIndexerCookie(cfg, cookie);
    site.cached = null;
    jackett.cache.clear();
    const s = await site.stats({ fresh: true });
    noteLogin(true);
    farmLog('cookie-updated', `Hebits cookie updated (logged in as ${s.userClass})`);
    return send(200, cookiePage(`Saved. Logged in (${s.userClass}, downloads today ${s.dailyUsed}/${s.dailyLimit}).`, true));
  } catch (e) {
    log(`cookie update: ${e.message}`);
    return send(400, cookiePage(e.message, false));
  }
}

function tokenOk(given) {
  const a = Buffer.from(given || '');
  const b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const LOG_FILE = cfg.logFile;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, token, ...rest] = url.pathname.split('/');
  if (!tokenOk(token)) return json(res, 404, { error: 'not found' });
  const baseUrl = `http://${req.headers.host}/${token}`;
  const route = rest.join('/');
  try {
    if (!route.startsWith('play/')) log(`${req.method} ${route} origin=${req.headers.origin || '-'} ua=${req.headers['user-agent'] || '-'}`);
    if (req.method === 'OPTIONS') {
      // Private Network Access: lets an https web page fetch from this LAN address.
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      return res.end();
    }
    if (route === 'cookie') return await handleCookiePage(req, res);
    if (route === 'notify-test') {
      const sent = await notifier.send('test', 'Hebits account builder test', 'Notifications from the Hebits account builder work.', { force: true });
      return json(res, sent ? 200 : 502, { sent, enabled: notifier.enabled });
    }
    if (route === 'status') {
      const d = await daily();
      const st = d.stats;
      return json(res, 200, {
        version: VERSION,
        account: st && {
          class: st.userClass,
          uploadedGB: +(st.uploaded / GB).toFixed(2),
          downloadedGB: +(st.downloaded / GB).toFixed(2),
          ratio: st.ratio,
          requiredRatio: st.requiredRatio,
          towardHebUser: `downloaded ${(st.downloaded / GB).toFixed(1)}/20 GB, ratio ${st.downloaded ? (st.uploaded / st.downloaded).toFixed(2) : '∞'}/1.25`,
        },
        downloadsToday: `${d.used}/${d.limit}`,
        health: { ...health, logFile: LOG_FILE },
        recentActivity: (store.data.farmLog || []).slice(-20).reverse(),
        freeGB: Math.round(((await qbit.freeSpace()) || 0) / GB),
        torrents: Object.entries(store.data.torrents)
          .filter(([, t]) => t.hash && !t.removedAt)
          .map(([id, t]) => ({ id, name: t.name, imdb: t.imdb })),
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log(`${req.method} ${route}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(err instanceof UserError ? 409 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    } else res.destroy();
  }
});

// launchd keeps the log file open in append mode: copy then truncate.
function rotateLog() {
  try {
    if (statSync(LOG_FILE).size < 20 * 1024 * 1024) return;
    copyFileSync(LOG_FILE, `${LOG_FILE}.1`);
    truncateSync(LOG_FILE, 0);
    log('log rotated');
  } catch {}
}

rotateLog();
setInterval(rotateLog, 3600_000);
setTimeout(farmTick, 60_000);
setInterval(farmTick, (cfg.farm?.intervalMin ?? 10) * 60_000);
setTimeout(cleanupTick, 90_000);
setInterval(cleanupTick, (cfg.cleanup?.intervalMin ?? 30) * 60_000);
server.listen(cfg.port, '0.0.0.0', () => log(`hebits account builder v${VERSION} listening on :${cfg.port}`));
