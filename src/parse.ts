// Release-name and file-list parsing.

// Untouched discs and remuxes: huge, and full discs aren't playable files at all.
export function isDiscOrRemux(title: string): boolean {
  return (
    /remux/i.test(title) ||
    /\bbdmv\b|\biso\b/i.test(title) ||
    /complete[ ._-]*(uhd[ ._-]*)?blu-?ray/i.test(title) ||
    // untouched discs name the disc codec (HEVC/AVC/VC-1) with no encoder (x264/x265/H.264)
    (/blu-?ray/i.test(title) && /\b(hevc|avc|vc-?1|mpeg-?2)\b/i.test(title) && !/x26[45]|h\.?26[45]/i.test(title))
  );
}

export type SeasonInfo =
  | { kind: 'episode'; season: number; episode: number }
  | { kind: 'season'; from: number; to: number }
  | { kind: 'complete' };

export function seasonInfo(title: string): SeasonInfo | null {
  const episodeMatch = title.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})(?!\d)/i);
  if (episodeMatch) {
    const [, season, episode] = episodeMatch;
    if (season !== undefined && episode !== undefined) {
      return { kind: 'episode', season: +season, episode: +episode };
    }
  }
  const rangeMatch = title.match(/\bS(\d{1,2})[ ._]?-[ ._]?S?(\d{1,2})\b/i);
  if (rangeMatch) {
    const [, from, to] = rangeMatch;
    if (from !== undefined && to !== undefined) {
      return { kind: 'season', from: +from, to: +to };
    }
  }
  const singleMatch = title.match(/\bS(\d{1,2})\b/i);
  if (singleMatch) {
    const [, season] = singleMatch;
    if (season !== undefined) {
      return { kind: 'season', from: +season, to: +season };
    }
  }
  if (/\bcomplete\b/i.test(title)) return { kind: 'complete' };
  return null;
}
