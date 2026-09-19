// Alerts over any transport. Configure a webhook, a command, or both.
// Home Assistant, ntfy, Telegram, Discord, Slack, Gotify and Pushover are all
// "POST to a URL", so one templated request covers them; `command` covers the rest.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_QUIET_MS = 6 * 3600 * 1000;
const DEFAULT_BODY = '{"kind":"{{json:kind}}","title":"{{json:title}}","message":"{{json:message}}"}';

const ESCAPERS = {
  raw: (v: unknown): string => String(v),
  json: (v: unknown): string => JSON.stringify(String(v)).slice(1, -1),
  url: (v: unknown): string => encodeURIComponent(String(v)),
} satisfies Record<string, (v: unknown) => string>;

function isEscaper(k: string): k is keyof typeof ESCAPERS {
  return k in ESCAPERS;
}

export type TemplateVars = Record<string, unknown>;

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{\{(?:(\w+):)?(\w+)\}\}/g, (_match, esc: string | undefined, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    const escaper = esc !== undefined && isEscaper(esc) ? ESCAPERS[esc] : ESCAPERS.raw;
    return escaper(v);
  });
}

export interface NotifyConfig {
  webhookUrl?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  command?: string[];
}

export interface NotifyDeps {
  fetch?: typeof fetch;
  execFile?: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
}

export interface SendOptions {
  quietMs?: number;
  force?: boolean;
  now?: number;
}

export class Notifier {
  cfg: NotifyConfig;
  // state: persisted object { [kind]: lastSentMs }; save: persists it
  state: Record<string, number>;
  save: () => void;
  log: (message: string) => void;
  fetch: typeof fetch;
  execFile: NonNullable<NotifyDeps['execFile']>;

  constructor(
    cfg: NotifyConfig = {},
    state: Record<string, number> = {},
    save: () => void = () => {},
    log: (message: string) => void = () => {},
    deps: NotifyDeps = {},
  ) {
    this.cfg = cfg;
    this.state = state;
    this.save = save;
    this.log = log;
    this.fetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.execFile = deps.execFile ?? ((file, args, options) => promisify(execFileCb)(file, args, options));
  }

  get enabled(): boolean {
    return Boolean(this.cfg.webhookUrl || this.cfg.command?.length);
  }

  // Same `kind` is sent at most once per `quietMs` unless `force`.
  async send(
    kind: string,
    title: string,
    message: string,
    { quietMs = DEFAULT_QUIET_MS, force = false, now = Date.now() }: SendOptions = {},
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const last = this.state[kind];
    if (!force && last !== undefined && now - last < quietMs) return false;
    const vars: TemplateVars = { kind, title, message };
    try {
      if (this.cfg.webhookUrl) await this.post(vars);
      if (this.cfg.command?.length) await this.run(vars);
      this.state[kind] = now;
      this.save();
      return true;
    } catch (e) {
      this.log(`notify ${kind}: ${(e as Error).message}`);
      return false;
    }
  }

  async post(vars: TemplateVars): Promise<void> {
    const { webhookUrl, method = 'POST', headers = {}, body = DEFAULT_BODY } = this.cfg;
    if (!webhookUrl) throw new Error('post: no webhookUrl configured');
    const res = await this.fetch(webhookUrl, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: renderTemplate(body, vars),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async run(vars: TemplateVars): Promise<void> {
    const rendered = (this.cfg.command ?? []).map((a) => renderTemplate(a, vars));
    const cmd = rendered[0];
    if (cmd === undefined) throw new Error('run: no command configured');
    await this.execFile(cmd, rendered.slice(1), { timeout: 10_000 });
  }

  // Lets a "problem" alert fire again right away once it has been resolved.
  reset(kind: string): void {
    if (this.state[kind]) {
      delete this.state[kind];
      this.save();
    }
  }

  // Kinds like `torrent-<hash>` and `stuck-<hash>` accumulate one entry per torrent ever
  // seen in that state, and are never otherwise removed. Drop anything stale so state.json
  // doesn't grow without bound.
  prune(maxAgeMs = 30 * 24 * 3600 * 1000, now: number = Date.now()): void {
    let changed = false;
    for (const [kind, at] of Object.entries(this.state)) {
      if (now - at >= maxAgeMs) {
        delete this.state[kind];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
