// qBittorrent WebUI API. Authentication is optional: leave the credentials empty if
// "bypass authentication for clients on localhost" is enabled.

export interface QBitConfig {
  qbitUrl: string;
  qbitUsername: string;
  qbitPassword: string;
}

// The torrents/info entry shape. farm.ts's QbitTorrent is the narrower slice its policy reads.
export interface Torrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  category: string;
  tags: string;
  save_path: string;
  added_on: number;
  completion_on: number;
  seeding_time: number;
  num_complete: number;
  num_incomplete: number;
  ratio: number;
}

export type Category = { name: string; savePath: string };

interface MainData {
  server_state?: { free_space_on_disk?: number };
}

interface CallOptions {
  params?: Record<string, string>;
  form?: FormData | Record<string, string>;
  retry?: boolean;
}

interface AddOptions {
  category: string;
  savePath: string;
}

export class QBit {
  base: string;
  username: string;
  password: string;
  sid: string | null;

  constructor({ qbitUrl, qbitUsername, qbitPassword }: QBitConfig) {
    this.base = `${qbitUrl}/api/v2`;
    this.username = qbitUsername;
    this.password = qbitPassword;
    this.sid = null;
  }

  // Only needed when "bypass authentication for localhost" is off.
  async login(): Promise<void> {
    if (!this.username) return;
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: this.username, password: this.password || '' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`qBittorrent login: HTTP ${res.status}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('SID='));
    if (!cookie) throw new Error('qBittorrent login: no session cookie returned');
    this.sid = cookie.split(';')[0] ?? null;
  }

  async call<T = unknown>(path: string, { params, form, retry = true }: CallOptions = {}): Promise<T> {
    const url = `${this.base}/${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
    const init: RequestInit & { headers: Record<string, string> } = { signal: AbortSignal.timeout(20_000), headers: {} };
    if (this.sid) init.headers.cookie = this.sid;
    if (form) {
      init.method = 'POST';
      init.body = form instanceof FormData ? form : new URLSearchParams(form);
    }
    const res = await fetch(url, init);
    if (res.status === 403 && this.username && retry) {
      await this.login();
      return this.call<T>(path, { params, form, retry: false });
    }
    if (!res.ok) throw new Error(`qBittorrent ${path}: HTTP ${res.status}`);
    const text = await res.text();
    return (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T;
  }

  async torrent(hash: string): Promise<Torrent | undefined> {
    const [t] = await this.call<Torrent[]>('torrents/info', { params: { hashes: hash } });
    return t;
  }

  async ensureCategory(name: string, savePath: string): Promise<void> {
    const cats = await this.call<Record<string, Category>>('torrents/categories');
    if (!cats[name]) await this.call('torrents/createCategory', { form: { category: name, savePath } });
  }

  add(torrentBuf: Buffer, filename: string, { category, savePath }: AddOptions): Promise<unknown> {
    const form = new FormData();
    form.append('torrents', new Blob([new Uint8Array(torrentBuf)], { type: 'application/x-bittorrent' }), filename);
    form.append('category', category);
    form.append('savepath', savePath);
    return this.call('torrents/add', { form });
  }

  // Identity tags. Harmless if no other tool reads them.
  addTags(hash: string, tags: string[]): Promise<unknown> {
    if (!tags?.length) return Promise.resolve();
    return this.call('torrents/addTags', { form: { hashes: hash, tags: tags.join(',') } });
  }

  all(): Promise<Torrent[]> {
    return this.call<Torrent[]>('torrents/info');
  }

  remove(hash: string): Promise<unknown> {
    return this.call('torrents/delete', { form: { hashes: hash, deleteFiles: 'true' } });
  }

  async freeSpace(): Promise<number> {
    const info = await this.call<MainData>('sync/maindata');
    return Number(info?.server_state?.free_space_on_disk ?? NaN);
  }
}
