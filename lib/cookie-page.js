// A page for pasting a fresh Hebits cookie. Jackett verifies the login before saving,
// so a bad paste is rejected rather than silently stored.
import { setIndexerCookie } from './jackett.js';

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function cookiePage(message, ok, health) {
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

// NOTE (deviation from the brief's declared signature): the moved body also reads
// `health`, `site`, `jackett` and `farmLog` from what used to be server.js module scope.
// The brief's Interfaces line and code block only list {cfg, noteLogin, log}, which would
// leave those four undefined (ReferenceError) — this module can't own them via import since
// they're instances built in server.js, not fixed dependencies like setIndexerCookie. Adding
// them here is required to preserve behaviour, not a logic change.
export async function handleCookiePage(req, res, { cfg, site, jackett, farmLog, health, noteLogin, log }) {
  const send = (code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  };
  const page = (message, ok) => cookiePage(message, ok, health);
  if (req.method !== 'POST') return send(200, page());
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_000) return send(413, page('Too long.', false));
  }
  const cookie = new URLSearchParams(body).get('cookie')?.replace(/^cookie:\s*/i, '').trim();
  if (!cookie || !cookie.includes('=')) return send(400, page('That does not look like a cookie value.', false));
  try {
    await setIndexerCookie(cfg, cookie);
    site.cached = null;
    jackett.cache.clear();
    const s = await site.stats({ fresh: true });
    noteLogin(true);
    farmLog('cookie-updated', `Hebits cookie updated (logged in as ${s.userClass})`);
    return send(200, page(`Saved. Logged in (${s.userClass}, downloads today ${s.dailyUsed}/${s.dailyLimit}).`, true));
  } catch (e) {
    log(`cookie update: ${e.message}`);
    return send(400, page(e.message, false));
  }
}
