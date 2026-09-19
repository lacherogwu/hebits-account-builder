// Hebits account builder: grabs freeleech uploads, seeds them, and releases them when the disk fills.

import { timingSafeEqual } from 'node:crypto';
import { copyFileSync, statSync, truncateSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hebits } from 'hebits-client';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CONFIG_DIR, loadConfig, readCookie, writeCookie } from './config';
import type { CookiePageReq, CookiePageRes } from './cookie-page';
import { handleCookiePage } from './cookie-page';
import { makeGrabber, UserError } from './grab';
import { makeJobs } from './jobs';
import { Notifier } from './notify';
import { QBit } from './qbit';
import { Store } from './store';
import { VERSION } from './version';

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone, (m) => log(m));
// Startup is unconditional: this is the only way to install a cookie, so a server that
// refuses to start without one could never be recovered. The constructor does not throw
// on an empty cookie; calls simply fail (as LoginExpiredError, typically) until a working
// cookie is pasted through the /cookie page.
//
// cookie is a provider, not a string: it is called fresh before every request, so a cookie
// pasted through the /cookie page takes effect immediately. A string would bind whatever
// readCookie() returned at startup.
//
// cacheTtlMs: 0 because stale uploaded/downloaded figures feed farm.ts's ratio check, and a
// counted download could be taken that a fresh read would have skipped. /status already
// reaches the tracker on every load anyway, since dailyDownloads() never caches.
const hebits = new Hebits({ cookie: () => readCookie() ?? '', cacheTtlMs: 0 });
const qbit = new QBit(cfg);
store.data.notified ??= {};
const notifier = new Notifier(
  cfg.notify || {},
  store.data.notified,
  () => store.save(),
  (m) => log(m),
);
const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);
const GB = 1024 ** 3;

const { ensureTorrent, daily } = makeGrabber({ cfg, store, hebits, qbit, log });

function farmLog(action: string, text: string): void {
  store.data.farmLog ??= [];
  const list = store.data.farmLog;
  list.push({ at: new Date().toISOString(), action, text });
  store.data.farmLog = list.slice(-100);
  store.save();
  log(`${action}: ${text}`);
}

const { farmTick, cleanupTick, health, noteLogin } = makeJobs({
  cfg,
  store,
  hebits,
  qbit,
  notifier,
  ensureTorrent,
  farmLog,
  log,
});

function tokenOk(given: string | undefined): boolean {
  const a = Buffer.from(given || '');
  const b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type AppEnv = { Variables: { route: string } };

function json(c: Context<AppEnv>, code: ContentfulStatusCode, body: unknown): Response {
  return c.json(body, code, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
}

// Private Network Access: lets an https web page fetch from this LAN address.
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
    },
  });
}

// Adapts a Hono request into the minimal streaming-body shape handleCookiePage expects, so
// its own body-accumulation and 16KB cutoff (in cookie-page.ts) run unchanged.
function toCookiePageReq(c: Context<AppEnv>): CookiePageReq {
  return {
    method: c.req.method,
    async *[Symbol.asyncIterator]() {
      const reader = c.req.raw.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// handleCookiePage writes through a writeHead/end pair (its own CookiePageRes shape); this
// captures that into a real Response instead of a node ServerResponse.
async function runCookiePage(c: Context<AppEnv>): Promise<Response> {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = '';
  const res: CookiePageRes = {
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(b = '') {
      body = b;
    },
  };
  await handleCookiePage(toCookiePageReq(c), res, {
    health,
    farmLog,
    log,
    hebits: (cookie: string) => new Hebits({ cookie }),
    writeCookie,
    noteLogin,
  });
  return new Response(body, { status: statusCode, headers });
}

const LOG_FILE = cfg.logFile;

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const segments = c.req.path.split('/');
  if (!tokenOk(segments[1])) return c.notFound();
  const route = segments.slice(2).join('/');
  c.set('route', route);
  if (!route.startsWith('play/')) {
    log(`${c.req.method} ${route} origin=${c.req.header('origin') || '-'} ua=${c.req.header('user-agent') || '-'}`);
  }
  await next();
});

app.options('/:token', preflight);
app.options('/:token/*', preflight);

app.get('/:token/cookie', runCookiePage);
app.post('/:token/cookie', runCookiePage);

app.get('/:token/notify-test', async (c) => {
  const sent = await notifier.send('test', 'Hebits account builder test', 'Notifications from the Hebits account builder work.', {
    force: true,
  });
  return json(c, sent ? 200 : 502, { sent, enabled: notifier.enabled });
});

app.get('/:token/status', async (c) => {
  const d = await daily();
  const st = await hebits.stats().catch(() => undefined);
  return json(c, 200, {
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
    health: { ...health, logFile: LOG_FILE, configIssues: cfg.configIssues },
    recentActivity: (store.data.farmLog || []).slice(-20).reverse(),
    freeGB: Math.round(((await qbit.freeSpace()) || 0) / GB),
    torrents: Object.entries(store.data.torrents)
      .filter(([, t]) => t.hash && !t.removedAt)
      .map(([id, t]) => ({ id, name: t.name, imdb: t.imdb })),
  });
});

app.notFound((c) => json(c, 404, { error: 'not found' }));

app.onError((err, c) => {
  const route = c.get('route') ?? '';
  log(`${c.req.method} ${route}: ${(err as Error).message}`);
  return c.text((err as Error).message, err instanceof UserError ? 409 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
});

// LOG_FILE is where the LaunchAgent points StandardOutPath/StandardErrorPath (see
// deploy/org.user.hebits-builder.plist), which is what `log` above actually writes to - it
// is console.log, so every line goes to stdout and launchd appends it there. That pairing is
// the whole point: rotating cfg.logFile while the process logged somewhere else meant this
// function faithfully rotated an empty file for as long as it existed while the real log
// grew without limit.
//
// DO NOT turn this into a rename. launchd opened that file once, in append mode, and holds
// the fd for the life of the process: truncating in place moves its write offset back to
// zero and logging continues into the same file, but renaming it leaves launchd writing to
// an unlinked inode - the log appears to stop dead until the next restart, and `.1` grows
// instead. copyFileSync + truncateSync is the only shape that works here.
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
serve({ fetch: app.fetch, hostname: '0.0.0.0', port: cfg.port }, () => log(`hebits account builder v${VERSION} listening on :${cfg.port}`));
