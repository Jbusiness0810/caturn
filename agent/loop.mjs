// The always-on runner: what .github/workflows/caturn.yml did in a 5.5-hour loop, done forever on one small machine.
// Each tick pulls master (so a push takes effect at the next tick, no redeploy), runs one think tick, publishes the feed,
// then two errand passes half a tick apart. Once a day it renews the machine's own funding on orbio.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ensureBucket, putObject, getObject, storageOn } from "./storage.mjs";
import { renewIfNeeded } from "./orbio-infra.mjs";

const env = process.env, ROOT = new URL("..", import.meta.url).pathname;
const TICK_MIN = Number(env.CATURN_TICK_MIN || 10), FEED = `${ROOT}data/feed.json`;
const log = (...a) => console.log(`[loop ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

function sh(cmd, args, extra = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...env, ...extra } });
    p.on("exit", (code) => resolve(code)); p.on("error", (e) => { log(`${cmd} failed to start:`, e.message); resolve(-1); });
  });
}
async function feedValid() { try { JSON.parse(await readFile(FEED, "utf8")); return true; } catch { return false; } }
// at boot the newest copy of the feed wins: storage (this runner's own writes), the GitHub release (what the Actions
// loop wrote), or the git snapshot. Starting from an old copy would replay the say queue and forget covered tokens.
const RELEASE = `https://github.com/${env.CATURN_REPO || "Jbusiness0810/caturn"}/releases/download/sketches/feed.json`;
async function pullFeed() {
  const cands = [];
  const consider = async (name, buf) => { try { const f = JSON.parse(buf.toString("utf8")); cands.push({ name, buf, at: Date.parse(f.updatedAt || 0) || 0 }); } catch { log(`feed from ${name} is not valid json`); } };
  try { await consider("git", await readFile(FEED)); } catch {}
  if (storageOn()) { try { const buf = await getObject("feed.json"); if (buf) await consider("storage", buf); } catch (e) { log("storage feed read failed:", String(e.message).slice(0, 120)); } }
  try { const r = await fetch(`${RELEASE}?t=${Date.now()}`, { redirect: "follow", signal: AbortSignal.timeout(60000) }); if (r.ok) await consider("release", Buffer.from(await r.arrayBuffer())); } catch (e) { log("release feed read failed:", String(e.message).slice(0, 120)); }
  cands.sort((a, b) => b.at - a.at);
  const best = cands[0]; if (!best) { log("no feed found anywhere; starting empty"); return; }
  await mkdir(`${ROOT}data`, { recursive: true }); await writeFile(FEED, best.buf);
  log(`feed: using the ${best.name} copy (${new Date(best.at).toISOString()}); others:`, cands.slice(1).map(c => `${c.name} ${new Date(c.at).toISOString().slice(0, 16)}`).join(", ") || "none");
}
async function pushFeed() {
  if (!storageOn() || !(await feedValid())) return;
  try { await putObject("feed.json", await readFile(FEED), "application/json; charset=utf-8", 10); } catch (e) { log("feed push failed:", String(e.message).slice(0, 160)); }
}
async function update() {
  await sh("git", ["pull", "-q", "--ff-only", "origin", "master"]);
  // deps the workflow used to install per run; a no-op when they are already there
  await sh("npm", ["i", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "playwright@1.49.1", "gifenc@1.0.3", "errand-mcp@0.5.0"]);
}
async function renew() {
  if (!env.CATURN_FLY_RESOURCE_ID) return;
  try { await renewIfNeeded(env.CATURN_FLY_RESOURCE_ID, { hours: Number(env.CATURN_FLY_RENEW_HOURS || 12), maxCost: env.CATURN_FLY_DAILY_CAP || "2.0", log }); }
  catch (e) { log("renew failed:", String(e.message).slice(0, 200)); }
}

log("runner starting; tick every", TICK_MIN, "min");
try { await ensureBucket(); } catch (e) { log("bucket:", String(e.message).slice(0, 160)); }
await update();
await pullFeed();
let first = true;
for (;;) {
  const t0 = Date.now();
  try {
    if (!first) await update();
    // the git copy of the feed may be older than the live one; never let a pull roll the feed back
    await sh("node", ["agent/run.mjs"], { CATURN_FORCE: first ? (env.FORCE_FIRST || "1") : "", CATURN_RUNNER: "1" });
    await pushFeed();
    await sh("node", ["agent/errand.mjs"], { CATURN_RUNNER: "1" });
    await pushFeed();
    await renew();
  } catch (e) { log("tick failed:", String(e.message).slice(0, 200)); }
  first = false;
  const half = t0 + TICK_MIN * 60e3 / 2, next = t0 + TICK_MIN * 60e3;
  await sleep(half - Date.now());
  try { await sh("node", ["agent/errand.mjs"], { CATURN_RUNNER: "1" }); await pushFeed(); } catch (e) { log("errand pass failed:", String(e.message).slice(0, 200)); }
  await sleep(next - Date.now());
}
