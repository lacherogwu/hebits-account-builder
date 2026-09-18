// Torrent identity, stored in qBittorrent as tags so any tool can read it.
// A torrent file carries no IMDb id and no tracker id, so whoever adds a torrent
// writes down what it knew at that moment: `hebits:<id>` and `imdb:tt<id>`.

const KEYS: Record<string, 'hebitsId' | 'imdb'> = { hebits: 'hebitsId', imdb: 'imdb' };

export interface TagInput {
  hebitsId?: string | number;
  imdb?: string;
}

export interface ParsedTags {
  hebitsId?: string;
  imdb?: string;
}

export function buildTags({ hebitsId, imdb }: TagInput = {}): string[] {
  const tags: string[] = [];
  if (hebitsId) tags.push(`hebits:${hebitsId}`);
  if (imdb) tags.push(`imdb:${imdb}`);
  return tags;
}

// qBittorrent joins tags with ", " on the way out and splits on "," on the way in.
export function parseTags(raw: string | undefined | null): ParsedTags {
  const out: ParsedTags = {};
  for (const tag of String(raw ?? '').split(',')) {
    const t = tag.trim();
    const i = t.indexOf(':');
    if (i < 1) continue;
    const field = KEYS[t.slice(0, i)];
    if (field) out[field] = t.slice(i + 1);
  }
  return out;
}
