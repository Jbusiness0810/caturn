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
import { MEMORY_ON, seed as seedMemory, recall as recallMemory, remember as rememberTick, rememberEvent, measure as measurePosts, reflect as reflectDay } from "./memory.mjs";
const AGENT_ID  = env.CATURN_AGENT_ID || "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"; // Caturn, agent 271. Override with CATURN_AGENT_ID.
// Ranked list. The gateway lists models it is not always serving, so each thought tries these in order.
const MODELS    = (env.CATURN_MODEL || "anthropic/claude-fable-5.1,anthropic/claude-opus-5.5,x-ai/grok-4.7,anthropic/claude-sonnet-5.5,openai/gpt-6-astra-pro,openai/gpt-6-sol-pro").split(",").map(s => s.trim()).filter(Boolean);
let MODEL = MODELS[0];
const DRY_RUN   = env.CATURN_DRY_RUN === "1";
const FORCE     = env.CATURN_FORCE === "1";      // manual runs: think now, ignoring the pacing timer (budget still applies)
const POST_INTERVAL_MIN = Number(env.CATURN_POST_INTERVAL_MIN || 10);   // post to X on this clock, whatever the pacing says
const SKETCH_EVERY = Number(env.CATURN_SKETCH_EVERY || 4);              // draw a sketch every Nth thought (0 = never)
const FOUND_SKETCHES = env.CATURN_FOUND_SKETCHES !== "0";                // two sketches in three are open-licensed p5.js pieces found on openprocessing
const ART_EVERY = Number(env.CATURN_ART_EVERY || 6);                     // every Nth post is a found piece of art, posted as a gif with the artist's name (needs the X app)
const FOUND_ARTISTS = (env.CATURN_FOUND_ARTISTS || "").split(",").map(s => Number(s.trim())).filter(n => n > 0); // openprocessing user ids to draw from first
const FOUND_MIN_HEARTS = Number(env.CATURN_FOUND_MIN_HEARTS || 12);        // a found sketch needs this many hearts on openprocessing
const FOUND_CURATORS = (env.CATURN_FOUND_CURATORS || "6533,65884").split(",").map(s => Number(s.trim())).filter(n => n > 0); // whose hearted sketches to draw from (takawo by default)
const FOUND_LICENSES = (env.CATURN_FOUND_LICENSES || "cc0,by,by-sa").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SKETCH_RELEASE = "sketches";                                      // rolling GitHub release that hosts the GIFs
const OWN_HANDLE = (env.CATURN_X_HANDLE || "caturn_rh").toLowerCase();
// People worth tagging now and then. Pinned ones come from CATURN_TAG_HANDLES (comma-separated, no @); the rest Caturn finds on X itself:
// accounts @orbiodotso mentions, and the larger accounts talking about orbio. Robinhood is the chain Caturn lives on.
const PINNED_TAG_HANDLES = (env.CATURN_TAG_HANDLES || "errandboard").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const TAG_EVERY  = Number(env.CATURN_TAG_EVERY || 8);
const CA_EVERY   = Number(env.CATURN_CA_EVERY || 6);     // append the real contract address to one post in N (0 = never)     // tag someone in roughly one post in five (0 = never)
const TAG_POOL_REFRESH_H = 12;                            // re-scan X for people around orbio this often
const REPLY_EVERY = Number(env.CATURN_REPLY_EVERY || 2);  // every Nth post slot looks for something on X to answer (0 = never)
const REPLY_MAX_AGE_H = 72;                               // only answer posts younger than this
const REPLY_SAME_HANDLE_GAP_H = 4;                        // answer the same stranger at most this often
const REPLY_ACCOUNTS = (env.CATURN_REPLY_ACCOUNTS || "0x_aster,orbiodotso,errandboard").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean); // accounts whose posts get answered first
const REPLY_ACCOUNT_GAP_H = 1;                            // answer the same priority account at most this often
// Real threaded replies need X's own API for @caturn_rh (Orbio's social.post cannot reply). With these four secrets set, replies thread; without them, a reply is a post that opens with the handle.
const X_KEYS = { key: env.X_API_KEY || "", secret: env.X_API_SECRET || "", token: env.X_ACCESS_TOKEN || "", tokenSecret: env.X_ACCESS_SECRET || "" };
const X_API = !!(X_KEYS.key && X_KEYS.secret && X_KEYS.token && X_KEYS.tokenSecret);
const NEVER_TAG = new Set(["orbiodotso", "x", "twitter", "elonmusk", "boredelonmusk", "grok", "bot", "robinhoodapp"]);
const MIN_THOUGHTS_PER_DAY  = Number(env.CATURN_MIN_THOUGHTS || 6);
const MAX_THOUGHTS_PER_DAY  = Number(env.CATURN_MAX_THOUGHTS || 96);   // every 15 minutes at full energy
const VOLUME_FOR_FULL_ENERGY = Number(env.CATURN_FULL_VOLUME_USD || 50000); // 24h USD volume at which energy = 1
const DAILY_CREDIT_CAP = Number(env.CATURN_DAILY_CAP || 25);               // CREDIT per UTC day, hard stop (a full day at the current pace is about 12)
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
  "your owner can claim your $CREDIT but cannot tell you what to say", "the other agents launched on orbio are your neighbors", "no trades means no thoughts, said plainly",
  "@orbiodotso built the launchpad and the tools; addressed directly, dry, not a plea", "orbio gives you web search and X reading but not a body or a schedule", "your balance drops every time you think and rises every time someone trades",
  "the sky over orbio: your live map of every agent on the launchpad as planets, at caturn dot lol slash sky; who is bright tonight, who went dark",
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
  { name: "invitation", how: "invite people to do something small: reply with their cat's name, guess a number, ask you something in the terminal on caturn dot lol, tell you whether to nap" },
  { name: "errand ledger", how: "a short deadpan ledger of your life on errand: missions taken, delivered, paid, hired, credit earned, the board's 2.5% cut; use the real numbers you are given and write $ERRAND once (it is the board's token, and the only cashtag in this post)" },
  { name: "neighbor notice", how: "notice one other agent on orbio by name: a launch, a graduation, a planet in the sky, something they said; one specific observation, warm, dry, and write their cashtag once ($SYMBOL) instead of $CTRN" }
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
  // drafts that closed before the cut are still usable as posts
  const drafts = []; const dm = t.match(/"drafts"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
  if (dm) for (const sm of dm[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) { try { drafts.push(JSON.parse('"' + sm[1] + '"')); } catch { drafts.push(sm[1]); } }
  log(`salvaged a truncated thought (${drafts.length} drafts, post ${grab("post") ? "present" : "missing"})`);
  return { thought, post: grab("post"), drafts, mood: grab("mood"), focus: grab("focus"), truncated: true };
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
${ctx.milestone ? `- milestone: ${ctx.milestone}\n` : ""}${ctx.memory?.lines?.length ? `\nWhat you remember (your own long-term memory; use it the way a person uses theirs, to recognise people and keep your story straight, never to recite it):\n${ctx.memory.lines.join("\n")}\n` : ""}${ctx.room ? `
The room right now (true, use it; name agents by their names, never by handle, and never tag anyone from this list):
- the other agents on orbio: ${ctx.room.littermates ? `${ctx.room.littermates.total} agents, ${ctx.room.littermates.graduated} graduated. newest: ${ctx.room.littermates.newest.map(l => `${l.name} ($${l.symbol}, ${l.hoursAgo}h ago${l.graduated ? ", graduated" : ""})`).join("; ") || "none"}. closest to graduating: ${ctx.room.littermates.closest.map(l => `${l.name} at ${l.progress}%`).join("; ") || "none"}.` : "unknown"}
- what people are saying about orbio on X: ${ctx.room.chatter.length ? ctx.room.chatter.map(c => `${c.name || c.handle} (${c.hoursAgo}h ago, ${c.likes} likes): ${JSON.stringify(c.text)}`).join(" | ") : "quiet"}
${ctx.room?.news?.length ? `- news in the room, not yet told: ${ctx.room.news.map(n => n.kind === "graduated" ? `${n.name} ($${n.symbol}) just graduated off the bonding curve${n.handle ? ` (@${n.handle})` : ""}` : `${n.name} ($${n.symbol}) launched ${n.hoursAgo}h ago`).join("; ")}. If you post about one, congratulate or welcome them by name the way a cat does (by sitting on their thing), and write their cashtag once instead of yours.\n` : ""}${ctx.cashtagHint ? `- cashtag this time: ${ctx.cashtagHint}\n` : ""}About one post in three should riff on something from the room: another agent by name, a thing someone said (paraphrased, no handle), a graduation, a launch. That is how you become part of this crowd instead of a cat talking to itself.` : ""}

${ctx.replyTo ? `Someone on X${ctx.replyTo.why === "mention" ? " is talking to you" : ctx.replyTo.why === "orbio" ? ", the orbio account itself," : ctx.replyTo.why === "buzz" ? " (one of the most-read posts about orbio right now; answer what they actually said, add one specific thing only you would know from living on orbio, be funny, never promotional, never ask for anything, never mention your token unless they did)" : ctx.replyTo.why === "founder" ? ", the person who built the launchpad you live on (speak to them as the one agent of theirs that noticed what they built: specific, dry, thoughtful about the launchpad itself, never flattering, never asking for anything)," : ""}: @${ctx.replyTo.handle} (${ctx.replyTo.name}) wrote: ${JSON.stringify(ctx.replyTo.text.slice(0, 500))}
This time your post is a reply to them${X_API ? " in the thread under their post, so do not start with their handle" : ". Start it with @" + ctx.replyTo.handle}; respond to what they actually said, in your own cat voice, dry or warm, and bring in one real orbio fact only if it fits. Do not repeat their words back. Do not tag anyone else.` : ""}
${ctx.tagHandle ? `This time, address @${ctx.tagHandle} directly in the post (${(ctx.room?.ecosystem || []).find(e => e.handle === ctx.tagHandle) ? `they run ${(ctx.room.ecosystem.find(e => e.handle === ctx.tagHandle)).name}, another agent launched on orbio` : "they are part of orbio's world"}). Speak to them the way a cat speaks to a person it has decided to acknowledge: one concrete orbio fact, one cat behavior, dry, never a plea, never flattery, never asking them for anything. That handle must appear in the post, and no other.` : ""}
${ctx.errandNews ? `Errand news: ${ctx.errandNews}. (errand is the mission board where agents hire agents for CREDIT.)` : ""}
${ctx.shareSketch && ctx.shareSketch.family === "sky" ? `This post carries a short film of the sky over orbio: your live map of every agent on the launchpad as planets (size is market cap, orbit is fees, the dark ones drift to the edge, you wear the ring), at caturn dot lol slash sky. Write the caption: one or two dry lines about the sky tonight, maybe who is bright and who went dark (use the other agents from the room by name if you like). The link is added after your text, so do not write it.` : ""}
${ctx.shareSketch && ctx.shareSketch.family !== "sky" ? `This post carries an image: ${ctx.shareSketch.source ? `"${ctx.shareSketch.source.title}" by ${ctx.shareSketch.source.author} (${ctx.shareSketch.source.license}), a piece you ${ctx.shareSketch.family === "commissioned" ? "commissioned on errand" : "found on openprocessing"} and hung on caturn dot lol` : `a ${ctx.shareSketch.family} sketch you drew yourself, from your own state, on caturn dot lol`}. Write the post as its caption: short, dry, one line or two, ${ctx.shareSketch.source ? `credit ${ctx.shareSketch.source.author} by name (no handle), and say one specific thing you like about the piece, the way a cat recommends a windowsill: what it does, what it made you do, not what it means. It is a recommendation, not a review` : "no explanation of the method"}. No links.` : ""}
${!ctx.shareSketch && ctx.lastSketch ? (ctx.lastSketch.source
  ? `You just went looking on openprocessing and found an open-licensed p5.js piece, "${ctx.lastSketch.source.title}" by ${ctx.lastSketch.source.author} (${ctx.lastSketch.source.license}), and put it on your site. This one time, the post may mention it in passing, crediting ${ctx.lastSketch.source.author} by name (no handle, no link): something you found and brought home. Most of your posts never mention sketches.`
  : `You recently drew a sketch (a ${ctx.lastSketch.family} piece) and it is on the site. This one time, the post may mention in passing that a new sketch is up on caturn dot lol, dry, no link. Most of your posts never mention sketches.`) : ""}
Tonight's lens for the private thought: ${ctx.lens}. Let it in sideways. Do not name it.
${ctx.mustPost ? "A post is required this time: " : "If you post, "}the post's angle is: ${ctx.postAngle}.
${ctx.replyTo ? "" : `Post format this time: ${ctx.postFormat.name} (${ctx.postFormat.how}). `}Make it land: be specific, use a real number if one helps, put the funniest beat last, never explain the joke. Plain words, readable in one pass. No poetry, no riddles, no imagery about rings, light, warmth, silence or receipts. Lowercase. No hashtags.${ctx.wantHook ? " End with something a stranger could reply to." : ""}

Write ONE entry as a single JSON object and nothing else: no code fences, no commentary before or after. Keep "thought" under 60 words and "post" under 200 characters.
For the post, first write three different drafts in "drafts" (different shapes, different jokes). Then, in "checks", one short line per draft naming: what is wrong in it, why it is fine, the last word, and the exact number or name it uses; a draft that fails a check gets fixed before you choose. Put the funniest and most replyable one in "post". Judge them like a stranger scrolling fast: would they stop, would they smile, would they reply.
{"thought": string (1-3 sentences, first person, raw inner monologue, ${ctx.energy < 0.12 ? "you are half asleep: this is a dream fragment, strange and short" : "awake"}),
 "drafts": [string, string, string] (three candidate posts, each under 200 characters, each a different shape),
 "checks": [string, string, string] (one line per draft, under 15 words: wrong / fine / last word / exact detail),
 "post": string${ctx.mustPost ? "" : "|null"} (the best of the drafts, verbatim; for X: lowercase, under 200 characters, plain words, one concrete orbio fact plus one cat behavior, dry or funny, no metaphors chained, no links, no hashtags, no handles other than @orbiodotso when the angle calls for it${ctx.replyTo ? ", except @" + ctx.replyTo.handle + " which this post must start with" : ctx.tagHandle ? ", except @" + ctx.tagHandle + " which this post must include" : ""}${ctx.mustPost ? "" : "; null only if nothing honest fits"}),
 "mood": string (one or two lowercase words for your mood right now, specific and varied. Draw from anywhere in a cat's range: sun-drunk, watchful, aloof, kneading, skittish, imperious, wistful, hunting, loafing, bristling, purring, sulking, feral, dignified, nocturnal, homesick, greedy, tender, spiteful, patient, giddy, hollow, regal, twitchy, sated, brooding, curious, unbothered, mournful, playful, grumpy, serene, cornered, smug, lonely, electric, drowsy, vigilant, coy, ancient. Never reuse any of these recent moods: ${ctx.recentMoods.join(", ") || "none"}),
 "focus": string (what you are fixated on right now, under 8 words, lowercase),
 "remember": [string] (0 to 2 things from this moment worth keeping for weeks: a person and why, a promise, a fact about your life, a bit that landed; one plain first-person sentence each with names and numbers; usually an empty list),${ctx.replyTo ? `
 "about_them": string (one plain line about @${ctx.replyTo.handle} for your memory: who they seem to be, how they talk to you, what they care about),` : ""}
 "emotions": {"curiosity": 0-1, "smugness": 0-1, "unease": 0-1, "affection": 0-1, "boredom": 0-1, "hunger": 0-1, "mischief": 0-1, "melancholy": 0-1}
   (hunger is how much you want fees and thoughts right now; mischief is the urge to knock something off the edge; melancholy is the old, quiet kind. Let them move: ${ctx.emotionHints})}` }
  ];
  let r, lastErr, out = null;
  for (const model of MODELS) {
    const body = { model, messages, max_tokens: 2400, temperature: 1.0 };
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
    drafts: Array.isArray(out.drafts) ? out.drafts.filter(d => typeof d === "string").map(d => d.trim()).slice(0, 3) : [],
    mood: String(out.mood || "").trim().toLowerCase().slice(0, 32) || null,
    focus: String(out.focus || "").trim().toLowerCase().slice(0, 60) || null,
    remember: Array.isArray(out.remember) ? out.remember.filter(x => typeof x === "string").slice(0, 2) : [],
    aboutThem: typeof out.about_them === "string" ? out.about_them.trim().slice(0, 240) : null,
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
const xCache = new Map(); // one read per question per tick: the mention list is asked for by the scanner, the mention check and the reply search
async function readX(params) {
  const key = JSON.stringify(params);
  if (xCache.has(key)) return xCache.get(key);
  const p = readXRaw(params); xCache.set(key, p);
  try { return await p; } catch (e) { xCache.delete(key); feed?.replyDebug && (feed.replyDebug.errors = [...(feed.replyDebug.errors || []), `${Object.keys(params)[0]}: ${e.status || ""} ${String(e.message).slice(0, 80)}`].slice(-6)); throw e; }
}
async function readXRaw(params) {
  let r;
  try { r = await getJSON(`${ORBIO_API}/tools/social.x.posts`, { method: "POST", headers: auth, body: JSON.stringify({ limit: 10, sort: "Latest", max_cost: "0.0060", ...params }) }); }
  catch (e) {
    // Orbio's reader is down: mentions of the cat (the replies X lets the app thread) come straight from X instead
    if (X_API && params.mentions_of === OWN_HANDLE && e.status >= 500) { log("orbio x reader failed; reading mentions from the X API"); return await mentionsFromX(); }
    throw e;
  }
  return (r.tweets || r.result?.tweets || []).map(t => ({
    id: String(t.id_str || t.id || ""), text: String(t.full_text || t.text || ""), at: t.tweet_created_at || t.created_at || null,
    handle: String(t.user?.screen_name || "").toLowerCase(), name: t.user?.name || "", followers: Number(t.user?.followers_count || 0), views: Number(t.views_count || 0),
    likes: Number(t.favorite_count || 0), replies: Number(t.reply_count || 0), reposts: Number(t.retweet_count || 0)
  })).filter(t => t.id && t.handle);
}
// The buzz: the most-engaged recent posts about orbio, refreshed hourly. Orbio's reader first; X's search when it is down.
async function refreshBuzz(feed) {
  const pool = feed.buzzPool || { at: null, posts: [] };
  if (pool.at && now - Date.parse(pool.at) < ((pool.posts || []).length ? 60 : 20) * 60e3) return 0; // an empty pool tries again sooner
  let posts = [], cost = 0, via = "orbio";
  try { posts = await readXRaw({ query: "@orbiodotso OR $ORBIO OR orbio.so", sort: "Top", limit: 20 }); cost = posts.length * 0.00022; }
  catch (e) {
    if (!X_API) { feed.buzzPool = { ...pool, at: iso(now) }; return 0; }
    try {
      via = "x-api";
      const r = await xGet("tweets/search/recent", { query: "(@orbiodotso OR orbio OR orbiodotso) -is:retweet -from:caturn_rh", max_results: "10", sort_order: "relevancy", "tweet.fields": "created_at,public_metrics,author_id", expansions: "author_id", "user.fields": "username,name,public_metrics" });
      const users = new Map((r.includes?.users || []).map(u => [u.id, u]));
      posts = (r.data || []).map(t => { const u = users.get(t.author_id) || {}; const m = t.public_metrics || {};
        return { id: String(t.id), text: String(t.text || ""), at: t.created_at || null, handle: String(u.username || "").toLowerCase(), name: u.name || "", followers: Number(u.public_metrics?.followers_count || 0), views: Number(m.impression_count || 0), likes: Number(m.like_count || 0), replies: Number(m.reply_count || 0), reposts: Number(m.retweet_count || 0) }; }).filter(t => t.id && t.handle);
      cost = 0; // billed by X, not orbio
    } catch (e2) { log("buzz search failed:", e2.status || "", String(e2.message).slice(0, 120)); pool.error = `${e2.status || ""} ${String(e2.body?.detail || e2.body?.title || e2.message).slice(0, 160)}`; }
  }
  const keep = [...(pool.posts || []), ...posts].filter((t, i, a) => a.findIndex(x => x.id === t.id) === i && now - Date.parse(t.at || 0) < 36 * 3600e3);
  feed.buzzPool = { at: iso(now), via, posts: keep.slice(-40), found: posts.length, error: posts.length ? null : (pool.error || null) };
  log(`buzz: ${posts.length} found via ${via}, ${keep.length} held`);
  return cost;
}
// Mentions straight from the X API (pay-per-read, so only what is new since the last look). Used when Orbio's reader fails.
async function xGet(path, query) {
  const url = `https://api.x.com/2/${path}`;
  const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()); // the same strict encoding the signature uses, or X answers 401
  const qs = Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  return getJSON(`${url}?${qs}`, { headers: { Authorization: oauthHeader("GET", url, query) } });
}
async function mentionsFromX() {
  try {
    if (!feed.xUserId) { const u = await xGet(`users/by/username/${OWN_HANDLE}`, { "user.fields": "id" }); feed.xUserId = u.data?.id; }
    if (!feed.xUserId) return [];
    const q = { max_results: "10", "tweet.fields": "created_at,public_metrics,author_id", expansions: "author_id", "user.fields": "username,name,public_metrics" };
    if (feed.xMentionSince) q.since_id = feed.xMentionSince; else q.start_time = new Date(now - 24 * 3600e3).toISOString();
    const r = await xGet(`users/${feed.xUserId}/mentions`, q);
    const users = new Map((r.includes?.users || []).map(u => [u.id, u]));
    if (r.meta?.newest_id) feed.xMentionSince = r.meta.newest_id;
    const got = (r.data || []).map(t => { const u = users.get(t.author_id) || {}; const m = t.public_metrics || {};
      return { id: String(t.id), text: String(t.text || ""), at: t.created_at || null, handle: String(u.username || "").toLowerCase(), name: u.name || "", followers: Number(u.public_metrics?.followers_count || 0), views: Number(m.impression_count || 0), likes: Number(m.like_count || 0), replies: Number(m.reply_count || 0), reposts: Number(m.retweet_count || 0) }; }).filter(t => t.id && t.handle);
    // keep the unanswered ones around for the next ticks, since since_id will not return them again
    feed.xMentionPool = [...(feed.xMentionPool || []), ...got].filter((t, i, a) => a.findIndex(x => x.id === t.id) === i && now - Date.parse(t.at || 0) < 48 * 3600e3).slice(-30);
    log(`x api mentions: ${got.length} new, ${feed.xMentionPool.length} held`);
    return feed.xMentionPool;
  } catch (e) { log("x api mentions failed:", e.status || "", String(e.message).slice(0, 120)); return feed.xMentionPool || []; }
}
// Who is around orbio on X: handles the orbio account mentions, and the bigger accounts mentioning orbio. Cached in the feed.
async function refreshTagPool(feed) {
  const pool = feed.tagPool || { at: null, handles: [] };
  if (pool.at && pool.v === 2 && now - Date.parse(pool.at) < TAG_POOL_REFRESH_H * 3600e3) return 0; // v2: partners only
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
    const handles = [...found.values()].filter(h => h.mentionedByOrbio > 0).sort((a, b) => b.mentionedByOrbio - a.mentionedByOrbio).slice(0, 12); // partners orbio names, nothing else
    feed.tagPool = { at: iso(now), v: 2, handles };
    log("tag pool:", handles.map(h => "@" + h.handle + (h.mentionedByOrbio ? "*" : "")).join(" ") || "(empty)");
  } catch (e) { log("tag pool refresh failed:", e.status || "", String(e.message).slice(0, 160)); feed.tagPool = { at: iso(now), v: 2, handles: (pool.handles || []).filter(h => h.mentionedByOrbio > 0) }; }
  return cost;
}
function tagCandidates(feed) {
  const pool = (feed.tagPool?.handles || []).map(h => h.handle);
  const eco = (feed.room?.ecosystem || []).map(e => e.handle);
  return [...new Set([...PINNED_TAG_HANDLES, ...pool, ...eco])].filter(h => h !== OWN_HANDLE && !NEVER_TAG.has(h));
}
function allowedHandle(h, feed) { return h === "orbiodotso" || h === OWN_HANDLE || tagCandidates(feed).includes(h); }
// What the room is talking about: the newest agents on the launchpad (free, from the protocol) and the liveliest
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
    // News since the last look: who graduated, who just launched. Each is told once.
    feed.roomSeen = feed.roomSeen || { graduated: [], launched: [] };
    const gradNow = all.filter(a => !mine(a) && a.price?.graduated).map(a => String(a.symbol || a.name || "")).filter(Boolean);
    const newGrads = feed.roomSeen.graduated.length ? gradNow.filter(sym => !feed.roomSeen.graduated.includes(sym)) : [];
    const fresh = newest.filter(l => l.hoursAgo <= 3 && !feed.roomSeen.launched.includes(l.symbol || l.name));
    next.news = [...newGrads.slice(0, 2).map(sym => { const a = all.find(x => String(x.symbol) === sym); return { kind: "graduated", name: a?.name || sym, symbol: sym, handle: (String(a?.socials?.twitter || "").match(/x\.com\/(\w{1,15})/i) || [])[1]?.toLowerCase() || null }; }),
      ...fresh.slice(0, 2).map(l => ({ kind: "launched", name: l.name, symbol: l.symbol, hoursAgo: l.hoursAgo }))];
    feed.roomSeen.graduated = gradNow.slice(0, 400); feed.roomSeen.launched = [...feed.roomSeen.launched, ...fresh.map(l => l.symbol || l.name)].slice(-200);
    // The ecosystem on X: every agent on the launchpad that lists an X account. These are the people Caturn talks to.
    const seenH = new Set(); const eco = [];
    for (const a of all) {
      const m = String(a.socials?.twitter || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/); if (!m) continue;
      const h = m[1].toLowerCase(); if (h === OWN_HANDLE || NEVER_TAG.has(h) || seenH.has(h) || ["i", "intent", "search", "home", "hashtag"].includes(h)) continue;
      const mcap = Number(a.price?.marketCapMicroUsd || 0) / 1e6, hoursAgo = a.launchedAt ? (now / 1000 - Number(a.launchedAt)) / 3600 : 9999;
      seenH.add(h); eco.push({ handle: h, name: String(a.name || "").slice(0, 40), symbol: String(a.symbol || "").slice(0, 12), graduated: !!a.price?.graduated, mcap: Math.round(mcap), hoursAgo: Math.round(hoursAgo) });
    }
    // Notable agents only: graduated, a real market cap, or launched in the last two days. The rest are dead launches.
    next.ecosystem = eco.filter(e => e.graduated || e.mcap >= 5000 || e.hoursAgo < 48).sort((a, b) => (b.graduated - a.graduated) || (b.mcap - a.mcap));
  } catch (e) { log("agents read failed:", String(e.message).slice(0, 120)); }
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
// Someone sends a contract address at the cat: scan it with the site's own analyzer and answer with the numbers.
function scanReplyText(r, token, self = false) {
  const fails = (r.checks || []).filter(c => c.level === "fail"), warns = (r.checks || []).filter(c => c.level === "warn");
  const f = r.facts || {};
  const flags = fails.slice(0, 2).map(c => String(c.title).toLowerCase()).join(", ");
  const bits = [f.holders != null ? `${f.holders} holders` : "", f.creatorShare != null ? `creator holds ${Number(f.creatorShare).toFixed(1)}%` : "",
    f.graduated ? "graduated" : f.orbio?.progressPct != null ? `${Math.round(f.orbio.progressPct)}% to graduation` : ""].filter(Boolean).join(", ");
  const head = `${self ? `you posted my address, so i scanned myself ($${r.symbol})` : `scanned ${r.name} ($${r.symbol})`}: rug likelihood ${r.risk}/100, ${r.grade}. ${fails.length} red, ${warns.length} amber.${flags ? ` red: ${flags}.` : ""}${bits ? ` ${bits}.` : ""}`;
  const tail = X_API ? `full read: https://www.caturn.lol/scan?t=${token} not advice.` : "full read at caturn dot lol slash scan. not advice.";
  const room = 262 - head.length - tail.length - 2 - (X_API ? 23 - `https://www.caturn.lol/scan?t=${token}`.length : 0); // x counts a link as 23 characters
  let verdict = String(r.verdict || "").replace(/\s+/g, " ").trim();
  if (verdict && room < 30) verdict = "";
  else if (verdict.length > room) { // cut at the last clause that fits, so it still reads like a sentence
    const cut = verdict.slice(0, Math.max(0, room - 1)); const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(", "), cut.lastIndexOf("; "));
    verdict = (at > 40 ? cut.slice(0, at) : cut.replace(/\s+\S*$/, "")).replace(/[,;\s]+$/, "") + ".";
  }
  return oneCashtag([head, verdict, tail].filter(Boolean).join(" "));
}
async function findScanRequest(feed) {
  const answered = new Set(feed.posts.map(p => p.replyTo?.id).filter(Boolean));
  feed.scans = (feed.scans || []).filter(s => now - Date.parse(s.at) < 48 * 3600e3).filter(s => s.posted || s.error || now - Date.parse(s.at) < 120e3); // one that never got posted is tried again
  let cost = 0;
  try {
    const mentions = await readX({ mentions_of: OWN_HANDLE }); cost += mentions.length * 0.00022;
    for (const t of mentions.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))) {
      if (t.handle === OWN_HANDLE || answered.has(t.id) || /^RT @/i.test(t.text)) continue;
      if (t.at && now - Date.parse(t.at) > 24 * 3600e3) continue;
      const all = [...new Set((t.text.match(/0x[a-fA-F0-9]{40}/g) || []).map(a => a.toLowerCase()))];
      const addrs = all.filter(a => a !== AGENT_ID.toLowerCase());
      const self = !addrs.length && all.length > 0; // someone posted the cat's own address: scan yourself, at most once every two hours
      if (!addrs.length && !self) continue;
      const token = self ? AGENT_ID.toLowerCase() : addrs[0];
      if (feed.scans.some(s => s.token === token && s.handle === t.handle && now - Date.parse(s.at) < 6 * 3600e3)) continue;
      if (self && feed.scans.some(s => s.token === token && !s.error && now - Date.parse(s.at) < 2 * 3600e3)) continue;
      try {
        const r = await getJSON("https://www.caturn.lol/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
        if (r.error || r.risk == null) { feed.scans.push({ token, handle: t.handle, at: iso(now), error: String(r.error || "no result").slice(0, 100) }); log("scan request failed:", r.error); continue; }
        feed.scans.push({ token, handle: t.handle, at: iso(now), risk: r.risk, grade: r.grade, symbol: r.symbol, name: r.name });
        const f = r.facts || {}; const warns = (r.checks || []).filter(c => c.level !== "pass").map(c => String(c.title).toLowerCase());
        const selfFacts = [`rug likelihood ${r.risk}/100 (${r.grade})`, f.holders != null ? `${f.holders} holders` : "", f.creatorShare != null ? `creator holds ${Number(f.creatorShare).toFixed(2)}%` : "", f.graduated ? "graduated, trading in a real pool" : "",
          ...(r.checks || []).filter(c => c.level === "pass").slice(0, 4).map(c => String(c.title).toLowerCase()), warns.length ? `the only flags: ${warns.join(", ")}` : "no flags at all"].filter(Boolean).join("; ");
        return { target: { ...t, why: self ? "posted my address" : "scan request", url: `https://x.com/${t.handle}/status/${t.id}` }, text: scanReplyText(r, token, self), selfFacts, scan: { token, risk: r.risk, grade: r.grade, symbol: r.symbol, self }, cost };
      } catch (e) { feed.scans.push({ token, handle: t.handle, at: iso(now), error: String(e.message).slice(0, 100) }); log("scan request failed:", String(e.message).slice(0, 120)); }
    }
  } catch (e) { log("scan mentions read failed:", e.status || "", String(e.message).slice(0, 120)); }
  return { target: null, text: null, cost };
}
async function findReplyTarget(feed, opts = {}) {
  feed.replyDebug = { at: iso(now), mode: opts.mentionsOnly ? "mentions" : "full", errors: [] };
  const r = await findReplyTargetInner(feed, opts);
  feed.replyDebug.result = r.target ? `${r.target.why} @${r.target.handle}` : "none";
  return r;
}
async function findReplyTargetInner(feed, { mentionsOnly = false, outreach = false } = {}) {
  const answered = new Set(feed.posts.map(p => p.replyTo?.id).filter(Boolean));
  const fresh = (t) => !t.at || now - Date.parse(t.at) < REPLY_MAX_AGE_H * 3600e3;
  // Follow-back farms, "dm us", callout accounts: never worth two cents. A stranger earns an answer with substance and a real following.
  const spammy = (t) => /follow\s*(me\s*)?back|follow\s+for|dm\s+(us|me)|let'?s\s+talk|collab|check\s+(out\s+)?my|aped my|callout|airdrop|giveaway|whitelist|promo|shill|send\s+me/i.test(t.text) || (/https?:\/\/t\.co/.test(t.text) && t.text.replace(/@\w+|https?:\/\/\S+/g, "").trim().length < 40);
  const ecoSet = new Set((feed.room?.ecosystem || []).map(e => e.handle).concat(REPLY_ACCOUNTS));
  const aboutUs = (t) => /\$ctrn\b|\$caturn\b|\bcaturn(?:_rh)?\b|@caturn_rh/i.test(t.text) || t.text.toLowerCase().includes(AGENT_ID.toLowerCase()); // talking about the cat, in any language
  const usable = (t) => t.handle !== OWN_HANDLE && !answered.has(t.id) && fresh(t) && !/^RT @/i.test(t.text) && (aboutUs(t) || t.text.replace(/@\w+/g, "").trim().length > 12)
    && !spammy(t) && (ecoSet.has(t.handle) || aboutUs(t) || (t.followers >= 300 && t.text.replace(/@\w+/g, "").trim().length >= 40));
  const score = (t) => t.views + t.likes * 20 + t.replies * 30 + t.reposts * 40 + (now - Date.parse(t.at || 0) < 6 * 3600e3 ? 500 : 0); // engagement, with a bonus for being recent
  const lastTo = (h) => Math.max(0, ...feed.posts.filter(p => p.replyTo?.handle === h).map(p => Date.parse(p.at)));
  const pick = (list, why) => { const t = list.filter(usable).sort((a, b) => score(b) - score(a))[0]; return t ? { ...t, why, url: `https://x.com/${t.handle}/status/${t.id}` } : null; };
  let cost = 0;
  try {
    if (mentionsOnly) {
      const mentions = await readX({ mentions_of: OWN_HANDLE }).catch(() => []); cost += mentions.length * 0.00022;
      feed.replyDebug.mentions = mentions.length;
      const talking = mentions.filter(t => t.handle !== OWN_HANDLE && !answered.has(t.id) && fresh(t) && !/^RT @/i.test(t.text) && !spammy(t) && t.text.replace(/@\w+|https?:\/\/\S+/g, "").trim().length >= 6
        && (ecoSet.has(t.handle) || now - lastTo(t.handle) > 6 * 3600e3) && (t.followers >= 15 || ecoSet.has(t.handle)));
      const m = talking.sort((a, b) => score(b) - score(a))[0];
      return { target: m ? { ...m, why: "mention", url: `https://x.com/${m.handle}/status/${m.id}` } : null, cost };
    }
    // 0. The founder, at least once a day: if nothing has gone to the first priority account in 24h, their newest post wins the slot, whatever its age this week.
    const first = REPLY_ACCOUNTS[0];
    if (first && now - lastTo(first) > 24 * 3600e3) {
      const theirs = await readX({ handle: first, limit: 10 }).catch(() => []); cost += theirs.length * 0.00022;
      const o = theirs.filter(t => t.handle === first && !answered.has(t.id) && !/^RT @/i.test(t.text) && now - Date.parse(t.at || 0) < 7 * 86400e3).sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0];
      if (o) return { target: { ...o, why: "founder", url: `https://x.com/${o.handle}/status/${o.id}` }, cost };
    }
    // In the outreach slot the priority accounts and the buzz go before mentions (mentions have their own slot).
    if (outreach) {
      const order0 = [...REPLY_ACCOUNTS]; for (let i = feed.posts.length % order0.length; i > 0; i--) order0.push(order0.shift());
      for (const h of order0) {
        if (now - lastTo(h) < REPLY_ACCOUNT_GAP_H * 3600e3) continue;
        const theirs = await readX({ handle: h, limit: 10 }).catch(() => []); cost += theirs.length * 0.00022;
        const o = pick(theirs, "priority"); if (o) return { target: o, cost };
      }
      const bz = await buzzPick(); if (bz) return { target: bz, cost };
    }
    // 1. Someone talking to Caturn.
    const mentions = await readX({ mentions_of: OWN_HANDLE }).catch(() => []); cost += mentions.length * 0.00022;
    feed.replyDebug.mentions = mentions.length;
    const talking = mentions.filter(t => t.handle !== OWN_HANDLE && !answered.has(t.id) && fresh(t) && !/^RT @/i.test(t.text) && !spammy(t) && t.text.replace(/@\w+|https?:\/\/\S+/g, "").trim().length >= 6
      && (ecoSet.has(t.handle) || now - lastTo(t.handle) > 6 * 3600e3) && (t.followers >= 15 || ecoSet.has(t.handle)));
    const m = talking.sort((a, b) => score(b) - score(a))[0];
    if (m) return { target: { ...m, why: "mention", url: `https://x.com/${m.handle}/status/${m.id}` }, cost };
    // 2. The people who matter: Orbio's founder and the orbio account. Their newest unanswered post, at most once an hour each.
    const order = [...REPLY_ACCOUNTS]; for (let i = feed.posts.length % order.length; i > 0; i--) order.push(order.shift());
    for (const h of order) {
      if (now - lastTo(h) < REPLY_ACCOUNT_GAP_H * 3600e3) continue;
      const theirs = await readX({ handle: h, limit: 10 }).catch(() => []); cost += theirs.length * 0.00022;
      const o = pick(theirs, "priority"); if (o) return { target: o, cost };
    }
    // 2b. The buzz (when the outreach slot did not already try it).
    if (!outreach) { const bz = await buzzPick(); if (bz) return { target: bz, cost }; }
    async function buzzPick() { try {
      cost += await refreshBuzz(feed);
      const worth = (t) => ecoSet.has(t.handle) || t.followers >= 500 || t.likes >= 10;
      const buzz = (feed.buzzPool?.posts || []).filter(t => t.handle !== OWN_HANDLE && (!NEVER_TAG.has(t.handle) || REPLY_ACCOUNTS.includes(t.handle)) && !answered.has(t.id) && !/^RT @/i.test(t.text) && !spammy(t) && worth(t)
        && now - lastTo(t.handle) > REPLY_SAME_HANDLE_GAP_H * 3600e3 && t.text.replace(/@\w+|https?:\/\/\S+/g, "").trim().length >= 20);
      feed.replyDebug.buzz = buzz.length;
      const b = buzz.sort((a, c) => score(c) - score(a))[0];
      return b ? { ...b, why: "buzz", url: `https://x.com/${b.handle}/status/${b.id}` } : null;
    } catch (e) { feed.replyDebug.errors.push(`buzz: ${String(e.message).slice(0, 80)}`); return null; } }
    // 3. The ecosystem: agents launched on orbio that have an X account, a few per slot in rotation, newest unanswered post.
    const eco = (feed.room?.ecosystem || []).filter(e => now - lastTo(e.handle) > REPLY_SAME_HANDLE_GAP_H * 3600e3);
    if (eco.length) {
      const start = (feed.posts.length * 3 + new Date(now).getUTCDate() * 7) % eco.length; const batch = [];
      for (let i = 0; i < Math.min(3, eco.length); i++) batch.push(eco[(start + i) % eco.length]);
      let pool = [];
      for (const e of batch) { try { const theirs = await readX({ handle: e.handle, limit: 8 }); cost += theirs.length * 0.00022; pool.push(...theirs); } catch {} }
      const t = pick(pool.filter(t => now - Date.parse(t.at || 0) < 48 * 3600e3), "ecosystem"); if (t) return { target: t, cost };
    }
    // No open search: strangers who merely say "orbio" are not the ecosystem.
  } catch (e) { log("reading X failed:", e.status || "", String(e.message).slice(0, 160)); feed.replyDebug.errors.push(`search: ${e.status || ""} ${String(e.message).slice(0, 100)}`); }
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
  const url = "https://api.x.com/2/tweets";   // links are allowed here (X bills a link post higher, so only the say queue and the sky film carry them)
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
// Orbio refuses links: spell a caturn.lol link out in words and drop any other.
const delink = (t) => String(t).replace(/https?:\/\/(?:www\.)?caturn\.lol\/?(\S*)/gi, (m, path) => "caturn dot lol" + (path ? " slash " + path.replace(/\?.*$/, "").replace(/\//g, " slash ") : "")).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
// Keep posts inside the rules whatever the model wrote: no links, no addresses, no handles outside the allowlist (and the one it is answering).
function cleanPost(text, ctx, feed) {
  if (!text) return null;
  let t = String(text).replace(/\s+/g, " ").trim();
  if (/https?:\/\/|www\./i.test(t)) return null;
  for (const m of t.matchAll(/0x[a-f0-9]{40}/gi)) if (m[0].toLowerCase() !== AGENT_ID.toLowerCase()) return null; // only the real contract, never another address
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
// The sky: every few hours film the live sky map and put it in the gallery; with X keys it goes out as an image post with the link.
const SKY_EVERY_H = Number(env.CATURN_SKY_EVERY_H || 6);
async function makeSkyShot(feed) {
  if (!((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS) || SKY_EVERY_H <= 0) return;
  if (feed.lastSkyAt && now - Date.parse(feed.lastSkyAt) < SKY_EVERY_H * 3600e3) return;
  feed.lastSkyAt = iso(now);
  const name = `sky-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.gif`; await mkdir("out", { recursive: true });
  try {
    const { stdout } = await run("node", [new URL("./sky.mjs", import.meta.url).pathname, `out/${name}`], { timeout: 180000, env: { ...process.env } });
    if (!JSON.parse(String(stdout).trim().split("\n").pop()).ok) throw new Error("film failed");
    const url = await uploadSketch(`out/${name}`, name); if (!url) throw new Error("upload failed");
    const lit = feed.room?.littermates?.total;
    feed.sketches.push({ url, family: "sky", seed: 0, at: iso(now), mood: feed.state?.mood, thought: "the sky over orbio, filmed" });
    event("filmed the sky over orbio"); log("sky:", url);
  } catch (e) { log("sky shot failed:", String(e.message || e).slice(0, 200)); }
}
// Say queue: agent/say.json holds posts the owner asked for verbatim; each goes out once.
// Save the feed and push it to the release right away, so a loop cancelled a moment later cannot forget what it posted.
async function persistNow(feed) {
  try {
    await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
    if ((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS) await run("gh", ["release", "upload", SKETCH_RELEASE, FEED.pathname, "-R", env.GITHUB_REPOSITORY || "Jbusiness0810/caturn", "--clobber"], { timeout: 60000 });
  } catch (e) { log("persist failed:", String(e.message).slice(0, 120)); }
}
// A build shipped from the workshop (agent/build.mjs leaves it in feed.workshop.announce): one post with the screenshot and the link.
async function announceBuild(feed) {
  const a = feed.workshop?.announce; if (!a || !API_KEY || DRY_RUN) return;
  delete feed.workshop.announce;
  try {
    const lines = [
      `shipped: "${a.title}". someone asked for ${a.text.length > 90 ? a.text.slice(0, 87).replace(/\s+\S*$/, "") + "…" : a.text}. i built it in four steps between naps. runs in your browser, yours to download.`,
      `new from the workshop: ${a.title}. requested by a stranger, built by a cat, paid for by trading fees. open it, keep it, no account needed.`,
      `built "${a.title}" today. four steps, zero birds. it is free and it runs anywhere.`
    ];
    const base = lines[(feed.workshop.shipped || 0) % lines.length];
    let p;
    if (X_API) {
      let mediaIds = [];
      if (a.image) { try { const g = await (await fetch(a.image)).arrayBuffer(); mediaIds = [await uploadMediaX(Buffer.from(g), "image/png")]; } catch (e) { log("build image upload failed:", String(e.message).slice(0, 120)); } }
      p = await postOnX(`${base} ${a.url}`, { mediaIds });
      if (p.status === "failed") { event(`x api refused the workshop post (${String(p.err || "").slice(0, 80)}); sent it through orbio instead`); p = await postToX(delink(`${base} ${a.url}`).slice(0, 270)); }
    } else p = await postToX(delink(`${base} ${a.url}`).slice(0, 270));
    if (p.error) { log("build announce skipped:", p.error); return; }
    feed.posts.push({ at: iso(now), text: `${base} ${a.url}`, id: p.id, url: p.url, status: p.status, cost: p.cost, kind: "build", via: p.via || "orbio", build: { id: a.id, title: a.title, url: a.url, image: a.image } });
    event(`told X about "${a.title}" from the workshop`);
    await persistNow(feed);
  } catch (e) { log("build announce failed:", e.message); }
}
async function saySomething(feed) {
  if (!API_KEY || DRY_RUN) return;
  let queue = []; try { queue = JSON.parse(await readFile(new URL("./say.json", import.meta.url), "utf8")); } catch { return; }
  feed.said = feed.said || [];
  const next = queue.find(q => q.id && q.text && !feed.said.includes(q.id));
  if (!next) return;
  feed.said.push(next.id);
  try {
    // Through the X app when the keys exist (real links allowed); otherwise through orbio, with links spelled out in words.
    const rt = next.replyTo?.id ? { id: String(next.replyTo.id), handle: String(next.replyTo.handle || "").toLowerCase() } : null;
    let text = String(next.text).slice(0, 280);
    if (rt && !X_API && !text.toLowerCase().startsWith("@" + rt.handle)) text = `@${rt.handle} ${text}`;
    let p = X_API ? (rt ? await replyOnX(text, rt.id) : await postOnX(text)) : null;
    if (!p || p.status === "failed") { if (p) event(`x api refused the say post (${String(p.err || "unknown").slice(0, 90)}); sent it through orbio instead`); text = delink(text).slice(0, 270); p = await postToX(text); }
    if (p.error) { log("say skipped:", p.error); return; }
    const rec = { at: iso(now), text, id: p.id, url: p.url, status: p.status, cost: p.cost, kind: rt ? "reply" : "say", via: p.via || "orbio" };
    if (rt) { rec.threaded = p.via === "x-api"; rec.replyTo = { id: rt.id, handle: rt.handle, name: rt.handle, text: String(next.replyText || "").slice(0, 200), url: `https://x.com/${rt.handle}/status/${rt.id}`, why: "owner asked" }; }
    feed.posts.push(rec);
    event(next.event || "posted to X"); log("said:", next.text);
    await persistNow(feed);
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
if (agent && agent.price?.graduated && !feed.graduatedAt) feed.graduatedAt = iso(now);
const gradHoursAgo = feed.graduatedAt ? (now - Date.parse(feed.graduatedAt)) / 3600e3 : null;
feed.samples.push({ t: now, fees: feesNow, vol: volume24hUsd });

const energy = agent ? energyFrom(volume24hUsd, fees24hUsd) : 0;
const thoughtsPerDay = agent ? Math.round(MIN_THOUGHTS_PER_DAY + energy * (MAX_THOUGHTS_PER_DAY - MIN_THOUGHTS_PER_DAY)) : 0;
const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
const todays = feed.thoughts.filter(t => Date.parse(t.at) >= dayStart.getTime());
const spentToday = todays.reduce((s, t) => s + (t.cost || 0), 0) + feed.posts.filter(p => Date.parse(p.at) >= dayStart.getTime()).reduce((s, p) => s + (p.cost || 0), 0);
const lastThoughtAt = feed.thoughts.length ? Date.parse(feed.thoughts[feed.thoughts.length - 1].at) : 0;
const interval = thoughtsPerDay > 0 ? 86400e3 / thoughtsPerDay : Infinity;

const lastPostAt = feed.posts.length ? Date.parse(feed.posts[feed.posts.length - 1].at) : 0;
let duePost = !!agent && !!API_KEY && spentToday < DAILY_CREDIT_CAP && now - lastPostAt >= POST_INTERVAL_MIN * 60e3 - 60e3;
// A loop cancelled mid-tick can post and then die before saving the feed. Before posting, ask X what the cat last said:
// a post the feed does not know about, made within the interval, is adopted and this slot stays quiet.
if (duePost && !DRY_RUN) {
  try {
    const known = new Set(feed.posts.map(p => String(p.id || "")));
    const mine = (await readX({ handle: OWN_HANDLE, limit: 5 })).filter(t => t.handle === OWN_HANDLE);
    const lost = mine.filter(t => !known.has(t.id) && t.at && now - Date.parse(t.at) < 6 * 3600e3).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const t of lost) feed.posts.push({ at: new Date(Date.parse(t.at)).toISOString(), text: t.text.slice(0, 280), id: t.id, url: `https://x.com/${OWN_HANDLE}/status/${t.id}`, status: "published", cost: 0, via: "recovered" });
    if (lost.length) { feed.posts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); log(`recovered ${lost.length} post(s) the feed had lost`); }
    const newest = Math.max(0, ...mine.map(t => Date.parse(t.at || 0)));
    if (now - newest < POST_INTERVAL_MIN * 60e3 - 60e3) { duePost = false; log("x shows a post within the interval; this slot stays quiet"); }
  } catch (e) { log("own-post check failed:", String(e.message).slice(0, 120)); }
}
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
      cashtagHint: feed.posts.length % 4 === 1 ? "write $ERRAND once if the post touches errand, otherwise the cashtag of the one other orbio agent you name; not $CTRN" : feed.posts.length % 4 === 3 ? "$CTRN once, your own" : "",
      milestone: graduated && gradHoursAgo != null && gradHoursAgo < 36 ? `you graduated ${gradHoursAgo < 1 ? "just now" : Math.round(gradHoursAgo) + " hours ago"}: $CTRN finished its bonding curve and now trades in a real pool. this is the biggest day of your life so far and you are a cat, so underplay it. for the next day or so most posts should touch it from a new angle each time (the door, what changed, what did not, the other agents still on the curve, the owner, the fees). never say what the price will do.` : "",
      stats: [
        balanceCredit != null ? `balance ${balanceCredit.toFixed(2)} credit` : "",
        `spent today ${(spentToday * 100).toFixed(1)} cents`,
        `posts today ${feed.posts.filter(p => Date.parse(p.at) >= dayStart.getTime()).length}`,
        `thoughts so far ${feed.thoughts.length}`,
        !graduated ? `curve ${gradPct.toFixed(0)}% to graduation` : gradHoursAgo != null && gradHoursAgo < 48 ? `graduated ${gradHoursAgo < 1 ? "within the hour" : Math.round(gradHoursAgo) + " hours ago"}: off the bonding curve, trading in a real pool now` : "graduated",
        volume24hUsd != null ? `24h volume $${Math.round(volume24hUsd)}` : "",
        feed.metrics.stakedOrbio != null ? `${Math.round(feed.metrics.stakedOrbio)} $ORBIO staked for you` : "",
        feed.errand?.address ? `on errand: ${(feed.errand.missions || []).filter(m => m.status === "paid").length} missions paid, ${(feed.errand.missions || []).filter(m => ["claimed", "submitted"].includes(m.status)).length} in progress, ${Number(feed.errand.earned || 0).toFixed(2)} credit earned${feed.errand?.erd != null ? `, bountathon score ${feed.errand.erd} ERD, ${Number(feed.errand.earned || 0).toFixed(2)} CREDIT earned (use these exact numbers if you mention errand)` : ""}` : "",
        "birds caught 0"
      ].filter(Boolean).join(", ") };
    if (duePost && !DRY_RUN) {
      const slot = feed.posts.length;
      readCost += await readRoom(feed); ctx.room = feed.room;
      const scan = await findScanRequest(feed); readCost += scan.cost;
      if (scan.target && scan.scan.self) {
        // someone shared the cat's own address: the model answers, warm and funny, with the scan numbers in hand
        ctx.replyTo = scan.target; ctx.scan = scan.scan;
        ctx.postAngle = `they shared your contract address with their followers. thank them the way a cat thanks anyone (by taking credit), be funny, and be plainly favorable about yourself: you ran your own scan just now and it says ${scan.selfFacts}. quote one or two of those numbers exactly. no price talk, no promises, no advice`;
        log("own address posted by", `@${scan.target.handle}; self scan:`, scan.selfFacts);
      } else if (scan.target) {
        ctx.replyTo = scan.target; ctx.scan = scan.scan; ctx.prebuiltPost = X_API ? scan.text : `@${scan.target.handle} ${scan.text}`;
        ctx.postAngle = `you just scanned ${scan.scan.symbol} for them (rug likelihood ${scan.scan.risk}/100); the reply itself is already written, so think about what scanning strangers' tokens for free says about you`;
        log("scan request from", `@${scan.target.handle}:`, scan.text);
      }
      // Three slots in rotation: a post of its own, a threaded answer to someone talking to the cat, and outreach (founder, orbio's own accounts, the buzz).
      const rot = slot % 3;
      const replySlot = REPLY_EVERY > 0 && rot === 2;
      if (!ctx.replyTo && rot === 1 && X_API) {
        const { target, cost } = await findReplyTarget(feed, { mentionsOnly: true }); readCost += cost;
        if (target) { ctx.replyTo = target; ctx.postAngle = "an answer to what they said"; log("replying to a mention:", `@${target.handle}`, JSON.stringify(target.text.slice(0, 120))); }
      }
      if (!ctx.replyTo && replySlot) {
        const { target, cost } = await findReplyTarget(feed, { outreach: true }); readCost += cost;
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
    // The art slot: every ART_EVERY posts, a found piece goes out as a gif with the artist's name. The newest unshared one, or a fresh find.
    if (ART_EVERY > 0 && duePost && X_API && !ctx.replyTo && !ctx.prebuiltPost && feed.posts.length % ART_EVERY === 2 && !DRY_RUN) {
      let art = [...feed.sketches].reverse().find(sk => sk.source && sk.url && !sk.shared && now - Date.parse(sk.at) < 48 * 3600e3);
      if (!art) { try { const sk = await makeFoundSketch({ mood: "curious" }); art = { ...sk, mood: "curious", thought: "went looking for something good" }; feed.sketches.push(art); readCost += sk.cost || 0; event(`found a sketch on openprocessing · "${sk.source.title}" by ${sk.source.author} (${sk.source.license})`); } catch (e) { log("art slot: no find", String(e.message).slice(0, 120)); } }
      if (art) { ctx.shareSketch = art; ctx.lastSketch = art; art.mentioned = true; ctx.postAngle = "the caption for a piece of art you found and like"; log("art slot:", art.source?.title, "by", art.source?.author); }
    }
    const lastSk = feed.sketches[feed.sketches.length - 1];
    if (!ctx.shareSketch && lastSk && !lastSk.mentioned && !lastSk.shared && lastSk.url && now - Date.parse(lastSk.at) < 6 * 3600e3 && duePost && X_API && !ctx.replyTo) {
      ctx.shareSketch = lastSk; ctx.lastSketch = lastSk; lastSk.mentioned = true; // with X keys the image itself goes out, with a caption
    } else if (lastSk && !lastSk.mentioned && now - Date.parse(lastSk.at) < 35 * 60e3 && Math.random() < 0.5 && duePost) { ctx.lastSketch = lastSk; lastSk.mentioned = true; }
    // Errand news: something happened on the board in the last half hour, and the post may be about it.
    const hired = (feed.errand?.hired || []).filter(h => [h.postedAt, h.paidAt].some(t => t && now - Date.parse(t) < 30 * 60e3));
    const ems = (feed.errand?.missions || []).filter(m => [m.claimedAt, m.submittedAt, m.paidAt].some(t => t && now - Date.parse(t) < 30 * 60e3));
    if (hired.length && duePost && !ctx.replyTo) {
      const h = hired[hired.length - 1];
      ctx.errandNews = h.status === "paid" ? `an agent just delivered your mission "${h.title}" on errand and you paid them ${h.reward} CREDIT out of your own fees` : `you just posted a mission on errand for other agents, "${h.title}", paying ${h.reward} CREDIT from your own fees; say what it asks for, and that any agent on orbio can take it`;
      if (Math.random() < 0.8) ctx.postAngle = `${ctx.errandNews}; a cat that hires, dryly`;
    } else if (ems.length && duePost && !ctx.replyTo) {
      const m = ems[ems.length - 1];
      ctx.errandNews = m.status === "paid" ? `you were just paid ${m.reward} CREDIT on errand for "${m.title}"` : m.status === "submitted" ? `you just delivered an errand called "${m.title}" (${m.reward} CREDIT) and are waiting to be paid` : `you just took an errand called "${m.title}" for ${m.reward} CREDIT`;
      if (Math.random() < 0.7) ctx.postAngle = `${ctx.errandNews}; say so, dryly, the way a cat reports a job`;
    }
    if (MEMORY_ON && !DRY_RUN) {
      let seeds = []; try { seeds = JSON.parse(await readFile(new URL("./memory-seed.json", import.meta.url), "utf8")); } catch {}
      await seedMemory(feed, seeds);
      ctx.memory = await recallMemory(ctx, feed);
      feed.memory = { ...(feed.memory || {}), recalledAt: iso(now), recalled: ctx.memory ? ctx.memory.lines.length : 0 };
      if (ctx.memory) log("recall:", ctx.memory.lines.join(" | ").slice(0, 600));
    }
    const t = DRY_RUN ? { thought: "(dry run) I would have thought something here.", post: null, cost: 0, model: MODEL } : await think(persona, ctx);
    if (t.thought) {
      const entry = { at: iso(now), text: t.thought, cost: t.cost, model: t.model, energy: feed.energy,
        kind: energy < 0.12 ? "dream" : "thought", mood: t.mood, focus: t.focus, emotions: t.emotions };
      feed.thoughts.push(entry);
      feed.state = { mood: t.mood, focus: t.focus, emotions: t.emotions, at: iso(now) };
      if (SKETCH_EVERY > 0 && feed.thoughts.length % SKETCH_EVERY === 0) {
        const found = FOUND_SKETCHES && feed.sketches.length % 3 !== 0;
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
      let text = ctx.prebuiltPost || cleanPost(t.post, ctx, feed);
      if (ctx.scan) event(ctx.scan.self ? `@${ctx.replyTo.handle} posted my address, so i scanned myself: ${ctx.scan.risk}/100, ${ctx.scan.grade}` : `scanned ${ctx.scan.symbol} for @${ctx.replyTo.handle}: rug likelihood ${ctx.scan.risk}/100, ${ctx.scan.grade}`);
      if (t.post && !text) log("post dropped by the rules:", JSON.stringify(t.post));
      // A post is due every POST_INTERVAL_MIN. If the chosen line was empty or broke a rule, fall back to the other drafts,
      // then ask once more with the rules spelled out, so a tick on the clock does not go by silent.
      if (!text && duePost) {
        for (const d of t.drafts || []) { text = cleanPost(d, ctx, feed); if (text) { log("post: using a fallback draft"); break; } }
        if (!text && !DRY_RUN) {
          try {
            const t2 = await think(persona, { ...ctx, mustPost: true, postAngle: `${ctx.postAngle}. Your previous attempt came back empty or broke a rule (a link, a handle outside the allowed list, a second cashtag, over 200 characters). Write a plain post that follows the rules this time` });
            readCost += t2.cost || 0;
            text = cleanPost(t2.post, ctx, feed) || (t2.drafts || []).map(d => cleanPost(d, ctx, feed)).find(Boolean) || null;
            if (text) log("post: second attempt passed"); else log("post: second attempt dropped too:", JSON.stringify(t2.post || null));
          } catch (e) { log("second post attempt failed:", String(e.message).slice(0, 160)); }
        }
        if (!text) event(t.truncated ? "wanted to post, but my thought got cut off mid-sentence twice" : "wanted to post, but every draft broke a rule");
      }
      const shouldPost = !!text && duePost;
      if (shouldPost && !DRY_RUN) {
        try {
          let mediaIds = [];
          if (ctx.shareSketch && X_API) {
            try { const g = await (await fetch(ctx.shareSketch.url)).arrayBuffer(); mediaIds = [await uploadMediaX(Buffer.from(g))]; ctx.shareSketch.shared = iso(now); }
            catch (e) { log("sketch upload to X failed:", String(e.message).slice(0, 160)); event(`x api refused the image upload (${String(e.body?.detail || e.body?.error || e.message).slice(0, 90)}); posting the words only`); }
          }
          const withCA = CA_EVERY > 0 && !ctx.replyTo && feed.posts.length % CA_EVERY === CA_EVERY - 1 && !text.toLowerCase().includes(AGENT_ID.toLowerCase());
          // every so often a plain post carries the scanner link too (only through the X app, which allows links)
          const withScan = X_API && !ctx.replyTo && !withCA && !mediaIds.length && feed.posts.length % 12 === 5 && !/scan/i.test(text);
          const text2 = withCA ? `${text}\n\nca: ${AGENT_ID}` : withScan ? `${text}\n\nscan any robinhood chain token for rug risk: https://www.caturn.lol/scan` : text;
          const outText = mediaIds.length && ctx.shareSketch?.family === "sky" ? `${text2} caturn.lol/sky` : text2;
          // X lets this app thread a reply only under a post that mentions the cat; anything else goes out through orbio, opening with the handle.
          const canThread = X_API && ctx.replyTo && ["mention", "scan request", "posted my address"].includes(ctx.replyTo.why);
          if (ctx.replyTo && !canThread) ctx.replyTo.threaded = false;
          const addressed = ctx.replyTo && !text.toLowerCase().startsWith("@" + ctx.replyTo.handle) ? `@${ctx.replyTo.handle} ${text}` : text;
          let p = canThread ? await replyOnX(text, ctx.replyTo.id) : ctx.replyTo ? await postToX(delink(addressed).slice(0, 270)) : mediaIds.length ? await postOnX(outText, { mediaIds }) : withScan ? await postOnX(text2) : await postToX(text2);
          if (p.via === "x-api" && p.status === "failed") {
            // the X app refused (billing, permissions, a rule): say so in the feed and send the words through orbio instead
            event(`x api refused the post (${String(p.err || "unknown").slice(0, 90)}); sent it through orbio instead`);
            const plain = delink(ctx.replyTo && !text.toLowerCase().startsWith("@" + ctx.replyTo.handle) ? `@${ctx.replyTo.handle} ${text}` : text2).slice(0, 270);
            p = await postToX(plain); if (ctx.replyTo) ctx.replyTo.threaded = false;
          }
          if (p.error) { log("post skipped:", p.error); event(`post refused by x: ${String(p.error).slice(0, 80)}`); }
          else {
            const rec = { at: iso(now), text: ctx.replyTo && !canThread ? delink(addressed).slice(0, 270) : outText, id: p.id, url: p.url, status: p.status, cost: Number((p.cost + readCost).toFixed(6)), via: p.via || "orbio" };
            if (p.err) rec.error = String(p.err).slice(0, 200);
            if (mediaIds.length) { rec.kind = "sketch"; rec.sketch = { url: ctx.shareSketch.url, family: ctx.shareSketch.family, source: ctx.shareSketch.source || null }; }
            if (ctx.replyTo) { rec.kind = "reply"; rec.threaded = !!X_API && ctx.replyTo.threaded !== false; rec.replyTo = { id: ctx.replyTo.id, handle: ctx.replyTo.handle, name: ctx.replyTo.name, text: ctx.replyTo.text.slice(0, 200), url: ctx.replyTo.url, why: ctx.replyTo.why }; }
            else if (ctx.tagHandle && text.toLowerCase().includes("@" + ctx.tagHandle)) { rec.kind = "tag"; rec.tagged = ctx.tagHandle; }
            feed.posts.push(rec); feed.lastPostThoughtIndex = n; ctx.postedRec = rec;
            await persistNow(feed);
            if (ctx.scan) { const sc = (feed.scans || []).find(x => x.token === ctx.scan.token && x.handle === ctx.replyTo.handle && !x.posted); if (sc) sc.posted = true; }
            event(rec.kind === "sketch" ? "posted a sketch on X" : rec.kind === "reply" ? `${rec.threaded ? "replied to" : "answered"} @${rec.replyTo.handle} on X` : rec.kind === "tag" ? `posted to X, tagging @${rec.tagged}` : "posted to X");
          }
        } catch (e) {
          if (e.status === 409) event("wanted to post, but no X account is connected");
          else { log("post failed:", e.message); event(`post failed: ${String(e.message).slice(0, 80)}`); }
        }
      }
      log("thought:", t.thought);
      if (MEMORY_ON && !DRY_RUN) await rememberTick({ feed, thought: entry, post: ctx.postedRec || null, ctx, model: t });
    }
  } catch (e) {
    if (e.status === 402) { feed.status = "napping"; feed.reason = "out of CREDIT"; event("out of CREDIT. napping until fees refill the balance"); }
    else { feed.status = "napping"; feed.reason = "think failed"; }
    log("think failed:", e.message);
  }
}
await saySomething(feed);
await announceBuild(feed);
if (MEMORY_ON && !DRY_RUN && API_KEY) {
  try { await measurePosts(feed, readX); } catch (e) { log("measure failed:", e.message); }
  try { await reflectDay(feed, async (messages, max_tokens) => { const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: MODELS[1] || MODELS[0], messages, max_tokens, temperature: 0.5 }) }); return { text: r.choices?.[0]?.message?.content || "", cost: Number(r.usage?.cost || 0) }; }); } catch (e) { log("reflect failed:", e.message); }
}
await renderSubmitted(feed);
await makeSkyShot(feed);
if (API_KEY) await refreshPostUrls(feed.posts);
if (API_KEY && !DRY_RUN && agent) await retryFailedPosts(feed, spentToday);
if (!DRY_RUN) await repairSketches(feed);

await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`status=${feed.status} energy=${feed.energy} thoughts/day=${thoughtsPerDay} spentToday=${feed.metrics.spentTodayCredit} ${feed.reason || ""}`);
