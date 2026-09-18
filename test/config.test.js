import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jackettPaths } from '../lib/config.js';

test('jackett paths follow the platform convention', () => {
  const mac = jackettPaths('darwin', '/Users/x', {});
  assert.match(mac.serverConfig, /Library\/Application Support\/Jackett\/ServerConfig\.json$/);
  assert.match(mac.indexerConfig('hebits'), /Jackett\/Indexers\/hebits\.json$/);

  const linux = jackettPaths('linux', '/home/x', {});
  assert.equal(linux.serverConfig, '/home/x/.config/Jackett/ServerConfig.json');

  const xdg = jackettPaths('linux', '/home/x', { XDG_CONFIG_HOME: '/cfg' });
  assert.equal(xdg.serverConfig, '/cfg/Jackett/ServerConfig.json');

  // Per the XDG spec, an empty (but set) XDG_CONFIG_HOME falls back to ~/.config too.
  const xdgEmpty = jackettPaths('linux', '/home/x', { XDG_CONFIG_HOME: '' });
  assert.equal(xdgEmpty.serverConfig, '/home/x/.config/Jackett/ServerConfig.json');

  const win = jackettPaths('win32', 'C:\\Users\\x', { ProgramData: 'C:\\ProgramData' });
  assert.match(win.serverConfig, /Jackett.ServerConfig\.json$/);
});

test('loadConfig explains itself when Jackett has no API key set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebits-config-'));
  writeFileSync(join(dir, 'jackett-server-config.json'), JSON.stringify({ SomeOtherField: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ jackettConfig: join(dir, 'jackett-server-config.json') }));

  process.env.HEBITS_BUILDER_DIR = dir;
  // Bust the module cache: CONFIG_DIR is captured at import time from the env var above.
  const { loadConfig } = await import(`../lib/config.js?t=${Date.now()}-${Math.random()}`);

  assert.throws(
    () => loadConfig(),
    (e) => {
      assert.match(e.message, /no API key set/);
      assert.match(e.message, /jackettApiKey/);
      assert.match(e.message, /jackett-server-config\.json/);
      return true;
    },
  );
  delete process.env.HEBITS_BUILDER_DIR;
});
