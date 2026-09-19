import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { Notifier, renderTemplate } from '../src/notify';

async function withHook(fn: (url: string, got: Record<string, string>[]) => Promise<void>): Promise<void> {
  const got: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req
      .on('data', (c: Buffer) => (body += c.toString()))
      .on('end', () => {
        got.push(JSON.parse(body));
        res.end('ok');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}/api/webhook/x`, got);
  } finally {
    server.close();
  }
}

test('sends, then stays quiet for the same kind until reset', async () => {
  await withHook(async (url, got) => {
    const state: Record<string, number> = {};
    const n = new Notifier(
      { webhookUrl: url },
      state,
      () => {},
      () => {},
    );
    expect(await n.send('login', 'T', 'M', { now: 1000 })).toBe(true);
    expect(await n.send('login', 'T', 'M', { now: 2000 })).toBe(false);
    expect(await n.send('disk', 'T2', 'M2', { now: 2000 })).toBe(true);
    n.reset('login');
    expect(await n.send('login', 'T', 'M', { now: 3000 })).toBe(true);
    expect(got.map((g) => g.kind)).toEqual(['login', 'disk', 'login']);
    expect(got[0]).toEqual({ kind: 'login', title: 'T', message: 'M' });
  });
});

test('disabled without a URL, and survives an unreachable hook', async () => {
  const off = new Notifier(
    {},
    {},
    () => {},
    () => {},
  );
  expect(await off.send('x', 't', 'm')).toBe(false);
  const logs: string[] = [];
  const bad = new Notifier(
    { webhookUrl: 'http://127.0.0.1:9/nothing' },
    {},
    () => {},
    (m) => logs.push(m),
  );
  expect(await bad.send('x', 't', 'm')).toBe(false);
  expect(logs.length).toBe(1);
});

test('renderTemplate substitutes raw by default', () => {
  expect(renderTemplate('{{title}}: {{message}}', { title: 'A', message: 'B' })).toBe('A: B');
});

test('renderTemplate json-escapes so a quote cannot break the body', () => {
  const out = renderTemplate('{"t":"{{json:title}}"}', { title: 'He said "hi"\nbye' });
  expect(JSON.parse(out)).toEqual({ t: 'He said "hi"\nbye' });
});

test('renderTemplate url-encodes', () => {
  expect(renderTemplate('q={{url:title}}', { title: 'a b&c' })).toBe('q=a%20b%26c');
});

test('renderTemplate blanks unknown keys', () => {
  expect(renderTemplate('[{{nope}}]', {})).toBe('[]');
});

test('the default body keeps the shape the Home Assistant automation expects', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const n = new Notifier(
    { webhookUrl: 'http://hook' },
    {},
    () => {},
    () => {},
    {
      fetch: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return { ok: true, status: 200 } as Response;
      },
    },
  );
  await n.send('disk', 'Title', 'Message');
  const first = sent[0];
  expect(first).toBeDefined();
  expect(first?.url).toBe('http://hook');
  expect(first?.init.method).toBe('POST');
  expect(JSON.parse(first?.init.body as string)).toEqual({ kind: 'disk', title: 'Title', message: 'Message' });
});

test('a custom method, headers and body are honoured', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const n = new Notifier(
    {
      webhookUrl: 'http://ntfy/topic',
      method: 'PUT',
      headers: { Title: 'x', 'content-type': 'text/plain' },
      body: '{{message}}',
    },
    {},
    () => {},
    () => {},
    {
      fetch: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return { ok: true, status: 200 } as Response;
      },
    },
  );
  await n.send('k', 'T', 'M');
  const first = sent[0];
  expect(first).toBeDefined();
  expect(first?.init.method).toBe('PUT');
  expect(first?.init.body).toBe('M');
  const headers = first?.init.headers as Record<string, string>;
  expect(headers['content-type']).toBe('text/plain');
});

test('a command is run with rendered arguments', async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const n = new Notifier(
    { command: ['/bin/echo', '{{title}}', '{{message}}'] },
    {},
    () => {},
    () => {},
    {
      execFile: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: '', stderr: '' };
      },
    },
  );
  expect(await n.send('k', 'T', 'M')).toBe(true);
  expect(calls[0]).toEqual({ cmd: '/bin/echo', args: ['T', 'M'] });
});

test('a notifier with neither a webhook nor a command is disabled', async () => {
  const n = new Notifier(
    {},
    {},
    () => {},
    () => {},
  );
  expect(n.enabled).toBe(false);
  expect(await n.send('k', 'T', 'M')).toBe(false);
});

test('a failing transport does not record the send, so the next attempt retries', async () => {
  const state: Record<string, number> = {};
  let fetchCalls = 0;
  const n = new Notifier(
    { webhookUrl: 'http://hook' },
    state,
    () => {},
    () => {},
    {
      fetch: async () => {
        fetchCalls++;
        return { ok: false, status: 500 } as Response;
      },
    },
  );
  expect(await n.send('k', 'T', 'M')).toBe(false);
  expect(fetchCalls).toBe(1);
  expect(state).toEqual({});
});

test('both transports fire when both are configured', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const n = new Notifier(
    { webhookUrl: 'http://hook', command: ['/bin/echo', '{{title}}'] },
    {},
    () => {},
    () => {},
    {
      fetch: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return { ok: true, status: 200 } as Response;
      },
      execFile: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: '', stderr: '' };
      },
    },
  );
  expect(await n.send('k', 'T', 'M')).toBe(true);
  expect(sent.length).toBe(1);
  expect(calls.length).toBe(1);
});

test('a failing command does not record the send, so the next attempt retries', async () => {
  const state: Record<string, number> = {};
  let execFileCalls = 0;
  const n = new Notifier(
    { command: ['/bin/echo', '{{title}}'] },
    state,
    () => {},
    () => {},
    {
      execFile: async () => {
        execFileCalls++;
        throw new Error('boom');
      },
    },
  );
  expect(await n.send('k', 'T', 'M')).toBe(false);
  expect(execFileCalls).toBe(1);
  expect(state).toEqual({});
});

test('prune drops throttle entries older than maxAgeMs and saves once', () => {
  let saves = 0;
  const state: Record<string, number> = { 'torrent-old': 1000, 'stuck-recent': 9000, login: 500 };
  const n = new Notifier(
    {},
    state,
    () => {
      saves++;
    },
    () => {},
  );
  n.prune(5000, 10000);
  expect(state).toEqual({ 'stuck-recent': 9000 });
  expect(saves).toBe(1);
});

test('prune does nothing, and does not save, when nothing is stale', () => {
  let saves = 0;
  const state: Record<string, number> = { fresh: 9000 };
  const n = new Notifier(
    {},
    state,
    () => {
      saves++;
    },
    () => {},
  );
  n.prune(5000, 10000);
  expect(state).toEqual({ fresh: 9000 });
  expect(saves).toBe(0);
});

test('{{json:...}} survives a backslash in the rendered default body', () => {
  const hostile = 'back\\slash "quote"\nnewline';
  const out = renderTemplate('{"kind":"{{json:kind}}","title":"{{json:title}}","message":"{{json:message}}"}', {
    kind: 'k',
    title: 'T',
    message: hostile,
  });
  expect(JSON.parse(out)).toEqual({ kind: 'k', title: 'T', message: hostile });
});
