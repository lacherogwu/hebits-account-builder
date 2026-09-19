import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
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
  // Fields from config.json that failed validation and fell back to their default, one
  // message per field. Always present (empty when the file was clean) - see loadConfig().
  configIssues: string[];
}

const DEFAULTS: Omit<Config, 'token' | 'configIssues'> = {
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

// --- config.json validation -------------------------------------------------------------
// config.json is hand-edited. A typo (e.g. "minFreeGB": "20") must not stop the service
// starting: launchd restarts it with KeepAlive, so a throwing loadConfig() becomes a
// restart loop, and because the process dies before the notifier initialises the owner
// gets no alert - it's simply, silently down. That's worse than running with one wrong
// threshold. So every field is validated on its own: a bad one falls back to its default
// and is logged and recorded in configIssues; every other field - including keys this
// version of the code doesn't know about - is honoured untouched.

// GRAB_DEFAULTS / CLEANUP_DEFAULTS (farm.ts) knobs, beyond the enabled/intervalMin schedule
// fields. Keep in sync with those; farm.ts is not imported from here to avoid coupling this
// validator to its internals.
const grabOptionsShape: Record<string, z.ZodType> = {
  enabled: z.boolean(),
  intervalMin: z.number(),
  maxAgeHours: z.number(),
  minSizeGB: z.number(),
  maxSizeGB: z.number(),
  maxCountedSizeGB: z.number(),
  reserveGB: z.number(),
  keepForUser: z.number(),
  maxPerRun: z.number(),
  maxPerHour: z.number(),
  quietAfterHours: z.number(),
  countedTargetGB: z.number(),
  ratioMargin: z.number(),
  targetRatio: z.number(),
};

const cleanupOptionsShape: Record<string, z.ZodType> = {
  enabled: z.boolean(),
  intervalMin: z.number(),
  reserveGB: z.number(),
  targetGB: z.number(),
  minSeedDays: z.number(),
  keepIfSeedersBelow: z.number(),
  emergencyGB: z.number(),
  minWatchAgeDays: z.number(),
  watchCategory: z.string(),
};

const notifyShape: Record<string, z.ZodType> = {
  webhookUrl: z.string(),
};

// Top-level scalar fields (everything in DEFAULTS except the nested farm/cleanup/notify
// objects, which get their own per-key validation below).
const fieldSchemas: Record<string, z.ZodType> = {
  port: z.number(),
  lanHost: z.string(),
  dailyLimit: z.number(),
  dailyLimitByDay: z.record(z.string(), z.number()),
  minFreeGB: z.number(),
  timezone: z.string(),
  qbitUrl: z.string(),
  qbitUsername: z.string(),
  qbitPassword: z.string(),
  watchCategory: z.string(),
  watchPath: z.string(),
  seedCategory: z.string(),
  seedPath: z.string(),
  lowDiskAlertGB: z.number(),
  torrentDir: z.string(),
  logFile: z.string(),
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function logIssue(msg: string, issues: string[]): void {
  console.error(`config: ${msg}`);
  issues.push(msg);
}

// One scalar top-level field. Returns the validated value, or undefined to fall back to
// DEFAULTS (the caller deletes the key so the DEFAULTS spread supplies it).
function validateScalar(key: string, schema: z.ZodType, fallback: unknown, received: unknown, issues: string[]): unknown {
  const result = schema.safeParse(received);
  if (result.success) return result.data;
  logIssue(`"${key}" is a ${typeOf(received)}, not the expected type - using default ${JSON.stringify(fallback)}`, issues);
  return undefined;
}

// One nested options object (farm/cleanup/notify), validated key by key against `shape`.
// - Not an object at all: the whole field falls back to its default.
// - A key in `shape` with the wrong type: that key falls back, the rest of the object -
//   including keys `shape` doesn't enumerate, such as future GrabOptions/CleanupOptions
//   knobs - survives untouched.
function validateOptions(
  name: string,
  shape: Record<string, z.ZodType>,
  fallback: Record<string, unknown>,
  received: unknown,
  issues: string[],
): Record<string, unknown> {
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    logIssue(`"${name}" is a ${typeOf(received)}, not an object - using default`, issues);
    return {};
  }
  const out: Record<string, unknown> = { ...(received as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const result = schema.safeParse(out[key]);
    if (!result.success) {
      logIssue(`"${name}.${key}" is a ${typeOf(out[key])}, not the expected type - using default ${JSON.stringify(fallback[key])}`, issues);
      delete out[key];
    }
  }
  return out;
}

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  let token = saved.token as string | undefined;
  if (!token) {
    token = randomBytes(16).toString('hex');
    saved.token = token;
    writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  }

  const configIssues: string[] = [];
  // Unknown keys (not in DEFAULTS) start here and are never touched below, so they survive
  // into the merged config untouched, per the "preserve, don't reject" requirement.
  const validated: Record<string, unknown> = { ...saved };

  for (const [key, schema] of Object.entries(fieldSchemas)) {
    if (!(key in saved)) continue;
    const value = validateScalar(key, schema, (DEFAULTS as Record<string, unknown>)[key], saved[key], configIssues);
    if (value === undefined) delete validated[key];
    else validated[key] = value;
  }

  if ('farm' in saved)
    validated.farm = {
      ...DEFAULTS.farm,
      ...validateOptions('farm', grabOptionsShape, DEFAULTS.farm as Record<string, unknown>, saved.farm, configIssues),
    };
  if ('cleanup' in saved)
    validated.cleanup = {
      ...DEFAULTS.cleanup,
      ...validateOptions('cleanup', cleanupOptionsShape, DEFAULTS.cleanup as Record<string, unknown>, saved.cleanup, configIssues),
    };
  if ('notify' in saved)
    validated.notify = {
      ...DEFAULTS.notify,
      ...validateOptions('notify', notifyShape, DEFAULTS.notify as Record<string, unknown>, saved.notify, configIssues),
    };

  const cfg: Config = { ...DEFAULTS, ...validated, token, configIssues } as Config;
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
