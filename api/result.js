// A long Errand delivery, served from caturn.lol: /r/<slug> -> the markdown the cat handed in.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";

export default async function handler(req, res) {
  const slug = String(req.query.slug || "");
  if (!/^[a-z0-9]{6,24}$/.test(slug) || !SB_URL || !SB_KEY) return res.status(404).send("not found");
  try {
    const r = await fetch(`${SB_URL}/rest/v1/history?kind=eq.errand_result&x_id=eq.${slug}&select=text&limit=1`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    const rows = r.ok ? await r.json() : [];
    if (!rows[0]?.text) return res.status(404).send("not found");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(rows[0].text);
  } catch { return res.status(502).send("try again in a moment"); }
}
