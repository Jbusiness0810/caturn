# The always-on runner image for orbio's Fly.io servers: node, chromium for the cards and sketches, git so each tick can
# pull master. Code is cloned at build time and pulled at every tick, so the image only changes when this file does.
FROM node:20-alpine
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-dejavu font-noto-emoji git bash tini
ENV CHROME_PATH=/usr/bin/chromium-browser PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production CATURN_RUNNER=1
ARG REPO=https://github.com/Jbusiness0810/caturn.git
WORKDIR /app
RUN git clone --depth 50 --branch master "$REPO" . \
 && git config user.name caturn-runner && git config user.email caturn-runner@users.noreply.github.com \
 && npm i --omit=dev --no-audit --no-fund --loglevel=error \
 && npm i --no-save --no-audit --no-fund --loglevel=error playwright@1.49.1 gifenc@1.0.3 errand-mcp@0.5.0 \
 && mkdir -p out data
ENTRYPOINT ["tini", "--"]
CMD ["node", "agent/loop.mjs"]
