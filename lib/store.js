// Persistent state: grabs (for the daily limit) and hebitsId -> torrent index.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function dayKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export class Store {
  // log: this is a cache and event log, not the source of truth (qBittorrent is), so a
  // failed save must never crash the process. It logs loudly instead and returns false.
  constructor(dir, timezone, log = () => {}) {
    this.file = join(dir, 'state.json');
    this.timezone = timezone;
    this.log = log;
    this.data = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { grabs: [], torrents: {} };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      const reason = e.code === 'ENOSPC' ? 'disk full (ENOSPC)' : e.code || e.message;
      this.log(`store: failed to save ${this.file}: ${reason} - ${e.message}`);
      // The write may have partially landed, or landed but the rename failed; either way
      // this.file is untouched (the rename never happened), so clean up the leftover tmp.
      try {
        unlinkSync(tmp);
      } catch {
        // tmp may not exist (writeFileSync itself failed) - nothing to clean up then.
      }
      return false;
    }
  }

  limitToday(cfg, now = new Date()) {
    return cfg.dailyLimitByDay?.[dayKey(now, this.timezone)] ?? cfg.dailyLimit;
  }

  grabsToday(now = new Date()) {
    const today = dayKey(now, this.timezone);
    return this.data.grabs.filter((g) => dayKey(new Date(g.at), this.timezone) === today).length;
  }

  recordGrab(hebitsId, now = new Date()) {
    this.data.grabs.push({ id: hebitsId, at: now.toISOString() });
    // keep a month of history
    const cutoff = now.getTime() - 31 * 864e5;
    this.data.grabs = this.data.grabs.filter((g) => Date.parse(g.at) >= cutoff);
    this.save();
  }

  torrent(hebitsId) {
    return this.data.torrents[hebitsId];
  }

  torrentsFor(imdb) {
    return Object.entries(this.data.torrents)
      .filter(([, t]) => t.imdb === imdb)
      .map(([id, t]) => ({ hebitsId: id, ...t }));
  }

  putTorrent(hebitsId, entry) {
    this.data.torrents[hebitsId] = { ...this.data.torrents[hebitsId], ...entry };
    this.save();
  }
}
