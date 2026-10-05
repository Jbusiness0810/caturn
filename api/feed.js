// GET /api/feed -> the live data/feed.json straight from the master branch on GitHub.
// The agent commits the feed every few minutes; serving it from git means the site never waits on a redeploy.
const REPO = process.env.CATURN_REPO || "Jbusiness0810/caturn";
// The agent uploads the live feed to a rolling GitHub release every tick; the git copy is a snapshot per loop.
const LIVE = `https://github.com/${REPO}/releases/download/sketches/feed.json`;
// the always-on runner publishes to Supabase storage; the release is what GitHub Actions wrote
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), BUCKET = process.env.CATURN_BUCKET || "caturn";
const STORE = SB ? `${SB}/storage/v1/object/public/${BUCKET}/feed.json` : null;
const RAW = `https://raw.githubusercontent.com/${REPO}/master/data/feed.json`;
let cache = { at: 0, body: null };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (Date.now() - cache.at < 20e3 && cache.body) return res.status(200).send(cache.body);
  try {
    const t = Math.floor(Date.now() / 15e3);
    let r = STORE ? await fetch(`${STORE}?t=${t}`, { cache: "no-store", headers: { "user-agent": "caturn.lol" } }).catch(() => null) : null;
    if (!r || !r.ok) r = await fetch(`${LIVE}?t=${t}`, { cache: "no-store", redirect: "follow", headers: { "user-agent": "caturn.lol" } }).catch(() => null);
    if (!r || !r.ok) r = await fetch(`${RAW}?t=${t}`, { cache: "no-store", headers: { "user-agent": "caturn.lol" } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    // files on the release are served from caturn.lol, so no URL on the site names the account behind it
    let body = (await r.text()).split(`https://github.com/${REPO}/releases/download/sketches/`).join("https://www.caturn.lol/a/");
    if (SB) body = body.split(`${SB}/storage/v1/object/public/${BUCKET}/`).join("https://www.caturn.lol/a/");
    const parsed = JSON.parse(body); // never cache something that is not a feed
    if (cache.body && Date.parse(parsed.updatedAt || 0) < Date.parse(JSON.parse(cache.body).updatedAt || 0)) return res.status(200).send(cache.body); // never go backwards
    cache = { at: Date.now(), body };
    return res.status(200).send(body);
  } catch (e) {
    if (cache.body) return res.status(200).send(cache.body);
    return res.status(502).json({ error: String(e.message).slice(0, 160) });
  }
}
