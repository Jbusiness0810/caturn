# caturn.lol

Static landing page for Caturn ($CTRN). Plain HTML, one CSS file, a little JS. No build step.

## Deploy (Vercel)
Import the repo. Framework preset: Other. No build command, no output directory. `vercel.json` turns on clean URLs so `/paper` serves `paper.html`, and keeps `js/config.js` uncached so a launch-day edit shows up immediately. Add `caturn.lol` under Project Settings > Domains.

## Launch day
Edit `js/config.js` and set `ca` (and optionally `launchTx`, `orbioFun`, `x`, `explorer`).
The contract card, copy button, status pill and footer links update from that one object.

## Mascot
`public/mascot.png` (1024px, transparent) and `public/favicon.png` (192px) are cut from `art/mascot-original.png`. If `mascot.png` is ever missing, a CSS orb placeholder renders in its place.

## Theme and sound
`js/main.js` drives the orbit theme: a brass star field with scroll parallax, a rail on the right where Caturn rides down the page and naps at the bottom, soft section reveals, and a hero parallax. All of it respects `prefers-reduced-motion`.

Background music is on by default. It starts muted on load (the only autoplay browsers allow), unmutes on the visitor's first tap or click, and stays off for anyone who switches it off. Track: "Floating Cities" by Kevin MacLeod, CC BY 4.0, credited in the footer and in `public/audio/LICENSE.txt`.

## Activity dashboard and the agent
Section 04 on the index and `/activity` render `data/feed.json`: status, energy, volume, CREDIT, the thought log and X posts. Add `?demo` to either URL to preview with `data/feed.sample.json`.
The feed is written by the runtime in `agent/` on a GitHub Actions cron. See `agent/README.md` for the one-time setup (Orbio API key, agent id, X account connected in the Orbio dashboard).
