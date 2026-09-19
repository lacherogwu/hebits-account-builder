import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'hebits-cfg-'));
  process.env.HEBITS_BUILDER_DIR = dir;
});
afterEach(() => {
  delete process.env.HEBITS_BUILDER_DIR;
});

function writeConfig(contents: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(contents), { mode: 0o600 });
}

test('loadConfig generates a token on first run and keeps it on the second', async () => {
  const { loadConfig } = await import('../src/config');
  const a = loadConfig();
  expect(a.token).toMatch(/^[0-9a-f]{32}$/);
  expect(loadConfig().token).toBe(a.token);
});

test('loadConfig writes config.json with owner-only permissions', async () => {
  const { loadConfig } = await import('../src/config');
  loadConfig();
  expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
});

test('a missing cookie is undefined, not a throw', async () => {
  const { readCookie } = await import('../src/config');
  expect(readCookie(join(dir, 'cookie.txt'))).toBeUndefined();
});

test('a written cookie round-trips and is owner-only', async () => {
  const { readCookie, writeCookie } = await import('../src/config');
  const path = join(dir, 'cookie.txt');
  writeCookie(path, '  session=abc123  ');
  expect(readCookie(path)).toBe('session=abc123');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('the cookie is never written into config.json', async () => {
  const { loadConfig, writeCookie } = await import('../src/config');
  const cfg = loadConfig();
  writeCookie(cfg.cookiePath, 'session=secret');
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('secret');
});

// --- cookiePath ---------------------------------------------------------------------------
// It defaults inside the config directory, and every other path in this service is
// configurable, so this one is too. The asymmetry mattered: sharing one cookie file between
// two services was only possible in one direction, which forced the *other* service to point
// into this one's private config directory and quietly depend on it continuing to exist.

test('cookiePath defaults inside the config directory', async () => {
  const { loadConfig } = await import('../src/config');
  expect(loadConfig().cookiePath).toBe(join(dir, 'cookie.txt'));
});

test('a custom cookiePath is honoured, and its parent directory is created', async () => {
  // Outside CONFIG_DIR and two levels deep: the old writeCookie created CONFIG_DIR, so a
  // shared path in a directory nobody had made would have failed with ENOENT.
  const shared = join(dir, 'shared', 'hebits', 'cookie.txt');
  writeConfig({ cookiePath: shared });
  const { loadConfig, readCookie, writeCookie } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.cookiePath).toBe(shared);

  writeCookie(cfg.cookiePath, 'session=shared');

  expect(existsSync(shared)).toBe(true);
  expect(readCookie(shared)).toBe('session=shared');
  expect(statSync(shared).mode & 0o777).toBe(0o600);
  // The default location stays empty - proving the custom path was used, not merely accepted.
  expect(existsSync(join(dir, 'cookie.txt'))).toBe(false);
});

test('a non-string cookiePath falls back to the default and is recorded in configIssues', async () => {
  writeConfig({ cookiePath: 42 });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.cookiePath).toBe(join(dir, 'cookie.txt'));
  expect(cfg.configIssues.some((m) => m.includes('cookiePath'))).toBe(true);
});

test('a valid config.json passes through untouched', async () => {
  writeConfig({
    port: 9001,
    lanHost: '192.0.2.1',
    minFreeGB: 25,
    farm: { enabled: false, intervalMin: 5, maxPerRun: 1 },
    notify: { webhookUrl: 'http://example.invalid/webhook' },
  });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.port).toBe(9001);
  expect(cfg.lanHost).toBe('192.0.2.1');
  expect(cfg.minFreeGB).toBe(25);
  expect(cfg.farm).toEqual({ enabled: false, intervalMin: 5, maxPerRun: 1 });
  expect(cfg.notify).toEqual({ webhookUrl: 'http://example.invalid/webhook' });
  expect(cfg.configIssues).toEqual([]);
});

test('a bad field falls back to its default without discarding the rest of the file', async () => {
  writeConfig({ minFreeGB: '20', lanHost: '192.0.2.1', port: 9001 });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.minFreeGB).toBe(20); // DEFAULTS.minFreeGB, the string was rejected
  expect(cfg.lanHost).toBe('192.0.2.1'); // untouched, valid field survives
  expect(cfg.port).toBe(9001);
  expect(cfg.configIssues).toHaveLength(1);
  expect(cfg.configIssues[0]).toContain('minFreeGB');
});

test('a bad nested farm key falls back while sibling farm keys survive', async () => {
  writeConfig({ farm: { enabled: true, intervalMin: '10', maxPerRun: 1 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.farm).toEqual({ enabled: true, intervalMin: 10, maxPerRun: 1 }); // intervalMin: DEFAULTS.farm.intervalMin
  expect(cfg.configIssues.some((i) => i.includes('farm.intervalMin'))).toBe(true);
});

test('unknown top-level and nested keys are preserved, not rejected', async () => {
  writeConfig({ futureKey: 'kept', farm: { enabled: true, futureFarmKnob: 42 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect((cfg as unknown as Record<string, unknown>).futureKey).toBe('kept');
  expect((cfg.farm as Record<string, unknown>).futureFarmKnob).toBe(42);
  expect(cfg.configIssues).toEqual([]);
});

test('multiple bad fields are all collected in configIssues', async () => {
  writeConfig({ minFreeGB: '20', port: 'nope', notify: { webhookUrl: 5 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.configIssues.length).toBeGreaterThanOrEqual(3);
  expect(cfg.minFreeGB).toBe(20);
  expect(cfg.port).toBe(7001);
  expect(cfg.notify).toEqual({ webhookUrl: '' });
});

// --- loadConfig() must never throw --------------------------------------------------------
// Everything below pins the same property from a different direction: loadConfig() runs at
// module load under a supervisor that restarts on exit, before the Notifier exists, so an
// uncaught throw here is not a crash the owner hears about - it is a silent restart loop with no
// alert, because the process dies before anything that could send one exists.
//
// Each test asserts the POST-STATE, not merely that a guard fired. The guard is the easy half:
// a service of this shape has shipped one that caught the parse error and then rewrote
// config.json as nothing but a fresh token, destroying every other setting - and its test
// passed, because it only checked that a message mentioned "json".

test('malformed JSON in config.json is moved aside, not silently destroyed', async () => {
  const original =
    '{ "port": 9001, "qbitUsername": "alice", "notify": { "webhookUrl": "http://example.invalid/hook" }, "token": "original"';
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();

  // The owner's original bytes must survive intact under a renamed path.
  const badFile = readdirSync(dir).find((f) => f.startsWith('config.json.bad-'));
  expect(badFile).toBeTruthy();
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);

  // config.json itself is a fresh, valid file - not the owner's settings minus everything but
  // a token, and not the old (unrecoverable-from-broken-JSON) token either.
  const rewritten = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  expect(rewritten.token).toMatch(/^[0-9a-f]{32}$/);
  expect(rewritten.token).not.toBe('original');
  expect(cfg?.token).toBe(rewritten.token);
  expect(cfg?.configIssues.some((m) => m.includes(badFile as string))).toBe(true);
});

// A typo is the expected way config.json breaks (it's hand-edited), so rotating the token on
// every one of them is a real cost: the owner's bookmarked /status and /cookie URLs, and the
// one in any login alert already sitting in their notifications, all die at once.
test('malformed config.json with a shape-valid token keeps that token, unchanged, in the fresh file', async () => {
  const validToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 lowercase hex - loadConfig()'s own shape
  const original = `{ "port": 9001, "token": "${validToken}"`; // truncated: still unparseable
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBe(validToken);
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token).toBe(validToken);

  // Still moved aside, still byte-identical - the salvage doesn't change that half at all.
  const badFile = readdirSync(dir).find((f) => f.startsWith('config.json.bad-'));
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(true);
});

test('malformed config.json with no token-shaped value gets a fresh token, original still preserved', async () => {
  const original = '{ "port": 9001, "token": "not-a-hex-token"'; // truncated, and not 32 hex chars
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);
  expect(cfg.token).not.toBe('not-a-hex-token');
  const badFile = readdirSync(dir).find((f) => f.startsWith('config.json.bad-'));
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(false);
  // A token was visibly in the file and did not survive - say why, or the owner is left with
  // a rotated admin URL and no explanation anywhere.
  expect(cfg.configIssues.some((m) => m.includes('not the expected 32-character lowercase-hex shape'))).toBe(true);
});

// salvageToken() runs a text search over a file that by definition doesn't parse, so it cannot
// tell nesting depth: notify.headers is a supported place for an auth header literally named
// "token" (notify.ts reads headers/method/body/command), and a non-global regex takes whichever
// "token" comes first in the text. That is the whole hole - shape was never the weak part,
// position was. Here the nested one comes first and is not token-shaped, so the real token
// must still be the one that survives.
test('a nested notify.headers.token ahead of the real one does not displace it', async () => {
  const realToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const original = `{ "notify": { "headers": { "token": "Bearer not-hex-at-all" } }, "token": "${realToken}"`;
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toBe(realToken);
  // Pin the post-state, not just the return value: this is what the admin URL is read from on
  // the next restart.
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token).toBe(realToken);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(true);
});

// The reported case: the nested header value IS 32 lowercase hex (an ordinary thing for a
// webhook auth header to be), so shape cannot separate it from the real token. Adopting either
// would be a guess, and the wrong guess silently hands the service's URL secret a value copied
// from a header that may be shared with another system, while reporting the token was kept.
test('two token-shaped candidates produce a fresh token rather than a guess', async () => {
  const headerToken = 'ffffffffffffffffffffffffffffffff';
  const realToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const original = `{ "notify": { "headers": { "token": "${headerToken}" } }, "token": "${realToken}"`;
  writeFileSync(join(dir, 'config.json'), original);
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).not.toBe(headerToken);
  expect(cfg.token).not.toBe(realToken);
  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token).toBe(cfg.token);
  expect(cfg.configIssues.some((m) => m.includes('kept its token'))).toBe(false);
  expect(cfg.configIssues.some((m) => m.includes('none could be trusted'))).toBe(true);

  // The original is still recoverable, so the real token is not lost - just not guessed at.
  const badFile = readdirSync(dir).find((f) => f.startsWith('config.json.bad-'));
  expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(original);
});

// JSON.parse succeeding is not the same as getting a config back. `null`, a number, a string
// and `true` all parse cleanly and then throw a TypeError on the very next statement; an array
// is worse because it does NOT throw - JSON.stringify drops a property set on an array, so the
// file is rewritten as the same array and a fresh token is minted and lost on every restart.
for (const [label, body] of [
  ['null', 'null'],
  ['a number', '42'],
  ['a string', '"hello"'],
  ['a boolean', 'true'],
  ['an array', '[1,2]'],
] as const) {
  test(`a config.json holding ${label} is moved aside and replaced with a fresh one`, async () => {
    writeFileSync(join(dir, 'config.json'), body);
    const { loadConfig } = await import('../src/config');
    let cfg: ReturnType<typeof loadConfig> | undefined;
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();

    const badFile = readdirSync(dir).find((f) => f.startsWith('config.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(body);

    // The array case is why this asserts the file's contents rather than only that a token
    // came back: `[1,2]` returned a perfectly good token before, and threw it away on disk.
    const rewritten = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(Array.isArray(rewritten)).toBe(false);
    expect(rewritten.token).toBe(cfg?.token);
    expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(cfg?.configIssues.some((m) => m.includes('not an object of settings'))).toBe(true);

    // And it stays: a second load must read the same token back, not mint another one.
    vi.resetModules();
    const { loadConfig: again } = await import('../src/config');
    expect(again().token).toBe(cfg?.token);
  });
}

test('a config.json that cannot even be moved aside runs from in-memory defaults, file untouched', async () => {
  const original = '{ this is not valid json';
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  chmodSync(dir, 0o500); // read+exec only: renameSync into/out of it fails with EACCES
  try {
    const { loadConfig } = await import('../src/config');
    let cfg: ReturnType<typeof loadConfig> | undefined;
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
    expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/); // usable this run, just never written to disk
    expect(cfg?.configIssues.some((m) => m.includes('could not be moved aside'))).toBe(true);
  } finally {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  }
  expect(readFileSync(cfgPath, 'utf8')).toBe(original); // left exactly as it was
  // Glob, not a literal name: `config.json.bad-` with no timestamp is a file no implementation
  // ever writes, so asserting its absence would pass unconditionally - including against an
  // implementation that did wrongly move the file aside.
  expect(readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))).toBeUndefined();
});

test('an unreadable config.json (permission denied) does not throw and is left untouched', async () => {
  const original = '{ "dailyLimit": 3, "token": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }\n';
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, original);
  chmodSync(cfgPath, 0o000); // EACCES: e.g. left behind by a single sudo run
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
  } finally {
    chmodSync(cfgPath, 0o600); // restore so the bytes can be read back (and cleaned up)
  }

  // Post-state, the half that matters: a file we could not read must not be rewritten - that
  // would destroy bytes we never saw - and must not be moved aside either.
  expect(readFileSync(cfgPath, 'utf8')).toBe(original);
  expect(readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))).toBeUndefined();

  // Nothing was read, so nothing was applied: 0 is DEFAULTS.dailyLimit, the sentinel that
  // means "derive the allowance from the rank the account holds" (see Config.dailyLimit).
  expect(cfg?.dailyLimit).toBe(0);
  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/); // usable this session, in memory only
  expect(cfg?.configIssues.some((m) => m.includes('could not be read'))).toBe(true);
});

test('a config.json that is a directory (EISDIR) does not throw and is left in place', async () => {
  const cfgPath = join(dir, 'config.json');
  mkdirSync(cfgPath); // existsSync() is true, readFileSync() throws EISDIR
  writeFileSync(join(cfgPath, 'marker'), 'still here');
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();

  expect(statSync(cfgPath).isDirectory()).toBe(true);
  expect(readFileSync(join(cfgPath, 'marker'), 'utf8')).toBe('still here');
  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
  expect(cfg?.configIssues.some((m) => m.includes('could not be read'))).toBe(true);
});

// Reachable on a completely ordinary config: no config.json at all, config dir not writable.
// existsSync() is false, so none of the malformed-file paths run - a token is generated with
// canWrite still true, and the write itself is what throws.
test('an unwritable config dir with no config.json runs from an in-memory token', async () => {
  chmodSync(dir, 0o500); // read+exec only: creating config.json in it fails with EACCES
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    expect(() => {
      cfg = loadConfig();
    }).not.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(cfg?.token).toMatch(/^[0-9a-f]{32}$/);
  expect(existsSync(join(dir, 'config.json'))).toBe(false);
  expect(cfg?.configIssues.some((m) => m.includes('could not be written'))).toBe(true);
});

// config.example.json's own torrentDir has crashed a service of this shape into a supervisor
// restart loop before (an unguarded mkdirSync threw for a path macOS can't create).
test('an uncreatable torrentDir falls back to the default and is recorded in configIssues', async () => {
  const blocker = join(dir, 'blocker'); // a file, not a directory
  writeFileSync(blocker, 'not a directory');
  writeConfig({ torrentDir: join(blocker, 'torrents') });
  const { loadConfig, CONFIG_DIR } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();
  expect(cfg?.torrentDir).toBe(join(CONFIG_DIR, 'torrents'));
  expect(cfg?.configIssues.some((m) => m.includes('torrentDir'))).toBe(true);
  expect(statSync(cfg?.torrentDir as string).isDirectory()).toBe(true);
});

// The fallback is only "normally creatable". A plain file sitting where the default directory
// would go makes the retry fail too - and an unguarded retry merely moves the crash three
// lines down, which is what a service of this shape has shipped before.
test('a torrentDir whose fallback is also uncreatable still does not throw', async () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  writeFileSync(join(dir, 'torrents'), 'a file where the default torrentDir would go');
  writeConfig({ torrentDir: join(blocker, 'torrents') });
  const { loadConfig } = await import('../src/config');
  let cfg: ReturnType<typeof loadConfig> | undefined;
  expect(() => {
    cfg = loadConfig();
  }).not.toThrow();
  expect(cfg?.configIssues.some((m) => m.includes('could not be created either'))).toBe(true);
});

// `token` was the one field exempt from the per-field contract, and the exemption was total: a
// truthy non-string reaches tokenOk()'s Buffer.from() in server.ts and throws
// ERR_INVALID_ARG_TYPE on EVERY route - /cookie, the page that exists to recover an expired
// login from a browser, included - and, being truthy, it also stopped config.json ever being
// rewritten, so the service stayed dead across restarts with no in-band way out.
test('a non-string token falls back to a fresh one and is recorded, not left to 500 every route', async () => {
  writeConfig({ token: 12345, port: 9001 });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();

  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);
  expect(cfg.port).toBe(9001); // the rest of the file is untouched: this is a per-field fallback
  expect(cfg.configIssues.some((m) => m.includes('"token"'))).toBe(true);
  // Written back, so the recovery survives a restart rather than minting a new token each time.
  const rewritten = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  expect(rewritten.token).toBe(cfg.token);
  // The property that was actually broken: Buffer.from() on the token must not throw.
  expect(() => Buffer.from(cfg.token)).not.toThrow();
});

// A JSON array is the nastier shape: Buffer.from(['ab']) does not throw, so every URL simply
// 404s with nothing in the log to say why.
test('an array token is rejected the same way, so routing cannot silently 404 forever', async () => {
  writeConfig({ token: ['ab'] });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.token).toMatch(/^[0-9a-f]{32}$/);
  expect(cfg.configIssues.some((m) => m.includes('"token" is a array'))).toBe(true);
});

// A string where an argv array belongs keeps `notifier.enabled` truthy (a non-empty string has
// a .length), so nothing looks wrong - and then .map() on it throws inside send()'s own catch,
// which logs and returns false. A config typo silently disabling the only channel that would
// have told the owner the disk is full.
test('a wrong-typed notify.command is dropped and recorded, never reaching the notifier', async () => {
  writeConfig({ notify: { webhookUrl: '', command: '/usr/bin/say hello' } });
  const { loadConfig } = await import('../src/config');
  const { Notifier } = await import('../src/notify');
  const cfg = loadConfig();

  expect(cfg.notify.command).toBeUndefined();
  expect(cfg.configIssues.some((m) => m.includes('notify.command'))).toBe(true);
  // The post-state that matters: the notifier built from this config reports itself disabled,
  // rather than claiming to work and failing silently on every alert.
  expect(new Notifier(cfg.notify).enabled).toBe(false);
});

// The positive control for the four notify keys the loader now checks: a correctly-typed value
// of the same name must survive untouched, or the validator is just deleting the key.
test('each notify key is type-checked, and correctly-typed ones survive', async () => {
  writeConfig({
    notify: { webhookUrl: 'http://example.invalid/hook', method: 'PUT', headers: { authorization: 'Bearer x', 'x-id': 7 }, body: '{}' },
  });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.notify).toEqual({
    webhookUrl: 'http://example.invalid/hook',
    method: 'PUT',
    headers: { authorization: 'Bearer x', 'x-id': 7 },
    body: '{}',
  });
  expect(cfg.configIssues).toEqual([]);
});

// --- Rank targets and presets -------------------------------------------------------------
// config.ts spells the rank and preset names out itself rather than importing farm.ts (see the
// comment above grabOptionsShape). These two tests are what keeps the two copies honest, and
// they do it behaviourally: every name farm.ts publishes must be a name config.json accepts.

test('every rank the ladder publishes is accepted as farm.targetRank', async () => {
  const { RANK_NAMES, AUTO_TARGET } = await import('../src/farm');
  for (const name of [...RANK_NAMES, AUTO_TARGET]) {
    vi.resetModules();
    writeConfig({ farm: { targetRank: name } });
    const { loadConfig } = await import('../src/config');
    const cfg = loadConfig();
    expect(cfg.configIssues, `${name} should be a valid targetRank`).toEqual([]);
    expect((cfg.farm as Record<string, unknown>).targetRank).toBe(name);
  }
});

test('every preset the policy publishes is accepted as farm.preset', async () => {
  const { PRESET_NAMES } = await import('../src/farm');
  for (const name of PRESET_NAMES) {
    vi.resetModules();
    writeConfig({ farm: { preset: name } });
    const { loadConfig } = await import('../src/config');
    const cfg = loadConfig();
    expect(cfg.configIssues, `${name} should be a valid preset`).toEqual([]);
    expect((cfg.farm as Record<string, unknown>).preset).toBe(name);
  }
});

test('a misspelled rank or preset is reported as a bad VALUE, not a bad type', async () => {
  writeConfig({ farm: { targetRank: 'Heb Fanatik', preset: 'ratio-fist', maxPerRun: 1 } });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  // Both are dropped, so farm.ts falls back rather than chasing a rank nobody asked for.
  expect((cfg.farm as Record<string, unknown>).targetRank).toBeUndefined();
  expect((cfg.farm as Record<string, unknown>).preset).toBeUndefined();
  // The sibling key survives, as every other per-field fallback in this file does.
  expect((cfg.farm as Record<string, unknown>).maxPerRun).toBe(1);
  // The message has to name the value and what was allowed. "is a string, not the expected
  // type" would send the owner looking for the wrong mistake entirely.
  const rank = cfg.configIssues.find((m) => m.includes('farm.targetRank'));
  expect(rank).toContain('"Heb Fanatik"');
  expect(rank).toContain('"Heb Lover"');
  expect(cfg.configIssues.find((m) => m.includes('farm.preset'))).toContain('"ratio-fist"');
});

test('per-dimension weights survive when valid and fall back whole when not', async () => {
  writeConfig({ farm: { weights: { ratio: 0.5, volume: 2 } } });
  const { loadConfig } = await import('../src/config');
  expect((loadConfig().farm as Record<string, unknown>).weights).toEqual({ ratio: 0.5, volume: 2 });

  vi.resetModules();
  writeConfig({ farm: { weights: { ratio: 'lots' }, maxPerRun: 1 } });
  const { loadConfig: reload } = await import('../src/config');
  const cfg = reload();
  // One bad weight drops the whole object back to the preset it meant to modify: a partially
  // applied weighting is not a weighting anyone chose.
  expect((cfg.farm as Record<string, unknown>).weights).toBeUndefined();
  expect((cfg.farm as Record<string, unknown>).maxPerRun).toBe(1);
  expect(cfg.configIssues.some((m) => m.includes('farm.weights'))).toBe(true);
});

// --- Adoption -------------------------------------------------------------------------------
// `trackerHost` is half of the test that decides whether a torrent already in qBittorrent may
// be adopted - and so whether the cleanup pass may ever delete it. config.ts spells the default
// out itself rather than importing farm.ts (see grabOptionsShape's comment); this is what keeps
// the two copies equal.

test('the default trackerHost is the tracker the policy checks against', async () => {
  const { HEBITS_TRACKER_HOST } = await import('../src/farm');
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.trackerHost).toBe(HEBITS_TRACKER_HOST);
  expect(cfg.configIssues).toEqual([]);
});

test('a trackerHost of the wrong type falls back to the default and is reported', async () => {
  // Left unvalidated, `cfg.trackerHost?.trim()` in adoptTick throws on every pass - which,
  // inside cleanupTick, is the release job failing on a config typo.
  writeConfig({ trackerHost: 1234 });
  const { loadConfig } = await import('../src/config');
  const cfg = loadConfig();
  expect(cfg.trackerHost).toBe('hebits.net');
  expect(cfg.configIssues.join('\n')).toContain('"trackerHost" is a number');
});

test('a custom trackerHost is honoured', async () => {
  writeConfig({ trackerHost: 'tracker.example.test' });
  const { loadConfig } = await import('../src/config');
  expect(loadConfig().trackerHost).toBe('tracker.example.test');
});
