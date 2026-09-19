import type { HebitsTorrent } from 'hebits-client';

// An hour before the suites' frozen `now` (Date.UTC(2026, 8, 18, 12)). Never wall-clock: a
// `new Date()` default drifts with the clock and silently clears every age-based filter, so a
// test could look like it exercises one without ever reaching it. Fixtures that care about age
// set `uploadedAt` explicitly.
const DEFAULT_UPLOADED_AT = new Date(Date.UTC(2026, 8, 18, 11));

let nextId = 1;
export function torrent(over: Partial<HebitsTorrent> = {}): HebitsTorrent {
  return {
    id: nextId++, groupId: 1, name: 'Some.Movie.2026.1080p.WEB-DL.x264-GRP', groupName: 'Some Movie',
    categoryId: 1, imdb: 'tt1234567', cover: undefined, tags: [], size: 5 * 1024 ** 3,
    fileCount: 1, seeders: 10, leechers: 2, snatches: 5, uploadedAt: DEFAULT_UPLOADED_AT,
    resolution: '1080p', codec: 'x264', audio: 'AC3', container: 'MKV',
    downloadFactor: 0, uploadFactor: 1, canUseToken: true, hasSnatched: false,
    ...over,
  };
}
