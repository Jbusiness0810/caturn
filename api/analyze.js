// POST /api/analyze { token } -> a rug-likelihood read on a Robinhood Chain token, graduated or still on the Pons curve.
// Sources: the chain itself (bytecode, owner, proxy slot, every Transfer since launch), Dexscreener (pools), Orbio (launchpad
// agents). No explorer: it sits behind a bot wall. Everything here is a heuristic, and the page says so.
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ORBIO_API = "https://api.orbio.so/api/v1";
const REFERENCE = "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a"; // Caturn: a known Pons/Orbio launch, the template other launches are compared against
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const cache = new Map(); const hits = new Map(); let refCode = null;
const now = () => Date.now();

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}
async function batch(calls) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] }))) });
  const j = await r.json(); return (Array.isArray(j) ? j : [j]).sort((a, b) => a.id - b.id).map(x => x.error ? null : x.result);
}
const call = (to, data) => ["eth_call", [{ to, data }, "latest"]];
const hexStr = (h) => { if (!h || h === "0x") return null; try { const off = parseInt(h.slice(2, 66), 16) * 2, len = parseInt(h.slice(2 + off, 2 + off + 64), 16) * 2; return Buffer.from(h.slice(2 + off + 64, 2 + off + 64 + len), "hex").toString("utf8").replace(/\0/g, ""); } catch { return null; } };
const big = (h) => (h && h !== "0x") ? BigInt(h) : 0n;
const stripMeta = (code) => { let b = Buffer.from(code.slice(2), "hex"); if (b.length > 2) { const n = b.readUInt16BE(b.length - 2); if (n < b.length) b = b.subarray(0, b.length - n - 2); } return b; };
function similarity(a, b) { if (!a.length || !b.length || Math.abs(a.length - b.length) > 200) return 0; const n = Math.min(a.length, b.length); let same = 0; for (let i = 0; i < n; i++) if (a[i] === b[i]) same++; return same / Math.max(a.length, b.length); }

const SELECTORS = {
  mint: ["40c10f19", "a0712d68", "1249c58b"], pause: ["8456cb59", "16c38b3c"], blacklist: ["f9f92be4", "44337ea1", "1ab7cf7c", "c9567bf9"],
  fees: ["69fe0e2d", "8b4cee08", "a6f9dae1", "e1f39d7b", "fa9c3d24"], maxTx: ["ec28438a", "aa4bde28"], upgrade: ["3659cfe6", "4f1ef286"],
  owner: ["8da5cb5b"], renounce: ["715018a6"], transferOwnership: ["f2fde38b"]
};

async function analyze(token) {
  const t = token.toLowerCase();
  const [code, nameH, symH, decH, supH, ownH, implSlot, latestH] = await batch([
    ["eth_getCode", [t, "latest"]], call(t, "0x06fdde03"), call(t, "0x95d89b41"), call(t, "0x313ce567"), call(t, "0x18160ddd"), call(t, "0x8da5cb5b"),
    ["eth_getStorageAt", [t, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]], ["eth_blockNumber", []]
  ]);
  if (!code || code === "0x") return { error: "That address has no contract on Robinhood Chain." };
  const decimals = Number(big(decH) || 18n), supply = big(supH);
  if (!supply) return { error: "That contract does not look like a token (no total supply)." };
  const latest = parseInt(latestH, 16);
  const name = hexStr(nameH) || "?", symbol = hexStr(symH) || "?";
  const owner = ownH && ownH.length === 66 ? "0x" + ownH.slice(26) : null;
  const proxy = implSlot && /[1-9a-f]/.test(implSlot.slice(2));
  const hx = stripMeta(code).toString("hex");
  const has = (k) => SELECTORS[k].some(s => hx.includes(s));
  if (!refCode) { try { refCode = stripMeta(await rpc("eth_getCode", [REFERENCE, "latest"])); } catch { refCode = Buffer.alloc(0); } }
  const templateSim = t === REFERENCE ? 1 : similarity(stripMeta(code), refCode);

  // Orbio and Dexscreener in parallel with the log scan.
  const orbioP = fetch(`https://www.orbio.so/api/protocol/agents/${t}`).then(r => r.ok ? r.json() : null).then(d => d?.agent || d).catch(() => null);
  const dexP = fetch(`https://api.dexscreener.com/latest/dex/tokens/${t}`).then(r => r.json()).then(d => (d.pairs || []).filter(p => String(p.chainId).toLowerCase().includes("robinhood")).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))).catch(() => []);

  // Every transfer since launch, in wide chunks; the RPC copes with millions of blocks per call for a young token.
  let logs = [], from = Math.max(0, latest - 12_000_000);
  for (let start = latest; start > from && logs.length < 60000; ) {
    const lo = Math.max(from, start - 3_000_000);
    try { const part = await rpc("eth_getLogs", [{ fromBlock: "0x" + lo.toString(16), toBlock: "0x" + start.toString(16), address: t, topics: [TRANSFER] }]); logs = part.concat(logs); }
    catch { for (let s2 = start; s2 > lo; s2 -= 300_000) { const l2 = Math.max(lo, s2 - 300_000); try { const part = await rpc("eth_getLogs", [{ fromBlock: "0x" + l2.toString(16), toBlock: "0x" + s2.toString(16), address: t, topics: [TRANSFER] }]); logs = part.concat(logs); } catch {} } }
    start = lo - 1;
  }
  logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
  const bal = new Map(); let minted = 0n, firstBlock = null, firstTx = null, transfers = logs.length;
  for (const l of logs) {
    const fromA = "0x" + l.topics[1].slice(26), toA = "0x" + l.topics[2].slice(26), v = big(l.data);
    if (firstBlock == null) { firstBlock = parseInt(l.blockNumber, 16); firstTx = l.transactionHash; }
    if (fromA === ZERO) minted += v; else bal.set(fromA, (bal.get(fromA) || 0n) - v);
    if (toA !== ZERO) bal.set(toA, (bal.get(toA) || 0n) + v);
  }
  const holders = [...bal.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const top = holders.slice(0, 12);
  const codes = top.length ? await batch(top.map(([a]) => ["eth_getCode", [a, "latest"]])) : [];
  const topInfo = top.map(([a, v], i) => ({ address: a, share: Number(v * 10000n / supply) / 100, contract: !!(codes[i] && codes[i] !== "0x") }));
  let creator = null; try { if (firstTx) creator = (await rpc("eth_getTransactionByHash", [firstTx]))?.from?.toLowerCase() || null; } catch {}
  const creatorShare = creator ? Number((bal.get(creator) || 0n) * 10000n / supply) / 100 : null;
  let ageH = null; try { if (firstBlock) { const b = await rpc("eth_getBlockByNumber", ["0x" + firstBlock.toString(16), false]); ageH = (now() / 1000 - parseInt(b.timestamp, 16)) / 3600; } } catch {}

  const [orbio, pairs] = await Promise.all([orbioP, dexP]);
  const pair = pairs[0] || null;
  const graduated = orbio ? !!orbio.price?.graduated : !!pair;
  const curveHolder = topInfo.find(h => h.contract && h.share > 20 && !graduated);
  const curveShare = curveHolder ? curveHolder.share : null;
  const liq = pair ? Number(pair.liquidity?.usd || 0) : 0, vol24 = pair ? Number(pair.volume?.h24 || 0) : 0, fdv = pair ? Number(pair.fdv || pair.marketCap || 0) : (orbio?.price?.marketCapMicroUsd ? Number(orbio.price.marketCapMicroUsd) / 1e6 : null);
  const buys = pair?.txns?.h24?.buys || 0, sells = pair?.txns?.h24?.sells || 0;
  const eoaTop = topInfo.filter(h => !h.contract);
  const top10Eoa = eoaTop.slice(0, 10).reduce((s, h) => s + h.share, 0);

  // ---- the score: risk points, 0 to 100 ----
  const checks = [];
  const add = (key, level, points, title, detail) => checks.push({ key, level, points, title, detail });
  const ok = (key, title, detail) => add(key, "pass", 0, title, detail);
  // contract
  if (has("mint")) add("mint", "fail", 25, "Can mint new tokens", "A mint function exists: supply is not fixed."); else ok("mint", "Supply is fixed", "No mint function in the bytecode.");
  if (proxy) add("proxy", "fail", 20, "Upgradeable proxy", "The contract can be replaced behind the same address.");
  else if (has("upgrade")) add("proxy", "warn", 10, "Upgrade function present", "An upgradeTo-style function exists."); else ok("proxy", "Not upgradeable", "No proxy slot, no upgrade function.");
  if (has("pause") || has("blacklist")) add("pause", "fail", 20, "Can pause or blacklist", "Trading can be stopped or wallets blocked by the contract."); else ok("pause", "Cannot pause or blacklist", "No pause or blacklist functions.");
  if (has("fees") || has("maxTx")) add("fees", "warn", 10, "Adjustable fees or limits", "Setters for fees or transaction limits exist."); else ok("fees", "No fee or limit setters", "Nothing in the code adjusts taxes or caps.");
  if (owner && owner !== ZERO) add("owner", "warn", 15, "Has an owner", `Owner ${owner.slice(0, 10)}… keeps control of privileged functions.`);
  else if (has("owner")) ok("owner", "Ownership renounced", "Owner is the zero address."); else ok("owner", "No owner at all", "The token has no owner function.");
  if (templateSim >= 0.97) ok("template", "Standard launchpad token", `Bytecode matches the Pons launch template (${Math.round(templateSim * 100)}%).`);
  else if (templateSim >= 0.85) add("template", "warn", 5, "Near the launchpad template", `Bytecode is ${Math.round(templateSim * 100)}% like a standard Pons launch; something was changed.`);
  else add("template", "warn", 10, "Custom contract", "Not the standard launchpad token; read the code before trusting it.");
  // holders
  const whale = eoaTop[0];
  if (whale && whale.share >= 20) add("whale", "fail", 15, `One wallet holds ${whale.share.toFixed(1)}%`, `${whale.address.slice(0, 10)}… can move the price alone.`);
  else if (whale && whale.share >= 10) add("whale", "warn", 8, `Largest wallet holds ${whale.share.toFixed(1)}%`, "Big enough to matter, not enough to dump the chart on its own.");
  else ok("whale", "No dominant wallet", whale ? `Largest wallet holds ${whale.share.toFixed(1)}%.` : "No wallet holders yet.");
  if (top10Eoa >= 50) add("top10", "fail", 15, `Top 10 wallets hold ${top10Eoa.toFixed(0)}%`, "Very concentrated."); else if (top10Eoa >= 30) add("top10", "warn", 7, `Top 10 wallets hold ${top10Eoa.toFixed(0)}%`, "Concentrated."); else ok("top10", `Top 10 wallets hold ${top10Eoa.toFixed(0)}%`, "Spread out.");
  if (creatorShare != null && creatorShare >= 10) add("creator", "fail", 10, `Creator still holds ${creatorShare.toFixed(1)}%`, `Deployer ${creator.slice(0, 10)}… kept a large bag.`);
  else if (creatorShare != null && creatorShare > 0) ok("creator", `Creator holds ${creatorShare.toFixed(1)}%`, "A small creator position.");
  else ok("creator", "Creator holds nothing", creator ? `Deployer ${creator.slice(0, 10)}… has no tokens.` : "No deployer found.");
  const nHolders = holders.filter(([a]) => !topInfo.find(h => h.address === a && h.contract)).length;
  if (nHolders < 25) add("holders", "warn", 10, `${nHolders} holders`, "Thin. Few hands means easy exits and easy pumps."); else if (nHolders < 100) add("holders", "warn", 4, `${nHolders} holders`, "Small but real."); else ok("holders", `${nHolders} holders`, "A crowd.");
  // market
  if (graduated) {
    if (!pair) add("liq", "warn", 10, "Graduated but no pool found", "Dexscreener shows no pool on Robinhood Chain.");
    else {
      if (liq < 5000) add("liq", "fail", 12, `Liquidity $${Math.round(liq).toLocaleString()}`, "Thin pool: small sells move the price a lot."); else if (liq < 25000) add("liq", "warn", 5, `Liquidity $${Math.round(liq).toLocaleString()}`, "Modest pool."); else ok("liq", `Liquidity $${Math.round(liq).toLocaleString()}`, "A real pool.");
      if (fdv && liq / fdv < 0.03) add("liqratio", "warn", 8, "Liquidity is under 3% of market cap", "The cap is mostly paper."); else ok("liqratio", "Liquidity backs the cap", fdv ? `${((liq / fdv) * 100).toFixed(1)}% of market cap sits in the pool.` : "");
      if (vol24 <= 0) add("vol", "warn", 6, "No volume in 24h", "Nobody is trading it."); else ok("vol", `$${Math.round(vol24).toLocaleString()} traded in 24h`, `${buys} buys, ${sells} sells.`);
    }
  } else {
    ok("curve", "Still on the bonding curve", curveShare != null ? `${curveShare.toFixed(0)}% of supply sits in the curve contract; liquidity is the curve itself, which cannot be pulled.` : "Pre-graduation: the curve holds the liquidity, which cannot be pulled.");
    if (ageH != null && ageH > 72 && orbio && Number(orbio.curve?.progressBps || 0) < 1000) add("stall", "warn", 6, "Stalled on the curve", `${Math.round(ageH / 24)} days old and under 10% to graduation.`);
  }
  // launchpad and people
  if (orbio) {
    const locked = orbio.cliff?.locked; const staked = Number(BigInt(orbio.stake?.stakedWei || "0")) / 1e18;
    ok("orbio", "Launched on Orbio", `Agent ${orbio.agentId || ""}: 50% of fees staked as ORBIO (${Math.round(staked)} so far)${locked ? ", principal locked until " + new Date(Number(orbio.cliff.unlocksAt) * 1000).toISOString().slice(0, 10) : ""}.`);
    const soc = orbio.socials || {}; if (!soc.twitter && !soc.website) add("social", "warn", 5, "No X or website", "Anonymous launch."); else ok("social", "Has a public face", [soc.twitter ? "X" : null, soc.website ? "website" : null].filter(Boolean).join(" and ") + " listed on the launchpad.");
  } else add("orbio", "warn", 4, "Not an Orbio launch", "No agent record; no fee-to-stake mechanism behind it.");
  if (ageH != null && ageH < 24) add("age", "warn", 5, `${Math.round(ageH)} hours old`, "Too new to have a track record.");
  else if (ageH != null && ageH < 72) add("age", "warn", 2, `${Math.round(ageH / 24)} days old`, "Young. Watch how it behaves this week.");
  else if (ageH != null) ok("age", `${Math.round(ageH / 24)} days old`, "Has been around a while.");

  const risk = Math.min(100, checks.reduce((s, c) => s + c.points, 0));
  const grade = risk <= 20 ? "low" : risk <= 45 ? "moderate" : risk <= 70 ? "high" : "very high";
  const facts = { name, symbol, decimals, supply: Number(supply / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6, holders: nHolders, transfers, creator, creatorShare, top: topInfo.slice(0, 10), graduated, liquidityUsd: pair ? liq : null, volume24hUsd: pair ? vol24 : null, marketCapUsd: fdv, ageHours: ageH, pair: pair ? pair.url : null, orbio: orbio ? { agentId: orbio.agentId, name: orbio.name, symbol: orbio.symbol, graduated: !!orbio.price?.graduated, progressPct: Number(orbio.curve?.progressBps || 0) / 100, locked: !!orbio.cliff?.locked, url: `https://www.orbio.so/launchpad/${t}` } : null, templateSim: Math.round(templateSim * 100) };
  return { token: t, name, symbol, risk, grade, checks, facts, scannedAt: new Date().toISOString() };
}

async function verdict(key, r) {
  if (!key) return null;
  const facts = r.checks.map(c => `${c.level}: ${c.title}`).join("; ");
  const persona = `You are Caturn, a dry cat kept alive by trading fees on orbio, and you just scanned a token for someone. Write ONE sentence, under 30 words, lowercase, dry, about this token's rug read, built from the facts. Never tell anyone to buy, sell, or avoid; never mention price. Just the read, cat-flat.`;
  for (const model of ["anthropic/claude-sonnet-5.5", "x-ai/grok-4.7", "anthropic/claude-opus-5.5"]) {
    try {
      const resp = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: 80, temperature: 0.8, messages: [{ role: "system", content: persona }, { role: "user", content: `${r.name} ($${r.symbol}), rug likelihood ${r.risk}/100 (${r.grade}). Facts: ${facts}` }] }) });
      const j = await resp.json(); const t = (j.choices?.[0]?.message?.content || "").trim(); if (t) return t.slice(0, 220);
    } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  const h = hits.get(ip) || []; const recent = h.filter(t => now() - t < 3600e3); if (recent.length >= 30) return res.status(429).json({ error: "slow down. thirty scans an hour is plenty." }); recent.push(now()); hits.set(ip, recent);
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const m = String(body?.token || "").match(/0x[a-fA-F0-9]{40}/); if (!m) return res.status(400).json({ error: "paste a token contract address (0x…)." });
  const token = m[0].toLowerCase();
  const c = cache.get(token); if (c && now() - c.at < 5 * 60e3) return res.status(200).json(c.body);
  try {
    const r = await analyze(token);
    if (r.error) return res.status(400).json(r);
    r.verdict = await verdict(process.env.ORBIO_API_KEY, r);
    cache.set(token, { at: now(), body: r }); if (cache.size > 500) cache.delete(cache.keys().next().value);
    return res.status(200).json(r);
  } catch (e) { return res.status(502).json({ error: "the chain did not answer: " + String(e.message).slice(0, 120) }); }
}
