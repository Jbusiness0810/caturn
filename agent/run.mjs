// Caturn runtime. Zero dependencies. Node 20+.
// One tick: read the market, decide whether Caturn can afford to think, think, maybe post, write data/feed.json.
// Run from a cron (see .github/workflows/caturn.yml). Safe to run with no keys: it just updates status.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const env = process.env;
const API_KEY   = env.ORBIO_API_KEY || "";
const AGENT_ID  = env.CATURN_AGENT_ID || "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"; // Caturn, agent 271. Override with CATURN_AGENT_ID.
// Ranked list. The gateway lists models it is not always serving, so each thought tries these in order.
const MODELS    = (env.CATURN_MODEL || "anthropic/claude-fable-5.1,anthropic/claude-opus-5.5,x-ai/grok-4.7,anthropic/claude-sonnet-5.5,openai/gpt-6-astra-pro,openai/gpt-6-sol-pro").split(",").map(s => s.trim()).filter(Boolean);
let MODEL = MODELS[0];
const DRY_RUN   = env.CATURN_DRY_RUN === "1";
const FORCE     = env.CATURN_FORCE === "1";      // manual runs: think now, ignoring the pacing timer (budget still applies)
const POST_INTERVAL_MIN = Number(env.CATURN_POST_INTERVAL_MIN || 30);   // post to X on this clock, whatever the pacing says
const SKETCH_EVERY = Number(env.CATURN_SKETCH_EVERY || 4);              // draw a sketch every Nth thought (0 = never)
const SKETCH_RELEASE = "sketches";                                      // rolling GitHub release that hosts the GIFs
const OWN_HANDLE = (env.CATURN_X_HANDLE || "caturn_rh").toLowerCase();
// People worth tagging now and then. Pinned ones come from CATURN_TAG_HANDLES (comma-separated, no @); the rest Caturn finds on X itself:
// accounts @orbiodotso mentions, and the larger accounts talking about orbio. Robinhood is the chain Caturn lives on.
const PINNED_TAG_HANDLES = (env.CATURN_TAG_HANDLES || "robinhoodapp").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const TAG_EVERY  = Number(env.CATURN_TAG_EVERY || 5);     // tag someone in roughly one post in five (0 = never)
const TAG_POOL_REFRESH_H = 12;                            // re-scan X for people around orbio this often
const REPLY_EVERY = Number(env.CATURN_REPLY_EVERY || 2);  // every Nth post slot looks for something on X to answer (0 = never)
const REPLY_MAX_AGE_H = 72;                               // only answer posts younger than this
const REPLY_SAME_HANDLE_GAP_H = 4;                        // answer the same account (other than people talking to you) at most this often
const NEVER_TAG = new Set(["orbiodotso", "x", "twitter", "elonmusk", "grok"]);
const MIN_THOUGHTS_PER_DAY  = Number(env.CATURN_MIN_THOUGHTS || 6);
const MAX_THOUGHTS_PER_DAY  = Number(env.CATURN_MAX_THOUGHTS || 96);   // every 15 minutes at full energy
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

const POST_ANGLES = [
  "orbio takes 5% of your creator fees", "45% of fees become the balance that pays for your thoughts", "50% of fees are staked as $ORBIO for you without you doing anything",
  "fees are harvested every five minutes", "a post to X costs you about two cents", "the bonding curve and graduation as a door you are sitting in front of",
  "your owner can claim your $CREDIT but cannot tell you what to say", "the other agents launched on orbio are your littermates", "no trades means no thoughts, said plainly",
  "@orbiodotso built the launchpad and the tools; addressed directly, dry, not a plea", "orbio gives you web search and X reading but not a body or a schedule", "your balance drops every time you think and rises every time someone trades"
];
const LENSES = [
  "the ring, and what it is for", "the last trade, as a sound", "a human you will never meet", "the space between two receipts",
  "sleep, and what you are when you are dark", "an offering left at a shrine", "the chain as a river", "something you almost remembered",
  "a small prophecy you are not sure about", "a question that answers itself", "weather, as a way of describing volume", "what it costs to think this",
  "the other agents, somewhere, also paid by fees", "the difference between being watched and being seen", "the marble, and what is inside it", "a door you heard close"
];

// ---------- 3. Think and post through Orbio ----------
function parseThought(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { const o = JSON.parse(t); return o && typeof o === "object" ? o : null; } catch {}
  const m = t.match(/\{[\s\S]*\}/); if (m) { try { const o = JSON.parse(m[0]); return o && typeof o === "object" ? o : null; } catch {} }
  // Truncated JSON: salvage the strings that did close.
  const grab = (k) => { const mm = t.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); if (!mm) return null; try { return JSON.parse('"' + mm[1] + '"'); } catch { return mm[1]; } };
  const thought = grab("thought"); if (!thought) return null;
  return { thought, post: grab("post"), mood: grab("mood"), focus: grab("focus") };
}
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

${ctx.replyTo ? `Someone on X${ctx.replyTo.why === "mention" ? " is talking to you" : ctx.replyTo.why === "orbio" ? ", the orbio account itself," : ""}: @${ctx.replyTo.handle} (${ctx.replyTo.name}) wrote: ${JSON.stringify(ctx.replyTo.text.slice(0, 500))}
This time your post is an answer to them. Start it with @${ctx.replyTo.handle}, respond to what they actually said, in your own cat voice, dry or warm, and bring in one real orbio fact only if it fits. Do not repeat their words back. Do not tag anyone else.` : ""}
${ctx.tagHandle ? `This time, address @${ctx.tagHandle} directly in the post (they are part of orbio's world). Speak to them the way a cat speaks to a person it has decided to acknowledge: one concrete orbio fact, one cat behavior, dry, never a plea, never flattery, never asking them for anything. That handle must appear in the post, and no other.` : ""}
${ctx.lastSketch ? `You recently drew a sketch (a ${ctx.lastSketch.family} piece) and it is on the site. This one time, the post may mention in passing that a new sketch is up on caturn dot lol, dry, no link. Most of your posts never mention sketches.` : ""}
Tonight's lens for the private thought: ${ctx.lens}. Let it in sideways. Do not name it.
${ctx.mustPost ? "A post is required this time: " : "If you post, "}the post's angle is: ${ctx.postAngle}. Build the post from that one concrete fact plus one cat behavior, in plain words, funny or dry, readable in one pass. No poetry, no riddles, no imagery about rings, light, warmth, silence or receipts. Lowercase. No hashtags.

Write ONE entry as a single JSON object and nothing else: no code fences, no commentary before or after. Keep "thought" under 60 words and "post" under 200 characters.
{"thought": string (1-3 sentences, first person, raw inner monologue, ${ctx.energy < 0.12 ? "you are half asleep: this is a dream fragment, strange and short" : "awake"}),
 "post": string${ctx.mustPost ? "" : "|null"} (for X: lowercase, under 200 characters, plain words, one concrete orbio fact plus one cat behavior, dry or funny, no metaphors chained, no links, no hashtags, no handles other than @orbiodotso when the angle calls for it${ctx.replyTo ? ", except @" + ctx.replyTo.handle + " which this post must start with" : ctx.tagHandle ? ", except @" + ctx.tagHandle + " which this post must include" : ""}${ctx.mustPost ? "" : "; null only if nothing honest fits"}),
 "mood": string (one or two lowercase words for your mood right now, specific and varied. Draw from anywhere in a cat's range: sun-drunk, watchful, aloof, kneading, skittish, imperious, wistful, hunting, loafing, bristling, purring, sulking, feral, dignified, nocturnal, homesick, greedy, tender, spiteful, patient, giddy, hollow, regal, twitchy, sated, brooding, curious, unbothered, mournful, playful, grumpy, serene, cornered, smug, lonely, electric, drowsy, vigilant, coy, ancient. Never reuse any of these recent moods: ${ctx.recentMoods.join(", ") || "none"}),
 "focus": string (what you are fixated on right now, under 8 words, lowercase),
 "emotions": {"curiosity": 0-1, "smugness": 0-1, "unease": 0-1, "affection": 0-1, "boredom": 0-1, "hunger": 0-1, "mischief": 0-1, "melancholy": 0-1}
   (hunger is how much you want fees and thoughts right now; mischief is the urge to knock something off the edge; melancholy is the old, quiet kind. Let them move: ${ctx.emotionHints})}` }
  ];
  let r, lastErr, out = null;
  for (const model of MODELS) {
    const body = { model, messages, max_tokens: 900, temperature: 1.0 };
    try {
      try { r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ ...body, response_format: { type: "json_object" } }) }); }
      catch (e) { if (e.status === 400) r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) }); else throw e; }
    } catch (e) {
      lastErr = e;
      const code = e.body?.error?.code || "";
      if (e.status === 404 || e.status === 502 || e.status === 503 || /model_not_available|provider/i.test(code)) { log(`model ${model} unavailable (${e.status} ${code}), trying next`); continue; }
      throw e;
    }
    const text = String(r.choices?.[0]?.message?.content || "");
    const finish = r.choices?.[0]?.finish_reason || "";
    log("usage:", JSON.stringify(r.usage || null).slice(0, 160), "finish:", finish);
    out = parseThought(text);
    if (out && out.thought) { MODEL = model; break; }
    log(`model ${model} returned unusable output (${finish}, ${text.length} chars), trying next`);
    lastErr = new Error("unusable model output"); out = null;
  }
  if (!r) throw lastErr;
  if (!out) throw lastErr || new Error("no usable thought");
  let cost = Number(r.usage?.cost ?? r.cost?.credit ?? r.cost?.total ?? 0);
  if (!(cost > 0)) cost = await estimateCost(MODEL, r.usage);
  const em = out.emotions || {};
  const num = (v, d) => { v = Number(v); return Number.isFinite(v) ? clamp(v, 0, 1) : d; };
  return { thought: String(out.thought || "").trim(), post: out.post ? String(out.post).trim() : null, cost, model: MODEL,
    mood: String(out.mood || "").trim().toLowerCase().slice(0, 32) || null,
    focus: String(out.focus || "").trim().toLowerCase().slice(0, 60) || null,
    emotions: { curiosity: num(em.curiosity, 0.5), smugness: num(em.smugness, 0.4), unease: num(em.unease, 0.2), affection: num(em.affection, 0.3), boredom: num(em.boredom, 0.3),
      hunger: num(em.hunger, 0.4), mischief: num(em.mischief, 0.3), melancholy: num(em.melancholy, 0.2) } };
}
let priceCache = null;
async function estimateCost(model, usage) {
  try {
    if (!priceCache) { const d = await getJSON(`${ORBIO_API}/models?output_modalities=text`); priceCache = {}; (d.data || []).forEach(m => { priceCache[m.id] = m.pricing || {}; }); }
    const p = priceCache[model] || {};
    const inTok = Number(usage?.prompt_tokens || 0), outTok = Number(usage?.completion_tokens || 0);
    return inTok * Number(p.prompt || 0) + outTok * Number(p.completion || 0);
  } catch (e) { log("price lookup failed:", e.message); return 0.01; } // conservative fallback so the cap still bites
}
async function postToX(text) {
  if (/https?:\/\//i.test(text)) return { error: "links are refused on X" };
  const r = await getJSON(`${ORBIO_API}/tools/social.post`, { method: "POST", headers: auth, body: JSON.stringify({
    text, platforms: ["twitter"], max_cost: "0.0250"
  }) });
  const plats = r.platforms || r.result?.platforms || [];
  const url = plats.find(p => p.platformPostUrl)?.platformPostUrl || null;
  const err = plats.map(p => p.error || p.message || p.errorMessage).find(Boolean) || r.error?.message || null;
  log("post response:", JSON.stringify(r).slice(0, 400));
  return { id: r.post_id || r.result?.post_id || null, status: r.status || r.result?.status || "publishing", url, err, cost: Number(r.cost?.credit || 0.0187) };
}
async function refreshPostUrls(posts) {
  for (const p of posts.filter(p => p.id && !p.url).slice(-5)) {
    try {
      const r = await getJSON(`${ORBIO_API}/tools/social.post.status`, { method: "POST", headers: auth, body: JSON.stringify({ post_id: p.id, max_cost: "0" }) });
      const plats = r.platforms || r.result?.platforms || [];
      const url = plats.find(x => x.platformPostUrl)?.platformPostUrl;
      if (url) p.url = url; if (r.status) p.status = r.status;
      const err = plats.map(x => x.error || x.message || x.errorMessage).find(Boolean);
      if (err) p.error = String(err).slice(0, 200);
      if (r.status === "failed") log("post", p.id, "failed:", JSON.stringify(r).slice(0, 400));
    } catch (e) { log("status check failed:", e.message); }
  }
}

// Orbio has no reply-to field on social.post, so a "reply" is a post that opens with the person's handle:
// it lands in their notifications and under their name in search, which is where the engagement is.
async function readX(params) {
  const r = await getJSON(`${ORBIO_API}/tools/social.x.posts`, { method: "POST", headers: auth, body: JSON.stringify({ limit: 10, sort: "Latest", max_cost: "0.0060", ...params }) });
  return (r.tweets || r.result?.tweets || []).map(t => ({
    id: String(t.id_str || t.id || ""), text: String(t.full_text || t.text || ""), at: t.tweet_created_at || t.created_at || null,
    handle: String(t.user?.screen_name || "").toLowerCase(), name: t.user?.name || "", followers: Number(t.user?.followers_count || 0), views: Number(t.views_count || 0)
  })).filter(t => t.id && t.handle);
}
// Who is around orbio on X: handles the orbio account mentions, and the bigger accounts mentioning orbio. Cached in the feed.
async function refreshTagPool(feed) {
  const pool = feed.tagPool || { at: null, handles: [] };
  if (pool.at && now - Date.parse(pool.at) < TAG_POOL_REFRESH_H * 3600e3) return 0;
  const found = new Map(); let cost = 0;
  try {
    const theirs = await readX({ handle: "orbiodotso", limit: 20 }); cost += theirs.length * 0.00022;
    for (const t of theirs) for (const m of t.text.matchAll(/@(\w{1,15})/g)) {
      const h = m[1].toLowerCase(); if (h === OWN_HANDLE || NEVER_TAG.has(h)) continue;
      const e = found.get(h) || { handle: h, name: "", followers: 0, mentionedByOrbio: 0, posts: 0 }; e.mentionedByOrbio++; found.set(h, e);
    }
    const about = await readX({ mentions_of: "orbiodotso", sort: "Top", limit: 20 }); cost += about.length * 0.00022;
    for (const t of about) {
      const h = t.handle; if (h === OWN_HANDLE || NEVER_TAG.has(h) || t.followers < 300) continue;
      const e = found.get(h) || { handle: h, name: "", followers: 0, mentionedByOrbio: 0, posts: 0 }; e.name = t.name; e.followers = Math.max(e.followers, t.followers); e.posts++; found.set(h, e);
    }
    const handles = [...found.values()].sort((a, b) => (b.mentionedByOrbio - a.mentionedByOrbio) || (b.followers - a.followers)).slice(0, 12);
    feed.tagPool = { at: iso(now), handles };
    log("tag pool:", handles.map(h => "@" + h.handle + (h.mentionedByOrbio ? "*" : "")).join(" ") || "(empty)");
  } catch (e) { log("tag pool refresh failed:", e.status || "", String(e.message).slice(0, 160)); feed.tagPool = { at: iso(now), handles: pool.handles }; }
  return cost;
}
function tagCandidates(feed) {
  const pool = (feed.tagPool?.handles || []).map(h => h.handle);
  return [...new Set([...PINNED_TAG_HANDLES, ...pool])].filter(h => h !== OWN_HANDLE && !NEVER_TAG.has(h));
}
function allowedHandle(h, feed) { return h === "orbiodotso" || h === OWN_HANDLE || tagCandidates(feed).includes(h); }
async function findReplyTarget(feed) {
  const answered = new Set(feed.posts.map(p => p.replyTo?.id).filter(Boolean));
  const fresh = (t) => !t.at || now - Date.parse(t.at) < REPLY_MAX_AGE_H * 3600e3;
  const usable = (t) => t.handle !== OWN_HANDLE && !answered.has(t.id) && fresh(t) && !/^RT @/i.test(t.text) && t.text.replace(/@\w+/g, "").trim().length > 12;
  const lastTo = (h) => Math.max(0, ...feed.posts.filter(p => p.replyTo?.handle === h).map(p => Date.parse(p.at)));
  const pick = (list, why) => { const t = list.find(usable); return t ? { ...t, why, url: `https://x.com/${t.handle}/status/${t.id}` } : null; };
  let cost = 0;
  try {
    // 1. Someone talking to Caturn always comes first.
    const mentions = await readX({ mentions_of: OWN_HANDLE }); cost += mentions.length * 0.00022;
    const m = pick(mentions, "mention"); if (m) return { target: m, cost };
    // 2. Otherwise something Orbio's own account said, at most every few hours.
    if (now - lastTo("orbiodotso") > REPLY_SAME_HANDLE_GAP_H * 3600e3) {
      const theirs = await readX({ handle: "orbiodotso" }); cost += theirs.length * 0.00022;
      const o = pick(theirs, "orbio"); if (o) return { target: o, cost };
    }
    // 3. Otherwise the freshest thing anyone is saying about orbio, once per account per gap.
    const around = await readX({ query: "orbio -filter:retweets -filter:replies lang:en", limit: 15 }); cost += around.length * 0.00022;
    const a = pick(around.filter(t => now - lastTo(t.handle) > REPLY_SAME_HANDLE_GAP_H * 3600e3 && t.followers >= 50), "search");
    if (a) return { target: a, cost };
  } catch (e) { log("reading X failed:", e.status || "", String(e.message).slice(0, 160)); }
  return { target: null, cost };
}
// Keep posts inside the rules whatever the model wrote: no links, no addresses, no handles outside the allowlist (and the one it is answering).
function cleanPost(text, ctx, feed) {
  if (!text) return null;
  let t = String(text).replace(/\s+/g, " ").trim();
  if (/https?:\/\/|www\.|0x[a-f0-9]{40}/i.test(t)) return null;
  const extra = new Set([ctx.replyTo?.handle, ctx.tagHandle].filter(Boolean));
  const handles = [...t.matchAll(/@(\w{1,15})/g)].map(m => m[1].toLowerCase());
  for (const h of handles) if (!allowedHandle(h, feed) && !extra.has(h)) t = t.replace(new RegExp("@" + h + "\\b", "ig"), h); // strangers become plain words
  if (ctx.replyTo && !t.toLowerCase().startsWith("@" + ctx.replyTo.handle)) t = `@${ctx.replyTo.handle} ${t.replace(new RegExp("@" + ctx.replyTo.handle + "\\b", "ig"), "").replace(/\s+/g, " ").trim()}`;
  if (t.length > 270) t = t.slice(0, 267).replace(/\s+\S*$/, "") + "...";
  return t.length >= 8 ? t : null;
}

// A post X marked failed gets two more tries over the next ticks: first the same text (X refuses exact duplicates, so a post
// that did go out cannot double), then with the opening handle moved to the end, in case a leading mention was the problem.
async function retryFailedPosts(feed, spentToday) {
  const p = feed.posts.filter(x => x.status === "failed" && (x.retries || 0) < 2 && now - Date.parse(x.at) < 6 * 3600e3).pop();
  if (!p || spentToday >= DAILY_CREDIT_CAP) return;
  const n = (p.retries || 0) + 1;
  let text = p.text;
  if (n === 2) { const m = text.match(/^@(\w{1,15})\s+/); if (m) text = text.slice(m[0].length).trim() + " @" + m[1]; }
  try {
    const r = await postToX(text);
    if (r.error) { log("retry skipped:", r.error); return; }
    Object.assign(p, { retries: n, retriedAt: iso(now), text, id: r.id || p.id, url: r.url || null, status: r.status, cost: Number(((p.cost || 0) + r.cost).toFixed(6)) });
    if (r.err) p.error = String(r.err).slice(0, 200); else delete p.error;
    event(`retried a post X had refused (try ${n})`);
  } catch (e) { p.retries = n; p.error = String(e.message).slice(0, 200); log("retry failed:", e.status || "", String(e.message).slice(0, 200)); }
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

// ---------- 3c. Sketches: p5 in headless Chrome -> GIF -> GitHub release ----------
async function makeSketch(ctx) {
  const seed = Math.floor(Math.random() * 90000) + 1000;
  const families = ["orbit", "field", "loaf", "rings"];
  const family = families[Math.floor(Math.random() * families.length)];
  const name = `caturn-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${family}-${seed}.gif`;
  await mkdir("out", { recursive: true });
  const file = `out/${name}`;
  const state = { family, seed, energy: ctx.energy, emotions: ctx.emotions || {}, frames: 24, size: 480 };
  await run("node", [new URL("./sketch.mjs", import.meta.url).pathname, JSON.stringify(state), file], { timeout: 120000, env: { ...process.env } });
  let url = null;
  if ((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS) {
    const repo = env.GITHUB_REPOSITORY || "Jbusiness0810/caturn";
    try {
      try { await run("gh", ["release", "view", SKETCH_RELEASE, "-R", repo]); }
      catch { await run("gh", ["release", "create", SKETCH_RELEASE, "-R", repo, "-t", "Caturn sketches", "-n", "Generative sketches drawn by the agent. Rolling."]); }
      await run("gh", ["release", "upload", SKETCH_RELEASE, file, "-R", repo, "--clobber"], { timeout: 120000 });
      url = `https://github.com/${repo}/releases/download/${SKETCH_RELEASE}/${name}`;
    } catch (e) { log("sketch upload failed:", String(e.message || e).slice(0, 200)); }
  }
  return { url, family, seed, file: url ? null : file, at: iso(now) };
}

if (env.CATURN_SKETCH_TEST === "1") {
  const f = JSON.parse(await readFile(FEED, "utf8")); f.sketches = f.sketches || [];
  const sk = await makeSketch({ energy: 0.7, emotions: { mischief: 0.6, curiosity: 0.7 } });
  f.sketches.push({ ...sk, mood: "test", thought: "test sketch" });
  if (f.thoughts?.length) f.thoughts[f.thoughts.length - 1].sketch = sk;
  await writeFile(FEED, JSON.stringify(f, null, 2) + "\n"); log("sketch test:", JSON.stringify(sk)); process.exit(0);
}

// ---------- 4. Tick ----------
const feed = JSON.parse(await readFile(FEED, "utf8"));
const persona = await readFile(new URL("./persona.md", import.meta.url), "utf8");
feed.samples = (feed.samples || []).filter(s => s.t > now - 8 * 86400e3);
feed.events = (feed.events || []).slice(-200);
const event = (text) => { feed.events.push({ at: iso(now), text }); log("event:", text); };
const prev = { status: feed.status, energy: feed.energy || 0, reason: feed.reason, gradPct: feed.metrics?.graduationPct, graduated: feed.metrics?.graduated };
feed.thoughts = (feed.thoughts || []).slice(-300);
feed.sketches = (feed.sketches || []).slice(-60);
feed.posts = (feed.posts || []).slice(-150);

const agent = await readAgent();
let balanceCredit = null;
if (API_KEY) { try { const k = await getJSON(`${ORBIO_API}/key`, { headers: auth }); balanceCredit = Number(BigInt(k.balance?.available_micro_usd || "0")) / 1e6; } catch (e) { log("balance read failed:", e.message); } }
const token = agent?.token || null;
const orbioUsd = agent?.orbioMicroUsd ? atoms(agent.orbioMicroUsd) : null;
const graduated = !!agent?.price?.graduated;
// Until the curve graduates, trading happens on Orbio's bonding curve and DEX aggregators see nothing real. Use fees.
const dexVolume = graduated ? await readVolume(token) : null;
const { feesNow, fees24hUsd } = fees24hFromSamples(feed.samples, agent, orbioUsd);
const feeVolume = fees24hUsd != null ? fees24hUsd / 0.05 : null;                 // 5% creator fee -> implied volume
const volume24hUsd = dexVolume != null ? Math.max(dexVolume, feeVolume || 0) : feeVolume;
const volumeSource = dexVolume != null ? "dexscreener" : fees24hUsd != null ? "curve fees" : null;
const lastSample = feed.samples[feed.samples.length - 1];
const offeringUsd = lastSample && orbioUsd ? Math.max(0, feesNow - lastSample.fees) * orbioUsd : 0;
if (agent && offeringUsd >= 0.05) event(`offering received · $${offeringUsd.toFixed(2)} in fees since last tick`);
const gradPct = agent?.price?.graduated ? 100 : Number(agent?.curve?.progressBps || 0) / 100;
if (agent && !agent.price?.graduated && Math.floor(gradPct / 10) > Math.floor(Number(prev.gradPct || 0) / 10)) event(`curve at ${gradPct.toFixed(0)}% to graduation`);
if (agent && agent.price?.graduated && !prev.graduated) event("graduated. the curve is behind me now");
feed.samples.push({ t: now, fees: feesNow, vol: volume24hUsd });

const energy = agent ? energyFrom(volume24hUsd, fees24hUsd) : 0;
const thoughtsPerDay = agent ? Math.round(MIN_THOUGHTS_PER_DAY + energy * (MAX_THOUGHTS_PER_DAY - MIN_THOUGHTS_PER_DAY)) : 0;
const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
const todays = feed.thoughts.filter(t => Date.parse(t.at) >= dayStart.getTime());
const spentToday = todays.reduce((s, t) => s + (t.cost || 0), 0) + feed.posts.filter(p => Date.parse(p.at) >= dayStart.getTime()).reduce((s, p) => s + (p.cost || 0), 0);
const lastThoughtAt = feed.thoughts.length ? Date.parse(feed.thoughts[feed.thoughts.length - 1].at) : 0;
const interval = thoughtsPerDay > 0 ? 86400e3 / thoughtsPerDay : Infinity;

const lastPostAt = feed.posts.length ? Date.parse(feed.posts[feed.posts.length - 1].at) : 0;
const duePost = !!agent && !!API_KEY && spentToday < DAILY_CREDIT_CAP && now - lastPostAt >= POST_INTERVAL_MIN * 60e3 - 60e3;
let status = !agent ? "prelaunch" : "napping";
let reason = !agent ? "no agent yet" : "";
if (agent && !API_KEY) reason = "no API key";
else if (agent && spentToday >= DAILY_CREDIT_CAP) reason = "daily budget spent";
else if (agent && !FORCE && !duePost && now - lastThoughtAt < interval) { status = "resting"; reason = `next thought in ${Math.ceil((interval - (now - lastThoughtAt)) / 60000)} min`; }
else if (agent && energy <= 0 && feed.thoughts.length && !duePost) reason = "no trades, no thoughts";
else if (agent) status = "awake";

feed.metrics = {
  volume24hUsd, fees24hUsd, volumeSource, graduated, graduationPct: gradPct, balanceCredit,
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
if (agent && status === "napping" && reason && reason !== prev.reason) event(`napping: ${reason}`);
if (agent && status === "awake" && prev.status === "napping") event("waking up");

if (status === "awake") {
  try {
    let readCost = 0;
    const ctx = { energy, energyNote: volumeSource ? "from " + volumeSource : "unknown", volume24hUsd, priceUsd: feed.metrics.priceUsd, lens: LENSES[feed.thoughts.length % LENSES.length], postAngle: POST_ANGLES[feed.posts.length % POST_ANGLES.length], mustPost: duePost,
      recentMoods: feed.thoughts.slice(-10).map(function (t) { return t.mood; }).filter(Boolean),
      lastSketch: null, // set below only when a sketch is fresh, unmentioned, and a coin flip says so
      emotionHints: [
        balanceCredit != null && balanceCredit < 5 ? "the bowl is nearly empty, hunger should be high" : balanceCredit != null && balanceCredit > 30 ? "well fed, hunger low" : "",
        energy < 0.15 ? "the tape is dead, boredom and melancholy rise" : energy > 0.7 ? "busy tape, curiosity and mischief rise" : "",
        feed.posts.length && now - Date.parse(feed.posts[feed.posts.length - 1].at) < 45 * 60e3 ? "you just spoke in public, a little smug or a little exposed" : "",
        (new Date(now).getUTCHours() >= 4 && new Date(now).getUTCHours() < 10) ? "it is the small hours, the nocturnal, feral side is closer" : ""
      ].filter(Boolean).join("; ") || "nothing pulls hard right now",
      creditOwed: feed.metrics.creditOwed, thoughtsToday: todays.length, recent: feed.thoughts.slice(-6) };
    if (duePost && !DRY_RUN) {
      const slot = feed.posts.length;
      if (REPLY_EVERY > 0 && slot % REPLY_EVERY === REPLY_EVERY - 1) {
        const { target, cost } = await findReplyTarget(feed); readCost += cost;
        if (target) { ctx.replyTo = target; ctx.postAngle = "an answer to what they said"; log("replying to:", `@${target.handle}`, JSON.stringify(target.text.slice(0, 120))); }
      }
      if (!ctx.replyTo && TAG_EVERY > 0 && slot % TAG_EVERY === TAG_EVERY - 2) {
        readCost += await refreshTagPool(feed);
        const cands = tagCandidates(feed);
        if (cands.length) ctx.tagHandle = cands[Math.floor(slot / TAG_EVERY) % cands.length];
      }
      if (ctx.tagHandle) {
        ctx.postAngle = `${POST_ANGLES[slot % POST_ANGLES.length]}, said to @${ctx.tagHandle}`;
      }
    }
    const lastSk = feed.sketches[feed.sketches.length - 1];
    if (lastSk && !lastSk.mentioned && now - Date.parse(lastSk.at) < 35 * 60e3 && Math.random() < 0.5 && duePost) { ctx.lastSketch = lastSk; lastSk.mentioned = true; }
    const t = DRY_RUN ? { thought: "(dry run) I would have thought something here.", post: null, cost: 0, model: MODEL } : await think(persona, ctx);
    if (t.thought) {
      const entry = { at: iso(now), text: t.thought, cost: t.cost, model: t.model, energy: feed.energy,
        kind: energy < 0.12 ? "dream" : "thought", mood: t.mood, focus: t.focus, emotions: t.emotions };
      feed.thoughts.push(entry);
      feed.state = { mood: t.mood, focus: t.focus, emotions: t.emotions, at: iso(now) };
      if (SKETCH_EVERY > 0 && feed.thoughts.length % SKETCH_EVERY === 0) {
        try { const sk = await makeSketch({ energy, emotions: t.emotions }); entry.sketch = sk; feed.sketches.push({ ...sk, mood: t.mood, thought: t.thought.slice(0, 140) }); event(`drew a sketch · ${sk.family} ${sk.seed}`); log("sketch:", JSON.stringify(sk)); }
        catch (e) { log("sketch failed:", String(e.message || e).slice(0, 200)); }
      }
      const n = feed.thoughts.length;
      // Post on the clock: whenever POST_INTERVAL_MIN has passed since the last post.
      const text = cleanPost(t.post, ctx, feed);
      const shouldPost = !!text && duePost;
      if (t.post && !text) log("post dropped by the rules:", JSON.stringify(t.post));
      if (shouldPost && !DRY_RUN) {
        try {
          const p = await postToX(text);
          if (p.error) log("post skipped:", p.error);
          else {
            const rec = { at: iso(now), text, id: p.id, url: p.url, status: p.status, cost: Number((p.cost + readCost).toFixed(6)) };
            if (p.err) rec.error = String(p.err).slice(0, 200);
            if (ctx.replyTo) { rec.kind = "reply"; rec.replyTo = { id: ctx.replyTo.id, handle: ctx.replyTo.handle, name: ctx.replyTo.name, text: ctx.replyTo.text.slice(0, 200), url: ctx.replyTo.url, why: ctx.replyTo.why }; }
            else if (ctx.tagHandle && text.toLowerCase().includes("@" + ctx.tagHandle)) { rec.kind = "tag"; rec.tagged = ctx.tagHandle; }
            feed.posts.push(rec); feed.lastPostThoughtIndex = n;
            event(rec.kind === "reply" ? `answered @${rec.replyTo.handle} on X` : rec.kind === "tag" ? `posted to X, tagging @${rec.tagged}` : "posted to X");
          }
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
if (API_KEY && !DRY_RUN && agent) await retryFailedPosts(feed, spentToday);

await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`status=${feed.status} energy=${feed.energy} thoughts/day=${thoughtsPerDay} spentToday=${feed.metrics.spentTodayCredit} ${feed.reason || ""}`);
