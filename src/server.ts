// Hebits account builder: grabs freeleech uploads, seeds them, and releases them when the disk fills.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { statSync, copyFileSync, truncateSync } from 'node:fs';
import { Hebits } from 'hebits-client';
import { loadConfig, CONFIG_DIR, readCookie, writeCookie } from './config';
import { Store } from './store';
import { Notifier } from './notify';
import { QBit } from './qbit';
import { makeGrabber, UserError } from './grab';
import { makeJobs } from './jobs';
import { handleCookiePage } from './cookie-page';
import { VERSION } from './version';

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone, (m) => log(m));
// Startup is unconditional: this is the only way to install a cookie, so a server that
// refuses to start without one could never be recovered. hebits-client@0.1.1's constructor
// does not throw on an empty cookie; calls simply fail (as LoginExpiredError, typically)
// until a working cookie is pasted through the /cookie page.
const hebits = new Hebits({ cookie: readCookie() ?? '' });
const qbit = new QBit(cfg);
const notifier = new Notifier(cfg.notify || {}, (store.data.notified ??= {}), () => store.save(), (m) => log(m));
const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);
const GB = 1024 ** 3;

const { ensureTorrent, daily } = makeGrabber({ cfg, store, hebits, qbit, log });

function farmLog(action: string, text: string): void {
  const list = (store.data.farmLog ??= []);
  list.push({ at: new Date().toISOString(), action, text });
  store.data.farmLog = list.slice(-100);
  store.save();
  log(`${action}: ${text}`);
}

const { farmTick, cleanupTick, health } = makeJobs({
  cfg, store, hebits, qbit, notifier, ensureTorrent, farmLog, log,
});

function tokenOk(given: string | undefined): boolean {
  const a = Buffer.from(given || '');
  const b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const LOG_FILE = cfg.logFile;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const [, token, ...rest] = url.pathname.split('/');
  if (!tokenOk(token)) return json(res, 404, { error: 'not found' });
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
    if (route === 'cookie') {
      return await handleCookiePage(req, res, {
        health,
        farmLog,
        log,
        hebits: (cookie: string) => new Hebits({ cookie }),
        writeCookie,
      });
    }
    if (route === 'notify-test') {
      const sent = await notifier.send('test', 'Hebits account builder test', 'Notifications from the Hebits account builder work.', { force: true });
      return json(res, sent ? 200 : 502, { sent, enabled: notifier.enabled });
    }
    if (route === 'status') {
      const d = await daily();
      const st = await hebits.stats().catch(() => undefined);
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
    log(`${req.method} ${route}: ${(err as Error).message}`);
    if (!res.headersSent) {
      res.writeHead(err instanceof UserError ? 409 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((err as Error).message);
    } else res.destroy();
  }
});

// launchd keeps the log file open in append mode: copy then truncate.
function rotateLog(): void {
  try {
    if (statSync(LOG_FILE).size < 20 * 1024 * 1024) return;
    copyFileSync(LOG_FILE, `${LOG_FILE}.1`);
    truncateSync(LOG_FILE, 0);
    log('log rotated');
  } catch {
    // best-effort; a rotation failure must not take the server down
  }
}

rotateLog();
setInterval(rotateLog, 3600_000);
setTimeout(farmTick, 60_000);
setInterval(farmTick, (cfg.farm?.intervalMin ?? 10) * 60_000);
setTimeout(cleanupTick, 90_000);
setInterval(cleanupTick, (cfg.cleanup?.intervalMin ?? 30) * 60_000);
server.listen(cfg.port, '0.0.0.0', () => log(`hebits account builder v${VERSION} listening on :${cfg.port}`));
