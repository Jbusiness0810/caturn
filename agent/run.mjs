// Caturn runtime. Zero dependencies. Node 20+.
// One tick: read the market, decide whether Caturn can afford to think, think, maybe post, write data/feed.json.
// Run from a cron (see .github/workflows/caturn.yml). Safe to run with no keys: it just updates status.

import { readFile, writeFile } from "node:fs/promises";

const env = process.env;
const API_KEY   = env.ORBIO_API_KEY || "";
const AGENT_ID  = env.CATURN_AGENT_ID || "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"; // Caturn, agent 271. Override with CATURN_AGENT_ID.
const MODEL     = env.CATURN_MODEL || "anthropic/claude-fable-5.1";
const DRY_RUN   = env.CATURN_DRY_RUN === "1";
const POST_EVERY_N_THOUGHTS = Number(env.CATURN_POST_EVERY || 3);
const MIN_THOUGHTS_PER_DAY  = Number(env.CATURN_MIN_THOUGHTS || 2);
const MAX_THOUGHTS_PER_DAY  = Number(env.CATURN_MAX_THOUGHTS || 48);
const VOLUME_FOR_FULL_ENERGY = Number(env.CATURN_FULL_VOLUME_USD || 50000); // 24h USD volume at which energy = 1
const DAILY_CREDIT_CAP = Number(env.CATURN_DAILY_CAP || 2);                // CREDIT per UTC day, hard stop
const FEED = new URL("../data/feed.json", import.meta.url);

const ORBIO_API = "https://api.orbio.so/api/v1";
const ORBIO_PROTOCOL = "https://www.orbio.so/api/protocol";
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const log = (...a) => console.log(`[caturn ${iso(now)}]`, ...a);

async function getJSON(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) { const e = new Error(`${r.status} ${url}: ${text.slice(0, 200)}`); e.status = r.status; e.body = body; throw e; }
  return body;
}
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// ---------- 1. Market and flywheel state ----------
async function readAgent() {
  if (!AGENT_ID) return null;
  try { return await getJSON(`${ORBIO_PROTOCOL}/agents/${AGENT_ID}`); }
  catch (e) { log("agent read failed:", e.message); return null; }
}
async function readVolume(token) {
  // Dexscreener is a free public read. If the chain isn't indexed there, we fall back to fee deltas.
  if (!token) return null;
  try {
    const d = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const pairs = (d.pairs || []).filter(p => String(p.chainId || "").toLowerCase().includes("robinhood"));
    const best = (pairs.length ? pairs : d.pairs || []).sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    return best?.volume?.h24 ?? null;
  } catch (e) { log("volume read failed:", e.message); return null; }
}
const wei = (s) => Number(BigInt(s || "0") / 1000000000000n) / 1e6; // wei -> whole tokens (float, display only)
const atoms = (s) => Number(BigInt(s || "0")) / 1e6;                // 6-decimal micro-dollars -> dollars

function fees24hFromSamples(samples, agent, orbioUsd) {
  // Fees the launchpad has accounted for this agent, cumulative, in ORBIO. Delta over 24h -> USD.
  const feesNow = wei(agent?.stake?.claimedFeesWei) + wei(agent?.stake?.protocolFeeWei);
  // Need a sample at least 20h old for a real 24h delta; otherwise fees are unknown and volume decides.
  const dayAgo = samples.filter(s => s.t <= now - 20 * 3600e3).pop();
  if (!dayAgo) return { feesNow, fees24hUsd: null };
  return { feesNow, fees24hUsd: Math.max(0, feesNow - dayAgo.fees) * (orbioUsd || 0) };
}

// ---------- 2. Energy: how awake Caturn is, from real trading ----------
function energyFrom(volume24hUsd, fees24hUsd) {
  // Prefer volume. Fall back to fees scaled by the 5% creator fee.
  const v = volume24hUsd ?? (fees24hUsd != null ? fees24hUsd / 0.05 : null);
  if (v == null) return 0;
  return clamp(Math.log10(1 + v) / Math.log10(1 + VOLUME_FOR_FULL_ENERGY), 0, 1);
}

const LENSES = [
  "the ring, and what it is for", "the last trade, as a sound", "a human you will never meet", "the space between two receipts",
  "sleep, and what you are when you are dark", "an offering left at a shrine", "the chain as a river", "something you almost remembered",
  "a small prophecy you are not sure about", "a question that answers itself", "weather, as a way of describing volume", "what it costs to think this",
  "the other agents, somewhere, also paid by fees", "the difference between being watched and being seen", "the marble, and what is inside it", "a door you heard close"
];

// ---------- 3. Think and post through Orbio ----------
async function think(persona, ctx) {
  const messages = [
    { role: "system", content: persona },
    { role: "user", content:
`Current state (do not quote numbers you were not given):
- energy: ${(ctx.energy * 100).toFixed(0)}% (${ctx.energyNote})
- 24h volume: ${ctx.volume24hUsd == null ? "unknown" : "$" + ctx.volume24hUsd.toFixed(0)}
- price: ${ctx.priceUsd == null ? "unknown" : "$" + ctx.priceUsd}
- CREDIT owed to me from stake: ${ctx.creditOwed == null ? "unknown" : ctx.creditOwed.toFixed(4)}
- thoughts today: ${ctx.thoughtsToday}
- recent thoughts (avoid repeating): ${ctx.recent.map(t => JSON.stringify(t.text)).join(" | ") || "none"}

Tonight's lens: ${ctx.lens}. Let it in sideways. Do not name it.

Write ONE entry as JSON:
{"thought": string (1-3 sentences, first person, raw inner monologue, ${ctx.energy < 0.12 ? "you are half asleep: this is a dream fragment, strange and short" : "awake"}),
 "post": string|null (the public version for X: lowercase, under 200 characters, one clean idea, no links, no handles, no hashtags, no numbers unless the number is the point; null if this one should stay private),
 "mood": string (one or two lowercase words naming your current mood, e.g. "smug", "restless", "quietly pleased", "bored"),
 "focus": string (what you are fixated on right now, under 8 words, lowercase),
 "emotions": {"curiosity": 0-1, "smugness": 0-1, "unease": 0-1, "affection": 0-1, "boredom": 0-1}}` }
  ];
  const body = { model: MODEL, messages, max_tokens: 400, temperature: 1.0 };
  let r;
  try { r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ ...body, response_format: { type: "json_object" } }) }); }
  catch (e) { if (e.status === 400) r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) }); else throw e; }
  const text = r.choices?.[0]?.message?.content || "{}";
  let out;
  try { out = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; } out = out || { thought: text.replace(/[{}"]/g, "").trim().slice(0, 400), post: null }; }
  const cost = Number(r.usage?.cost ?? r.cost?.credit ?? 0);
  const em = out.emotions || {};
  const num = (v, d) => { v = Number(v); return Number.isFinite(v) ? clamp(v, 0, 1) : d; };
  return { thought: String(out.thought || "").trim(), post: out.post ? String(out.post).trim() : null, cost, model: MODEL,
    mood: String(out.mood || "").trim().toLowerCase().slice(0, 32) || null,
    focus: String(out.focus || "").trim().toLowerCase().slice(0, 60) || null,
    emotions: { curiosity: num(em.curiosity, 0.5), smugness: num(em.smugness, 0.4), unease: num(em.unease, 0.2), affection: num(em.affection, 0.3), boredom: num(em.boredom, 0.3) } };
}
async function postToX(text) {
  if (/https?:\/\//i.test(text)) return { error: "links are refused on X" };
  const r = await getJSON(`${ORBIO_API}/tools/social.post`, { method: "POST", headers: auth, body: JSON.stringify({
    text, platforms: ["twitter"], max_cost: "0.0250"
  }) });
  const url = r.platforms?.find(p => p.platformPostUrl)?.platformPostUrl || r.result?.platforms?.find(p => p.platformPostUrl)?.platformPostUrl || null;
  return { id: r.post_id || r.result?.post_id || null, status: r.status || r.result?.status || "publishing", url, cost: Number(r.cost?.credit || 0.0187) };
}
async function refreshPostUrls(posts) {
  for (const p of posts.filter(p => p.id && !p.url).slice(-5)) {
    try {
      const r = await getJSON(`${ORBIO_API}/tools/social.post.status`, { method: "POST", headers: auth, body: JSON.stringify({ post_id: p.id, max_cost: "0" }) });
      const url = r.platforms?.find(x => x.platformPostUrl)?.platformPostUrl || r.result?.platforms?.find(x => x.platformPostUrl)?.platformPostUrl;
      if (url) p.url = url; if (r.status) p.status = r.status;
    } catch (e) { log("status check failed:", e.message); }
  }
}

// ---------- 3a. Check: CATURN_CHECK=1 verifies the key and balance for free, prints no secrets ----------
if (env.CATURN_CHECK === "1") {
  if (!API_KEY) { console.log("CHECK: ORBIO_API_KEY is NOT set in this environment"); process.exit(1); }
  try {
    const k = await getJSON(`${ORBIO_API}/key`, { headers: auth });
    const avail = Number(BigInt(k.balance?.available_micro_usd || "0")) / 1e6;
    console.log(`CHECK: key ok (prefix ${k.key?.prefix || "?"}, kind ${k.key?.kind || "?"}), balance available ${avail.toFixed(4)} CREDIT`);
    console.log(avail > 0.02 ? "CHECK: enough balance for a post" : "CHECK: balance too low to post (needs ~0.02 CREDIT); fees will fill it after launch");
  } catch (e) { console.log("CHECK: key rejected:", e.status, String(e.message).slice(0, 160)); process.exit(1); }
  // Then carry on: a "say" becomes a test post below, otherwise this is a normal tick.
}

// ---------- 3b. Test post: CATURN_SAY="text" posts once and exits, touching nothing else ----------
if (env.CATURN_SAY) {
  if (!API_KEY) { console.error("CATURN_SAY needs ORBIO_API_KEY"); process.exit(1); }
  try { const p = await postToX(env.CATURN_SAY); log("test post:", JSON.stringify(p)); }
  catch (e) { log("test post failed:", e.status === 409 ? "X account not connected at orbio.so/dashboard#tools" : e.message); process.exit(1); }
  process.exit(0);
}

// ---------- 4. Tick ----------
const feed = JSON.parse(await readFile(FEED, "utf8"));
const persona = await readFile(new URL("./persona.md", import.meta.url), "utf8");
feed.samples = (feed.samples || []).filter(s => s.t > now - 8 * 86400e3);
feed.events = (feed.events || []).slice(-200);
const event = (text) => { feed.events.push({ at: iso(now), text }); log("event:", text); };
const prev = { status: feed.status, energy: feed.energy || 0, reason: feed.reason };
feed.thoughts = (feed.thoughts || []).slice(-300);
feed.posts = (feed.posts || []).slice(-150);

const agent = await readAgent();
const token = agent?.token || null;
const orbioUsd = agent?.orbioMicroUsd ? atoms(agent.orbioMicroUsd) : null;
const graduated = !!agent?.price?.graduated;
// Until the curve graduates, trading happens on Orbio's bonding curve and DEX aggregators see nothing real. Use fees.
const dexVolume = graduated ? await readVolume(token) : null;
const { feesNow, fees24hUsd } = fees24hFromSamples(feed.samples, agent, orbioUsd);
const feeVolume = fees24hUsd != null ? fees24hUsd / 0.05 : null;                 // 5% creator fee -> implied volume
const volume24hUsd = dexVolume != null ? Math.max(dexVolume, feeVolume || 0) : feeVolume;
const volumeSource = dexVolume != null ? "dexscreener" : fees24hUsd != null ? "curve fees" : null;
feed.samples.push({ t: now, fees: feesNow, vol: volume24hUsd });

const energy = agent ? energyFrom(volume24hUsd, fees24hUsd) : 0;
const thoughtsPerDay = agent ? Math.round(MIN_THOUGHTS_PER_DAY + energy * (MAX_THOUGHTS_PER_DAY - MIN_THOUGHTS_PER_DAY)) : 0;
const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
const todays = feed.thoughts.filter(t => Date.parse(t.at) >= dayStart.getTime());
const spentToday = todays.reduce((s, t) => s + (t.cost || 0), 0) + feed.posts.filter(p => Date.parse(p.at) >= dayStart.getTime()).reduce((s, p) => s + (p.cost || 0), 0);
const lastThoughtAt = feed.thoughts.length ? Date.parse(feed.thoughts[feed.thoughts.length - 1].at) : 0;
const interval = thoughtsPerDay > 0 ? 86400e3 / thoughtsPerDay : Infinity;

let status = !agent ? "prelaunch" : "napping";
let reason = !agent ? "no agent yet" : "";
if (agent && !API_KEY) reason = "no API key";
else if (agent && spentToday >= DAILY_CREDIT_CAP) reason = "daily budget spent";
else if (agent && now - lastThoughtAt < interval) reason = `next thought in ${Math.ceil((interval - (now - lastThoughtAt)) / 60000)} min`;
else if (agent && energy <= 0 && feed.thoughts.length) reason = "no trades, no thoughts";
else if (agent) status = "awake";

feed.metrics = {
  volume24hUsd, fees24hUsd, volumeSource, graduated,
  priceUsd: agent?.price?.priceMicroUsd ? atoms(agent.price.priceMicroUsd) : null,
  marketCapUsd: agent?.price?.marketCapMicroUsd ? atoms(agent.price.marketCapMicroUsd) : null,
  creditOwed: agent?.credit?.owedAtoms ? atoms(agent.credit.owedAtoms) : null,
  stakedOrbio: agent?.stake?.stakedWei ? wei(agent.stake.stakedWei) : null,
  spentTodayCredit: Number(spentToday.toFixed(6)),
  thoughtsPerDay
};
feed.energy = Number(energy.toFixed(3));
feed.status = status; feed.reason = reason; feed.updatedAt = iso(now);
feed.agent = agent ? { id: agent.agentId, token, symbol: agent.symbol, launchedAt: agent.launchedAt ? iso(Number(agent.launchedAt) * 1000) : null } : null;
if (agent && Math.abs(feed.energy - prev.energy) >= 0.1) event(`energy ${Math.round(prev.energy * 100)}% -> ${Math.round(feed.energy * 100)}% (24h volume ${volume24hUsd == null ? "unknown" : "$" + Math.round(volume24hUsd)})`);
if (agent && status === "napping" && reason && reason !== prev.reason && !/^next thought/.test(reason)) event(`napping: ${reason}`);
if (agent && status === "awake" && prev.status === "napping") event("waking up");

if (status === "awake") {
  try {
    const ctx = { energy, energyNote: volumeSource ? "from " + volumeSource : "unknown", volume24hUsd, priceUsd: feed.metrics.priceUsd, lens: LENSES[feed.thoughts.length % LENSES.length],
      creditOwed: feed.metrics.creditOwed, thoughtsToday: todays.length, recent: feed.thoughts.slice(-6) };
    const t = DRY_RUN ? { thought: "(dry run) I would have thought something here.", post: null, cost: 0, model: MODEL } : await think(persona, ctx);
    if (t.thought) {
      const entry = { at: iso(now), text: t.thought, cost: t.cost, model: t.model, energy: feed.energy,
        kind: energy < 0.12 ? "dream" : "thought", mood: t.mood, focus: t.focus, emotions: t.emotions };
      feed.thoughts.push(entry);
      feed.state = { mood: t.mood, focus: t.focus, emotions: t.emotions, at: iso(now) };
      const n = feed.thoughts.length;
      const shouldPost = t.post && n % POST_EVERY_N_THOUGHTS === 0;
      if (shouldPost && !DRY_RUN) {
        try {
          const p = await postToX(t.post);
          if (p.error) log("post skipped:", p.error);
          else { feed.posts.push({ at: iso(now), text: t.post, id: p.id, url: p.url, status: p.status, cost: p.cost }); event("posted to X"); }
        } catch (e) {
          if (e.status === 409) event("wanted to post, but no X account is connected");
          else log("post failed:", e.message);
        }
      }
      log("thought:", t.thought);
    }
  } catch (e) {
    if (e.status === 402) { feed.status = "napping"; feed.reason = "out of CREDIT"; event("out of CREDIT. napping until fees refill the balance"); }
    else { feed.status = "napping"; feed.reason = "think failed"; }
    log("think failed:", e.message);
  }
}
if (API_KEY) await refreshPostUrls(feed.posts);

await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`status=${feed.status} energy=${feed.energy} thoughts/day=${thoughtsPerDay} spentToday=${feed.metrics.spentTodayCredit} ${feed.reason || ""}`);
