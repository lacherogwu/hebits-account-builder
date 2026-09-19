import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CleanupOptions, GrabOptions } from './farm';
// Type-only: the notifier's own view of its options is the single source of truth for what
// config.json's "notify" object supports. `import type` keeps this erased, so config.ts
// gains no runtime dependency on notify.ts.
import type { NotifyConfig } from './notify';

const HOME = homedir();
export const CONFIG_DIR = process.env.HEBITS_BUILDER_DIR || join(HOME, '.config', 'hebits-account-builder');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const COOKIE_FILE = join(CONFIG_DIR, 'cookie.txt');

export interface Config {
  port: number;
  // LAN address to put in links (e.g. the cookie-update alert). Empty auto-detects it.
  lanHost: string;
  // Fallback allowance, used only when the tracker's own counter is unreachable. 0 means
  // "derive it from the rank the account currently holds" (the ladder in farm.ts specifies
  // one per rank), which is the default; a non-zero value pins it for every day.
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
  // Alert transport. `webhookUrl` is the common case (a POST to Home Assistant, ntfy,
  // Discord, ...), but notify.ts also reads `method`, `headers` and `body` to shape that
  // request, and `command` to run a local argv instead - so the type is NotifyConfig rather
  // than just the URL. It was narrowed to { webhookUrl } before, which compiled only because
  // the narrow type is assignable to the notifier's wider one; the other keys always worked
  // at runtime (validateOptions spreads the received object), so this widening documents
  // existing behaviour and changes none of it.
  notify: NotifyConfig & { webhookUrl: string };
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
  dailyLimit: 0, // 0 = derive from the current rank; see Config.dailyLimit
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
  // Also what deploy/org.user.hebits-builder.plist points StandardOutPath/StandardErrorPath
  // at, which is what makes rotateLog() in server.ts rotate the log that actually exists.
  // The plist holds the machine-specific spelling of this path; this default stays portable.
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

// Every key notify.ts reads, so what the loader checks matches what Config['notify']
// promises. Only `webhookUrl` has an entry in DEFAULTS.notify; the other four have no
// default here and a bad one is simply dropped, leaving the notifier's own fallback
// (method 'POST', DEFAULT_BODY, no headers, no command) - see validateOptions().
//
// `command` is the one that bites. A string instead of an argv array makes
// `cfg.command?.length` truthy, so `notifier.enabled` stays true and nothing looks wrong,
// and then `.map()` on a string throws inside send()'s own catch - which logs and returns
// false. The result is a config typo silently disabling the only channel that would have
// told the owner the tracker is unhappy or the disk is full. Validating here turns that
// into a startup log line and a configIssues entry on /status.
const notifyShape: Record<string, z.ZodType> = {
  webhookUrl: z.string(),
  method: z.string(),
  // string | number: see NotifyConfig.headers - a numeric value is valid usage and is
  // stringified at the point of use, so rejecting it here would break a working config.
  headers: z.record(z.string(), z.union([z.string(), z.number()])),
  body: z.string(),
  command: z.array(z.string()),
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

// Every token this module has ever generated is randomBytes(16).toString('hex') - 32
// lowercase hex characters. Accepting only that exact shape out of unparseable text is
// deliberate: this value flows straight into the URL guard (tokenOk() in server.ts), so a
// loosely-shaped "close enough" match would leave the service running behind a secret the
// owner can't know and can't discover from config.json (it's gone, moved aside). Better to
// fall through to a normal fresh token than to trust a garbled one.
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

// What salvageToken() decided, and the clause explaining it that loadConfig() appends to the
// parse-failure message. `note` is never empty except when the file contained no "token" key
// at all: a token that was visibly in the file but did not survive must say why, or the owner
// is left with a rotated admin URL and no explanation.
interface Salvage {
  token?: string;
  note: string;
}

// Bounded on purpose: a single regex over the raw (unparseable) text, never an attempt to
// repair or partially parse the rest of the file. Used only when JSON.parse has already
// failed - see loadConfig(). A malformed config.json is the expected failure mode here (the
// file is hand-edited), and without this, every typo would rotate the token, so the
// `/<token>/status` and `/<token>/cookie` URLs the owner has bookmarked - and the one in any
// login alert already sitting in their notifications - all stop working at once.
//
// Treat this as a trust boundary, not a parser. Its input is by definition a malformed file,
// and its output becomes the URL secret that tokenOk() in server.ts is the only thing
// standing between the admin routes and an unauthenticated caller on the LAN. Two
// independent checks have to hold before a value is trusted:
//
//  - SHAPE. TOKEN_SHAPE above: exactly what randomBytes(16).toString('hex') produces.
//  - POSITION. The regex cannot tell nesting depth, so `"token"` at ANY depth matches - and
//    `notify.headers` is a supported place for an operator to put an auth header literally
//    named "token" (notify.ts reads headers/method/body/command). A non-global match would
//    take whichever came first in the text, which is how a webhook header's value once
//    became the sibling addon's URL secret while the code reported the operator's token had
//    been kept - every client URL dead, and the secret copied from a header that may be
//    shared with another system. So: collect every candidate, and salvage only when exactly
//    ONE is shape-valid. Zero or several fall through to a fresh token, which is the
//    already-correct default. Guessing between candidates is not an option here - "first"
//    and "last" are both wrong on some real file, silently.
function salvageToken(rawText: string): Salvage {
  const found: string[] = [];
  const valid: string[] = [];
  for (const match of rawText.matchAll(/"token"\s*:\s*"([^"]*)"/g)) {
    const candidate = match[1] ?? '';
    found.push(candidate);
    if (TOKEN_SHAPE.test(candidate)) valid.push(candidate);
  }
  const only = valid[0];
  if (valid.length === 1 && only !== undefined) return { token: only, note: ', kept its token so the existing admin URLs keep working' };
  if (valid.length > 1)
    return {
      note: `, and ${valid.length} token-shaped values were found in it so none could be trusted (a nested "token", e.g. a notify header, looks the same to a text search) - a fresh token was generated`,
    };
  if (found.length > 0)
    return { note: ', and the "token" in it is not the expected 32-character lowercase-hex shape - a fresh token was generated' };
  return { note: '' };
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
  // Any options object; only ever read as fallback[key] to name the default in a message.
  // Not Record<string, unknown>, so a caller can pass a precisely-typed default (such as
  // DEFAULTS.notify, whose NotifyConfig type has no index signature) without a cast.
  fallback: object,
  received: unknown,
  issues: string[],
): Record<string, unknown> {
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    logIssue(`"${name}" is a ${typeOf(received)}, not an object - using default`, issues);
    return {};
  }
  const out: Record<string, unknown> = { ...(received as Record<string, unknown>) };
  const defaults = fallback as Record<string, unknown>;
  for (const [key, schema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const result = schema.safeParse(out[key]);
    if (!result.success) {
      // Not every validated key has a default to name: notify's `method`, `headers`, `body`
      // and `command` are absent from DEFAULTS.notify, and "using default undefined" would
      // tell the owner nothing about what now happens. Dropping the key is the same action
      // either way; only the wording differs.
      const fix = key in defaults ? `using default ${JSON.stringify(defaults[key])}` : 'ignoring it';
      logIssue(`"${name}.${key}" is a ${typeOf(out[key])}, not the expected type - ${fix}`, issues);
      delete out[key];
    }
  }
  return out;
}

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const configIssues: string[] = [];
  let saved: Record<string, unknown> = {};
  // Whether it's safe to write CONFIG_FILE below. Cleared when the existing file could not
  // be read at all, and when a malformed one couldn't even be moved aside - writing in
  // either case would overwrite operator bytes we never saw with nothing but a fresh token,
  // which is strictly worse than leaving the file in place untouched.
  let canWrite = true;
  // Set once a broken file has been moved aside, so a salvaged token doesn't skip the write
  // below - config.json needs to exist again either way, and "token was already truthy from
  // salvage" is not the same signal as "nothing needs writing".
  let justRecovered = false;
  // A hand-edited config.json that fails to parse (trailing comma, truncated write, ...)
  // must not throw here: this runs at module load, before the notifier exists, so an
  // uncaught throw becomes a silent launchd restart loop - see the block comment above
  // validateScalar() for why every other field gets the same treatment. But treating the
  // parse failure as plain "no saved config" is worse than the throw it replaces: the token
  // block just below would then overwrite config.json with nothing but a fresh token,
  // destroying every other setting - a typo silently costing the owner their whole tuned
  // farm/cleanup policy. So move the broken file aside first; the owner recovers by fixing
  // the one bad character and restoring it.
  if (existsSync(CONFIG_FILE)) {
    // The read is inside the try for the same reason the parse is: a file that exists but
    // cannot be read throws just as fatally here (mode 000 after one sudo run, a directory
    // left in its place, a half-restored backup) and this runs at module load. It also has
    // to set canWrite = false - there is no text to salvage a token from, and rewriting a
    // file whose bytes we never saw is the same destruction the move-aside below exists to
    // prevent. Without that, guarding the read would only relocate the throw into the
    // writeFileSync further down.
    let raw: string | undefined;
    try {
      raw = readFileSync(CONFIG_FILE, 'utf8');
    } catch (e) {
      canWrite = false;
      logIssue(
        `config.json exists but could not be read (${(e as Error).message}) - running from in-memory defaults only, config.json left untouched`,
        configIssues,
      );
    }
    if (raw !== undefined) {
      try {
        // JSON.parse succeeding is not the same as getting a config back, and every guard
        // in this function until now caught only a parse FAILURE. `null`, a number, a string
        // and `true` all parse cleanly and then throw a TypeError on the very next statement
        // (`saved.token`), and would throw again at `key in saved` and `'farm' in saved` -
        // the `in` operator rejects primitives. That is the same silent KeepAlive restart
        // loop as an unguarded parse, through a different door.
        //
        // An array is worse precisely because it does NOT throw: JSON.stringify drops a
        // `token` property set on an array, so the file gets rewritten as the same array, a
        // fresh token is generated, and it is lost again on every single restart - so the
        // admin URL changes under the owner on a schedule nobody chose.
        //
        // None of these is a config, so they all take the corrupt-file path below rather
        // than getting a recovery mechanism of their own.
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error(`it holds a JSON ${typeOf(parsed)}, not an object of settings`);
        saved = parsed as Record<string, unknown>;
      } catch (e) {
        const badPath = `${CONFIG_FILE}.bad-${Date.now()}`;
        const salvaged = salvageToken(raw);
        if (salvaged.token) saved.token = salvaged.token;
        try {
          renameSync(CONFIG_FILE, badPath);
          justRecovered = true;
          logIssue(
            `config.json could not be loaded (${(e as Error).message}) - the original was moved to ${badPath}; starting from defaults${salvaged.note}`,
            configIssues,
          );
        } catch (renameError) {
          // Couldn't even move it aside (e.g. the config dir isn't writable) - leave the file
          // exactly as it is and run this process from in-memory defaults only. Do NOT fall
          // through to the write below.
          canWrite = false;
          logIssue(
            `config.json could not be loaded (${(e as Error).message}) and could not be moved aside (${(renameError as Error).message}) - running from in-memory defaults only, config.json left untouched`,
            configIssues,
          );
        }
      }
    }
  }
  // `token` gets the same treatment as every other field: a hand-edited typo must not stop
  // the service. It was the one field exempted, and the exemption was total - a truthy
  // non-string is passed straight to tokenOk()'s Buffer.from() in server.ts, which throws
  // ERR_INVALID_ARG_TYPE on EVERY route (a JSON array doesn't even throw: Buffer.from(['ab'])
  // succeeds, so every URL simply 404s). Worse, a truthy value means the block below never
  // rewrites config.json, so the service stays dead across restarts and /cookie - the page
  // that exists to recover an expired login from a browser - is dead with it, which also
  // means auto-grab never resumes. The owner's only way out is hand-editing JSON on the
  // target. Falling back to a fresh token rotates the admin URL, but it leaves a service
  // that answers and a configIssues line on /status saying why.
  if (saved.token !== undefined && typeof saved.token !== 'string')
    logIssue(`"token" is a ${typeOf(saved.token)}, not a string - a fresh token was generated, so the admin URLs changed`, configIssues);
  let token = typeof saved.token === 'string' ? saved.token : undefined;
  let tokenWasGenerated = false;
  if (!token) {
    token = randomBytes(16).toString('hex');
    saved.token = token;
    tokenWasGenerated = true;
  }
  // Write whenever a fresh token was generated (original behaviour), or whenever the file on
  // disk was just moved aside and needs replacing - even when the token itself was salvaged
  // rather than generated, config.json still doesn't exist on disk any more.
  if (canWrite && (tokenWasGenerated || justRecovered)) {
    // Unguarded, this throws uncaught for a config dir that exists but isn't writable - the
    // same silent restart loop again, and reachable on a completely ordinary config (no
    // config.json at all, dir mode 500: token generated, canWrite still true, EACCES).
    // Running this session from an in-memory token is strictly better than not running: it
    // is exactly what the "couldn't move it aside" path above already does.
    try {
      writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    } catch (e) {
      logIssue(
        `config.json could not be written (${(e as Error).message}) - the builder is running with a token that exists only in memory, so it will change on the next restart; fix the permissions on ${CONFIG_DIR}`,
        configIssues,
      );
    }
  }

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
      ...validateOptions('farm', grabOptionsShape, DEFAULTS.farm, saved.farm, configIssues),
    };
  if ('cleanup' in saved)
    validated.cleanup = {
      ...DEFAULTS.cleanup,
      ...validateOptions('cleanup', cleanupOptionsShape, DEFAULTS.cleanup, saved.cleanup, configIssues),
    };
  if ('notify' in saved)
    validated.notify = {
      ...DEFAULTS.notify,
      ...validateOptions('notify', notifyShape, DEFAULTS.notify, saved.notify, configIssues),
    };

  const cfg: Config = { ...DEFAULTS, ...validated, token, configIssues } as Config;
  // A bad custom torrentDir (unwritable parent, a path through a file, ...) must not throw
  // here either, for the same reason as the JSON.parse above - fall back to the default,
  // which lives inside CONFIG_DIR and is normally creatable since that mkdirSync already
  // succeeded above. "Normally" is doing real work in that sentence: a plain file named
  // "torrents" sitting inside CONFIG_DIR would make the fallback fail too, so that retry is
  // guarded as well - the module-load path must not throw no matter what's on disk.
  try {
    mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    logIssue(`"torrentDir" (${cfg.torrentDir}) could not be created: ${(e as Error).message} - using default`, configIssues);
    cfg.torrentDir = DEFAULTS.torrentDir;
    try {
      mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
    } catch (e2) {
      logIssue(
        `the default torrentDir (${cfg.torrentDir}) could not be created either: ${(e2 as Error).message} - grabbing will fail until this is fixed`,
        configIssues,
      );
    }
  }
  return cfg;
}

// Missing or unreadable (absent, a directory, permission-denied, ...): undefined, never a
// throw. The /cookie page is the only way to install one, so a server that refuses to start
// without a readable cookie file can never be recovered.
export function readCookie(): string | undefined {
  try {
    const raw = readFileSync(COOKIE_FILE, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export function writeCookie(cookie: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(COOKIE_FILE, `${cookie.trim()}\n`, { mode: 0o600 });
}
