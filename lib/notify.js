// Phone alerts through a Home Assistant webhook automation.

const DEFAULT_QUIET_MS = 6 * 3600 * 1000;

export class Notifier {
  // state: persisted object { [kind]: lastSentMs }; save: persists it
  constructor({ webhookUrl }, state, save, log) {
    this.url = webhookUrl;
    this.state = state;
    this.save = save;
    this.log = log;
  }

  get enabled() {
    return Boolean(this.url);
  }

  // Same `kind` is sent at most once per `quietMs` unless `force`.
  async send(kind, title, message, { quietMs = DEFAULT_QUIET_MS, force = false, now = Date.now() } = {}) {
    if (!this.enabled) return false;
    const last = this.state[kind];
    if (!force && last !== undefined && now - last < quietMs) return false;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, title, message }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.state[kind] = now;
      this.save();
      return true;
    } catch (e) {
      this.log(`notify ${kind}: ${e.message}`);
      return false;
    }
  }

  // Lets a "problem" alert fire again right away once it has been resolved.
  reset(kind) {
    if (this.state[kind]) {
      delete this.state[kind];
      this.save();
    }
  }
}
