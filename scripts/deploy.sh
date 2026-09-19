#!/usr/bin/env bash
# Deploy the builder: test, build, copy one bundled file, restart, verify.
#   DEPLOY_HOST=my-ssh-host scripts/deploy.sh   # set it each time, or...
#   echo my-ssh-host > .deploy-host             # ...once, in a git-ignored file
set -euo pipefail

HOST="${DEPLOY_HOST:-$(cat .deploy-host 2>/dev/null || true)}"
if [[ -z "$HOST" ]]; then
  echo "No deploy host. Set DEPLOY_HOST=<ssh-host>, or write it to .deploy-host (git-ignored):" >&2
  echo "  echo my-ssh-host > .deploy-host" >&2
  exit 1
fi
DEST="Applications/hebits-account-builder"
cd "$(dirname "$0")/.."

echo "→ typecheck + tests"
npm run typecheck
npm test

echo "→ build"
npm run build

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "! uncommitted changes are being deployed"
fi

VERSION=$(node -p "require('./package.json').version")
echo "→ copying v$VERSION to $HOST:$DEST/dist/"
ssh "$HOST" "mkdir -p $DEST/dist"
rsync -az dist/server.mjs "$HOST:$DEST/dist/server.mjs"

echo "→ restarting"
ssh "$HOST" 'launchctl kickstart -k gui/$(id -u)/org.user.hebits-builder'

# This script deploys dist/server.mjs and nothing else - the LaunchAgent is installed once,
# by hand. That matters for one specific thing: the service logs with console.log, so the log
# it actually writes is wherever the plist points StandardOutPath, while rotateLog() truncates
# config.json's `logFile`. If those two ever disagree the rotator rotates an empty file and the
# real log grows unbounded, which is exactly the state this repo shipped in until the plist was
# corrected. Read-only check; it never fails the deploy.
ssh "$HOST" 'bash -s' <<'REMOTE' || true
PLIST=~/Library/LaunchAgents/org.user.hebits-builder.plist
[[ -f "$PLIST" ]] || exit 0
grep -q '\.config/hebits-account-builder/builder\.log' "$PLIST" && exit 0
echo "! the installed LaunchAgent still sends stdout somewhere other than"
echo "  ~/.config/hebits-account-builder/builder.log, so log rotation is a no-op and the"
echo "  real log grows unbounded. Reinstall deploy/org.user.hebits-builder.plist:"
echo "    launchctl bootout gui/\$(id -u)/org.user.hebits-builder"
echo "    launchctl bootstrap gui/\$(id -u) $PLIST"
REMOTE

echo "→ waiting for it to answer"
ssh "$HOST" 'bash -s' <<'REMOTE'
T=$(~/Applications/node/bin/node -p 'require(process.env.HOME + "/.config/hebits-account-builder/config.json").token')
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:7001/$T/status" >/dev/null 2>&1; then
    echo "✓ builder is answering"
    tail -n 3 ~/.config/hebits-account-builder/builder.log
    exit 0
  fi
  sleep 1
done
echo "✗ builder did not come up; last log lines:"
tail -n 20 ~/.config/hebits-account-builder/builder.log
exit 1
REMOTE
