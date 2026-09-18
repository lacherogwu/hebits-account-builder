// Minimal bencode reader for .torrent files: infohash, name, files with byte offsets.
import { createHash } from 'node:crypto';

function decode(buf) {
  let i = 0;
  let infoSpan = null;

  function next(depth) {
    const c = buf[i];
    if (c === 0x69) {
      const end = buf.indexOf(0x65, i);
      if (end < 0) throw new Error('bad integer');
      const n = Number(buf.toString('ascii', i + 1, end));
      i = end + 1;
      return n;
    }
    if (c === 0x6c) {
      i++;
      const list = [];
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('unterminated list');
        list.push(next(depth + 1));
      }
      i++;
      return list;
    }
    if (c === 0x64) {
      i++;
      const dict = {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('unterminated dict');
        const key = next(depth + 1);
        if (!Buffer.isBuffer(key)) throw new Error('bad dict key');
        const start = i;
        const value = next(depth + 1);
        if (depth === 0 && key.toString() === 'info') infoSpan = [start, i];
        dict[key.toString('utf8')] = value;
      }
      i++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, i);
      if (colon < 0) throw new Error('bad string');
      const len = Number(buf.toString('ascii', i, colon));
      const s = buf.subarray(colon + 1, colon + 1 + len);
      if (s.length !== len) throw new Error('truncated string');
      i = colon + 1 + len;
      return s;
    }
    throw new Error(`not bencode (byte ${i})`);
  }

  const root = next(0);
  return { root, infoSpan };
}

const str = (d, key) => (d[`${key}.utf-8`] ?? d[key])?.toString('utf8');

export function readTorrent(buf) {
  const { root, infoSpan } = decode(buf);
  const info = root?.info;
  if (!info || !infoSpan) throw new Error('not a torrent file');

  const name = str(info, 'name');
  const files = [];
  if (Array.isArray(info.files)) {
    let offset = 0;
    for (const f of info.files) {
      const isPad = f.attr?.toString().includes('p');
      const parts = (f['path.utf-8'] ?? f.path).map((p) => p.toString('utf8'));
      if (!isPad) files.push({ path: [name, ...parts].join('/'), length: f.length, offset });
      offset += f.length;
    }
  } else {
    files.push({ path: name, length: info.length, offset: 0 });
  }

  return {
    infoHash: createHash('sha1').update(buf.subarray(...infoSpan)).digest('hex'),
    name,
    pieceLength: info['piece length'],
    private: info.private === 1,
    files,
  };
}
