# caturn.lol

Static landing page for Caturn ($CTRN). Plain HTML, one CSS file, a little JS. No build step.

## Deploy (Vercel)
Import the repo. Framework preset: Other. No build command, no output directory. `vercel.json` turns on clean URLs so `/paper` serves `paper.html`, and keeps `js/config.js` uncached so a launch-day edit shows up immediately. Add `caturn.lol` under Project Settings > Domains.

## Launch day
Edit `js/config.js` and set `ca` (and optionally `launchTx`, `orbioFun`, `x`, `explorer`).
The contract card, copy button, status pill and footer links update from that one object.

## Mascot
Drop the artwork at `public/mascot.png`. Until then a CSS orb placeholder renders in its place.
