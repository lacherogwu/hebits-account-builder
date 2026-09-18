import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Notifier } from '../lib/notify.js';

async function withHook(fn) {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      got.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/webhook/x`, got);
  } finally {
    server.close();
  }
}

test('sends, then stays quiet for the same kind until reset', async () => {
  await withHook(async (url, got) => {
    const state = {};
    const n = new Notifier({ webhookUrl: url }, state, () => {}, () => {});
    assert.equal(await n.send('login', 'T', 'M', { now: 1000 }), true);
    assert.equal(await n.send('login', 'T', 'M', { now: 2000 }), false);
    assert.equal(await n.send('disk', 'T2', 'M2', { now: 2000 }), true);
    n.reset('login');
    assert.equal(await n.send('login', 'T', 'M', { now: 3000 }), true);
    assert.deepEqual(got.map((g) => g.kind), ['login', 'disk', 'login']);
    assert.deepEqual(got[0], { kind: 'login', title: 'T', message: 'M' });
  });
});

test('disabled without a URL, and survives an unreachable hook', async () => {
  const off = new Notifier({}, {}, () => {}, () => {});
  assert.equal(await off.send('x', 't', 'm'), false);
  const logs = [];
  const bad = new Notifier({ webhookUrl: 'http://127.0.0.1:9/nothing' }, {}, () => {}, (m) => logs.push(m));
  assert.equal(await bad.send('x', 't', 'm'), false);
  assert.equal(logs.length, 1);
});
