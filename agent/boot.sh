#!/bin/sh
# Boot of the always-on runner. The image is only node on alpine, so it uploads to orbio once; everything else arrives
# here at start: chromium for the cards, git for the per-tick pull, the repo itself and its npm deps.
set -e
REPO="${CATURN_REPO_URL:-https://github.com/Jbusiness0810/caturn.git}"
apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-dejavu font-noto-emoji git bash >/dev/null
export CHROME_PATH=/usr/bin/chromium-browser PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production CATURN_RUNNER=1
if [ ! -d /app/.git ]; then
  rm -rf /app && git clone -q --depth 1 --branch master "$REPO" /app
fi
cd /app
git config user.name caturn-runner && git config user.email caturn-runner@users.noreply.github.com
npm i --omit=dev --no-audit --no-fund --loglevel=error
npm i --no-save --no-audit --no-fund --loglevel=error playwright@1.49.1 gifenc@1.0.3 errand-mcp@0.5.0
mkdir -p out data
exec node agent/loop.mjs
