// /a/<file> -> a file from the agent's rolling release (sketch GIFs, build screenshots), served from caturn.lol.
const REPO = process.env.CATURN_REPO || "Jbusiness0810/caturn";
const TYPES = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", webp: "image/webp", md: "text/markdown; charset=utf-8" };
export default async function handler(req, res) {
  const name = String(req.query.name || "");
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(name) || !TYPES[ext] || name === "feed.json") return res.status(404).send("not found");
  try {
    const r = await fetch(`https://github.com/${REPO}/releases/download/sketches/${name}`, { redirect: "follow", headers: { "user-agent": "caturn.lol" } });
    if (!r.ok) return res.status(404).send("not found");
    res.setHeader("Content-Type", TYPES[ext]);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch { return res.status(502).send("try again in a moment"); }
}
