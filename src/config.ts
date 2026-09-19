import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CleanupOptions, GrabOptions } from './farm';

const HOME = homedir();
export const CONFIG_DIR = process.env.HEBITS_BUILDER_DIR || join(HOME, '.config', 'hebits-account-builder');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const COOKIE_FILE = join(CONFIG_DIR, 'cookie.txt');

export interface Config {
  port: number;
  // LAN address to put in links (e.g. the cookie-update alert). Empty auto-detects it.
  lanHost: string;
  // Hebits Heb Rookie: 5 on day one, then 10. Raise when the account ranks up.
  dailyLimit: number;
  // Per-day exceptions, e.g. { "2026-09-17": 5 } for the account's first day.
  dailyLimitByDay: Record<string, number>;
  // Keep this much disk free after a download.
  minFreeGB: number;
  timezone: string;
  qbitUrl: string;
  // Only needed when "bypass authentication for localhost" is off.
  qbitUsername: string;
  qbitPassword: string;
  watchCategory: string;
  watchPath: string;
  seedCategory: string;
  seedPath: string;
  // Account building. Both are passed to the policy whole as `opts`, so the whole knob set
  // (see GRAB_DEFAULTS / CLEANUP_DEFAULTS in farm.ts) is settable here alongside the schedule.
  farm: GrabOptions;
  cleanup: CleanupOptions;
  // Home Assistant webhook, e.g. http://homeassistant.local:8123/api/webhook/<id>
  notify: { webhookUrl: string };
  lowDiskAlertGB: number;
  torrentDir: string;
  logFile: string;
  token: string;
}

const DEFAULTS: Omit<Config, 'token'> = {
  port: 7001,
  lanHost: '',
  dailyLimit: 10,
  dailyLimitByDay: {},
  minFreeGB: 20,
  timezone: 'Asia/Jerusalem',
  qbitUrl: 'http://127.0.0.1:8080',
  qbitUsername: '',
  qbitPassword: '',
  watchCategory: 'watch',
  watchPath: join(HOME, 'hebits', 'watch'),
  seedCategory: 'seed-auto',
  seedPath: join(HOME, 'hebits', 'seed'),
  farm: { enabled: true, intervalMin: 10 },
  cleanup: { enabled: true, intervalMin: 30 },
  notify: { webhookUrl: '' },
  lowDiskAlertGB: 15,
  torrentDir: join(CONFIG_DIR, 'torrents'),
  logFile: join(CONFIG_DIR, 'builder.log'),
};

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  let token = saved.token;
  if (!token) {
    token = randomBytes(16).toString('hex');
    saved.token = token;
    writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  }
  const cfg: Config = { ...DEFAULTS, ...saved, token };
  mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
  return cfg;
}

export function readCookie(): string | undefined {
  try {
    const raw = readFileSync(COOKIE_FILE, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined; // absent or unreadable: the builder starts and reports login failing
  }
}

export function writeCookie(cookie: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(COOKIE_FILE, cookie.trim() + '\n', { mode: 0o600 });
}
