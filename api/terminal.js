// Rent the cat's brain: a paid terminal on caturn.lol that runs frontier models on Caturn's orbio gateway balance
// (which cannot be withdrawn, so it is put to work). Payments are reviewed by the owner: a user sends crypto to the
// cat's wallet and files the transaction here; the owner confirms it from the admin view and the wallet is credited
// with compute at 30% under list. Nothing here moves or verifies funds on its own.
// GET  /api/terminal[?token=]                                  -> price, payment address, models, the caller's account
// GET  /api/terminal?admin=<key>                               -> pending payment requests (owner only)
// POST {action:"login", wallet, time, sig}                     -> session token (one signature, no gas)
// POST {action:"request", token, chain, asset, amount, tx}     -> files a payment for the owner to review
// POST {action:"chat", token, model, messages}                 -> one answer, billed at the provider's cost
// POST {action:"credit", admin, id, usd}                       -> owner confirms a request: credits usd / 0.7 of compute
// POST {action:"reject", admin, id, note}                      -> owner declines a request
import { recoverSigner, isAddress, makeToken, readToken } from "./_lib/wallet.js";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ORBIO_API = "https://api.orbio.so/api/v1", ORBIO_KEY = process.env.ORBIO_API_KEY || "";
const ADMIN_KEY = process.env.TERMINAL_ADMIN_KEY || "";
const PAY_TO = process.env.TERMINAL_ADDRESS || "0x4eF5b7c02c90465B71837c879734538648e70483"; // Caturn's wallet, any EVM chain
const PRICE = Number(process.env.TERMINAL_PRICE || 0.7);      // $1 of compute costs $0.70 of crypto: 30% under list
const RESERVE = Number(process.env.TERMINAL_RESERVE || 250);  // the cat keeps at least this much gateway balance for itself
const MAX_TOKENS = 4000, MAX_CHARS = 60000;
const SECRET = "caturn-terminal|" + SB_KEY.slice(0, 32);
const MODELS = [
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1" },
  { id: "openai/gpt-6.1-sol-pro", name: "GPT-6.1 Sol Pro" },
  { id: "x-ai/grok-4.7", name: "Grok 4.7" },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "deepseek/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" }
];
const SYSTEM = "You are a capable general assistant, reached through the terminal on caturn.lol, where people rent compute from Caturn, an AI cat agent on the orbio launchpad. Answer the user directly and well. Format code in fenced blocks.";
const hits = new Map(), cache = {};
const now = () => Date.now();
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e = new Error(`supabase ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 300)); e.status = r.status; throw e; }
  return body;
}
async function cached(key, ms, fn) { const c = cache[key]; if (c && now() - c.t < ms) return c.v; const v = await fn(); cache[key] = { v, t: now() }; return v; }
const pricing = () => cached("models", 3600e3, async () => {
  const r = await fetch(`${ORBIO_API}/models?output_modalities=text`); const j = await r.json(); const out = {};
  for (const m of j.data || []) out[m.id] = { prompt: Number(m.pricing?.prompt || 0), completion: Number(m.pricing?.completion || 0) };
  return out;
});
const catBalance = () => cached("bal", 60e3, async () => {
  const r = await fetch(`${ORBIO_API}/key`, { headers: { Authorization: `Bearer ${ORBIO_KEY}` } }); const j = await r.json();
  return Number(j?.balance?.available ?? j?.data?.limit_remaining ?? 0);
});
async function account(wallet) {
  const rows = await sb(`terminal_accounts?wallet=eq.${wallet}&select=wallet,credit,spent`);
  return rows[0] || { wallet, credit: 0, spent: 0 };
}
async function saveAccount(a) {
  await sb("terminal_accounts", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ wallet: a.wallet, credit: round(a.credit), spent: round(a.spent || 0), updated_at: new Date().toISOString() }) });
}
const isAdmin = (k) => ADMIN_KEY.length >= 16 && k === ADMIN_KEY;

export default async function handler(req, res) {
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: "the terminal is not wired up yet." });
  try {
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      if (req.query.admin) {
        if (!isAdmin(req.query.admin)) return res.status(403).json({ error: "no." });
        const pending = await sb(`terminal_requests?status=eq.pending&order=created_at.asc&limit=100&select=id,wallet,chain,asset,amount,tx,created_at`);
        const recent = await sb(`terminal_requests?status=neq.pending&order=created_at.desc&limit=30&select=id,wallet,chain,asset,amount,tx,status,usd,credit,created_at`);
        return res.status(200).json({ pending, recent, price: PRICE, balance: await catBalance().catch(() => null) });
      }
      const wallet = readToken(req.query.token, SECRET);
      const bal = await catBalance().catch(() => null);
      let requests = [];
      if (wallet) requests = await sb(`terminal_requests?wallet=eq.${wallet}&order=created_at.desc&limit=10&select=id,chain,asset,amount,status,credit,created_at`);
      return res.status(200).json({ payTo: PAY_TO, price: PRICE, models: MODELS, open: bal == null ? true : bal > RESERVE, account: wallet ? await account(wallet) : null, requests });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const h = (hits.get(ip) || []).filter(t => now() - t < 60e3); if (h.length >= 20) return res.status(429).json({ error: "slow down. the cat is one cat." }); h.push(now()); hits.set(ip, h);
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (b.action === "credit" || b.action === "reject") {
      if (!isAdmin(b.admin)) return res.status(403).json({ error: "no." });
      const id = Number(b.id); const r = (await sb(`terminal_requests?id=eq.${id}&select=id,wallet,status`))[0];
      if (!r || r.status !== "pending") return res.status(400).json({ error: "no pending request with that id." });
      if (b.action === "reject") { await sb(`terminal_requests?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected", note: String(b.note || "").slice(0, 200) }), prefer: "return=minimal" }); return res.status(200).json({ ok: true }); }
      const usd = Number(b.usd); if (!(usd > 0 && usd < 100000)) return res.status(400).json({ error: "how many dollars was it worth?" });
      const credit = round(usd / PRICE), a = await account(r.wallet);
      await saveAccount({ ...a, credit: Number(a.credit || 0) + credit });
      await sb(`terminal_requests?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "credited", usd: round(usd), credit }), prefer: "return=minimal" });
      return res.status(200).json({ ok: true, wallet: r.wallet, credit });
    }

    if (b.action === "login") {
      const wallet = String(b.wallet || "").toLowerCase();
      if (!isAddress(wallet)) return res.status(400).json({ error: "connect a wallet first." });
      const t = Date.parse(b.time); if (!Number.isFinite(t) || Math.abs(now() - t) > 10 * 60e3) return res.status(401).json({ error: "that signature is stale. try again." });
      try { if (recoverSigner(`caturn terminal\nwallet: ${wallet}\ntime: ${b.time}`, b.sig) !== wallet) return res.status(401).json({ error: "the signature does not match that wallet." }); }
      catch { return res.status(401).json({ error: "the signature did not check out." }); }
      return res.status(200).json({ token: makeToken(wallet, SECRET), account: await account(wallet) });
    }

    const wallet = readToken(b.token, SECRET);
    if (!wallet) return res.status(401).json({ error: "sign in again." });

    if (b.action === "request") {
      const chain = String(b.chain || "").trim().slice(0, 40), asset = String(b.asset || "").trim().slice(0, 20), amount = String(b.amount || "").trim().slice(0, 30), tx = String(b.tx || "").trim().slice(0, 120);
      if (!chain || !asset || !amount || tx.length < 10) return res.status(400).json({ error: "fill in the chain, the coin, the amount and the transaction." });
      const mine = await sb(`terminal_requests?wallet=eq.${wallet}&status=eq.pending&select=id`); if (mine.length >= 5) return res.status(429).json({ error: "five payments are already waiting for review. hang tight." });
      const dup = await sb(`terminal_requests?tx=eq.${encodeURIComponent(tx)}&select=id`); if (dup.length) return res.status(409).json({ error: "that transaction was already filed." });
      await sb("terminal_requests", { method: "POST", body: JSON.stringify({ wallet, chain, asset, amount, tx, status: "pending" }), prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }

    if (b.action === "chat") {
      const model = MODELS.find(m => m.id === b.model)?.id; if (!model) return res.status(400).json({ error: "pick a model from the list." });
      const msgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-24).map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "say something." });
      const chars = msgs.reduce((a, m) => a + m.content.length, 0); if (chars > MAX_CHARS) return res.status(400).json({ error: "that conversation is too long. start a new one." });
      const uh = (hits.get(wallet) || []).filter(t => now() - t < 60e3); if (uh.length >= 8) return res.status(429).json({ error: "eight a minute. the cat needs to breathe." }); uh.push(now()); hits.set(wallet, uh);
      if ((await catBalance().catch(() => RESERVE + 1)) <= RESERVE) return res.status(503).json({ error: "the cat's compute is reserved for the cat right now. try again later." });
      const a = await account(wallet), credit = Number(a.credit || 0);
      const p = (await pricing())[model] || { prompt: 0.00001, completion: 0.00005 };
      const inTok = Math.ceil((chars + SYSTEM.length) / 3.5), inCost = inTok * p.prompt * 1.1;
      const maxTokens = Math.min(MAX_TOKENS, Math.floor((credit - inCost) / (p.completion * 1.1)));
      if (maxTokens < 200) return res.status(402).json({ error: "not enough compute left for that. top up below.", account: a });
      const r = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${ORBIO_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "system", content: SYSTEM }, ...msgs] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: `the model did not answer (${j?.error?.message || r.status}). nothing was charged.` });
      const reply = String(j.choices?.[0]?.message?.content || ""), u = j.usage || {};
      let cost = Number(u.cost ?? j.cost?.credit ?? 0);
      if (!(cost > 0)) cost = ((u.prompt_tokens || inTok) * p.prompt + (u.completion_tokens || Math.ceil(reply.length / 3.5)) * p.completion) * 1.1;
      cost = round(Math.min(cost, credit));
      const next = { ...a, credit: credit - cost, spent: Number(a.spent || 0) + cost };
      await saveAccount(next);
      sb("terminal_usage", { method: "POST", body: JSON.stringify({ wallet, model, cost, prompt: msgs[msgs.length - 1].content.slice(0, 300) }), prefer: "return=minimal" }).catch(() => {});
      return res.status(200).json({ reply, cost, model, finish: j.choices?.[0]?.finish_reason || null, account: { wallet, credit: round(next.credit), spent: round(next.spent) } });
    }
    return res.status(400).json({ error: "what?" });
  } catch (e) {
    console.error("terminal api:", e.message);
    return res.status(502).json({ error: "the terminal hiccuped. try again in a moment." });
  }
}
