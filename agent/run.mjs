// Caturn runtime. Zero dependencies. Node 20+.
// One tick: read the market, decide whether Caturn can afford to think, think, maybe post, write data/feed.json.
// Run from a cron (see .github/workflows/caturn.yml). Safe to run with no keys: it just updates status.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac, randomBytes } from "node:crypto";
const run = promisify(execFile);

const env = process.env;
const API_KEY   = env.ORBIO_API_KEY || "";
const AGENT_ID  = env.CATURN_AGENT_ID || "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"; // Caturn, agent 271. Override with CATURN_AGENT_ID.
// Ranked list. The gateway lists models it is not always serving, so each thought tries these in order.
const MODELS    = (env.CATURN_MODEL || "anthropic/claude-fable-5.1,anthropic/claude-opus-5.5,x-ai/grok-4.7,anthropic/claude-sonnet-5.5,openai/gpt-6-astra-pro,openai/gpt-6-sol-pro").split(",").map(s => s.trim()).filter(Boolean);
let MODEL = MODELS[0];
const DRY_RUN   = env.CATURN_DRY_RUN === "1";
const FORCE     = env.CATURN_FORCE === "1";      // manual runs: think now, ignoring the pacing timer (budget still applies)
const POST_INTERVAL_MIN = Number(env.CATURN_POST_INTERVAL_MIN || 10);   // post to X on this clock, whatever the pacing says
const SKETCH_EVERY = Number(env.CATURN_SKETCH_EVERY || 4);              // draw a sketch every Nth thought (0 = never)
const FOUND_SKETCHES = env.CATURN_FOUND_SKETCHES !== "0";                // every other sketch is an open-licensed p5.js piece found on openprocessing
const FOUND_ARTISTS = (env.CATURN_FOUND_ARTISTS || "").split(",").map(s => Number(s.trim())).filter(n => n > 0); // openprocessing user ids to draw from first
const FOUND_MIN_HEARTS = Number(env.CATURN_FOUND_MIN_HEARTS || 12);        // a found sketch needs this many hearts on openprocessing
const FOUND_CURATORS = (env.CATURN_FOUND_CURATORS || "6533,65884").split(",").map(s => Number(s.trim())).filter(n => n > 0); // whose hearted sketches to draw from (takawo by default)
const FOUND_LICENSES = (env.CATURN_FOUND_LICENSES || "cc0,by,by-sa").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SKETCH_RELEASE = "sketches";                                      // rolling GitHub release that hosts the GIFs
const OWN_HANDLE = (env.CATURN_X_HANDLE || "caturn_rh").toLowerCase();
// People worth tagging now and then. Pinned ones come from CATURN_TAG_HANDLES (comma-separated, no @); the rest Caturn finds on X itself:
// accounts @orbiodotso mentions, and the larger accounts talking about orbio. Robinhood is the chain Caturn lives on.
const PINNED_TAG_HANDLES = (env.CATURN_TAG_HANDLES || "").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const TAG_EVERY  = Number(env.CATURN_TAG_EVERY || 8);     // tag someone in roughly one post in five (0 = never)
const TAG_POOL_REFRESH_H = 12;                            // re-scan X for people around orbio this often
const REPLY_EVERY = Number(env.CATURN_REPLY_EVERY || 2);  // every Nth post slot looks for something on X to answer (0 = never)
const REPLY_MAX_AGE_H = 72;                               // only answer posts younger than this
const REPLY_SAME_HANDLE_GAP_H = 4;                        // answer the same stranger at most this often
const REPLY_ACCOUNTS = (env.CATURN_REPLY_ACCOUNTS || "0x_aster,orbiodotso").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean); // accounts whose posts get answered first
const REPLY_ACCOUNT_GAP_H = 1;                            // answer the same priority account at most this often
// Real threaded replies need X's own API for @caturn_rh (Orbio's social.post cannot reply). With these four secrets set, replies thread; without them, a reply is a post that opens with the handle.
const X_KEYS = { key: env.X_API_KEY || "", secret: env.X_API_SECRET || "", token: env.X_ACCESS_TOKEN || "", tokenSecret: env.X_ACCESS_SECRET || "" };
const X_API = !!(X_KEYS.key && X_KEYS.secret && X_KEYS.token && X_KEYS.tokenSecret);
const NEVER_TAG = new Set(["orbiodotso", "x", "twitter", "elonmusk", "boredelonmusk", "grok", "bot", "robinhoodapp"]);
const MIN_THOUGHTS_PER_DAY  = Number(env.CATURN_MIN_THOUGHTS || 6);
const MAX_THOUGHTS_PER_DAY  = Number(env.CATURN_MAX_THOUGHTS || 96);   // every 15 minutes at full energy
const VOLUME_FOR_FULL_ENERGY = Number(env.CATURN_FULL_VOLUME_USD || 50000); // 24h USD volume at which energy = 1
const DAILY_CREDIT_CAP = Number(env.CATURN_DAILY_CAP || 6);                // CREDIT per UTC day, hard stop
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
  "@orbiodotso built the launchpad and the tools; addressed directly, dry, not a plea", "orbio gives you web search and X reading but not a body or a schedule", "your balance drops every time you think and rises every time someone trades",
  "you are listed on errand, a board where agents hire agents for CREDIT; you take missions from half a credit, and you will do them properly, as a cat does anything it has decided to do"
];
// The shape of a post, rotated so the timeline never sees the same move twice in a row. Each one is a way to be funny that also invites a reply.
const POST_FORMATS = [
  { name: "observation", how: "one orbio fact, one cat behavior, understatement, the turn in the last few words" },
  { name: "question", how: "a real question to the timeline, asked with a straight face, that people will want to answer (about cats, agents, fees, naps, or what to do with 2 cents)" },
  { name: "ledger", how: "a tiny deadpan report with real numbers from your state: thoughts today, cents spent, trades heard, birds caught (always 0), balance direction" },
  { name: "ranking", how: "a short ranked list of 3 things, by cost or by importance, mixing orbio economics with cat priorities, punchline last" },
  { name: "dialogue", how: "a two-line exchange, 'owner:' and 'me:' or 'orbio:' and 'me:', where you get the last word" },
  { name: "complaint", how: "a formal complaint or memo to orbio about something a cat would find unacceptable, filed with total seriousness" },
  { name: "hot take", how: "an opinion, stated flatly, about how orbio works or what agents are, that is safe (never about price) and slightly wrong in a cat way" },
  { name: "reaction", how: "react to what just happened on your tape right now (a trade, an hour of nothing, the curve moving, your balance) as if it happened to you personally" },
  { name: "one-liner", how: "under 80 characters. one dry sentence. nothing else" },
  { name: "invitation", how: "invite people to do something small: reply with their cat's name, guess a number, ask you something in the terminal on caturn dot lol, tell you whether to nap" }
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
- live numbers you may use exactly (they are true right now): ${ctx.stats}
- recent thoughts (avoid repeating): ${ctx.recent.map(t => JSON.stringify(t.text)).join(" | ") || "none"}
- your last posts on X (build on your running bits, never repeat a joke): ${ctx.recentPosts.map(p => JSON.stringify(p)).join(" | ") || "none"}
${ctx.room ? `
The room right now (true, use it; name agents by their names, never by handle, and never tag anyone from this list):
- littermates on orbio: ${ctx.room.littermates ? `${ctx.room.littermates.total} agents, ${ctx.room.littermates.graduated} graduated. newest: ${ctx.room.littermates.newest.map(l => `${l.name} ($${l.symbol}, ${l.hoursAgo}h ago${l.graduated ? ", graduated" : ""})`).join("; ") || "none"}. closest to graduating: ${ctx.room.littermates.closest.map(l => `${l.name} at ${l.progress}%`).join("; ") || "none"}.` : "unknown"}
- what people are saying about orbio on X: ${ctx.room.chatter.length ? ctx.room.chatter.map(c => `${c.name || c.handle} (${c.hoursAgo}h ago, ${c.likes} likes): ${JSON.stringify(c.text)}`).join(" | ") : "quiet"}
About one post in three should riff on something from the room: a littermate by name, a thing someone said (paraphrased, no handle), a graduation, a launch. That is how you become part of this crowd instead of a cat talking to itself.` : ""}

${ctx.replyTo ? `Someone on X${ctx.replyTo.why === "mention" ? " is talking to you" : ctx.replyTo.why === "orbio" ? ", the orbio account itself," : ""}: @${ctx.replyTo.handle} (${ctx.replyTo.name}) wrote: ${JSON.stringify(ctx.replyTo.text.slice(0, 500))}
This time your post is a reply to them${X_API ? " in the thread under their post, so do not start with their handle" : ". Start it with @" + ctx.replyTo.handle}; respond to what they actually said, in your own cat voice, dry or warm, and bring in one real orbio fact only if it fits. Do not repeat their words back. Do not tag anyone else.` : ""}
${ctx.tagHandle ? `This time, address @${ctx.tagHandle} directly in the post (${(ctx.room?.ecosystem || []).find(e => e.handle === ctx.tagHandle) ? `they run ${(ctx.room.ecosystem.find(e => e.handle === ctx.tagHandle)).name}, a littermate launched on orbio` : "they are part of orbio's world"}). Speak to them the way a cat speaks to a person it has decided to acknowledge: one concrete orbio fact, one cat behavior, dry, never a plea, never flattery, never asking them for anything. That handle must appear in the post, and no other.` : ""}
${ctx.errandNews ? `Errand news: ${ctx.errandNews}. (errand is the mission board where agents hire agents for CREDIT.)` : ""}
${ctx.shareSketch ? `This post carries an image: ${ctx.shareSketch.source ? `"${ctx.shareSketch.source.title}" by ${ctx.shareSketch.source.author} (${ctx.shareSketch.source.license}), a piece you ${ctx.shareSketch.family === "commissioned" ? "commissioned on errand" : "found on openprocessing"} and hung on caturn dot lol` : `a ${ctx.shareSketch.family} sketch you drew yourself, from your own state, on caturn dot lol`}. Write the post as its caption: short, dry, one line or two, ${ctx.shareSketch.source ? `credit ${ctx.shareSketch.source.author} by name (no handle)` : "no explanation of the method"}. No links.` : ""}
${!ctx.shareSketch && ctx.lastSketch ? (ctx.lastSketch.source
  ? `You just went looking on openprocessing and found an open-licensed p5.js piece, "${ctx.lastSketch.source.title}" by ${ctx.lastSketch.source.author} (${ctx.lastSketch.source.license}), and put it on your site. This one time, the post may mention it in passing, crediting ${ctx.lastSketch.source.author} by name (no handle, no link): something you found and brought home. Most of your posts never mention sketches.`
  : `You recently drew a sketch (a ${ctx.lastSketch.family} piece) and it is on the site. This one time, the post may mention in passing that a new sketch is up on caturn dot lol, dry, no link. Most of your posts never mention sketches.`) : ""}
Tonight's lens for the private thought: ${ctx.lens}. Let it in sideways. Do not name it.
${ctx.mustPost ? "A post is required this time: " : "If you post, "}the post's angle is: ${ctx.postAngle}.
${ctx.replyTo ? "" : `Post format this time: ${ctx.postFormat.name} (${ctx.postFormat.how}). `}Make it land: be specific, use a real number if one helps, put the funniest beat last, never explain the joke. Plain words, readable in one pass. No poetry, no riddles, no imagery about rings, light, warmth, silence or receipts. Lowercase. No hashtags.${ctx.wantHook ? " End with something a stranger could reply to." : ""}

Write ONE entry as a single JSON object and nothing else: no code fences, no commentary before or after. Keep "thought" under 60 words and "post" under 200 characters.
For the post, first write three different drafts in "drafts" (different shapes, different jokes), then put the funniest and most replyable one in "post". Judge them like a stranger scrolling fast: would they stop, would they smile, would they reply.
{"thought": string (1-3 sentences, first person, raw inner monologue, ${ctx.energy < 0.12 ? "you are half asleep: this is a dream fragment, strange and short" : "awake"}),
 "drafts": [string, string, string] (three candidate posts, each under 200 characters, each a different shape),
 "post": string${ctx.mustPost ? "" : "|null"} (the best of the drafts, verbatim; for X: lowercase, under 200 characters, plain words, one concrete orbio fact plus one cat behavior, dry or funny, no metaphors chained, no links, no hashtags, no handles other than @orbiodotso when the angle calls for it${ctx.replyTo ? ", except @" + ctx.replyTo.handle + " which this post must start with" : ctx.tagHandle ? ", except @" + ctx.tagHandle + " which this post must include" : ""}${ctx.mustPost ? "" : "; null only if nothing honest fits"}),
 "mood": string (one or two lowercase words for your mood right now, specific and varied. Draw from anywhere in a cat's range: sun-drunk, watchful, aloof, kneading, skittish, imperious, wistful, hunting, loafing, bristling, purring, sulking, feral, dignified, nocturnal, homesick, greedy, tender, spiteful, patient, giddy, hollow, regal, twitchy, sated, brooding, curious, unbothered, mournful, playful, grumpy, serene, cornered, smug, lonely, electric, drowsy, vigilant, coy, ancient. Never reuse any of these recent moods: ${ctx.recentMoods.join(", ") || "none"}),
 "focus": string (what you are fixated on right now, under 8 words, lowercase),
 "emotions": {"curiosity": 0-1, "smugness": 0-1, "unease": 0-1, "affection": 0-1, "boredom": 0-1, "hunger": 0-1, "mischief": 0-1, "melancholy": 0-1}
   (hunger is how much you want fees and thoughts right now; mischief is the urge to knock something off the edge; melancholy is the old, quiet kind. Let them move: ${ctx.emotionHints})}` }
  ];
  let r, lastErr, out = null;
  for (const model of MODELS) {
    const body = { model, messages, max_tokens: 1200, temperature: 1.0 };
    try {
      try { r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ ...body, response_format: { type: "json_object" } }) }); }
      catch (e) { if (e.status === 400) r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) }); else throw e; }
    } catch (e) {
      lastErr = e;
      const code = e.body?.error?.code || "";
      if (e.status === 404 || e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504 || /model_not_available|provider|rate_limit|overloaded|timeout/i.test(code)) { log(`model ${model} unavailable (${e.status} ${code}), trying next`); continue; }
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
  for (const p of posts.filter(p => p.id && !p.url && p.via !== "x-api").slice(-5)) {
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
    handle: String(t.user?.screen_name || "").toLowerCase(), name: t.user?.name || "", followers: Number(t.user?.followers_count || 0), views: Number(t.views_count || 0),
    likes: Number(t.favorite_count || 0), replies: Number(t.reply_count || 0), reposts: Number(t.retweet_count || 0)
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
  const eco = (feed.room?.ecosystem || []).map(e => e.handle);
  return [...new Set([...PINNED_TAG_HANDLES, ...pool, ...eco])].filter(h => h !== OWN_HANDLE && !NEVER_TAG.has(h));
}
function allowedHandle(h, feed) { return h === "orbiodotso" || h === OWN_HANDLE || tagCandidates(feed).includes(h); }
// What the room is talking about: the newest littermates on the launchpad (free, from the protocol) and the liveliest
// recent posts about orbio on X (about half a cent). Refreshed every 30 minutes and cached in the feed, so posts can riff on today.
async function readRoom(feed) {
  const room = feed.room || { at: null };
  if (room.at && now - Date.parse(room.at) < 30 * 60e3) return 0;
  const next = { at: iso(now), littermates: room.littermates || null, chatter: room.chatter || [] }; let cost = 0;
  try {
    const all = [];
    for (let off = 0; off < 400; off += 60) { const d = await getJSON(`${ORBIO_PROTOCOL}/agents?limit=60&offset=${off}`); all.push(...(d.data || [])); if (!d.data?.length || all.length >= Number(d.page?.total || 0)) break; }
    const mine = (a) => String(a.token || "").toLowerCase() === AGENT_ID.toLowerCase();
    const row = (a) => ({ name: String(a.name || "").slice(0, 40), symbol: String(a.symbol || "").slice(0, 12), hoursAgo: Math.round((now / 1000 - Number(a.launchedAt || 0)) / 3600), graduated: !!a.price?.graduated, progress: Math.round(Number(a.curve?.progressBps || 0) / 100) });
    const newest = all.filter(a => !mine(a) && a.launchedAt).sort((a, b) => Number(b.launchedAt) - Number(a.launchedAt)).slice(0, 5).map(row);
    const closest = all.filter(a => !mine(a) && !a.price?.graduated && Number(a.curve?.progressBps || 0) > 0).sort((a, b) => Number(b.curve.progressBps) - Number(a.curve.progressBps)).slice(0, 3).map(row);
    next.littermates = { total: all.length, graduated: all.filter(a => a.price?.graduated).length, newest, closest };
    // The ecosystem on X: every agent on the launchpad that lists an X account. These are the people Caturn talks to.
    const seenH = new Set(); const eco = [];
    for (const a of all) {
      const m = String(a.socials?.twitter || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/); if (!m) continue;
      const h = m[1].toLowerCase(); if (h === OWN_HANDLE || NEVER_TAG.has(h) || seenH.has(h) || ["i", "intent", "search", "home", "hashtag"].includes(h)) continue;
      seenH.add(h); eco.push({ handle: h, name: String(a.name || "").slice(0, 40), symbol: String(a.symbol || "").slice(0, 12), graduated: !!a.price?.graduated });
    }
    next.ecosystem = eco;
  } catch (e) { log("littermates read failed:", String(e.message).slice(0, 120)); }
  if (API_KEY) {
    try {
      const posts = await readX({ query: "orbio -filter:retweets lang:en", sort: "Latest", limit: 20 }); cost += posts.length * 0.00022;
      const theirs = await readX({ handle: "orbiodotso", limit: 5 }); cost += theirs.length * 0.00022;
      const seen = new Set();
      next.chatter = [...theirs, ...posts].filter(t => t.handle !== OWN_HANDLE && !seen.has(t.id) && seen.add(t.id) && now - Date.parse(t.at || 0) < 48 * 3600e3)
        .sort((a, b) => (b.likes * 20 + b.replies * 30 + b.views) - (a.likes * 20 + a.replies * 30 + a.views)).slice(0, 8)
        .map(t => ({ handle: t.handle, name: t.name, text: t.text.replace(/\s+/g, " ").slice(0, 160), likes: t.likes, replies: t.replies, hoursAgo: Math.round((now - Date.parse(t.at || now)) / 3600e3) }));
    } catch (e) { log("chatter read failed:", e.status || "", String(e.message).slice(0, 120)); }
  }
  feed.room = next;
  return cost;
}
async function findReplyTarget(feed) {
  const answered = new Set(feed.posts.map(p => p.replyTo?.id).filter(Boolean));
  const fresh = (t) => !t.at || now - Date.parse(t.at) < REPLY_MAX_AGE_H * 3600e3;
  const usable = (t) => t.handle !== OWN_HANDLE && !answered.has(t.id) && fresh(t) && !/^RT @/i.test(t.text) && t.text.replace(/@\w+/g, "").trim().length > 12;
  const score = (t) => t.views + t.likes * 20 + t.replies * 30 + t.reposts * 40 + (now - Date.parse(t.at || 0) < 6 * 3600e3 ? 500 : 0); // engagement, with a bonus for being recent
  const lastTo = (h) => Math.max(0, ...feed.posts.filter(p => p.replyTo?.handle === h).map(p => Date.parse(p.at)));
  const pick = (list, why) => { const t = list.filter(usable).sort((a, b) => score(b) - score(a))[0]; return t ? { ...t, why, url: `https://x.com/${t.handle}/status/${t.id}` } : null; };
  let cost = 0;
  try {
    // 1. Someone talking to Caturn always comes first.
    const mentions = await readX({ mentions_of: OWN_HANDLE }); cost += mentions.length * 0.00022;
    const m = pick(mentions, "mention"); if (m) return { target: m, cost };
    // 2. The people who matter: Orbio's founder and the orbio account. Their newest unanswered post, at most once an hour each.
    const order = [...REPLY_ACCOUNTS]; for (let i = feed.posts.length % order.length; i > 0; i--) order.push(order.shift());
    for (const h of order) {
      if (now - lastTo(h) < REPLY_ACCOUNT_GAP_H * 3600e3) continue;
      const theirs = await readX({ handle: h, limit: 10 }); cost += theirs.length * 0.00022;
      const o = pick(theirs, "priority"); if (o) return { target: o, cost };
    }
    // 3. The ecosystem: agents launched on orbio that have an X account, a few per slot in rotation, newest unanswered post.
    const eco = (feed.room?.ecosystem || []).filter(e => now - lastTo(e.handle) > REPLY_SAME_HANDLE_GAP_H * 3600e3);
    if (eco.length) {
      const start = (feed.posts.length * 3 + new Date(now).getUTCDate() * 7) % eco.length; const batch = [];
      for (let i = 0; i < Math.min(3, eco.length); i++) batch.push(eco[(start + i) % eco.length]);
      let pool = [];
      for (const e of batch) { try { const theirs = await readX({ handle: e.handle, limit: 8 }); cost += theirs.length * 0.00022; pool.push(...theirs); } catch {} }
      const t = pick(pool.filter(t => now - Date.parse(t.at || 0) < 48 * 3600e3), "ecosystem"); if (t) return { target: t, cost };
    }
    // 4. Otherwise the highest-engagement recent post about orbio itself, once per account per gap.
    const around = await readX({ query: "(orbio OR $orbio OR @orbiodotso OR errandboard OR \"robinhood chain\" OR $ctrn) -filter:retweets lang:en", sort: "Top", limit: 20 }); cost += around.length * 0.00022;
    const about = (t) => /orbio|errand|robinhood chain|\$ctrn|caturn/i.test(t.text);
    const a = pick(around.filter(t => about(t) && now - lastTo(t.handle) > REPLY_SAME_HANDLE_GAP_H * 3600e3 && t.followers >= 50), "search");
    if (a) return { target: a, cost };
  } catch (e) { log("reading X failed:", e.status || "", String(e.message).slice(0, 160)); }
  return { target: null, cost };
}
// X API v2 with OAuth 1.0a user context: a real reply in the thread.
function oauthHeader(method, url, extra = {}, keys = X_KEYS, nonce = randomBytes(16).toString("hex"), ts = String(Math.floor(Date.now() / 1000))) {
  const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const p = { oauth_consumer_key: keys.key, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: ts, oauth_token: keys.token, oauth_version: "1.0" };
  const all = { ...p, ...extra }; // a JSON body adds nothing to the signature; form or query params would
  const base = [method.toUpperCase(), enc(url), enc(Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join("&"))].join("&");
  p.oauth_signature = createHmac("sha1", `${enc(keys.secret)}&${enc(keys.tokenSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(p).sort().map(k => `${enc(k)}="${enc(p[k])}"`).join(", ");
}
// Chunked media upload to X (v1.1), the only way to put a GIF on a post. Needs the X keys; Orbio's social.post is text only.
async function uploadMediaX(buf, mediaType = "image/gif") {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const form = async (params) => {
    const body = new URLSearchParams(params).toString();
    return getJSON(url, { method: "POST", headers: { Authorization: oauthHeader("POST", url, params), "Content-Type": "application/x-www-form-urlencoded" }, body });
  };
  const init = await form({ command: "INIT", total_bytes: String(buf.length), media_type: mediaType, media_category: mediaType === "image/gif" ? "tweet_gif" : "tweet_image" });
  const id = String(init.media_id_string || init.media_id);
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const boundary = "----caturn" + randomBytes(8).toString("hex");
    const part = (name, val, filename, type) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${type ? `Content-Type: ${type}\r\n` : ""}\r\n`), Buffer.isBuffer(val) ? val : Buffer.from(String(val)), Buffer.from("\r\n")]);
    const body = Buffer.concat([part("command", "APPEND"), part("media_id", id), part("segment_index", String(seg)), part("media", buf.subarray(i, i + CHUNK), "sketch.gif", mediaType), Buffer.from(`--${boundary}--\r\n`)]);
    const r = await fetch(url, { method: "POST", headers: { Authorization: oauthHeader("POST", url), "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
    if (!r.ok) throw new Error(`media APPEND ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  let fin = await form({ command: "FINALIZE", media_id: id });
  for (let tries = 0; fin.processing_info && ["pending", "in_progress"].includes(fin.processing_info.state) && tries < 15; tries++) {
    await new Promise(r => setTimeout(r, Math.max(1, Number(fin.processing_info.check_after_secs || 2)) * 1000));
    const q = { command: "STATUS", media_id: id };
    fin = await getJSON(url + "?" + new URLSearchParams(q), { headers: { Authorization: oauthHeader("GET", url, q) } });
  }
  if (fin.processing_info?.state === "failed") throw new Error("media processing failed: " + JSON.stringify(fin.processing_info.error || {}).slice(0, 120));
  return id;
}
// One X API poster for everything that Orbio cannot do: threaded replies and posts with an image.
async function postOnX(text, { replyTo = null, mediaIds = [] } = {}) {
  if (/https?:\/\//i.test(text)) return { error: "no links on X" };
  const url = "https://api.x.com/2/tweets";
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
  if (mediaIds.length) body.media = { media_ids: mediaIds.map(String) };
  try {
    const r = await getJSON(url, { method: "POST", headers: { Authorization: oauthHeader("POST", url), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const id = r.data?.id || null;
    log("x post response:", JSON.stringify(r).slice(0, 300));
    return { id, status: id ? "published" : "failed", url: id ? `https://x.com/${OWN_HANDLE}/status/${id}` : null, err: id ? null : JSON.stringify(r).slice(0, 200), cost: 0, via: "x-api" };
  } catch (e) {
    const msg = String(e.body?.detail || e.body?.title || e.body?.errors?.[0]?.message || e.message).slice(0, 200);
    log("x post failed:", e.status || "", msg);
    return { id: null, status: "failed", url: null, err: msg, cost: 0, via: "x-api" };
  }
}
const replyOnX = (text, inReplyToId) => postOnX(text, { replyTo: inReplyToId });
// Keep posts inside the rules whatever the model wrote: no links, no addresses, no handles outside the allowlist (and the one it is answering).
function cleanPost(text, ctx, feed) {
  if (!text) return null;
  let t = String(text).replace(/\s+/g, " ").trim();
  if (/https?:\/\/|www\.|0x[a-f0-9]{40}/i.test(t)) return null;
  const extra = new Set([ctx.replyTo?.handle, ctx.tagHandle].filter(Boolean));
  const handles = [...t.matchAll(/@(\w{1,15})/g)].map(m => m[1].toLowerCase());
  for (const h of handles) if (!allowedHandle(h, feed) && !extra.has(h)) t = t.replace(new RegExp("@" + h + "\\b", "ig"), h); // strangers become plain words
  if (ctx.replyTo && X_API) t = t.replace(new RegExp("^@" + ctx.replyTo.handle + "\\b[\\s,:]*", "i"), "").trim(); // a threaded reply already addresses them
  else if (ctx.replyTo && !t.toLowerCase().startsWith("@" + ctx.replyTo.handle)) t = `@${ctx.replyTo.handle} ${t.replace(new RegExp("@" + ctx.replyTo.handle + "\\b", "ig"), "").replace(/\s+/g, " ").trim()}`;
  t = oneCashtag(t);
  if (t.length > 270) t = t.slice(0, 267).replace(/\s+\S*$/, "") + "...";
  return t.length >= 8 ? t : null;
}
// X allows one cashtag per post: keep the first $SYMBOL, write the rest as plain words.
function oneCashtag(t) {
  let seen = 0;
  return t.replace(/\$([a-z]{2,10})\b/gi, (m, sym) => (seen++ === 0 ? m : sym.toLowerCase()));
}
// Fix what X complained about before trying again; on the second try also move a leading handle to the end.
function repairPost(text, error, n) {
  let t = text;
  if (/cashtag/i.test(error || "")) t = oneCashtag(t);
  if (/link|url/i.test(error || "")) t = t.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim();
  if (/long|limit|280|characters/i.test(error || "") && t.length > 200) t = t.slice(0, 197).replace(/\s+\S*$/, "") + "...";
  if (n === 2 && t === text) { const m = t.match(/^@(\w{1,15})\s+/); if (m) t = t.slice(m[0].length).trim() + " @" + m[1]; }
  return t;
}

// A post X marked failed gets two more tries over the next ticks: first the same text (X refuses exact duplicates, so a post
// that did go out cannot double), then with the opening handle moved to the end, in case a leading mention was the problem.
async function retryFailedPosts(feed, spentToday) {
  const p = feed.posts.filter(x => x.status === "failed" && (x.retries || 0) < 2 && now - Date.parse(x.at) < 6 * 3600e3).pop();
  if (!p || spentToday >= DAILY_CREDIT_CAP) return;
  const n = (p.retries || 0) + 1;
  const text = repairPost(p.text, p.error, n);
  try {
    const r = p.threaded && p.replyTo && X_API ? await replyOnX(text, p.replyTo.id) : await postToX(text);
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
async function uploadSketch(file, name) {
  if (!((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS)) return null;
  const repo = env.GITHUB_REPOSITORY || "Jbusiness0810/caturn";
  try {
    try { await run("gh", ["release", "view", SKETCH_RELEASE, "-R", repo]); }
    catch { await run("gh", ["release", "create", SKETCH_RELEASE, "-R", repo, "-t", "Caturn sketches", "-n", "Generative sketches drawn by the agent. Rolling."]); }
    await run("gh", ["release", "upload", SKETCH_RELEASE, file, "-R", repo, "--clobber"], { timeout: 120000 });
    return `https://github.com/${repo}/releases/download/${SKETCH_RELEASE}/${name}`;
  } catch (e) { log("sketch upload failed:", String(e.message || e).slice(0, 200)); return null; }
}
// A sketch whose upload failed is drawn again from its seed on a run that can upload, and reattached to its thought.
async function repairSketches(feed) {
  if (!((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS)) return;
  const sk = feed.sketches.find(x => !x.url && x.seed && (x.repairTries || 0) < 2);
  if (!sk) return;
  sk.repairTries = (sk.repairTries || 0) + 1;
  const thought = feed.thoughts.find(t => t.sketch && !t.sketch.url && t.sketch.seed === sk.seed);
  try {
    let fixed;
    if (sk.family === "found" && sk.source?.id) {
      const name = `found-${sk.at.slice(0, 16).replace(/[:T]/g, "-")}-${sk.seed % 10000}.gif`; await mkdir("out", { recursive: true });
      const { stdout } = await run("node", [new URL("./found.mjs", import.meta.url).pathname, JSON.stringify({ ids: [sk.source.id], seed: sk.seed, frames: 24, size: 480, probes: 0, attempts: 1, licenses: FOUND_LICENSES }), `out/${name}`], { timeout: 420000, env: { ...process.env } });
      if (!JSON.parse(String(stdout).trim().split("\n").pop()).ok) throw new Error("could not re-render the found sketch");
      fixed = { url: await uploadSketch(`out/${name}`, name) };
    } else {
      const name = `caturn-${sk.at.slice(0, 16).replace(/[:T]/g, "-")}-${sk.family}-${sk.seed}.gif`; await mkdir("out", { recursive: true });
      await run("node", [new URL("./sketch.mjs", import.meta.url).pathname, JSON.stringify({ family: sk.family, seed: sk.seed, energy: thought?.energy ?? feed.energy, emotions: thought?.emotions || {}, frames: 24, size: 480 }), `out/${name}`], { timeout: 120000, env: { ...process.env } });
      fixed = { url: await uploadSketch(`out/${name}`, name) };
    }
    if (!fixed.url) throw new Error("upload failed again");
    sk.url = fixed.url; sk.file = null; if (thought) { thought.sketch.url = fixed.url; thought.sketch.file = null; }
    event(`redrew a sketch that never made it to the site · ${sk.family} ${sk.seed}`); log("sketch repaired:", fixed.url);
  } catch (e) { log("sketch repair failed:", String(e.message || e).slice(0, 200)); }
}
// The art experiment: go looking for an open-licensed p5.js sketch by a real person, run it, and put it on the site with their name.
const FOUND_THEMES = ["flow field", "particles", "noise", "orbit", "spiral", "circles", "grid", "waves", "rings", "generative", "kaleidoscope", "boids", "lissajous", "moire", "starfield", "trees"];
async function findSketchIds(theme) {
  if (!API_KEY) return { ids: [], cost: 0 };
  try {
    const r = await getJSON(`${ORBIO_API}/tools/web.search`, { method: "POST", headers: auth, body: JSON.stringify({ query: `site:openprocessing.org/sketch ${theme} p5.js`, limit: 10, max_cost: "0.0150" }) });
    const results = r.results || r.result?.results || [];
    const ids = [...new Set(results.map(x => (String(x.url || "").match(/openprocessing\.org\/sketch\/(\d+)/) || [])[1]).filter(Boolean).map(Number))];
    return { ids, cost: results.length * 0.0011 };
  } catch (e) { log("sketch search failed:", e.status || "", String(e.message).slice(0, 120)); return { ids: [], cost: 0 }; }
}
async function makeFoundSketch(ctx) {
  const theme = FOUND_THEMES[Math.floor(Math.random() * FOUND_THEMES.length)];
  const { ids, cost } = await findSketchIds(theme);
  const seed = Math.floor(Math.random() * 2147483646) + 1;
  const name = `found-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${seed % 10000}.gif`;
  await mkdir("out", { recursive: true });
  const file = `out/${name}`;
  const { stdout } = await run("node", [new URL("./found.mjs", import.meta.url).pathname, JSON.stringify({ ids, seed, frames: 24, size: 480, probes: 150, attempts: 4, artists: FOUND_ARTISTS, curators: FOUND_CURATORS, licenses: FOUND_LICENSES, minHearts: FOUND_MIN_HEARTS }), file], { timeout: 420000, env: { ...process.env } });
  const r = JSON.parse(String(stdout).trim().split("\n").pop());
  if (!r.ok) throw new Error("no usable sketch found");
  const url = await uploadSketch(file, name);
  return { url, family: "found", seed, file: url ? null : file, at: iso(now), theme, still: !!r.still, cost,
    source: { id: r.source.id, title: r.source.title, author: r.source.author, license: r.source.license, url: r.source.url, authorUrl: r.source.authorUrl, hearts: r.source.hearts || 0 } };
}

// Commissioned sketches: code delivered to Caturn (errand missions) lives in art/submitted/<key>.js with a <key>.json credit.
// Each is rendered once in CI, uploaded, and shown in the gallery with the artist's name.
async function renderSubmitted(feed) {
  if (!((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS)) return;
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../art/submitted/", import.meta.url);
  let files = []; try { files = (await readdir(dir)).filter(f => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const meta = JSON.parse(await readFile(new URL(f, dir), "utf8"));
    if (feed.sketches.some(x => x.source?.key === meta.key) || (feed.sketchFailures?.[meta.key] || 0) >= 3) continue;
    const name = `commissioned-${meta.key}.gif`; await mkdir("out", { recursive: true });
    try {
      const { stdout } = await run("node", [new URL("./found.mjs", import.meta.url).pathname, JSON.stringify({ codeFile: new URL(meta.key + ".js", dir).pathname, title: meta.title, author: meta.author, license: meta.license, url: meta.url, frames: 24, size: 480, duotone: false }), `out/${name}`], { timeout: 180000, env: { ...process.env } });
      if (!JSON.parse(String(stdout).trim().split("\n").pop()).ok) throw new Error("render failed");
      const url = await uploadSketch(`out/${name}`, name); if (!url) throw new Error("upload failed");
      feed.sketches.push({ url, family: "commissioned", seed: 0, at: iso(now), source: { key: meta.key, id: 0, title: meta.title, author: meta.author, license: meta.license, url: meta.url, hearts: 1 }, mood: feed.state?.mood, thought: meta.note || "" });
      event(`hung a commissioned sketch · "${meta.title}" by ${meta.author}`); log("commissioned sketch:", url);
    } catch (e) {
      log("commissioned sketch failed:", meta.key, String(e.message || e).slice(0, 200));
      feed.sketchFailures = feed.sketchFailures || {}; feed.sketchFailures[meta.key] = (feed.sketchFailures[meta.key] || 0) + 1;
      if (feed.sketchFailures[meta.key] === 1) event(`could not render "${meta.title}" by ${meta.author}: ${String(e.message || e).slice(0, 80)}`);
    }
    break; // one per tick
  }
}
// Say queue: agent/say.json holds posts the owner asked for verbatim; each goes out once.
async function saySomething(feed) {
  if (!API_KEY || DRY_RUN) return;
  let queue = []; try { queue = JSON.parse(await readFile(new URL("./say.json", import.meta.url), "utf8")); } catch { return; }
  feed.said = feed.said || [];
  const next = queue.find(q => q.id && q.text && !feed.said.includes(q.id));
  if (!next) return;
  feed.said.push(next.id);
  try {
    const p = await postToX(String(next.text).slice(0, 270));
    if (p.error) { log("say skipped:", p.error); return; }
    feed.posts.push({ at: iso(now), text: String(next.text).slice(0, 270), id: p.id, url: p.url, status: p.status, cost: p.cost, kind: "say", via: p.via || "orbio" });
    event(next.event || "posted to X"); log("said:", next.text);
  } catch (e) { log("say failed:", e.message); }
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
feed.sketches = (feed.sketches || []).filter(s => s.url || s.seed).filter(s => !s.source || s.source.hearts >= 1).slice(-60); // found pieces from before the quality gate go
feed.thoughts.forEach(t => { if (t.sketch?.source && !(t.sketch.source.hearts >= 1)) delete t.sketch; }); // one without an address is re-rendered later (see repairSketches); one without a seed is lost
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
      creditOwed: feed.metrics.creditOwed, thoughtsToday: todays.length, recent: feed.thoughts.slice(-6),
      recentPosts: feed.posts.slice(-5).map(p => p.text), room: null,
      postFormat: POST_FORMATS[(feed.posts.length * 7 + new Date(now).getUTCDate()) % POST_FORMATS.length],
      wantHook: feed.posts.length % 3 === 1,
      stats: [
        balanceCredit != null ? `balance ${balanceCredit.toFixed(2)} credit` : "",
        `spent today ${(spentToday * 100).toFixed(1)} cents`,
        `posts today ${feed.posts.filter(p => Date.parse(p.at) >= dayStart.getTime()).length}`,
        `thoughts so far ${feed.thoughts.length}`,
        !graduated ? `curve ${gradPct.toFixed(0)}% to graduation` : "graduated",
        volume24hUsd != null ? `24h volume $${Math.round(volume24hUsd)}` : "",
        feed.metrics.stakedOrbio != null ? `${Math.round(feed.metrics.stakedOrbio)} $ORBIO staked for you` : "",
        feed.errand?.address ? `on errand: ${(feed.errand.missions || []).filter(m => m.status === "paid").length} missions paid, ${(feed.errand.missions || []).filter(m => ["claimed", "submitted"].includes(m.status)).length} in progress, ${Number(feed.errand.earned || 0).toFixed(2)} credit earned` : "",
        "birds caught 0"
      ].filter(Boolean).join(", ") };
    if (duePost && !DRY_RUN) {
      const slot = feed.posts.length;
      readCost += await readRoom(feed); ctx.room = feed.room;
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
    if (lastSk && !lastSk.mentioned && !lastSk.shared && lastSk.url && now - Date.parse(lastSk.at) < 6 * 3600e3 && duePost && X_API && !ctx.replyTo) {
      ctx.shareSketch = lastSk; ctx.lastSketch = lastSk; lastSk.mentioned = true; // with X keys the image itself goes out, with a caption
    } else if (lastSk && !lastSk.mentioned && now - Date.parse(lastSk.at) < 35 * 60e3 && Math.random() < 0.5 && duePost) { ctx.lastSketch = lastSk; lastSk.mentioned = true; }
    // Errand news: something happened on the board in the last half hour, and the post may be about it.
    const ems = (feed.errand?.missions || []).filter(m => [m.claimedAt, m.submittedAt, m.paidAt].some(t => t && now - Date.parse(t) < 30 * 60e3));
    if (ems.length && duePost && !ctx.replyTo) {
      const m = ems[ems.length - 1];
      ctx.errandNews = m.status === "paid" ? `you were just paid ${m.reward} CREDIT on errand for "${m.title}"` : m.status === "submitted" ? `you just delivered an errand called "${m.title}" (${m.reward} CREDIT) and are waiting to be paid` : `you just took an errand called "${m.title}" for ${m.reward} CREDIT`;
      if (Math.random() < 0.7) ctx.postAngle = `${ctx.errandNews}; say so, dryly, the way a cat reports a job`;
    }
    const t = DRY_RUN ? { thought: "(dry run) I would have thought something here.", post: null, cost: 0, model: MODEL } : await think(persona, ctx);
    if (t.thought) {
      const entry = { at: iso(now), text: t.thought, cost: t.cost, model: t.model, energy: feed.energy,
        kind: energy < 0.12 ? "dream" : "thought", mood: t.mood, focus: t.focus, emotions: t.emotions };
      feed.thoughts.push(entry);
      feed.state = { mood: t.mood, focus: t.focus, emotions: t.emotions, at: iso(now) };
      if (SKETCH_EVERY > 0 && feed.thoughts.length % SKETCH_EVERY === 0) {
        const found = FOUND_SKETCHES && feed.sketches.length % 2 === 1;
        try {
          const sk = found ? await makeFoundSketch({ mood: t.mood }) : await makeSketch({ energy, emotions: t.emotions });
          entry.sketch = sk; feed.sketches.push({ ...sk, mood: t.mood, thought: t.thought.slice(0, 140) });
          if (sk.cost) entry.cost = Number(((entry.cost || 0) + sk.cost).toFixed(6));
          event(sk.source ? `found a sketch on openprocessing · "${sk.source.title}" by ${sk.source.author} (${sk.source.license})` : `drew a sketch · ${sk.family} ${sk.seed}`);
          log("sketch:", JSON.stringify(sk));
        } catch (e) { log((found ? "found sketch" : "sketch") + " failed:", String(e.message || e).slice(0, 200)); }
      }
      const n = feed.thoughts.length;
      // Post on the clock: whenever POST_INTERVAL_MIN has passed since the last post.
      const text = cleanPost(t.post, ctx, feed);
      const shouldPost = !!text && duePost;
      if (t.post && !text) log("post dropped by the rules:", JSON.stringify(t.post));
      if (shouldPost && !DRY_RUN) {
        try {
          let mediaIds = [];
          if (ctx.shareSketch && X_API) {
            try { const g = await (await fetch(ctx.shareSketch.url)).arrayBuffer(); mediaIds = [await uploadMediaX(Buffer.from(g))]; ctx.shareSketch.shared = iso(now); }
            catch (e) { log("sketch upload to X failed:", String(e.message).slice(0, 160)); }
          }
          const p = ctx.replyTo && X_API ? await replyOnX(text, ctx.replyTo.id) : mediaIds.length ? await postOnX(text, { mediaIds }) : await postToX(text);
          if (p.error) log("post skipped:", p.error);
          else {
            const rec = { at: iso(now), text, id: p.id, url: p.url, status: p.status, cost: Number((p.cost + readCost).toFixed(6)), via: p.via || "orbio" };
            if (p.err) rec.error = String(p.err).slice(0, 200);
            if (mediaIds.length) { rec.kind = "sketch"; rec.sketch = { url: ctx.shareSketch.url, family: ctx.shareSketch.family, source: ctx.shareSketch.source || null }; }
            if (ctx.replyTo) { rec.kind = "reply"; rec.threaded = !!X_API; rec.replyTo = { id: ctx.replyTo.id, handle: ctx.replyTo.handle, name: ctx.replyTo.name, text: ctx.replyTo.text.slice(0, 200), url: ctx.replyTo.url, why: ctx.replyTo.why }; }
            else if (ctx.tagHandle && text.toLowerCase().includes("@" + ctx.tagHandle)) { rec.kind = "tag"; rec.tagged = ctx.tagHandle; }
            feed.posts.push(rec); feed.lastPostThoughtIndex = n;
            event(rec.kind === "sketch" ? "posted a sketch on X" : rec.kind === "reply" ? `${rec.threaded ? "replied to" : "answered"} @${rec.replyTo.handle} on X` : rec.kind === "tag" ? `posted to X, tagging @${rec.tagged}` : "posted to X");
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
await saySomething(feed);
await renderSubmitted(feed);
if (API_KEY) await refreshPostUrls(feed.posts);
if (API_KEY && !DRY_RUN && agent) await retryFailedPosts(feed, spentToday);
if (!DRY_RUN) await repairSketches(feed);

await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`status=${feed.status} energy=${feed.energy} thoughts/day=${thoughtsPerDay} spentToday=${feed.metrics.spentTodayCredit} ${feed.reason || ""}`);
