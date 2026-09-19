import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { readTorrent } from '../src/bencode';

const enc = (s: string) => `${Buffer.byteLength(s)}:${s}`;

test('multi-file torrent: infohash, files, offsets, pad files', () => {
  const info =
    'd' +
    enc('files') +
    'l' +
    'd' +
    enc('length') +
    'i100e' +
    enc('path') +
    'l' +
    enc('a.mkv') +
    'e' +
    'e' +
    'd' +
    enc('attr') +
    enc('p') +
    enc('length') +
    'i28e' +
    enc('path') +
    'l' +
    enc('.pad') +
    enc('28') +
    'e' +
    'e' +
    'd' +
    enc('length') +
    'i50e' +
    enc('path') +
    'l' +
    enc('sub') +
    enc('b.mkv') +
    'e' +
    'e' +
    'e' +
    enc('name') +
    enc('Show') +
    enc('piece length') +
    'i64e' +
    enc('pieces') +
    enc('x'.repeat(60)) +
    enc('private') +
    'i1e' +
    'e';
  const buf = Buffer.from(`d${enc('announce')}${enc('http://t/a')}${enc('info')}${info}e`);
  const t = readTorrent(buf);
  expect(t.infoHash).toBe(createHash('sha1').update(info).digest('hex'));
  expect(t.name).toBe('Show');
  expect(t.pieceLength).toBe(64);
  expect(t.private).toBe(true);
  expect(t.files.map((x) => [x.path, x.length, x.offset])).toEqual([
    ['Show/a.mkv', 100, 0],
    ['Show/sub/b.mkv', 50, 128],
  ]);
});

test('single-file torrent', () => {
  const info = `d${enc('length')}i10e${enc('name')}${enc('movie.mkv')}${enc('piece length')}i4e${enc('pieces')}${enc('y'.repeat(60))}e`;
  const t = readTorrent(Buffer.from(`d${enc('info')}${info}e`));
  expect(t.private).toBe(false);
  expect(t.files).toEqual([{ path: 'movie.mkv', length: 10, offset: 0 }]);
});

test('rejects non-torrent input (e.g. an HTML error page)', () => {
  expect(() => readTorrent(Buffer.from('<html>limit reached</html>'))).toThrow();
});
