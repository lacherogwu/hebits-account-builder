# Hebits Account Builder

A Node.js service that builds a ratio on [Hebits](https://hebits.net), a private Israeli
BitTorrent tracker: it grabs freeleech uploads automatically, seeds them, and releases them
once the disk fills up.

It talks to Hebits directly through [hebits-client](https://github.com/lacherogwu/hebits-client)
using a login cookie you paste in through this service's own `/cookie` page, and to
[qBittorrent](https://www.qbittorrent.org/) to download and seed.

**No debrid service.** Hebits bans debrid services outright; an account that uses one is
blocked immediately. Nothing here proxies through TorBox, AIOStreams or similar — every
torrent downloads, seeds and stays on the machine this service runs on.

## Requirements

- Node.js ≥ 22
- [qBittorrent](https://www.qbittorrent.org/), with the WebUI enabled
- A Hebits account and a login cookie, pasted in through `/cookie` once the service is
  running (see [Endpoints](#endpoints))

## Install

```bash
git clone <this repo>
cd hebits-account-builder
npm install
npm run build
npm start
```

`npm run build` compiles the service to `dist/server.mjs`. The first run creates
`~/.config/hebits-account-builder/config.json` with a random `token` and prints either the
listening banner or an error explaining what to fix (see [Configuration](#configuration)).
Until a cookie is saved through `/cookie`, the service starts fine but reports Hebits login
as failing.

## Configuration

Settings live in `~/.config/hebits-account-builder/config.json` (mode `600`), overriding the
defaults in `src/config.ts`. Override the directory itself with the `HEBITS_BUILDER_DIR`
environment variable. See `deploy/config.example.json` for a starting point.

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `7001` | Listen port, all interfaces |
| `lanHost` | empty (auto-detected) | LAN address used in links such as the cookie-update alert; set it if auto-detection picks the wrong interface |
| `dailyLimit` | `10` | Fallback only; the real counter is read from Hebits through `hebits-client` |
| `dailyLimitByDay` | `{}` | Per-day overrides, e.g. `{"2026-09-17": 5}` for a new account's first day |
| `minFreeGB` | `20` | Free disk space to keep after a download |
| `timezone` | `Asia/Jerusalem` | Used for the daily download counter's day boundary |
| `qbitUrl` | `http://127.0.0.1:8080` | qBittorrent WebUI base URL |
| `qbitUsername`, `qbitPassword` | empty | Only needed if qBittorrent's "bypass authentication for clients on localhost" is off |
| `watchCategory`, `watchPath` | `watch`, `~/hebits/watch` | Category/path for torrents grabbed on demand (for a companion streaming addon) |
| `seedCategory`, `seedPath` | `seed-auto`, `~/hebits/seed` | Category/path for torrents auto-grabbed to build the account |
| `farm` | `{"enabled": true, "intervalMin": 10}` | Auto-grab job; see `GRAB_DEFAULTS` in `src/farm.ts` for tuning knobs (`keepForUser`, `reserveGB`, `maxSizeGB`, …) |
| `cleanup` | `{"enabled": true, "intervalMin": 30}` | Auto-release job; see `CLEANUP_DEFAULTS` in `src/farm.ts` (`reserveGB`, `minSeedDays`, `keepIfSeedersBelow`, …) |
| `notify` | `{"webhookUrl": ""}` | Alert transport; see [Notifications](#notifications) |
| `lowDiskAlertGB` | `15` | Alert threshold after a release pass still leaves the disk full |
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached |
| `logFile` | `<config dir>/builder.log` | The log the service writes. It logs to stdout, so this must be the same path the LaunchAgent points `StandardOutPath`/`StandardErrorPath` at (`deploy/org.user.hebits-builder.plist` already does); it's truncated in place, with a `.1` backup, once it passes 20 MB |

The Hebits login cookie itself is not a `config.json` key — it lives in `cookie.txt` next to
`config.json`, written by `/cookie` once a paste passes verification.

## Endpoints

Every route sits behind the random `token` from `config.json`, as a path segment:
`http://<host>:<port>/<token>/<route>`. A wrong or missing token gets a plain 404, same as an
unknown route — the token isn't revealed by the response.

- **`/status`** — JSON: account class, upload/download totals, ratio, progress toward the
  **Heb User** rank, today's download count, Hebits login health, free disk space, the last
  20 grab/release/error events, and the torrents currently managed. It also reports anything
  that went wrong at startup: `configIssues` (settings that failed validation and fell back to
  their default) and `storeIssue` (a `state.json` that had to be moved aside). Every reading
  degrades on its own, so this page still answers when Hebits or qBittorrent is unreachable —
  `freeGB` is `null` when qBittorrent did not answer, not `0`.
- **`/cookie`** — GET returns a form to paste a fresh Hebits login cookie; POST verifies it
  directly against Hebits (through `hebits-client`) before saving it, so a bad paste is
  rejected rather than silently stored. Use this whenever the Hebits login expires (an alert
  fires when it does).
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

## Layout

| File | Purpose |
|---|---|
| `src/server.ts` | HTTP server: routing, token auth, startup wiring, log rotation, schedules the two jobs |
| `src/config.ts` | Loads/saves `config.json` and owns the Hebits cookie file |
| `src/jobs.ts` | The two background jobs (`farmTick`, `cleanupTick`) and login/service health tracking |
| `src/farm.ts` | Account-building policy: pure functions deciding what to grab and what to release |
| `src/grab.ts` | Turns a Hebits id into a running qBittorrent torrent: download, add, tag |
| `src/qbit.ts` | qBittorrent WebUI API client |
| `src/cookie-page.ts` | The `/cookie` HTML page: paste a cookie, verify it, save it |
| `src/notify.ts` | Alert transport (webhook and/or local command), with templating and throttling |
| `src/store.ts` | Persistent JSON state: grab history, torrent index, notifier throttle state |
| `src/tags.ts` | Builds/parses the qBittorrent tags that record Hebits/IMDb identity |
| `src/parse.ts` | Release-name parsing: disc/remux detection, season/episode info |
| `src/bencode.ts` | Minimal bencode reader for `.torrent` files (infohash, name, files, piece length) |

`test/` mirrors `src/` one-to-one (one `*.test.ts` per module), plus `test/factory.ts` for
shared test fixtures and `test/bundle.test.ts`, which tests the built artifact rather than a
module (see [Tests](#tests)).

## Dependencies

Four runtime dependencies: [`hebits-client`](https://github.com/lacherogwu/hebits-client),
which talks to Hebits' JSON API; [`hono`](https://hono.dev/) and `@hono/node-server` for the
HTTP layer; and [`zod`](https://zod.dev/) to validate `config.json`. All four are bundled into
`dist/server.mjs` at build time, so the target installs nothing. Everything else (`typescript`,
`tsdown`, `vitest`, `biome`, `@types/node`) is a dev dependency needed only to build and test.

## Tests

```bash
npm test
```

Runs the [vitest](https://vitest.dev/) suite. No network access required — Hebits and
qBittorrent are mocked throughout, and the tests that spawn the built bundle point `qbitUrl` at
a dead port and disable both jobs, so isolation holds by construction rather than by which
routes happen to be exercised.

`test/bundle.test.ts` is the exception to "`test/` mirrors `src/`": it builds, then runs
`dist/server.mjs` as a lone file in an empty directory with no `package.json` and no
`node_modules` — the deployment condition. That is the only place a build that stopped inlining
`package.json` (which `src/version.ts` imports for `VERSION`) would show up, and the only place
that proves a corrupt `config.json` or `state.json` leaves a service that still answers rather
than a launchd restart loop.

## Deploy

```bash
npm run deploy
```

`scripts/deploy.sh` runs `npm run typecheck` and `npm test`, builds with `npm run build`, and
copies the single resulting `dist/server.mjs` to the target machine. The target needs a Node
≥ 22 binary to run it and nothing else — no `node_modules`, no `npm install`, no registry
access.

The LaunchAgent itself is installed once, by hand: copy `deploy/org.user.hebits-builder.plist`
to `~/Library/LaunchAgents/`, replace `__HOME__` with the target's home directory, and
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.user.hebits-builder.plist`. Its
`StandardOutPath` must stay equal to `logFile` — the service logs to stdout, so if the two
disagree the rotator truncates a file nothing writes while the real log grows without limit.
`deploy.sh` checks for that and warns, but does not fix it, since it never touches the plist.
