// GET /api/sky -> every agent on the Orbio launchpad, trimmed for the sky map. Cached two minutes.
const PROTOCOL = "https://www.orbio.so/api/protocol/agents";
let cache = { at: 0, body: null };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (Date.now() - cache.at < 120e3 && cache.body) return res.status(200).send(cache.body);
  try {
    const all = []; let orbioUsd = 0, total = 0;
    for (let off = 0; off < 600; off += 60) {
      const r = await fetch(`${PROTOCOL}?limit=60&offset=${off}`, { headers: { "user-agent": "caturn.lol sky" } });
      if (!r.ok) throw new Error(`orbio ${r.status}`);
      const d = await r.json();
      orbioUsd = Number(d.orbioMicroUsd || 0) / 1e6; total = Number(d.page?.total || 0);
      all.push(...(d.data || []));
      if (!d.data?.length || all.length >= total) break;
    }
    const wei = (s) => Number(BigInt(s || "0")) / 1e18;
    const now = Date.now() / 1000;
    const agents = all.map(a => ({
      id: a.agentId, name: String(a.name || "").slice(0, 40), symbol: String(a.symbol || "").slice(0, 12), token: a.token,
      mcap: Number(a.price?.marketCapMicroUsd || 0) / 1e6,
      fees: (wei(a.stake?.claimedFeesWei) + wei(a.stake?.protocolFeeWei)) * orbioUsd, // lifetime creator fees, USD
      staked: wei(a.stake?.stakedWei), ageH: a.launchedAt ? Math.max(0, (now - Number(a.launchedAt)) / 3600) : null,
      graduated: !!a.price?.graduated, logo: a.logo || null,
      x: (String(a.socials?.twitter || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/) || [])[1] || null
    })).filter(a => a.token);
    const body = JSON.stringify({ at: new Date().toISOString(), orbioUsd, total: agents.length, agents });
    cache = { at: Date.now(), body };
    return res.status(200).send(body);
  } catch (e) {
    if (cache.body) return res.status(200).send(cache.body);
    return res.status(502).json({ error: String(e.message).slice(0, 160) });
  }
}
