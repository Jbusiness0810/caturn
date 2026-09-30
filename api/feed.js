// GET /api/feed -> the live data/feed.json straight from the master branch on GitHub.
// The agent commits the feed every few minutes; serving it from git means the site never waits on a redeploy.
const REPO = process.env.CATURN_REPO || "Jbusiness0810/caturn";
// The agent uploads the live feed to a rolling GitHub release every tick; the git copy is a snapshot per loop.
const LIVE = `https://github.com/${REPO}/releases/download/sketches/feed.json`;
const RAW = `https://raw.githubusercontent.com/${REPO}/master/data/feed.json`;
let cache = { at: 0, body: null };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (Date.now() - cache.at < 20e3 && cache.body) return res.status(200).send(cache.body);
  try {
    const t = Math.floor(Date.now() / 15e3);
    let r = await fetch(`${LIVE}?t=${t}`, { cache: "no-store", redirect: "follow", headers: { "user-agent": "caturn.lol" } }).catch(() => null);
    if (!r || !r.ok) r = await fetch(`${RAW}?t=${t}`, { cache: "no-store", headers: { "user-agent": "caturn.lol" } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const body = await r.text();
    const parsed = JSON.parse(body); // never cache something that is not a feed
    if (cache.body && Date.parse(parsed.updatedAt || 0) < Date.parse(JSON.parse(cache.body).updatedAt || 0)) return res.status(200).send(cache.body); // never go backwards
    cache = { at: Date.now(), body };
    return res.status(200).send(body);
  } catch (e) {
    if (cache.body) return res.status(200).send(cache.body);
    return res.status(502).json({ error: String(e.message).slice(0, 160) });
  }
}
