// The single source of truth for the version is package.json. A hand-maintained copy here
// could drift from it while its own test still passed - pinning the duplicate proves only
// that the duplicate is what it was - and the drift would then show up as /status and the
// startup banner reporting a version that is not the one scripts/deploy.sh just shipped, on
// a service whose only build-identity signal those two are.
//
// tsdown bundles this import, so it is resolved at build time and the shipped dist/server.mjs
// carries the literal rather than reading package.json at runtime. That matters concretely:
// the target holds dist/server.mjs and nothing else - no package.json, no node_modules - so a
// build that stopped inlining would not report a wrong version, it would fail to start at all
// (ERR_MODULE_NOT_FOUND) under KeepAlive. test/bundle.test.ts pins that against the built
// artifact, because build-time inlining is not a property any unit test can see.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
