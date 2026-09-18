import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jackettPaths } from '../lib/config.js';

test('jackett paths follow the platform convention', () => {
  const mac = jackettPaths('darwin', '/Users/x', {});
  assert.match(mac.serverConfig, /Library\/Application Support\/Jackett\/ServerConfig\.json$/);
  assert.match(mac.indexerConfig('hebits'), /Jackett\/Indexers\/hebits\.json$/);

  const linux = jackettPaths('linux', '/home/x', {});
  assert.equal(linux.serverConfig, '/home/x/.config/Jackett/ServerConfig.json');

  const xdg = jackettPaths('linux', '/home/x', { XDG_CONFIG_HOME: '/cfg' });
  assert.equal(xdg.serverConfig, '/cfg/Jackett/ServerConfig.json');

  const win = jackettPaths('win32', 'C:\\Users\\x', { ProgramData: 'C:\\ProgramData' });
  assert.match(win.serverConfig, /Jackett.ServerConfig\.json$/);
});
