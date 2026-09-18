// Read-only account stats from hebits.net, using the login cookie Jackett already holds.
// It must run on the same public IP as your Hebits session, which is normally the case
// when Jackett and this service share a machine.
import { readFileSync } from 'node:fs';

const BASE = 'https://hebits.net';
const CACHE_MS = 5 * 60 * 1000;
// An honest client identifier, not a spoofed browser: this is a scripted client using the
// user's own session cookie, and the tracker operator should be able to see that, identify
// it and rate-limit it fairly.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const USER_AGENT = `hebits-account-builder/${VERSION}`;

export function parseDailyDownloads(html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(/הורדות יומיות:\s*(\d+)\s*\/\s*(\d+)/);
  return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
}

export class HebitsSite {
  constructor(indexerConfigPath) {
    this.path = indexerConfigPath;
    this.cached = null;
  }

  cookie() {
    // Re-read every time: updating the cookie in Jackett takes effect without a restart.
    const cfg = JSON.parse(readFileSync(this.path, 'utf8'));
    return cfg.find((x) => x.id === 'cookie')?.value;
  }

  async get(path) {
    const res = await fetch(`${BASE}/${path}`, {
      headers: { cookie: this.cookie(), 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 200) throw new Error(`hebits ${path}: HTTP ${res.status} (login cookie expired?)`);
    return res.text();
  }

  // { uploaded, downloaded, ratio, requiredRatio, userClass, dailyUsed, dailyLimit }
  async stats({ fresh = false } = {}) {
    if (!fresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const idx = JSON.parse(await this.get('ajax.php?action=index'));
    if (idx.status !== 'success') throw new Error('hebits index: not logged in');
    const u = idx.response.userstats;
    const daily = parseDailyDownloads(await this.get(`user.php?id=${idx.response.id}`));
    const value = {
      uploaded: u.uploaded,
      downloaded: u.downloaded,
      ratio: u.ratio,
      requiredRatio: u.requiredratio,
      userClass: u.class,
      dailyUsed: daily?.used,
      dailyLimit: daily?.limit,
    };
    this.cached = { at: Date.now(), value };
    return value;
  }
}
