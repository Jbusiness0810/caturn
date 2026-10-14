// On-demand read of Robinhood Chain sentiment on X, paid from Caturn's orbio balance. Posts nothing.
//   node agent/sentiment.mjs            -> full read (about 4 credit of X reads plus one model call)
//   node agent/sentiment.mjs --quick    -> fewer, smaller reads
// Writes the report to out/sentiment/<time>.md and .json and prints it.
import { writeFile, mkdir } from "node:fs/promises";

const env = process.env, KEY = env.ORBIO_API_KEY || "";
const API = "https://api.orbio.so/api/v1", PROTOCOL = "https://www.orbio.so/api/protocol";
const MODELS = (env.CATURN_SENTIMENT_MODEL || "anthropic/claude-fable-5.1,anthropic/claude-opus-5.5,anthropic/claude-sonnet-5.5").split(",").map(s => s.trim());
const QUICK = process.argv.includes("--quick");
const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const log = (...a) => console.error("[sentiment]", ...a);
let spent = 0;

async function post(path, body, timeout = 90000) {
  const r = await fetch(`${API}/${path}`, { method: "POST", headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok || j.error) throw new Error(`${path} ${r.status}: ${String(j.error?.message || text).slice(0, 200)}`);
  return j;
}

// X reads: orbio's reader bills per call, about 0.016 credit per post
async function readX(query, sort, limit) {
  try {
    const r = await post("tools/social.x.posts", { query, sort, limit, max_cost: (limit * 0.03).toFixed(4) });
    spent += Number(r.cost?.credit || 0);
    return (r.result?.tweets || r.tweets || []).map(t => ({
      id: String(t.id_str || t.id || ""), text: String(t.full_text || t.text || ""), at: t.tweet_created_at || t.created_at || null,
      handle: String(t.user?.screen_name || "").toLowerCase(), followers: Number(t.user?.followers_count || 0),
      views: Number(t.views_count || 0), likes: Number(t.favorite_count || 0), replies: Number(t.reply_count || 0), reposts: Number(t.retweet_count || 0), q: query
    })).filter(t => t.id && t.handle);
  } catch (e) { log(`read failed (${query}):`, e.message); return []; }
}

// the chain's own tokens: the biggest agents on the orbio launchpad and their last 24h on the dex
async function market() {
  try {
    const r = await fetch(`${PROTOCOL}/agents?limit=60&sort=cap`, { signal: AbortSignal.timeout(20000) }).then(r => r.json());
    const agents = (r.agents || r.items || r.data || []).filter(a => a.token && a.symbol);
    const pairs = [];
    for (let i = 0; i < Math.min(agents.length, 60); i += 30) {
      const addrs = agents.slice(i, i + 30).map(a => a.token).join(",");
      const d = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${addrs}`, { signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => []);
      pairs.push(...(Array.isArray(d) ? d : []));
    }
    const best = new Map();
    for (const p of pairs) { const a = String(p.baseToken?.address || "").toLowerCase(); if (!best.has(a) || (p.liquidity?.usd || 0) > (best.get(a).liquidity?.usd || 0)) best.set(a, p); }
    const rows = [...best.values()].map(p => ({ symbol: p.baseToken?.symbol, change24h: Number(p.priceChange?.h24 ?? 0), vol24h: Number(p.volume?.h24 || 0), liq: Number(p.liquidity?.usd || 0), cap: Number(p.marketCap || p.fdv || 0) }))
      .filter(x => x.symbol && x.liq > 1000).sort((a, b) => b.cap - a.cap);
    const vol = rows.reduce((s, x) => s + x.vol24h, 0);
    const wChange = vol ? rows.reduce((s, x) => s + x.change24h * x.vol24h, 0) / vol : 0;
    return { tokens: rows.length, up: rows.filter(x => x.change24h > 0).length, down: rows.filter(x => x.change24h < 0).length, volWeightedChange24h: +wChange.toFixed(1), vol24h: Math.round(vol), top: rows.slice(0, 12), symbols: agents.slice(0, 12).map(a => a.symbol) };
  } catch (e) { log("market read failed:", e.message); return null; }
}

const SCAM_RE = /airdrop|claim\s+(now|your|here)|connect\s+(your\s+)?wallet|seed\s+phrase|giveaway|whitelist|presale|free\s+(mint|tokens?)\s+claim|dm\s+(us|me)\s+for/i;
const tagCount = (t) => (t.match(/\$[A-Za-z]{2,10}\b/g) || []).length;

async function think(posts, mkt) {
  const lines = posts.map((t, i) => `[${i}] @${t.handle} (${t.followers} followers, ${t.likes} likes, ${t.views} views, ${t.at ? new Date(t.at).toISOString().slice(0, 16) : "?"}): ${t.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const sys = `You are a careful market-sentiment analyst for Robinhood Chain (Robinhood's L2, home of tokenized stocks and the orbio agent launchpad). You read a sample of recent X posts and judge the crowd's mood about the chain and its tokens. Weigh real users above bots, raffles, shills and engagement farms, and say how much of the sample is noise. Do not give financial advice or buy/sell/hold calls. Answer in JSON only with these keys:
score (integer -100 very bearish to 100 very bullish), label (one of: very bearish, bearish, cautious, neutral, constructive, bullish, euphoric), confidence (low|medium|high), summary (3-4 plain sentences), bullish_themes (array of short strings), bearish_themes (array), tokens (array of {symbol, mood: bullish|bearish|mixed, why}), noise_share (0-1, share of posts that are bots, raffles, shills or farming), notable (array of {index, why}, up to 5 of the most telling posts), versus_price (one sentence on whether talk matches the on-chain price data), watch (array of up to 3 things to watch next).`;
  const user = `On-chain backdrop (orbio launchpad tokens on Robinhood Chain, last 24h): ${mkt ? JSON.stringify({ tokens: mkt.tokens, up: mkt.up, down: mkt.down, volWeightedChange24h: mkt.volWeightedChange24h, vol24h: mkt.vol24h, top: mkt.top }) : "unavailable"}\n\nX posts (${posts.length}):\n${lines}`;
  for (const model of MODELS) {
    try {
      const body = { model, max_tokens: 2500, messages: [{ role: "system", content: sys }, { role: "user", content: user }], response_format: { type: "json_object" } };
      const r = await post("chat/completions", body, 180000);
      spent += Number(r.cost?.credit || r.usage?.cost || 0);
      const txt = String(r.choices?.[0]?.message?.content || "");
      const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
      return { ...j, model };
    } catch (e) { log(`${model} failed:`, e.message); }
  }
  throw new Error("every model failed");
}

if (!KEY) { console.error("ORBIO_API_KEY is not set"); process.exit(1); }
const mkt = await market();
const n = QUICK ? 20 : 50;
const tick = mkt?.symbols?.filter(s => /^[A-Za-z]{3,10}$/.test(s)).slice(0, 8).map(s => `$${s}`).join(" OR ");
const queries = [
  ['"robinhood chain"', "Latest", n], ['"robinhood chain"', "Top", n],
  ['#RobinhoodChain OR "rh chain" OR "robinhood l2" OR "robinhood testnet"', "Latest", QUICK ? 0 : 40],
  ["@orbiodotso OR orbio.so OR $ORBIO", "Latest", QUICK ? 20 : 40],
  ...(tick && !QUICK ? [[tick, "Latest", 40]] : [])
].filter(q => q[2] > 0);
const reads = await Promise.all(queries.map(([q, s, l]) => readX(q, s, l)));
const seen = new Set(), posts = [];
for (const t of reads.flat()) {
  if (seen.has(t.id) || /^RT @/.test(t.text) || SCAM_RE.test(t.text) || tagCount(t.text) >= 4) continue;
  seen.add(t.id); posts.push(t);
}
// one voice per account at most three times, the most engaged first
const per = {}; const sample = posts.sort((a, b) => (b.likes + 2 * b.replies + 3 * b.reposts) - (a.likes + 2 * a.replies + 3 * a.reposts)).filter(t => (per[t.handle] = (per[t.handle] || 0) + 1) <= 3).slice(0, 160);
log(`${reads.flat().length} posts read, ${sample.length} kept from ${new Set(sample.map(t => t.handle)).size} accounts`);
if (!sample.length) { console.error("no posts to read"); process.exit(1); }

const v = await think(sample, mkt);
const at = new Date().toISOString();
const bar = (s) => { const i = Math.round((Number(s) + 100) / 10); return "[" + "#".repeat(i) + "-".repeat(20 - i) + "]"; };
const md = [
  `# Robinhood Chain sentiment on X, ${at.slice(0, 16).replace("T", " ")} UTC`,
  ``, `**${v.label}** (${v.score}) ${bar(v.score)} confidence ${v.confidence}`,
  ``, v.summary,
  ``, `Bullish: ${(v.bullish_themes || []).join("; ") || "none"}`,
  `Bearish: ${(v.bearish_themes || []).join("; ") || "none"}`,
  ``, `Tokens: ${(v.tokens || []).map(t => `$${String(t.symbol).replace(/^\$/, "")} ${t.mood} (${t.why})`).join("; ") || "none stood out"}`,
  mkt ? `On-chain 24h: ${mkt.up} up, ${mkt.down} down of ${mkt.tokens} launchpad tokens, volume-weighted ${mkt.volWeightedChange24h}%, $${mkt.vol24h.toLocaleString()} volume` : "On-chain 24h: unavailable",
  `Talk vs price: ${v.versus_price || "n/a"}`,
  `Noise: about ${Math.round((v.noise_share || 0) * 100)}% of the sample looked like bots, raffles or shills`,
  ``, `Telling posts:`, ...(v.notable || []).map(x => { const t = sample[x.index]; return t ? `- @${t.handle}: "${t.text.replace(/\s+/g, " ").slice(0, 140)}" (${x.why}) https://x.com/${t.handle}/status/${t.id}` : null; }).filter(Boolean),
  ``, `Watch: ${(v.watch || []).join("; ")}`,
  ``, `${sample.length} posts from ${new Set(sample.map(t => t.handle)).size} accounts, read by ${v.model}. Cost about ${spent.toFixed(2)} credit. Not advice.`
].join("\n");
await mkdir("out/sentiment", { recursive: true });
const stamp = at.replace(/[:.]/g, "-").slice(0, 19);
await writeFile(`out/sentiment/${stamp}.md`, md);
await writeFile(`out/sentiment/${stamp}.json`, JSON.stringify({ at, verdict: v, market: mkt, queries, sample }, null, 2));
console.log(md);
