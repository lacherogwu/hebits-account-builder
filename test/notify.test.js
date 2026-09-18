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

import { renderTemplate } from '../lib/notify.js';

test('renderTemplate substitutes raw by default', () => {
  assert.equal(renderTemplate('{{title}}: {{message}}', { title: 'A', message: 'B' }), 'A: B');
});

test('renderTemplate json-escapes so a quote cannot break the body', () => {
  const out = renderTemplate('{"t":"{{json:title}}"}', { title: 'He said "hi"\nbye' });
  assert.deepEqual(JSON.parse(out), { t: 'He said "hi"\nbye' });
});

test('renderTemplate url-encodes', () => {
  assert.equal(renderTemplate('q={{url:title}}', { title: 'a b&c' }), 'q=a%20b%26c');
});

test('renderTemplate blanks unknown keys', () => {
  assert.equal(renderTemplate('[{{nope}}]', {}), '[]');
});

test('the default body keeps the shape the Home Assistant automation expects', async () => {
  const sent = [];
  const n = new Notifier(
    { webhookUrl: 'http://hook' }, {}, () => {}, () => {},
    { fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; } },
  );
  await n.send('disk', 'Title', 'Message');
  assert.equal(sent[0].url, 'http://hook');
  assert.equal(sent[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(sent[0].init.body), { kind: 'disk', title: 'Title', message: 'Message' });
});

test('a custom method, headers and body are honoured', async () => {
  const sent = [];
  const n = new Notifier(
    {
      webhookUrl: 'http://ntfy/topic',
      method: 'PUT',
      headers: { Title: 'x', 'content-type': 'text/plain' },
      body: '{{message}}',
    },
    {}, () => {}, () => {},
    { fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; } },
  );
  await n.send('k', 'T', 'M');
  assert.equal(sent[0].init.method, 'PUT');
  assert.equal(sent[0].init.body, 'M');
  assert.equal(sent[0].init.headers['content-type'], 'text/plain');
});

test('a command is run with rendered arguments', async () => {
  const calls = [];
  const n = new Notifier(
    { command: ['/bin/echo', '{{title}}', '{{message}}'] },
    {}, () => {}, () => {},
    { execFile: async (cmd, args) => { calls.push({ cmd, args }); } },
  );
  assert.equal(await n.send('k', 'T', 'M'), true);
  assert.deepEqual(calls[0], { cmd: '/bin/echo', args: ['T', 'M'] });
});

test('a notifier with neither a webhook nor a command is disabled', async () => {
  const n = new Notifier({}, {}, () => {}, () => {});
  assert.equal(n.enabled, false);
  assert.equal(await n.send('k', 'T', 'M'), false);
});

test('a failing transport does not record the send, so the next attempt retries', async () => {
  const state = {};
  const n = new Notifier(
    { webhookUrl: 'http://hook' }, state, () => {}, () => {},
    { fetch: async () => ({ ok: false, status: 500 }) },
  );
  assert.equal(await n.send('k', 'T', 'M'), false);
  assert.deepEqual(state, {});
});

test('both transports fire when both are configured', async () => {
  const sent = [];
  const calls = [];
  const n = new Notifier(
    { webhookUrl: 'http://hook', command: ['/bin/echo', '{{title}}'] },
    {}, () => {}, () => {},
    {
      fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; },
      execFile: async (cmd, args) => { calls.push({ cmd, args }); },
    },
  );
  assert.equal(await n.send('k', 'T', 'M'), true);
  assert.equal(sent.length, 1);
  assert.equal(calls.length, 1);
});

test('a failing command does not record the send, so the next attempt retries', async () => {
  const state = {};
  const n = new Notifier(
    { command: ['/bin/echo', '{{title}}'] }, state, () => {}, () => {},
    { execFile: async () => { throw new Error('boom'); } },
  );
  assert.equal(await n.send('k', 'T', 'M'), false);
  assert.deepEqual(state, {});
});

test('prune drops throttle entries older than maxAgeMs and saves once', () => {
  let saves = 0;
  const state = { 'torrent-old': 1000, 'stuck-recent': 9000, login: 500 };
  const n = new Notifier({}, state, () => saves++, () => {});
  n.prune(5000, 10000);
  assert.deepEqual(state, { 'stuck-recent': 9000 });
  assert.equal(saves, 1);
});

test('prune does nothing, and does not save, when nothing is stale', () => {
  let saves = 0;
  const state = { fresh: 9000 };
  const n = new Notifier({}, state, () => saves++, () => {});
  n.prune(5000, 10000);
  assert.deepEqual(state, { fresh: 9000 });
  assert.equal(saves, 0);
});

test('{{json:...}} survives a backslash in the rendered default body', () => {
  const hostile = 'back\\slash "quote"\nnewline';
  const out = renderTemplate(
    '{"kind":"{{json:kind}}","title":"{{json:title}}","message":"{{json:message}}"}',
    { kind: 'k', title: 'T', message: hostile },
  );
  assert.deepEqual(JSON.parse(out), { kind: 'k', title: 'T', message: hostile });
});
