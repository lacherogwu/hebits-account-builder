# Hebits Account Builder

A zero-dependency Node.js service that builds a ratio on [Hebits](https://hebits.net), a
private Israeli BitTorrent tracker: it grabs freeleech uploads automatically, seeds them,
and releases them once the disk fills up.

It talks to [Jackett](https://github.com/Jackett/Jackett) to search Hebits and to
[qBittorrent](https://www.qbittorrent.org/) to download and seed. It never reaches Hebits
directly — Jackett already holds a login cookie for the tracker, and this service reads it.

**No debrid service.** Hebits bans debrid services outright; an account that uses one is
blocked immediately. Nothing here proxies through TorBox, AIOStreams or similar — every
torrent downloads, seeds and stays on the machine this service runs on.

This is one half of a split: the other half is a separate Stremio addon that streams from
the same qBittorrent instance. They don't talk to each other and neither depends on the
other running — they share state only through tags this service writes into qBittorrent
(see [Tags](#tags) below), so a streaming addon can tell which torrents it didn't add
itself.

## Requirements

- Node.js ≥ 22
- [Jackett](https://github.com/Jackett/Jackett), with a **HeBits** Torznab indexer configured
  (logged in with a valid Hebits cookie)
- [qBittorrent](https://www.qbittorrent.org/), with the WebUI enabled

## Install

```bash
git clone <this repo>
cd hebits-account-builder
node server.js
```

There's no build step and no npm install — the repo has zero dependencies. The first run
creates `~/.config/hebits-account-builder/config.json` with a random `token` and prints
either the listening banner or an error explaining what to fix (see
[Configuration](#configuration)).

## Configuration

Settings live in `~/.config/hebits-account-builder/config.json` (mode `600`), overriding the
defaults in `lib/config.js`. Override the directory itself with the `HEBITS_BUILDER_DIR`
environment variable. See `config.example.json` for a starting point.

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `7001` | Listen port, all interfaces |
| `lanHost` | empty (auto-detected) | LAN address used in links such as the cookie-update alert; set it if auto-detection picks the wrong interface |
| `dailyLimit` | `10` | Fallback only; the real counter is read from the Hebits profile page |
| `dailyLimitByDay` | `{}` | Per-day overrides, e.g. `{"2026-09-17": 5}` for a new account's first day |
| `minFreeGB` | `20` | Free disk space to keep after a download |
| `timezone` | `Asia/Jerusalem` | Used for the daily download counter's day boundary |
| `jackettUrl` | `http://127.0.0.1:9117` | Jackett base URL |
| `jackettIndexer` | `hebits` | Jackett Torznab indexer id |
| `jackettConfig` | Jackett's `ServerConfig.json`, auto-located per OS | Where the Jackett API key is read from |
| `jackettIndexerConfig` | Jackett's indexer config, auto-located per OS | Where the Hebits login cookie is read from |
| `jackettApiKey` | read from `jackettConfig` | Set this directly to skip that read |
| `qbitUrl` | `http://127.0.0.1:8080` | qBittorrent WebUI base URL |
| `qbitUsername`, `qbitPassword` | empty | Only needed if qBittorrent's "bypass authentication for clients on localhost" is off |
| `watchCategory`, `watchPath` | `watch`, `~/hebits/watch` | Category/path for torrents grabbed on demand (for a companion streaming addon) |
| `seedCategory`, `seedPath` | `seed-auto`, `~/hebits/seed` | Category/path for torrents auto-grabbed to build the account |
| `farm` | `{"enabled": true, "intervalMin": 10}` | Auto-grab job; see `GRAB_DEFAULTS` in `lib/farm.js` for tuning knobs (`keepForUser`, `reserveGB`, `maxSizeGB`, …) |
| `cleanup` | `{"enabled": true, "intervalMin": 30}` | Auto-release job; see `CLEANUP_DEFAULTS` in `lib/farm.js` (`reserveGB`, `minSeedDays`, `keepIfSeedersBelow`, …) |
| `notify` | `{"webhookUrl": ""}` | Alert transport; see [Notifications](#notifications) |
| `lowDiskAlertGB` | `15` | Alert threshold after a release pass still leaves the disk full |
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached |
| `logFile` | `<config dir>/builder.log` | If something redirects this process's stdout there, it's truncated (with a `.1` backup) once it passes 20 MB |

Jackett's API key and the Hebits login cookie are both read from Jackett's own files, never
stored in this repository.

### Jackett's API key

On startup, if `jackettApiKey` isn't set in `config.json`, this service reads it from
Jackett's `ServerConfig.json`. If that file can't be read (Jackett isn't installed yet, or
lives somewhere non-standard) or has no key set, the service refuses to start and prints
exactly what's wrong and where — set `jackettApiKey` and `jackettConfig` in `config.json` to
work around either case.

## Endpoints

Every route sits behind the random `token` from `config.json`, as a path segment:
`http://<host>:<port>/<token>/<route>`. A wrong or missing token gets a plain 404, same as an
unknown route — the token isn't revealed by the response.

- **`/status`** — JSON: account class, upload/download totals, ratio, progress toward the
  **Heb User** rank, today's download count, Hebits login health, free disk space, the last
  20 grab/release/error events, and the torrents currently managed.
- **`/cookie`** — GET returns a form to paste a fresh Hebits login cookie; POST saves it
  through Jackett's admin API and verifies it by loading the account's stats page. Use this
  whenever the Hebits login expires (an alert fires when it does).
- **`/notify-test`** — sends a test alert through whatever transport `notify` is configured
  with, and reports whether it was accepted.

## Notifications

Set `notify.webhookUrl` to POST a JSON alert to any webhook (Home Assistant, ntfy, ...), or
`notify.command` (an argv array) to run a local command instead — both can be set at once.
Alerts of the same kind are throttled to once per 6 hours. The login-failure alert includes
the `/<token>/cookie` URL so it can be opened straight from the notification; that URL is
your admin secret, so only send alerts to a channel you control, not a shared one. See
`examples/notify/` for ready-made configs for Home Assistant, ntfy, Discord and Telegram, and
`examples/notify/home-assistant-automation.yaml` for the Home Assistant side.

## Tags

Every torrent this service adds to qBittorrent gets tagged with what it knew when it grabbed
it: `hebits:<id>` and, when known, `imdb:tt<id>`. A `.torrent` file itself carries neither —
these tags are the only record. A separate tool reading qBittorrent (such as a companion
Stremio addon sharing the same instance) can use them to recognize torrents this service
added and match them to an IMDb id, without either service depending on the other.

## Account-building policy

The goal is the **Heb User** rank: 30 days on the site, 20 GB downloaded, and a ratio of 1.25.

- **Grab** (every 10 min), from uploads of the last 6 h: movies/TV only, 1–40 GB, no remux.
  - Always takes freeleech.
  - Takes counted downloads only while under 22 GB downloaded, only when half-leech or
    ×2-upload and ≤ 15 GB. The projected ratio must stay ≥ 1.25 (the Heb User ratio) and
    ≥ the required ratio + 0.2.
  - Prefers torrents with more downloaders per seeder. Skips releases older than 1 h that
    nobody is downloading.
  - x2/x3-upload releases rank higher.
  - At most 2 grabs per hour, so later releases in the day still get a slot.
  - Leaves `keepForUser` (3) daily downloads and `reserveGB` (40 GB) of disk free.
- **Release** (every 30 min), only when free space drops under 40 GB.
  - Candidates: finished torrents this service manages, seeded ≥ 8 days, with ≥ 5 seeders.
    Titles in the `watch` category also need ≥ 14 days since completion.
  - Lowest bonus points per GB go first, until 50 GB is free.
  - Below 10 GB free, rare torrents may go too.
- **Stuck downloads**: a managed torrent still unfinished after 24 h triggers an alert.
- **Points formula**:
  `Size × (0.2 + 0.4·ln(1+months)) / ln(2 + seeders^0.7)` per hour, per torrent.

## Lessons learned

- **Pre-allocation doubles disk usage on APFS.** With qBittorrent pre-allocation on, every
  file used roughly twice its size until it finished. Turn pre-allocation off.
- **Pausing files to prioritize one stalls the torrent.** On qBittorrent 5.2 / libtorrent
  1.2, pausing other files to prioritize one stalls the whole torrent for 10–60 s.
- **Seeding time only counts from 100%.** An unfinished torrent earns no seed credit, so a
  stalled download is a hit-and-run risk — that's what the stuck-download alert is for.

## Tests

```bash
node --test
```

No dependencies, no network access required — the test suite mocks Jackett, qBittorrent and
Hebits.
