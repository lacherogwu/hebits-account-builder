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
environment variable. See `config.example.json` for a starting point.

| Key | Default | Meaning |
|---|---|---|
| `token` | random, generated on first run | Secret path segment every route sits behind |
| `port` | `18701` | Listen port, all interfaces. Chosen to sit below the range the OS hands out for outbound connections (49152+ on macOS/Windows, 32768+ on Linux), so it cannot lose a bind race, and clear of the round ports common services claim |
| `lanHost` | empty (auto-detected) | LAN address used in links such as the cookie-update alert; set it if auto-detection picks the wrong interface |
| `dailyLimit` | `0` | Fallback only; the real counter is read from Hebits through `hebits-client`. `0` means "take the allowance of the rank the account currently holds" (see the ladder below); a non-zero value pins it |
| `dailyLimitByDay` | `{}` | Per-day overrides, e.g. `{"2026-09-17": 5}` for a new account's first day |
| `minFreeGB` | `20` | Free disk space to keep after a download |
| `timezone` | `Asia/Jerusalem` | Used for the daily download counter's day boundary |
| `qbitUrl` | `http://127.0.0.1:8080` | qBittorrent WebUI base URL |
| `qbitUsername`, `qbitPassword` | empty | Only needed if qBittorrent's "bypass authentication for clients on localhost" is off |
| `watchCategory`, `watchPath` | `watch`, `~/hebits/watch` | Category/path for torrents grabbed on demand, as opposed to the ones this service farms |
| `seedCategory`, `seedPath` | `seed-auto`, `~/hebits/seed` | Category/path for torrents auto-grabbed to build the account |
| `trackerHost` | `hebits.net` | The tracker host a torrent must announce to before it can be [adopted](#adoption). Only worth changing if the tracker's announce domain moves; a wrong value means nothing is ever adopted, which `/status` reports and an alert names |
| `farm` | `{"enabled": true, "intervalMin": 10}` | Auto-grab job; see `GRAB_DEFAULTS` in `src/farm.ts` for tuning knobs (`keepForUser`, `reserveGB`, `maxSizeGB`, …) and [Rank targets and presets](#rank-targets-and-presets) for `targetRank`, `preset` and `weights` |
| `cleanup` | `{"enabled": true, "intervalMin": 30}` | Auto-release job; see `CLEANUP_DEFAULTS` in `src/farm.ts` (`reserveGB`, `minSeedDays`, `keepIfSeedersBelow`, …) |
| `notify` | `{"webhookUrl": ""}` | Alert transport; see [Notifications](#notifications) |
| `rateLimit` | `{"limit": 1, "interval": 2000}` | At most `limit` requests per `interval` ms, shared across every tracker call — `browse`, the profile counter, `.torrent` downloads and every retry. The default is one per two seconds, which is right here: nothing in this service has a person waiting on it. Past 5/s a note is recorded in `configIssues`, but the value is honoured |
| `lowDiskAlertGB` | `15` | Alert threshold after a release pass still leaves the disk full |
| `torrentDir` | `<config dir>/torrents` | Where downloaded `.torrent` files are cached |
| `cookiePath` | `<config dir>/cookie.txt` | File holding the Hebits session cookie; written by the `/cookie` page |
| `logFile` | `<config dir>/builder.log` | The log the service writes. It logs to stdout, so whatever supervises the service must redirect stdout and stderr to this same path — see [Running it as a service](#running-it-as-a-service); it's truncated in place, with a `.1` backup, once it passes 20 MB |

**Why the `token` is random rather than empty.** There is no login here: the token *is* the
authentication, and the service listens on all interfaces. An empty token would not mean "no
protection" — it would mean the guard compares two empty strings and passes, leaving every
route open to anyone who can reach the port, including `/cookie`, where the Hebits session
cookie is pasted and can be read back. Generating one on first run is safe by default with
nothing to set up. It is then preserved across restarts, and across a corrupted `config.json`
wherever it can be identified unambiguously, because rotating it breaks the `/status` and
`/cookie` URLs you have bookmarked.

The cookie **value** is never a `config.json` key — only its location is. It lives in the file
at `cookiePath`, written by `/cookie` once a paste passes verification, and is re-read on every
request, so a fresh paste takes effect with no restart.

`cookiePath` defaults inside the config directory, so the service is self-contained. Point it
at a file another service also reads — anything logging in as the same Hebits account — and one
paste serves both. The parent directory is created on write, so a shared location outside
either service's config directory works.

## Endpoints

Every route sits behind the random `token` from `config.json`, as a path segment:
`http://<host>:<port>/<token>/<route>`. A wrong or missing token gets a plain 404, same as an
unknown route — the token isn't revealed by the response.

- **`/status`** — JSON: account class, upload/download totals, ratio, progress toward the
  **target rank** on each farmable dimension (`account.target`: the rank, which dimension is
  binding, the preset in force and its weights, and a one-line `summary` such as
  `ratio 1.51/1.5 ✓, volume 10.4/75 GB, torrents ≥12/50`), today's download count, Hebits
  login health, free disk space, the last 20 grab/release/error events, and the torrents
  currently managed. It also reports anything that went wrong at startup: `configIssues`
  (settings that failed validation and fell back to their default), `storeIssue` (a
  `state.json` that had to be moved aside) and `adoption` (which torrents already in
  qBittorrent the builder has taken over, and which tagged ones it declined to and why — see
  [Adoption](#adoption)). Every reading
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
these tags are the only record. The scheme is deliberately plain, so any other tool sharing
the qBittorrent instance can read it: recognize torrents this service added and match them to
an IMDb id. Nothing here requires such a tool to exist.

## Adoption

`state.json` is a cache, not a source of truth — except in one place: the release job will only
ever delete a torrent that the store records, and nothing else on the machine says which those
are. Restore a Mac from scratch, keep the qBittorrent data directory and lose the config
directory, and the result is a service that grabs, never frees a byte, and looks healthy until
the disk is full about a week later.

Adoption closes that. Every 30 minutes — and again at the top of each release pass, before it
decides anything — the builder looks for torrents qBittorrent is holding that its own index has
never heard of, and takes over the ones it can prove are its business. A torrent is adoptable
only if **both** hold:

- it carries a `hebits:<id>` tag whose value is a torrent id (digits) — see [Tags](#tags); and
- its announce list contains a URL whose host is `trackerHost`, or a subdomain of it.

That is deliberately strict, because adopting a torrent is what gives the release job
permission to delete it with its files. A torrent wrongly adopted is the owner's own download
disappearing; a torrent wrongly left alone is just a torrent the builder does not manage, which
is the status quo. So anything ambiguous — a `hebits:` tag that isn't an id, an id already on
record against a different infohash, a tracker list that couldn't be read — is reported on
`/status` rather than adopted, and torrents with no `hebits:` tag at all (the owner's own,
sharing the same qBittorrent) are neither adopted nor reported.

An adopted entry records only what qBittorrent can evidence: the infohash, the torrent name,
the size on disk, the IMDb id if the tag carries one, and `completedAt` taken from
qBittorrent's own completion time — not from the moment adoption ran, which on a rebuilt
machine would date every torrent to the rebuild. An existing `completedAt` is never moved. The
fields that came from the tracker listing or the `.torrent` file (`title`, `cover`,
`fileCount`, `files`, `pieceLength`, and whether the grab was automatic) are left absent rather
than guessed; a later real grab fills them in.

Running it repeatedly changes nothing: a torrent whose infohash any entry already holds is
recognised, so a converged machine makes no tracker calls and writes nothing. And because only
torrents *present* in qBittorrent are ever considered, an entry the release job marked
`removedAt` can never come back.

It runs as a tick rather than once at startup on purpose. The service is meant to run under a
supervisor that restarts it on exit, so anything that throws before the notifier exists is a
silent restart loop, and
the one thing adoption depends on is a local qBittorrent — which on a machine that just
rebooted is down for a minute or two. A tick converges instead of getting a single chance.

## Rank targets and presets

Every rank above Heb Rookie asks for four things: time on site, GB downloaded, a ratio, and —
from Heb Lover up — a number of torrents downloaded in full. `RANKS` in `src/farm.ts` carries
the ladder, and `farm.targetRank` says which rung to aim at.

| Rank | Time | Volume | Ratio | Torrents | Demoted below | Downloads/day |
|---|---|---|---|---|---|---|
| Heb Rookie | — | — | — | — | — | 5 on day one, then 10 |
| Heb User | 30 days | 20 GB | 1.25 | — | 0.8 | 25 (30 after 6 months) |
| Heb Lover | 6 weeks | 75 GB | 1.5 | 50 | 1.45 | 50 |
| Heb Veteran | 12 weeks | 250 GB | 2.05 | 100 | 1.95 | 50 |
| Heb Fanatic | 16 weeks | 500 GB | 2.5 | 150 | 2.45 | 65 |
| Heb Elite | 52 weeks | 1 TB | 3 | 350 | 2.95 | 65 |
| Heb Supreme | 82 weeks | 2 TB | 4 | 500 | 3.95 | 80 |
| Heb Prophet | 130 weeks | 3.5 TB | 5 | 700 | 4.95 | 100 |

The table flattens two footnotes toward the conservative reading, because over-grabbing on a
private tracker is not a cosmetic mistake: Heb Rookie's first day is 5 downloads, which is what
`dailyLimitByDay` is for, and Heb User's allowance rises to 30 after six months, which nothing
here can verify. Donor, V.I.P and the staff classes are not farmable and are deliberately
absent — an account in one of them reads as an unknown rank, and every fallback applies.

Time on site is the one requirement nothing can farm. It is reported, never chased. The daily
allowance is read from the rank the account currently *holds*, so a promotion raises it without
anyone editing `config.json`; everything else is measured against the rank it is *aiming at*.

`farm.targetRank` defaults to `"auto"` — one rung above whatever rank the account currently
holds — and accepts any rank name to aim higher or to hold a lower target. The volume, ratio
and torrent-count goals all derive from it; `farm.countedTargetGB` and `farm.targetRatio` still
pin those two numbers explicitly if you set them.

**Required ratio vs target ratio.** These are different things and only one of them blocks a
grab. The *required* ratio (`requiredRatioFor`, plus the demotion line of the rank you hold) is
a floor: crossing it costs the account its rank or its ability to download at all, so a counted
download may never project below it. The *target* rank's ratio is a goal. It steers which
torrents are preferred and it is what `/status` reports progress against, but it never refuses
a grab — an earlier version conflated the two and throttled the account to defend a threshold
the tracker never required.

**Presets** weight the three farmable dimensions against each other. They decide *which*
candidates win the day's scarce slots; every filter and every safety check runs identically
under all of them.

| Preset | ratio | volume | count | For |
|---|---|---|---|---|
| `ratio-first` | 1 | 0 | 0 | Ratio is at or near the floor. Nothing else matters from a demoted account |
| `balanced` | 0.5 | 0.25 | 0.25 | Nothing is binding; keep earning on every dimension |
| `volume-first` | 0.25 | 0.75 | 0 | GB downloaded is what is missing |
| `count-first` | 0.25 | 0 | 0.75 | The torrent count is what is missing |

`volume` and `count` pull in opposite directions on purpose: the volume requirement counts GB,
so it wants big *counted* torrents (freeleech bytes do not count toward it at all), while the
torrent requirement counts torrents, so a 1 GB episode is worth exactly as much as a 40 GB
remux. `ratio` constrains both.

With nothing configured the policy farms the **recommended** preset: whichever dimension is
furthest from the target rank's requirement, except that at or below the ratio floor `ratio`
wins outright regardless. Set `farm.preset` to pin one, or `farm.weights`
(`{"ratio": …, "volume": …, "count": …}`) to override individual weights.

**The completed-torrent count is a lower bound**, and `/status` prints it as `≥ n`. The
tracker's own figure is a lifetime count it never lowers, and nothing this service can reach
reports it: `hebits-client`'s account stats carry uploaded, downloaded, ratio, required ratio
and class, and no snatch count. What is counted instead is torrents this service has *observed*
at 100% — from qBittorrent, plus a `completedAt` stamp kept in `state.json` so releasing a
torrent does not un-count it. Torrents grabbed by hand, or completed before this service (or
this `state.json`) existed, are invisible to it — except where [adoption](#adoption) can
recover them, which it does for any tagged Hebits torrent still in qBittorrent. The real number
can only be higher. A count
with no basis at all is reported as `unknown` rather than as `0`, because a zero would steer
every decision at a dimension nobody measured.

## Account-building policy

- **Grab** (every 10 min), from uploads of the last 6 h: movies/TV only, 1–40 GB, no remux.
  - Always takes freeleech.
  - Takes counted downloads only while under the target rank's volume (plus 10% headroom),
    only when half-leech or ×2-upload and ≤ 15 GB, and only while the projected ratio stays
    ≥ the required ratio + 0.2 and ≥ the current rank's demotion line + 0.2.
  - Ranks candidates by the preset in force (see above). Skips releases older than 1 h that
    nobody is downloading.
  - x2/x3-upload releases rank higher.
  - At most 2 grabs per hour, so later releases in the day still get a slot.
  - Leaves `keepForUser` (3) daily downloads and `reserveGB` (40 GB) of disk free.
- **Release** (every 30 min), only when free space drops under 40 GB.
  - Candidates: finished torrents this service manages, seeded ≥ 8 days, with ≥ 5 seeders.
    Titles in the `watch` category also need ≥ 14 days since completion.
  - Lowest bonus points per GB go first, until 50 GB is free.
  - Below 10 GB free, rare torrents may go too.
- **Adopt** (every 30 min, and before every release pass): takes over torrents already in
  qBittorrent that carry a `hebits:<id>` tag and announce to `trackerHost`, so a rebuilt
  machine can release them again. See [Adoption](#adoption).
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
| `src/server.ts` | HTTP server: routing, token auth, startup wiring, log rotation, schedules the background jobs |
| `src/config.ts` | Loads/saves `config.json` and owns the Hebits cookie file |
| `src/jobs.ts` | The background jobs (`farmTick`, `cleanupTick`, `adoptTick`) and login/service health tracking |
| `src/farm.ts` | Account-building policy: pure functions deciding what to grab and what to release |
| `src/grab.ts` | Turns a Hebits id into a running qBittorrent torrent: download, add, tag |
| `src/qbit.ts` | qBittorrent WebUI API client |
| `src/cookie-page.ts` | The `/cookie` HTML page: paste a cookie, verify it, save it |
| `src/notify.ts` | Alert transport (webhook and/or local command), with templating and throttling |
| `src/store.ts` | Persistent JSON state: grab history, torrent index, notifier throttle state |
| `src/tags.ts` | Builds/parses the qBittorrent tags that record Hebits/IMDb identity |
| `src/parse.ts` | Release-name parsing: disc/remux detection, season/episode info |
| `src/bencode.ts` | Minimal bencode reader for `.torrent` files (infohash, name, files, piece length) |

`test/` mirrors `src/` one file per module, except that `src/farm.ts` — which holds three
separate policies — is covered by `farm.test.ts` (what to grab and release), `ranks.test.ts`
(the rank ladder and presets) and `adopt.test.ts` (what may be adopted). Plus `test/factory.ts`
for shared fixtures and `test/bundle.test.ts`, which tests the built artifact rather than a
module (see [Tests](#tests)).

## Dependencies

Four runtime dependencies: [`hebits-client`](https://github.com/lacherogwu/hebits-client),
which talks to Hebits' JSON API; [`hono`](https://hono.dev/) and `@hono/node-server` for the
HTTP layer; and [`zod`](https://zod.dev/) to validate `config.json`. All four are bundled into
`dist/server.mjs` at build time, so the machine that runs it installs nothing. Everything else (`typescript`,
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
`node_modules` — the shipping condition. That is the only place a build that stopped inlining
`package.json` (which `src/version.ts` imports for `VERSION`) would show up, and the only place
that proves a corrupt `config.json` or `state.json` leaves a service that still answers rather
than a restart loop.

## Running it as a service

`npm run build` produces one self-contained file, `dist/server.mjs`. Copy it wherever you keep
it and start it under whatever supervisor you already use — launchd, systemd, pm2, a
container. The machine that runs it needs a Node ≥ 22 binary and nothing else: no
`node_modules`, no `npm install`, no registry access.

This repo ships no deployment tooling on purpose. The host, the install path and the service
manager are facts about your machine, not about this service.

Three things a supervisor has to get right:

- **Send stdout and stderr to `logFile`.** The service logs with `console.log`, so whatever the
  supervisor does with stdout *is* the log, while rotation truncates `logFile`. Let those two
  disagree and the rotator faithfully truncates a file nothing writes while the real log grows
  without limit. Truncation is deliberate — it is the only method that works while the
  supervisor holds the descriptor open, so don't replace it with a rename.
- **Set `HEBITS_BUILDER_DIR` in the supervisor's own environment**, if you set it at all. A
  supervised service does not inherit your shell, so a shell profile has no effect on it. It
  also moves the default `logFile`, so it runs into the point above as well.
- **Restart-on-exit is safe, and worth turning on.** Nothing on the startup path throws: a
  `config.json` or `state.json` that will not parse is moved aside and the service starts on
  defaults, so a restart policy cannot turn one typo into a restart loop that never alerts
  anybody.

After an upgrade, confirm the version now answering is the build you just installed rather
than assuming the restart took — a supervisor that failed to restart leaves the old process
answering happily:

```bash
curl -s "http://127.0.0.1:18701/<token>/status" | grep -o '"version":"[^"]*"'
```

## Using it only for maintenance, not for grabbing

If you already download what you want some other way and only need the seeding side handled,
set `"farm": { "enabled": false }` and leave `cleanup` on. The grab job stops; **adoption and
the release pass run on their own timers and are unaffected**. What you get is a service with
one job: keep torrents seeding until they have met the tracker's requirement with a margin,
then remove them — worst value per GB first — and only once free space actually runs low.

It works on torrents this service never added. Adoption takes over anything in qBittorrent
that carries a `hebits:<id>` tag and announces to `trackerHost` (see
[Adoption](#adoption)), so torrents added by hand, or by any other tool writing the same
[tags](#tags), become releasable with no integration between the two. Titles in
`watchCategory` are held longer than the rest, on the assumption that you downloaded those to
watch rather than to seed — so something you just finished watching is not the first thing to
go.

Read [Account-building policy](#account-building-policy) for the thresholds before pointing
this at a live account: "met the requirement" is `CLEANUP_DEFAULTS` in `src/farm.ts`, not the
tracker's own rules, and you are responsible for keeping the two in agreement.

## Related

Independent projects, listed only because they may be useful — this service requires none of
them and does not talk to them:

- [`hebits-client`](https://www.npmjs.com/package/hebits-client) — the Hebits API client this
  service is built on. Useful on its own.
- [`hebits-stremio-addon`](https://github.com/lacherogwu/hebits-stremio-addon) — a separate
  Stremio-protocol addon that streams from the same tracker through your own qBittorrent. It
  never removes a torrent, so this service pairs well with it as the release side — see
  [Using it only for maintenance](#using-it-only-for-maintenance-not-for-grabbing). If you run
  both against one qBittorrent, they recognize each other's torrents through the
  [tags](#tags) above, but neither needs the other to be installed or running.
