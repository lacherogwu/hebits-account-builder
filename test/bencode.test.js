import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readTorrent } from '../lib/bencode.js';

const enc = (s) => `${Buffer.byteLength(s)}:${s}`;

test('multi-file torrent: infohash, files, offsets, pad files', () => {
  const info =
    'd' +
    enc('files') + 'l' +
      'd' + enc('length') + 'i100e' + enc('path') + 'l' + enc('a.mkv') + 'e' + 'e' +
      'd' + enc('attr') + enc('p') + enc('length') + 'i28e' + enc('path') + 'l' + enc('.pad') + enc('28') + 'e' + 'e' +
      'd' + enc('length') + 'i50e' + enc('path') + 'l' + enc('sub') + enc('b.mkv') + 'e' + 'e' +
    'e' +
    enc('name') + enc('Show') +
    enc('piece length') + 'i64e' +
    enc('pieces') + enc('x'.repeat(60)) +
    enc('private') + 'i1e' +
    'e';
  const buf = Buffer.from('d' + enc('announce') + enc('http://t/a') + enc('info') + info + 'e');
  const t = readTorrent(buf);
  assert.equal(t.infoHash, createHash('sha1').update(info).digest('hex'));
  assert.equal(t.name, 'Show');
  assert.equal(t.pieceLength, 64);
  assert.equal(t.private, true);
  assert.deepEqual(t.files.map((x) => [x.path, x.length, x.offset]), [
    ['Show/a.mkv', 100, 0],
    ['Show/sub/b.mkv', 50, 128],
  ]);
});

test('single-file torrent', () => {
  const info = 'd' + enc('length') + 'i10e' + enc('name') + enc('movie.mkv') + enc('piece length') + 'i4e' + enc('pieces') + enc('y'.repeat(60)) + 'e';
  const t = readTorrent(Buffer.from('d' + enc('info') + info + 'e'));
  assert.equal(t.private, false);
  assert.deepEqual(t.files, [{ path: 'movie.mkv', length: 10, offset: 0 }]);
});

test('rejects non-torrent input (e.g. an HTML error page)', () => {
  assert.throws(() => readTorrent(Buffer.from('<html>limit reached</html>')));
});
