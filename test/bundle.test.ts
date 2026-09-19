// Exercises the BUILT artifact (dist/server.mjs), not the source, and runs it the way the
// target runs it: one file, alone, with no package.json and no node_modules anywhere above
// it. src/version.ts derives VERSION from ../package.json, which tsdown inlines at build
// time - a property no test that imports src/ can see, because in the repo that import
// resolves either way. Where it runs it would not: the installed tree holds dist/server.mjs
// and nothing else, so a build that stopped inlining dies with ERR_MODULE_NOT_FOUND, i.e. a
// silent restart loop under a supervisor that restarts on exit. Hence the copy into a temp
// dir - Node resolves a bare specifier from the FILE's location, so spawning out of the repo
// would quietly supply everything the real install lacks.
//
// The second block below is the end-to-end form of the same rule: config.ts and store.ts both
// run at module load, and their recovery paths can only be proved to keep the process alive by
// a process that actually starts.
//
// Nothing here reaches the network or a real qBittorrent: the routes exercised (the token
// guard's 404 and the /cookie form) are served without a single outbound call, and both jobs
// are disabled in the throwaway configs.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

interface RawResponse {
  status: number;
  body: string;
}

function rawGet(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ hostname: '127.0.0.1', port, path, timeout: 5_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

// Isolation by construction, not by which routes a test happens to exercise. The machine this
// builder deploys to runs a live qBittorrent on qbitUrl's default (127.0.0.1:8080), so point at
// a port nothing listens on. notify's webhook is '' by default; spelled out so isolation
// doesn't depend on that staying true. Both jobs off: a farm tick would talk to hebits.net -
// it is 60s away and these suites finish long before, but "no network" should not rest on a
// race being won. The adoption tick has no enabled flag (it only reads qBittorrent and writes
// the local index), so the dead qbitUrl - not a config switch - is what holds for it.
const throwawayConfig = (port: number): string =>
  JSON.stringify({
    port,
    qbitUrl: 'http://127.0.0.1:1',
    notify: { webhookUrl: '' },
    farm: { enabled: false },
    cleanup: { enabled: false },
  });

// The same throwaway config, but with the one field that used to kill every route.
const withBadToken = (port: number): string => JSON.stringify({ ...JSON.parse(throwawayConfig(port)), token: 12345 });

interface ConfigFile {
  token?: string;
}

// One spawned bundle, plus everything needed to say why it didn't start.
interface Running {
  dir: string;
  port: number;
  token: string;
  child: ChildProcess;
  stdout: () => string;
  diagnostics: () => string;
}

// `seed` writes whatever the config dir should already contain; it gets the dir and the port
// this run will use. It is what lets the second block hand the bundle a broken config dir.
async function startBundle(seed: (dir: string, port: number) => void): Promise<Running> {
  const port = await getFreePort();
  const dir = mkdtempSync(join(tmpdir(), 'hebits-builder-bundle-test-'));
  seed(dir, port);

  // Copy the bundle out as a lone file: the deployment condition, and the only thing that makes
  // the inlining check below real rather than a proxy for it.
  const deployedBundle = join(dir, 'server.mjs');
  copyFileSync(join(REPO_ROOT, 'dist', 'server.mjs'), deployedBundle);

  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  let exitInfo: string | undefined;
  const child = spawn('node', [deployedBundle], {
    cwd: dir,
    env: { ...process.env, HEBITS_BUILDER_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.on('error', (e) => {
    spawnError = e;
  });
  child.on('exit', (code, signal) => {
    exitInfo = `code=${code} signal=${signal}`;
  });
  const diagnostics = (): string =>
    `spawnError: ${spawnError?.message ?? '-'}\nexit: ${exitInfo ?? '-'}\nstdout:\n${stdout}\nstderr:\n${stderr}`;

  // These are the tests meant to catch subtle build and module-load breakage - when the server
  // fails to even start, they should say why, not just that a connection was refused.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await rawGet(port, '/');
      break;
    } catch (e) {
      if (Date.now() > deadline)
        throw new Error(`builder on :${port} did not become ready in time: ${(e as Error).message}\n${diagnostics()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // loadConfig() writes the token to config.json synchronously, before the server starts
  // accepting connections - so by the time the probe above succeeds it's there.
  const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as ConfigFile;
  if (!saved.token) throw new Error(`config.json has no token after startup\n${diagnostics()}`);
  return { dir, port, token: saved.token, child, stdout: () => stdout, diagnostics };
}

let clean: Running | undefined;

describe('the built bundle (dist/server.mjs)', () => {
  beforeAll(async () => {
    // Never let these tests pass against a stale dist/ - rebuild every run.
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
    clean = await startBundle((dir, port) => writeFileSync(join(dir, 'config.json'), throwawayConfig(port)));
  }, 60_000);

  afterAll(() => {
    clean?.child.kill();
    if (clean) rmSync(clean.dir, { recursive: true, force: true });
  });

  test('a wrong token gets the same plain 404 as an unknown route', async () => {
    const { port, token } = clean as Running;
    const wrong = await rawGet(port, '/not-the-token/status');
    const unknown = await rawGet(port, `/${token}/does-not-exist`);
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(wrong.body).toBe('{"error":"not found"}');
    expect(wrong.body).toBe(unknown.body);
  });

  // The success-path control for the 404 above. On its own, a 404 assertion cannot tell "the
  // token guard rejected it" from "routing is broken and everything falls through to the
  // catch-all 404" - both look identical. /cookie is the one token-guarded route that answers
  // without a single outbound call (it renders a form; the tracker is only touched on POST),
  // so this proves a correct token reaches a real handler without giving up the no-network
  // property.
  test('control: the right token reaches a route handler (the /cookie form, 200)', async () => {
    const { port, token } = clean as Running;
    const res = await rawGet(port, `/${token}/cookie`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Update the Hebits login');
  });

  // The property that matters: the SHIPPED artifact reports package.json's version. The banner
  // is the builder's only network-free version surface (/status reads the tracker), and it is
  // what `tail`ing the log after a deploy shows. Compared by exact string match against
  // package.json read from disk here - not imported, so a broken derivation cannot satisfy both
  // sides at once.
  test('the built bundle reports package.json version in its startup banner', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    expect((clean as Running).stdout()).toContain(`hebits account builder v${pkg.version} listening on :${(clean as Running).port}`);
  });

  // The inlining itself, pinned directly. The lone-file spawn above already fails if the bundle
  // needs a package.json at runtime, but only because Node cannot find one - this says the
  // bundle does not so much as name the file, so a future build mode that resolved it to some
  // path that happens to exist is caught as well.
  test('the bundle contains no runtime package.json read', () => {
    expect(readFileSync(join(REPO_ROOT, 'dist', 'server.mjs'), 'utf8')).not.toContain('package.json');
  });
});

// loadConfig() and new Store() both run at module load, before the Notifier exists, under a
// supervisor that restarts on exit. Every unit test for their recovery paths
// asserts "does not throw"; only a spawned process proves that what they leave behind is a
// service that answers. This block hands the bundle both files broken at once, which is also
// the one arrangement that catches an ordering trap the unit tests cannot see: server.ts passes
// `log` to the Store constructor, and a corrupt state.json is the only thing that makes that
// constructor call its logger - so `const log` declared after the Store would be a temporal
// dead zone ReferenceError here and nowhere else.
describe('the built bundle starting from a broken config dir', () => {
  let broken: Running | undefined;

  beforeAll(async () => {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
    broken = await startBundle((dir, port) => {
      // A non-string token: the field that used to be exempt from the per-field contract, and
      // whose failure mode was total - Buffer.from() in tokenOk() throws on every route, and a
      // truthy value also stopped config.json ever being rewritten, so the service stayed dead
      // across restarts with /cookie dead too. The config stays parseable because an
      // unparseable one cannot carry `port`, and this suite needs the bundle on a free port.
      writeFileSync(join(dir, 'config.json'), withBadToken(port));
      // Truncated mid-object: the Store's recovery path, and the only thing that makes the
      // Store constructor call the logger server.ts hands it.
      writeFileSync(join(dir, 'state.json'), '{ "grabs": [{"id":"1","at":"2026-01-01T00:00:00.000Z"}], "torrents": {');
    });
  }, 60_000);

  afterAll(() => {
    broken?.child.kill();
    if (broken) rmSync(broken.dir, { recursive: true, force: true });
  });

  test('it starts and answers on a freshly generated token', async () => {
    const { port, token } = broken as Running;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const res = await rawGet(port, `/${token}/cookie`);
    expect(res.status).toBe(200);
  });

  test('the broken state.json is moved aside, not destroyed', () => {
    const { dir } = broken as Running;
    const badFile = readdirSync(dir).find((f) => f.startsWith('state.json.bad-'));
    expect(badFile).toBeTruthy();
    expect(readFileSync(join(dir, badFile as string), 'utf8')).toBe(
      '{ "grabs": [{"id":"1","at":"2026-01-01T00:00:00.000Z"}], "torrents": {',
    );
  });
});
