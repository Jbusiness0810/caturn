// The board: people suggest what Caturn does next and vote; once a day the top one gets done (by Claude, in public).
// GET  /api/board            -> today's pick (if one is in progress), the queue by CTRN weight, and everything done so far
// GET  /api/board?wallet=0x… -> that wallet's CTRN balance
// POST /api/board {action:"submit", text, wallet, time, sig} | {action:"vote", id, wallet, time, sig}
// Every write is signed by the wallet (personal_sign of a fixed message), and a vote weighs whatever CTRN that wallet
// holds at the moment the board is read: weights are recomputed from live balances, so moving tokens to a second wallet
// moves the weight instead of doubling it.
// board/log.json is written by the daily run and shipped with this function; it is the record of what was picked and done,
// and every GET folds it back into the database so the queue never shows a finished suggestion.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { readFile } from "node:fs/promises";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ORBIO_API = "https://api.orbio.so/api/v1";
const MODELS = (process.env.ASK_MODELS || "anthropic/claude-sonnet-5.5,x-ai/grok-4.7,anthropic/claude-opus-5.5").split(",").map(s => s.trim()).filter(Boolean);
const MAX_TEXT = 280, PER_WALLET_PER_DAY = 3, PICK_HOUR_UTC = 17;
const RPC = "https://rpc.mainnet.chain.robinhood.com", CTRN = "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a";
const MIN_SUBMIT = Number(process.env.BOARD_MIN_SUBMIT_CTRN || 1000); // a floor against spam; any balance can vote
const SIG_WINDOW_MS = 10 * 60e3;
const hits = new Map();
const now = () => Date.now();

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e = new Error(`supabase ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 300)); e.status = r.status; throw e; }
  return body;
}

// The exact text a wallet signs; js/board.js builds the same string.
function message(b) {
  const head = `caturn board\naction: ${b.action === "vote" ? "vote" : "suggest"}\n`;
  const body = b.action === "vote" ? `suggestion: ${Number(b.id)}\n` : `text: ${b.text}\n`;
  return head + body + `wallet: ${b.wallet}\ntime: ${b.time}`;
}
const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ""), "hex"));
function recover(msg, sigHex) {
  const sig = hexToBytes(sigHex); if (sig.length !== 65) throw new Error("bad signature");
  const m = Buffer.from(msg, "utf8"), digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
  let v = sig[64]; if (v >= 27) v -= 27; if (v > 1) throw new Error("bad signature");
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return "0x" + Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString("hex");
}
function verify(b) {
  const wallet = String(b.wallet || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return "connect a wallet first.";
  const t = Date.parse(b.time); if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIG_WINDOW_MS) return "that signature is stale. try again.";
  try { if (recover(message({ ...b, wallet }), b.sig) !== wallet) return "the signature does not match that wallet."; } catch { return "the signature did not check out."; }
  return null;
}

// CTRN balances, read straight from the chain in batches; cached a minute so a busy board does not hammer the RPC.
const balCache = new Map();
async function balances(wallets) {
  const out = {}, need = [];
  for (const w of new Set(wallets)) { const c = balCache.get(w); if (c && now() - c.t < 60e3) out[w] = c.v; else need.push(w); }
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk.map((w, k) => ({ jsonrpc: "2.0", id: k, method: "eth_call", params: [{ to: CTRN, data: "0x70a08231" + w.slice(2).padStart(64, "0") }, "latest"] }))) });
    const res = await r.json(); const arr = Array.isArray(res) ? res : [res];
    for (const x of arr) { const w = chunk[x.id]; if (w == null || !x.result) continue; const v = Number(BigInt(x.result) / 10n ** 14n) / 1e4; out[w] = v; balCache.set(w, { v, t: now() }); }
  }
  return out;
}
async function readLog() { try { return JSON.parse(await readFile(new URL("../board/log.json", import.meta.url), "utf8")); } catch { return []; } }

async function moderate(text) {
  const key = process.env.ORBIO_API_KEY; if (!key) return { ok: true, title: text.slice(0, 48) };
  const system = `You screen suggestions for a public board where people vote on what an AI cat agent (Caturn, a token agent on the orbio launchpad) should do next. Once a day the top suggestion is carried out by an AI developer working in the cat's public website repo: it can build pages, games, tools, art, stories, research write-ups, site features, and write posts for the cat's X account. Reject: anything that moves, spends, sends, buys or sells money or tokens (airdrops, giveaways, buybacks, burns, paying people); price promises or financial advice; anything hateful, sexual, violent, illegal; harassing, targeting or doxxing a person; impersonating a real person or brand; asking for keys, passwords or private data; changing who controls the agent or deleting its work; anything that needs paid outside services or accounts. Accept everything else, including silly or ambitious things. Answer with one JSON object only: {"ok": true|false, "reason": "one short dry line in the cat's voice if rejected, else empty", "title": "a 2 to 6 word title, lowercase"}.`;
  for (const model of MODELS) {
    try {
      const r = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: 120, temperature: 0.2 }) });
      const body = await r.json().catch(() => ({})); if (!r.ok) continue;
      const m = String(body.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); if (!m) continue;
      const j = JSON.parse(m[0]); return { ok: !!j.ok, reason: String(j.reason || "").slice(0, 160), title: String(j.title || text.slice(0, 48)).toLowerCase().slice(0, 60) };
    } catch {}
  }
  return { ok: true, title: text.slice(0, 48) }; // the daily run screens again before it does anything
}

// Fold the log into the database: whatever the daily run marked doing, done or rejected stops being votable.
async function sync(log) {
  const ids = log.map(e => Number(e.id)).filter(Number.isFinite); if (!ids.length) return;
  const rows = await sb(`suggestions?id=in.(${ids.join(",")})&select=id,status,result_url`);
  for (const r of rows) {
    const e = [...log].reverse().find(x => Number(x.id) === r.id); if (!e || !e.status || (e.status === r.status && (e.url || null) === (r.result_url || null))) continue;
    const patch = { status: e.status, result_url: e.url || null, result_note: e.summary || e.reason || null };
    if (e.status === "done") patch.done_at = e.at || new Date().toISOString();
    await sb(`suggestions?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=minimal" }).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: "the board is not up yet (no database configured)." });
  try {
    const log = await readLog();
    const closed = new Set(log.filter(e => e.status !== "queued").map(e => Number(e.id)));
    if (req.method === "GET" && req.query.wallet) {
      const w = String(req.query.wallet).toLowerCase(); if (!/^0x[a-f0-9]{40}$/.test(w)) return res.status(400).json({ error: "not a wallet." });
      const bal = (await balances([w]))[w] ?? null;
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ wallet: w, ctrn: bal, minSubmit: MIN_SUBMIT });
    }
    if (req.method === "GET") {
      await sync(log).catch(e => console.error("board sync:", e.message));
      const [rawQueued, done] = await Promise.all([
        sb(`suggestions?status=eq.queued&order=created_at.asc&limit=200&select=id,text,title,votes,created_at`),
        sb(`suggestions?status=eq.done&order=done_at.desc&limit=60&select=id,text,title,votes,done_at,result_url,result_note`)
      ]);
      // weigh every queued suggestion by the CTRN its voters hold right now
      const open = rawQueued.filter(q => !closed.has(q.id));
      const votes = open.length ? await sb(`suggestion_votes?suggestion_id=in.(${open.map(q => q.id).join(",")})&select=suggestion_id,wallet&limit=5000`) : [];
      const bal = await balances(votes.map(v => v.wallet)).catch(() => ({}));
      const queued = open.map(q => { const vs = votes.filter(v => v.suggestion_id === q.id); return { ...q, votes: Math.round(vs.reduce((a, v) => a + (bal[v.wallet] || 0), 0)), voters: vs.length }; })
        .sort((a, b) => b.votes - a.votes || Date.parse(a.created_at) - Date.parse(b.created_at)).slice(0, 40);
      const doing = [...log].reverse().find(e => e.status === "doing") || null;
      const next = new Date(); next.setUTCHours(PICK_HOUR_UTC, 0, 0, 0); if (next.getTime() <= now()) next.setUTCDate(next.getUTCDate() + 1);
      res.setHeader("Cache-Control", "public, max-age=15");
      return res.status(200).json({ queued, doing, minSubmit: MIN_SUBMIT, done, log: log.slice(-30).reverse(), nextPick: next.toISOString(), at: new Date().toISOString() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const h = (hits.get(ip) || []).filter(t => now() - t < 60e3); if (h.length >= 10) return res.status(429).json({ error: "slow down. the cat is one cat." }); h.push(now()); hits.set(ip, h);
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const bad = verify(b); if (bad) return res.status(401).json({ error: bad });
    const wallet = String(b.wallet).toLowerCase();
    const held = (await balances([wallet]))[wallet] || 0;
    if (b.action === "vote") {
      const id = Number(b.id); if (!Number.isFinite(id) || closed.has(id)) return res.status(400).json({ error: "that one is closed." });
      if (!(held > 0)) return res.status(403).json({ error: "that wallet holds no $CTRN. votes are weighed in CTRN." });
      try { await sb("suggestion_votes", { method: "POST", body: JSON.stringify({ suggestion_id: id, wallet }), prefer: "return=minimal" }); }
      catch (e) { if (e.status === 409) return res.status(200).json({ ok: true, already: true }); throw e; }
      return res.status(200).json({ ok: true, weight: held });
    }
    if (b.action === "submit") {
      const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (text.length < 8) return res.status(400).json({ error: "say a little more than that." });
      if (text !== String(b.text || "")) return res.status(400).json({ error: "sign the suggestion exactly as typed." });
      if (/0x[a-f0-9]{40}/i.test(text)) return res.status(400).json({ error: "no addresses. describe the thing." });
      if (held < MIN_SUBMIT) return res.status(403).json({ error: `suggesting takes at least ${MIN_SUBMIT.toLocaleString("en-US")} $CTRN in the wallet. this one holds ${held.toLocaleString("en-US")}. anyone holding any can vote.` });
      const since = new Date(now() - 86400e3).toISOString();
      const mine = await sb(`suggestions?wallet=eq.${wallet}&created_at=gte.${encodeURIComponent(since)}&select=id`);
      if (mine.length >= PER_WALLET_PER_DAY) return res.status(429).json({ error: "three suggestions a day per wallet. vote for the others." });
      const dup = await sb(`suggestions?status=eq.queued&text=ilike.${encodeURIComponent("%" + text.slice(0, 40).replace(/[%_*,()]/g, "") + "%")}&select=id&limit=1`);
      if (dup.length) return res.status(409).json({ error: "that one is already on the board. vote for it instead." });
      const m = await moderate(text);
      const row = await sb("suggestions", { method: "POST", body: JSON.stringify({ text, wallet, status: m.ok ? "queued" : "rejected", reject_reason: m.ok ? null : m.reason, title: m.title }) });
      if (!m.ok) return res.status(200).json({ ok: false, rejected: true, reason: m.reason || "not that one." });
      const id = row?.[0]?.id;
      if (id) await sb("suggestion_votes", { method: "POST", body: JSON.stringify({ suggestion_id: id, wallet }), prefer: "return=minimal" }).catch(() => {});
      return res.status(200).json({ ok: true, id, title: m.title });
    }
    return res.status(400).json({ error: "what?" });
  } catch (e) {
    console.error("board api:", e.message);
    return res.status(502).json({ error: "the board wobbled. try again in a moment." });
  }
}
