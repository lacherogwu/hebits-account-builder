// Alerts over any transport. Configure a webhook, a command, or both.
// Home Assistant, ntfy, Telegram, Discord, Slack, Gotify and Pushover are all
// "POST to a URL", so one templated request covers them; `command` covers the rest.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_QUIET_MS = 6 * 3600 * 1000;
const DEFAULT_BODY = '{"kind":"{{json:kind}}","title":"{{json:title}}","message":"{{json:message}}"}';

const ESCAPERS = {
  raw: (v) => String(v),
  json: (v) => JSON.stringify(String(v)).slice(1, -1),
  url: (v) => encodeURIComponent(String(v)),
};

export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(?:(\w+):)?(\w+)\}\}/g, (_, esc, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return (ESCAPERS[esc] || ESCAPERS.raw)(v);
  });
}

export class Notifier {
  // state: persisted object { [kind]: lastSentMs }; save: persists it
  constructor(cfg = {}, state = {}, save = () => {}, log = () => {}, deps = {}) {
    this.cfg = cfg;
    this.state = state;
    this.save = save;
    this.log = log;
    this.fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this.execFile = deps.execFile || promisify(execFileCb);
  }

  get enabled() {
    return Boolean(this.cfg.webhookUrl || this.cfg.command?.length);
  }

  // Same `kind` is sent at most once per `quietMs` unless `force`.
  async send(kind, title, message, { quietMs = DEFAULT_QUIET_MS, force = false, now = Date.now() } = {}) {
    if (!this.enabled) return false;
    const last = this.state[kind];
    if (!force && last !== undefined && now - last < quietMs) return false;
    const vars = { kind, title, message };
    try {
      if (this.cfg.webhookUrl) await this.post(vars);
      if (this.cfg.command?.length) await this.run(vars);
      this.state[kind] = now;
      this.save();
      return true;
    } catch (e) {
      this.log(`notify ${kind}: ${e.message}`);
      return false;
    }
  }

  async post(vars) {
    const { webhookUrl, method = 'POST', headers = {}, body = DEFAULT_BODY } = this.cfg;
    const res = await this.fetch(webhookUrl, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: renderTemplate(body, vars),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async run(vars) {
    const [cmd, ...args] = this.cfg.command.map((a) => renderTemplate(a, vars));
    await this.execFile(cmd, args, { timeout: 10_000 });
  }

  // Lets a "problem" alert fire again right away once it has been resolved.
  reset(kind) {
    if (this.state[kind]) {
      delete this.state[kind];
      this.save();
    }
  }
}
