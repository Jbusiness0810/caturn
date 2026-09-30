# Caturn runtime

`run.mjs` is one tick of the agent. A GitHub Actions cron runs it every 30 minutes, it reads the market from Orbio's public endpoints, decides whether Caturn can afford a thought, calls a model through Orbio's gateway, sometimes posts to X through Orbio's `social.post` tool, and writes `data/feed.json`. The site renders that file. Vercel redeploys when the workflow commits it.

## How thoughts track the flywheel
- Energy is 0 to 1 from 24h trading volume (Dexscreener), falling back to the fee delta Orbio reports for the agent.
- Thoughts per day = 2 + energy × 46. At zero energy Caturn barely mumbles. Near $50k daily volume it thinks every 30 minutes.
- Every Nth thought (default 3) becomes an X post.
- A hard daily cap in CREDIT stops spending regardless of energy. A 402 from Orbio means the balance is empty: Caturn naps.

## One-time setup
1. Launch the token on orbio.so/launchpad. Note the agent id or token address.
2. In orbio.so/dashboard create a gateway API key. It can spend inference balance only. It cannot touch stake or principal.
3. In orbio.so/dashboard#tools connect Caturn's X account, signed in as the same Orbio account that owns the key.
4. In this GitHub repo: Settings > Secrets and variables > Actions.
   - Secret `ORBIO_API_KEY`
   - Variable `CATURN_AGENT_ID` (agent id or token address)
   - Optional variables: `CATURN_MODEL` (default `openai/gpt-6-luna`), `CATURN_DAILY_CAP` (default 0.5 CREDIT), `CATURN_FULL_VOLUME_USD` (default 50000), `CATURN_POST_EVERY` (default 3)
5. Run the workflow once by hand from the Actions tab to check the log.

## Funding
Fees are harvested and CREDIT claimed from the owner wallet in the Orbio dashboard. The runtime never holds a wallet key. Claim, activate, and the gateway balance refills.

## Local dry run
```
CATURN_DRY_RUN=1 CATURN_AGENT_ID=<id> node agent/run.mjs
```

## Cadence on GitHub Actions
GitHub delays scheduled workflows by hours, so a `*/30` cron does not give 30-minute ticks. The workflow runs hourly and each run can loop several ticks itself: set the repository variable `CATURN_LOOP_TICKS` to `11` for a 5.5 hour loop (ticks every 30 minutes, committing after each). Overlapping runs are prevented by the concurrency group. Leave it unset (one tick per run) unless the repository is public: private repos get 2,000 free Actions minutes a month, and a continuous loop uses far more. Public repositories have unlimited free minutes.
