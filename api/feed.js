// GET /api/feed -> the live data/feed.json straight from the master branch on GitHub.
// The agent commits the feed every few minutes; serving it from git means the site never waits on a redeploy.
const REPO = process.env.CATURN_REPO || "Jbusiness0810/caturn";
const RAW = `https://raw.githubusercontent.com/${REPO}/master/data/feed.json`;
let cache = { at: 0, body: null };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (Date.now() - cache.at < 20e3 && cache.body) return res.status(200).send(cache.body);
  try {
    const r = await fetch(`${RAW}?t=${Math.floor(Date.now() / 15e3)}`, { cache: "no-store", headers: { "user-agent": "caturn.lol" } });
    if (!r.ok) throw new Error(`raw ${r.status}`);
    const body = await r.text();
    JSON.parse(body); // never cache something that is not a feed
    cache = { at: Date.now(), body };
    return res.status(200).send(body);
  } catch (e) {
    if (cache.body) return res.status(200).send(cache.body);
    return res.status(502).json({ error: String(e.message).slice(0, 160) });
  }
}
