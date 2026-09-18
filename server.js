// Hebits account builder: grabs freeleech uploads, seeds them, and releases them when the disk fills.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, copyFileSync, truncateSync } from 'node:fs';
import { loadConfig, CONFIG_DIR } from './lib/config.js';
import { Store } from './lib/store.js';
import { Jackett } from './lib/jackett.js';
import { Notifier } from './lib/notify.js';
import { QBit } from './lib/qbit.js';
import { HebitsSite } from './lib/hebits.js';
import { makeGrabber, UserError } from './lib/grab.js';
import { makeJobs } from './lib/jobs.js';
import { handleCookiePage } from './lib/cookie-page.js';

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

const { farmTick, cleanupTick, health, noteLogin } = makeJobs({
  cfg, store, jackett, qbit, site, notifier, ensureTorrent, farmLog, log,
});

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
    if (route === 'cookie') return await handleCookiePage(req, res, { cfg, site, jackett, farmLog, health, noteLogin, log });
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
