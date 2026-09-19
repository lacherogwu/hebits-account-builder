// Minimal bencode reader for .torrent files: infohash, name, files with byte offsets.
import { createHash } from 'node:crypto';

type Bencoded = number | Uint8Array | Bencoded[] | { [k: string]: Bencoded };

export interface TorrentFile {
  path: string;
  length: number;
  offset: number;
}

export interface Torrent {
  infoHash: string;
  name: string;
  files: TorrentFile[];
  pieceLength: number;
  private: boolean;
}

// buf[i] and nested string values are Bencoded-typed as Uint8Array, but they are always
// real Buffers underneath (produced by Buffer#subarray below) — this just recovers that
// for the type checker so `.toString(encoding)` is available.
function toBuffer(v: Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function isDict(v: Bencoded | undefined): v is { [k: string]: Bencoded } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function decode(input: Uint8Array): { root: Bencoded; infoSpan: [number, number] | null } {
  const buf = toBuffer(input);
  let i = 0;
  let infoSpan: [number, number] | null = null;

  function next(depth: number): Bencoded {
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
      const list: Bencoded[] = [];
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('unterminated list');
        list.push(next(depth + 1));
      }
      i++;
      return list;
    }
    if (c === 0x64) {
      i++;
      const dict: { [k: string]: Bencoded } = {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('unterminated dict');
        const key = next(depth + 1);
        if (!(key instanceof Uint8Array)) throw new Error('bad dict key');
        const start = i;
        const value = next(depth + 1);
        const keyStr = toBuffer(key).toString('utf8');
        if (depth === 0 && keyStr === 'info') infoSpan = [start, i];
        dict[keyStr] = value;
      }
      i++;
      return dict;
    }
    if (c !== undefined && c >= 0x30 && c <= 0x39) {
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

function str(d: { [k: string]: Bencoded }, key: string): string | undefined {
  const v = d[`${key}.utf-8`] ?? d[key];
  return v instanceof Uint8Array ? toBuffer(v).toString('utf8') : undefined;
}

export function readTorrent(buf: Uint8Array): Torrent {
  const { root, infoSpan } = decode(buf);
  const info = isDict(root) ? root.info : undefined;
  if (!isDict(info) || !infoSpan) throw new Error('not a torrent file');

  const name = str(info, 'name');
  if (name === undefined) throw new Error('not a torrent file');

  const files: TorrentFile[] = [];
  if (Array.isArray(info.files)) {
    let offset = 0;
    for (const f of info.files) {
      if (!isDict(f)) throw new Error('bad file entry');
      const attr = f.attr;
      const isPad = attr instanceof Uint8Array && toBuffer(attr).toString().includes('p');
      const pathList = f['path.utf-8'] ?? f.path;
      if (!Array.isArray(pathList)) throw new Error('bad file entry');
      const parts = pathList.map((p) => {
        if (!(p instanceof Uint8Array)) throw new Error('bad path component');
        return toBuffer(p).toString('utf8');
      });
      const length = f.length;
      if (typeof length !== 'number') throw new Error('bad file entry');
      if (!isPad) files.push({ path: [name, ...parts].join('/'), length, offset });
      offset += length;
    }
  } else {
    const length = info.length;
    if (typeof length !== 'number') throw new Error('not a torrent file');
    files.push({ path: name, length, offset: 0 });
  }

  const pieceLength = info['piece length'];
  if (typeof pieceLength !== 'number') throw new Error('not a torrent file');

  return {
    infoHash: createHash('sha1').update(toBuffer(buf).subarray(infoSpan[0], infoSpan[1])).digest('hex'),
    name,
    pieceLength,
    private: info.private === 1,
    files,
  };
}
