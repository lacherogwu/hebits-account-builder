// qBittorrent WebUI API (localhost auth bypass is enabled on the media Mac).

export class QBit {
  constructor({ qbitUrl }) {
    this.base = `${qbitUrl}/api/v2`;
  }

  async call(path, { params, form } = {}) {
    const url = `${this.base}/${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
    const init = { signal: AbortSignal.timeout(20_000) };
    if (form) {
      init.method = 'POST';
      init.body = form instanceof FormData ? form : new URLSearchParams(form);
    }
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`qBittorrent ${path}: HTTP ${res.status}`);
    const text = await res.text();
    return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
  }

  async torrent(hash) {
    const [t] = await this.call('torrents/info', { params: { hashes: hash } });
    return t;
  }

  async torrents(hashes) {
    if (!hashes.length) return [];
    return this.call('torrents/info', { params: { hashes: hashes.join('|') } });
  }

  files(hash) {
    return this.call('torrents/files', { params: { hash } });
  }

  pieceStates(hash) {
    return this.call('torrents/pieceStates', { params: { hash } });
  }

  properties(hash) {
    return this.call('torrents/properties', { params: { hash } });
  }

  async ensureCategory(name, savePath) {
    const cats = await this.call('torrents/categories');
    if (!cats[name]) await this.call('torrents/createCategory', { form: { category: name, savePath } });
  }

  add(torrentBuf, filename, { category, savePath }) {
    const form = new FormData();
    form.append('torrents', new Blob([torrentBuf], { type: 'application/x-bittorrent' }), filename);
    form.append('category', category);
    form.append('savepath', savePath);
    return this.call('torrents/add', { form });
  }

  setFilePriority(hash, ids, priority) {
    if (!ids.length) return Promise.resolve();
    return this.call('torrents/filePrio', { form: { hash, id: ids.join('|'), priority: String(priority) } });
  }

  // The API only toggles; `current` is the torrent's seq_dl / f_l_piece_prio.
  async setSequential(hash, on, current) {
    if (Boolean(current) !== on) await this.call('torrents/toggleSequentialDownload', { form: { hashes: hash } });
  }

  async setFirstLastPiecePrio(hash, on, current) {
    if (Boolean(current) !== on) await this.call('torrents/toggleFirstLastPiecePrio', { form: { hashes: hash } });
  }

  all() {
    return this.call('torrents/info');
  }

  remove(hash) {
    return this.call('torrents/delete', { form: { hashes: hash, deleteFiles: 'true' } });
  }

  freeSpace() {
    return this.call('sync/maindata').then((d) => d.server_state?.free_space_on_disk);
  }
}
