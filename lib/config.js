import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
export const CONFIG_DIR = process.env.HEBITS_BUILDER_DIR || join(HOME, '.config', 'hebits-account-builder');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// Jackett's own data directory, per platform. Override with `jackettConfig` /
// `jackettIndexerConfig` if yours lives somewhere else.
export function jackettPaths(platform = process.platform, home = HOME, env = process.env) {
  const dir =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Jackett')
      : platform === 'win32'
        ? join(env.ProgramData || 'C:\\ProgramData', 'Jackett')
        : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Jackett');
  return {
    serverConfig: join(dir, 'ServerConfig.json'),
    indexerConfig: (indexer) => join(dir, 'Indexers', `${indexer}.json`),
  };
}

const DEFAULTS = {
  port: 7001,
  // Hebits Heb Rookie: 5 on day one, then 10. Raise when the account ranks up.
  dailyLimit: 10,
  // Per-day exceptions, e.g. { "2026-09-17": 5 } for the account's first day.
  dailyLimitByDay: {},
  // Keep this much disk free after a download.
  minFreeGB: 20,
  timezone: 'Asia/Jerusalem',
  jackettUrl: 'http://127.0.0.1:9117',
  jackettIndexer: 'hebits',
  jackettConfig: jackettPaths().serverConfig,
  jackettIndexerConfig: jackettPaths().indexerConfig('hebits'),
  qbitUrl: 'http://127.0.0.1:8080',
  // Only needed when "bypass authentication for localhost" is off.
  qbitUsername: '',
  qbitPassword: '',
  watchCategory: 'watch',
  watchPath: join(HOME, 'hebits', 'watch'),
  seedCategory: 'seed-auto',
  seedPath: join(HOME, 'hebits', 'seed'),
  // Account building (see lib/farm.js for the knobs and their defaults).
  farm: { enabled: true, intervalMin: 10 },
  cleanup: { enabled: true, intervalMin: 30 },
  // Home Assistant webhook, e.g. http://homeassistant.local:8123/api/webhook/<id>
  notify: { webhookUrl: '' },
  lowDiskAlertGB: 15,
  torrentDir: join(CONFIG_DIR, 'torrents'),
  logFile: join(CONFIG_DIR, 'builder.log'),
};

export function loadConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved = {};
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  if (!saved.token) {
    saved.token = randomBytes(16).toString('hex');
    writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  }
  const cfg = { ...DEFAULTS, ...saved };
  if (!saved.jackettIndexerConfig && saved.jackettIndexer) {
    cfg.jackettIndexerConfig = jackettPaths().indexerConfig(saved.jackettIndexer);
  }
  mkdirSync(cfg.torrentDir, { recursive: true, mode: 0o700 });
  if (!cfg.jackettApiKey) {
    let key;
    try {
      key = JSON.parse(readFileSync(cfg.jackettConfig, 'utf8')).APIKey;
    } catch (e) {
      throw new Error(
        `Could not read Jackett's API key from ${cfg.jackettConfig}: ${e.message}\n` +
          `Set "jackettApiKey" and "jackettConfig" in ${CONFIG_FILE}.`,
      );
    }
    if (!key) {
      throw new Error(
        `Jackett's config at ${cfg.jackettConfig} has no API key set.\n` +
          `Set "jackettApiKey" and "jackettConfig" in ${CONFIG_FILE}.`,
      );
    }
    cfg.jackettApiKey = key;
  }
  return cfg;
}
