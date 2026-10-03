// Rent the cat's brain: a paid terminal on caturn.lol that runs frontier models on Caturn's orbio gateway balance
// (which cannot be withdrawn, so it is put to work). Users top up by signing a transfer from their own wallet to the
// cat's wallet on Robinhood Chain (ETH, USDG or $CTRN); the server reads the confirmed transfer back from the chain and
// credits compute at 30% under list. The server never holds keys or moves funds; it only reads the chain.
// GET  /api/terminal[?token=]                          -> price, deposit address and tokens, models, the caller's account
// POST {action:"login", wallet, time, sig}             -> session token (one signature, no gas)
// POST {action:"deposit", token, tx}                   -> reads a confirmed transfer to the cat's wallet and credits it
// POST {action:"chat", token, model, messages, repo?}  -> one answer, billed at the provider's cost. repo (optional) is the
//      GitHub repo the user connected in their browser: {name, branch, tree:[paths], files:[{path, content}]}. The model
//      answers with file blocks the browser commits with the user's own token; the token never reaches this server.
import { recoverSigner, isAddress, makeToken, readToken } from "./_lib/wallet.js";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ORBIO_API = "https://api.orbio.so/api/v1", ORBIO_KEY = process.env.ORBIO_API_KEY || "";
const RPC = "https://rpc.mainnet.chain.robinhood.com", CHAIN_ID = 4663;
const PAY_TO = (process.env.TERMINAL_ADDRESS || "0x4eF5b7c02c90465B71837c879734538648e70483").toLowerCase(); // Caturn's wallet
const PRICE = Number(process.env.TERMINAL_PRICE || 0.7);      // $1 of compute costs $0.70 of crypto: 30% under list
const RESERVE = Number(process.env.TERMINAL_RESERVE || 250);  // the cat keeps at least this much gateway balance for itself
const MIN_USD = 1, MAX_AGE_S = 72 * 3600, MAX_TOKENS = 4000, MAX_CHARS = 60000;
const SECRET = "caturn-terminal|" + SB_KEY.slice(0, 32);
// tokens accepted on Robinhood Chain besides native ETH: stablecoins at $1, $CTRN at its live DEX price
const TOKENS = {
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", decimals: 6, usd: async () => 1 },
  "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a": { symbol: "CTRN", decimals: 18, usd: () => ctrnUsd() }
};
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
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
const MAX_REPO_CHARS = 90000, MAX_REPO_TOKENS = 6000;
// the file protocol the browser understands (js/terminal.js parses exactly these markers)
const repoSystem = (r) => `The user connected the GitHub repository ${r.name} (branch ${r.branch}). You can work in it like a coding agent:
- To create or replace a file, write the WHOLE new file between these marker lines, each on its own line:
=== FILE: path/from/repo/root ===
(full file content, no fences)
=== END FILE ===
- To delete a file, write a line: === DELETE: path ===
- To read files before changing them, write one line per file: === READ: path === and stop; the user's browser attaches them and you continue. Read a file before you replace it unless you are creating it from scratch.
Never print partial files or diffs inside FILE blocks: the block replaces the file exactly. Keep explanations short and outside the blocks. The browser shows the changes and commits them to ${r.branch}.
Repository files${r.tree.length >= 1500 ? " (first 1500)" : ""}:
${r.tree.join("\n")}${r.files.length ? "\n\nAttached files:\n" + r.files.map(f => `=== ATTACHED: ${f.path} ===\n${f.content}\n=== END ATTACHED ===`).join("\n") : ""}`;
function readRepo(x) {
  if (!x || typeof x !== "object") return null;
  const name = String(x.name || ""); if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return null;
  const clean = (p) => String(p || "").replace(/[\r\n]/g, "").slice(0, 300);
  const tree = (Array.isArray(x.tree) ? x.tree : []).map(clean).filter(Boolean).slice(0, 1500);
  let room = MAX_REPO_CHARS - tree.join("\n").length;
  const files = [];
  for (const f of (Array.isArray(x.files) ? x.files : []).slice(0, 20)) {
    const content = String(f?.content ?? "").slice(0, Math.max(0, room)); if (!f?.path || !content && f.content) break;
    files.push({ path: clean(f.path), content }); room -= content.length + 60;
  }
  return { name, branch: String(x.branch || "main").replace(/[^\w./-]/g, "").slice(0, 100) || "main", tree, files };
}
const hits = new Map(), cache = {};
const now = () => Date.now();
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e = new Error(`supabase ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 300)); e.status = r.status; throw e; }
  return body;
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || "rpc error"); return j.result;
}
async function cached(key, ms, fn) { const c = cache[key]; if (c && now() - c.t < ms) return c.v; const v = await fn(); cache[key] = { v, t: now() }; return v; }
const ethUsd = () => cached("eth", 120e3, async () => {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"); const j = await r.json();
  const p = Number(j?.ethereum?.usd); if (!(p > 100)) throw new Error("no eth price"); return p;
});
const ctrnUsd = () => cached("ctrn", 120e3, async () => {
  const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"); const j = await r.json();
  const pair = (j.pairs || []).filter(p => String(p.chainId).toLowerCase().includes("robinhood")).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const p = Number(pair?.priceUsd); if (!(p > 0)) throw new Error("no ctrn price"); return p;
});
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

export default async function handler(req, res) {
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: "the terminal is not wired up yet." });
  try {
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      const wallet = readToken(req.query.token, SECRET);
      const [bal, eth, ctrn] = await Promise.all([catBalance().catch(() => null), ethUsd().catch(() => null), ctrnUsd().catch(() => null)]);
      const deposits = wallet ? await sb(`terminal_deposits?wallet=eq.${wallet}&order=at.desc&limit=10&select=tx_hash,asset,amount,usd,credit,at`) : [];
      return res.status(200).json({
        payTo: PAY_TO, chainId: CHAIN_ID, rpc: RPC, price: PRICE, minUsd: MIN_USD, open: bal == null ? true : bal > RESERVE, models: MODELS,
        assets: [{ symbol: "ETH", native: true, usd: eth }, { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, usd: 1 }, { symbol: "CTRN", address: "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a", decimals: 18, usd: ctrn }],
        account: wallet ? await account(wallet) : null, deposits
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const h = (hits.get(ip) || []).filter(t => now() - t < 60e3); if (h.length >= 30) return res.status(429).json({ error: "slow down. the cat is one cat." }); h.push(now()); hits.set(ip, h);
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

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

    if (b.action === "deposit") {
      const tx = String(b.tx || "").toLowerCase(); if (!/^0x[a-f0-9]{64}$/.test(tx)) return res.status(400).json({ error: "that is not a transaction hash." });
      if ((await sb(`terminal_deposits?tx_hash=eq.${tx}&select=wallet`)).length) return res.status(200).json({ ok: true, already: true, account: await account(wallet) });
      const [t, rc] = await Promise.all([rpc("eth_getTransactionByHash", [tx]), rpc("eth_getTransactionReceipt", [tx])]);
      if (!t || !rc) return res.status(202).json({ pending: true });
      if (rc.status !== "0x1") return res.status(400).json({ error: "that transaction failed on chain." });
      if (String(t.from || "").toLowerCase() !== wallet) return res.status(400).json({ error: "that payment came from a different wallet than the one signed in." });
      const block = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]);
      if (now() / 1000 - parseInt(block.timestamp, 16) > MAX_AGE_S) return res.status(400).json({ error: "that payment is older than three days." });
      let usd = 0, asset = "", amount = 0;
      if (String(t.to || "").toLowerCase() === PAY_TO && BigInt(t.value) > 0n) {
        amount = Number(BigInt(t.value)) / 1e18; usd = amount * await ethUsd(); asset = "ETH";
      } else {
        const to = "0x" + PAY_TO.slice(2).padStart(64, "0");
        for (const l of rc.logs || []) {
          const tok = TOKENS[String(l.address).toLowerCase()];
          if (!tok || l.topics?.[0] !== TRANSFER || String(l.topics?.[2] || "").toLowerCase() !== to) continue;
          const n = Number(BigInt(l.data)) / 10 ** tok.decimals; amount += n; usd += n * await tok.usd(); asset = tok.symbol;
        }
      }
      if (!(usd >= MIN_USD)) return res.status(400).json({ error: `no payment of at least $${MIN_USD} to the cat's wallet in that transaction.` });
      const credit = round(usd / PRICE);
      try { await sb("terminal_deposits", { method: "POST", body: JSON.stringify({ tx_hash: tx, wallet, asset, amount: round(amount), usd: round(usd), credit }), prefer: "return=minimal" }); }
      catch (e) { if (e.status === 409) return res.status(200).json({ ok: true, already: true, account: await account(wallet) }); throw e; }
      const a = await account(wallet); await saveAccount({ ...a, credit: Number(a.credit || 0) + credit });
      return res.status(200).json({ ok: true, credited: credit, usd: round(usd), asset, account: await account(wallet) });
    }

    if (b.action === "chat") {
      const model = MODELS.find(m => m.id === b.model)?.id; if (!model) return res.status(400).json({ error: "pick a model from the list." });
      const msgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-24).map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "say something." });
      const repo = readRepo(b.repo), system = repo ? SYSTEM + "\n\n" + repoSystem(repo) : SYSTEM;
      const chars = msgs.reduce((a, m) => a + m.content.length, 0); if (chars > MAX_CHARS) return res.status(400).json({ error: "that conversation is too long. start a new one." });
      const uh = (hits.get(wallet) || []).filter(t => now() - t < 60e3); if (uh.length >= 8) return res.status(429).json({ error: "eight a minute. the cat needs to breathe." }); uh.push(now()); hits.set(wallet, uh);
      if ((await catBalance().catch(() => RESERVE + 1)) <= RESERVE) return res.status(503).json({ error: "the cat's compute is reserved for the cat right now. try again later." });
      const a = await account(wallet), credit = Number(a.credit || 0);
      const p = (await pricing())[model] || { prompt: 0.00001, completion: 0.00005 };
      const inTok = Math.ceil((chars + system.length) / 3.5), inCost = inTok * p.prompt * 1.1;
      const maxTokens = Math.min(repo ? MAX_REPO_TOKENS : MAX_TOKENS, Math.floor((credit - inCost) / (p.completion * 1.1)));
      if (maxTokens < 200) return res.status(402).json({ error: "not enough compute left for that. deposit below.", account: a });
      const r = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${ORBIO_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, ...msgs] }) });
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
