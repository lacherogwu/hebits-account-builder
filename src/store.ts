// Persistent state: grabs (for the daily limit) and hebitsId -> torrent index.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TorrentEntry {
  imdb?: string;
  title?: string;
  size?: number;
  fileCount?: number;
  cover?: string;
  auto?: boolean;
  hash?: string;
  name?: string;
  files?: { path: string; length: number; offset: number }[];
  pieceLength?: number;
  // Written by the cleanup job (lib/jobs.js) when qBittorrent releases a managed torrent;
  // the entry stays in the index (for history/dedup) but is marked gone.
  removedAt?: string;
}

export interface StoreData {
  grabs: { id: string; at: string }[];
  torrents: Record<string, TorrentEntry>;
  farmLog?: { action: string; text: string; at: string }[];
  // Notifier throttle state: { [kind]: lastSentMs }. Created on first use via `??= {}`
  // in server.js, so it's absent from a fresh store.
  notified?: Record<string, number>;
}

// The slice of Config that limitToday() needs. Config itself is defined where it's loaded.
export interface DailyLimitConfig {
  dailyLimit: number;
  dailyLimitByDay?: Record<string, number>;
}

export function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export class Store {
  file: string;
  timezone: string;
  log: (message: string) => void;
  data: StoreData;

  // log: this is a cache and event log, not the source of truth (qBittorrent is), so a
  // failed save must never crash the process. It logs loudly instead and returns false.
  constructor(dir: string, timezone: string, log: (message: string) => void = () => {}) {
    this.file = join(dir, 'state.json');
    this.timezone = timezone;
    this.log = log;
    this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as StoreData) : { grabs: [], torrents: {} };
  }

  save(): boolean {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const reason = err.code === 'ENOSPC' ? 'disk full (ENOSPC)' : err.code || err.message;
      this.log(`store: failed to save ${this.file}: ${reason} - ${err.message}`);
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

  limitToday(cfg: DailyLimitConfig, now: Date = new Date()): number {
    return cfg.dailyLimitByDay?.[dayKey(now, this.timezone)] ?? cfg.dailyLimit;
  }

  grabsToday(now: Date = new Date()): number {
    const today = dayKey(now, this.timezone);
    return this.data.grabs.filter((g) => dayKey(new Date(g.at), this.timezone) === today).length;
  }

  recordGrab(hebitsId: string, now: Date = new Date()): void {
    this.data.grabs.push({ id: hebitsId, at: now.toISOString() });
    // keep a month of history
    const cutoff = now.getTime() - 31 * 864e5;
    this.data.grabs = this.data.grabs.filter((g) => Date.parse(g.at) >= cutoff);
    this.save();
  }

  torrent(hebitsId: string): TorrentEntry | undefined {
    return this.data.torrents[hebitsId];
  }

  torrentsFor(imdb: string): ({ hebitsId: string } & TorrentEntry)[] {
    return Object.entries(this.data.torrents)
      .filter(([, t]) => t.imdb === imdb)
      .map(([id, t]) => ({ hebitsId: id, ...t }));
  }

  putTorrent(hebitsId: string, entry: Partial<TorrentEntry>): void {
    this.data.torrents[hebitsId] = { ...this.data.torrents[hebitsId], ...entry };
    this.save();
  }
}
