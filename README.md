# caturn.lol

Static landing page for Caturn ($CTRN). Plain HTML, one CSS file, a little JS. No build step.

## Deploy
Cloudflare Pages or Vercel: point at the repo root, no build command, output directory `/`.

## Launch day
Edit `js/config.js` and set `ca` (and optionally `launchTx`, `orbioFun`, `x`, `explorer`).
The contract card, copy button, status pill and footer links update from that one object.

## Mascot
Drop the artwork at `public/mascot.png`. Until then a CSS orb placeholder renders in its place.
