// A page for pasting a fresh Hebits cookie. A candidate client verifies the login through
// hebits-client's checkLogin() before the cookie is saved, so a bad paste is rejected rather
// than silently stored, and never replaces a working cookie.
import type { Health } from './jobs';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (x: unknown): string => String(x).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);

export function cookiePage(message: string | undefined, ok: boolean | undefined, health: Health): string {
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

// Minimal surface this module needs from an http.IncomingMessage: a method, and the ability
// to stream the body as an async iterable of chunks (Buffer, as Node gives it, or string).
export interface CookiePageReq {
  method?: string | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

// Minimal surface this module needs from an http.ServerResponse.
export interface CookiePageRes {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

export interface CookiePageDeps {
  health: Health;
  farmLog: (action: string, text: string) => void;
  log: (message: string) => void;
  // Builds a fresh client bound to a candidate cookie, so verifying a paste never touches
  // the cookie the running server is already using. Production wires this to
  // `(cookie) => new Hebits({ cookie })` from hebits-client.
  hebits: (cookie: string) => { checkLogin(): Promise<void> };
  writeCookie: (cookie: string) => void;
  // Flips `health.hebitsLogin` to 'ok' the moment a save succeeds, so the page's own status
  // line is never stale for the operator who just fixed it. Without this, health only
  // catches up on the next scheduled farmTick.
  noteLogin: (ok: boolean, err?: string) => void;
}

export async function handleCookiePage(
  req: CookiePageReq,
  res: CookiePageRes,
  { health, farmLog, log, hebits, writeCookie, noteLogin }: CookiePageDeps,
): Promise<void> {
  const send = (code: number, html: string): void => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  };
  const page = (message?: string, ok?: boolean): string => cookiePage(message, ok, health);
  if (req.method !== 'POST') return send(200, page());
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_000) return send(413, page('Too long.', false));
  }
  const cookie = new URLSearchParams(body)
    .get('cookie')
    ?.replace(/^cookie:\s*/i, '')
    .trim();
  if (!cookie?.includes('=')) return send(400, page('That does not look like a cookie value.', false));
  // Never echo the pasted value back into the page or the log, on either path: it is a
  // credential, and this page is the one place an operator pastes it. Only the verify
  // outcome and the error's own message (never the cookie itself) are rendered or logged.
  try {
    await hebits(cookie).checkLogin();
    writeCookie(cookie);
    noteLogin(true);
    farmLog('cookie-updated', 'Hebits cookie updated (verified login)');
    return send(200, page('Saved. The new cookie is logged in.', true));
  } catch (e) {
    const message = (e as Error).message;
    log(`cookie update: ${message}`);
    return send(400, page(message, false));
  }
}
