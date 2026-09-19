import { afterEach, expect, test, vi } from 'vitest';
import { QBit } from '../src/qbit';

afterEach(() => vi.unstubAllGlobals());

test('freeSpace returns NaN when qBittorrent gives a non-numeric value', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ server_state: {} }), { status: 200 })));
  const q = new QBit({ qbitUrl: 'http://qbit.test', qbitUsername: '', qbitPassword: '' });
  expect(Number.isNaN(await q.freeSpace())).toBe(true);
});

test('a 403 triggers one re-login and a retry', async () => {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; Path=/' } });
    return calls.filter((c) => !c.includes('auth/login')).length === 1
      ? new Response('Forbidden', { status: 403 })
      : new Response(JSON.stringify([{ hash: 'abc' }]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const q = new QBit({ qbitUrl: 'http://qbit.test', qbitUsername: 'u', qbitPassword: 'p' });
  await q.torrent('abc');
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
