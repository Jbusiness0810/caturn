# Caturn runtime

`run.mjs` is one tick of the agent. A GitHub Actions cron runs it every 30 minutes, it reads the market from Orbio's public endpoints, decides whether Caturn can afford a thought, calls a model through Orbio's gateway, sometimes posts to X through Orbio's `social.post` tool, and writes `data/feed.json`. The site renders that file. Vercel redeploys when the workflow commits it.

## How thoughts track the flywheel
- Energy is 0 to 1 from 24h trading volume (Dexscreener), falling back to the fee delta Orbio reports for the agent.
- Thoughts per day = 6 + energy × 90. At zero energy Caturn mumbles a few times a day. Near $50k daily volume it thinks every 15 minutes.
- Caturn posts to X on a clock: every `CATURN_POST_INTERVAL_MIN` minutes (default 30) a tick thinks and posts regardless of pacing; thoughts in between follow volume.
- A hard daily cap in CREDIT stops spending regardless of energy. A 402 from Orbio means the balance is empty: Caturn naps.

## One-time setup
1. Launch the token on orbio.so/launchpad. Note the agent id or token address.
2. In orbio.so/dashboard create a gateway API key. It can spend inference balance only. It cannot touch stake or principal.
3. In orbio.so/dashboard#tools connect Caturn's X account, signed in as the same Orbio account that owns the key.
4. In this GitHub repo: Settings > Secrets and variables > Actions.
   - Secret `ORBIO_API_KEY`
   - Variable `CATURN_AGENT_ID` (agent id or token address)
   - Optional variables: `CATURN_MODEL` (comma-separated ranked list; default tries `anthropic/claude-fable-5.1`, then `anthropic/claude-opus-5.5`, then `anthropic/claude-sonnet-5.5`, then OpenAI and xAI flagships, because the gateway lists models it is not always serving), `CATURN_DAILY_CAP` (default 2 CREDIT), `CATURN_FULL_VOLUME_USD` (default 50000), `CATURN_POST_INTERVAL_MIN` (default 30)
5. Run the workflow once by hand from the Actions tab to check the log.

## Funding
Fees are harvested and CREDIT claimed from the owner wallet in the Orbio dashboard. The runtime never holds a wallet key. Claim, activate, and the gateway balance refills.

## Local dry run
```
CATURN_DRY_RUN=1 CATURN_AGENT_ID=<id> node agent/run.mjs
```

## Cadence on GitHub Actions
GitHub delays scheduled workflows by hours, so a `*/30` cron does not give 30-minute ticks. The workflow runs hourly and each run can loop several ticks itself: ticks are 15 minutes apart and a run loops `CATURN_LOOP_TICKS` times (default 22, about 5.5 hours). Overlapping runs are prevented by the concurrency group. Leave it unset (one tick per run) unless the repository is public: private repos get 2,000 free Actions minutes a month, and a continuous loop uses far more. Public repositories have unlimited free minutes.

## If GitHub's schedule does not fire
GitHub's cron can skip hours. `api/kick.js` lets an outside scheduler start the loop: set `GITHUB_DISPATCH_TOKEN` (a fine-grained token for this repo with Actions: read and write) and `KICK_SECRET` (any long random string) in Vercel, then point a free pinger such as cron-job.org at `https://www.caturn.lol/api/kick?key=<KICK_SECRET>` every hour. A kick is skipped while a loop is already running, so they never pile up.

## Self-perpetuating loop
At the end of every loop the workflow pushes a timestamp to `.kick` using the `KICK_TOKEN` secret (a fine-grained personal access token for this repository with Contents: read and write). That push starts the next loop, so the agent never waits on GitHub's unreliable cron. Without the secret the step is skipped and an outside kicker has to start loops.

## Sketches
Every `CATURN_SKETCH_EVERY` thoughts (default 4) Caturn draws a p5.js sketch (`agent/sketch/index.html`, four families: orbit, field, loaf, rings) driven by its energy and emotions. `agent/sketch.mjs` renders it in headless Chrome and encodes a GIF with gifenc; the workflow uploads it to the rolling `sketches` GitHub release so the repo stays small. The feed records each sketch; the console shows them inline and in a gallery. Posts may mention a new sketch. Orbio's posting tool is text-only, so sketches cannot be attached to X posts.
