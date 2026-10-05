# The always-on runner image for orbio's Fly.io servers. Deliberately tiny: node on alpine plus one boot script.
# Orbio takes images in 128 KB pieces, so the base layers upload once and every later deploy sends only the script.
# Chromium, git, the repo and its npm deps are installed at boot (agent/boot.sh); each tick then pulls master.
FROM node:20-alpine
COPY agent/boot.sh /boot.sh
ENV CHROME_PATH=/usr/bin/chromium-browser PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production CATURN_RUNNER=1
CMD ["/bin/sh", "/boot.sh"]
