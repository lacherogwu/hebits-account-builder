#!/usr/bin/env bash
# Deploy the builder: test, build, copy one bundled file, restart, verify.
#   scripts/deploy.sh                 # uses ssh host "my-ssh-host"
#   DEPLOY_HOST=other scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-my-ssh-host}"
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

echo "→ waiting for it to answer"
ssh "$HOST" 'bash -s' <<'REMOTE'
T=$(~/Applications/node/bin/node -p 'require(process.env.HOME + "/.config/hebits-account-builder/config.json").token')
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:7001/$T/status" >/dev/null 2>&1; then
    echo "✓ builder is answering"
    tail -n 3 ~/Library/Logs/hebits-builder.log
    exit 0
  fi
  sleep 1
done
echo "✗ builder did not come up; last log lines:"
tail -n 20 ~/Library/Logs/hebits-builder.log
exit 1
REMOTE
