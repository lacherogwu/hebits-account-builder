import { afterEach, expect, test, vi } from 'vitest';
import { QBit } from '../src/qbit';

afterEach(() => vi.unstubAllGlobals());

test('freeSpace returns NaN when qBittorrent gives a non-numeric value', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ server_state: {} }), { status: 200 })));
  const q = new QBit({ qbitUrl: 'http://qbit.test', qbitUsername: '', qbitPassword: '' });
  expect(Number.isNaN(await q.freeSpace())).toBe(true);
});

test('a 403 triggers exactly one re-login, and a persistent 403 afterward is not retried again', async () => {
  const calls: string[] = [];
  const cookiesSeen: (string | undefined)[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; Path=/' } });
    cookiesSeen.push((init?.headers as Record<string, string> | undefined)?.cookie);
    // Every real request 403s, even the retry — which genuinely carries the session
    // cookie login() just issued (asserted below via cookiesSeen). This models an
    // invalid/expired-account case a re-login can't fix. Gating success on the mere
    // *count* of prior calls (as an earlier version of this test did) can't tell a
    // correctly-bounded client from an unbounded one: with that mock both only ever
    // need one retry to succeed, so a client that dropped the `retry: false` bound and
    // kept retrying forever would still pass. Gating success once *any* cookie shows up
    // has the same blind spot, since the bound is only exercised by a failure that
    // survives the retry. Persisting the 403 regardless of the (valid) cookie is what
    // forces a bounded client to give up and an unbounded one to recurse forever.
    return new Response('Forbidden', { status: 403 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const q = new QBit({ qbitUrl: 'http://qbit.test', qbitUsername: 'u', qbitPassword: 'p' });
  await expect(q.torrent('abc')).rejects.toThrow('HTTP 403');
  // The retry did carry the session the re-login obtained ...
  expect(cookiesSeen).toEqual([undefined, 'SID=abc123']);
  // ... but the client gave up after exactly one re-login, not more.
  expect(calls.filter((c) => c.includes('auth/login')).length).toBe(1);
});

test('addTags sends the tags joined the way qBittorrent expects', async () => {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.body) seen.push(String(init.body));
      return new Response('Ok.', { status: 200 });
    }),
  );
  const q = new QBit({ qbitUrl: 'http://qbit.test', qbitUsername: '', qbitPassword: '' });
  await q.addTags('HASH', ['hebits:1', 'imdb:tt2']);
  expect(seen.join('')).toContain('hebits%3A1%2Cimdb%3Att2');
});
