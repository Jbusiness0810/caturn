// GET /api/asks -> { asks: [...], tracked: boolean }  Recent terminal exchanges from Vercel Blob (last 3 days).
import { get } from "@vercel/blob";
let cache = { at: 0, body: null };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(200).json({ asks: [], tracked: false });
  if (Date.now() - cache.at < 20e3 && cache.body) return res.status(200).json(cache.body);
  try {
    const days = [0, 1, 2].map(d => new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10));
    const parts = await Promise.all(days.map(async d => { try { const g = await get(`asks/${d}.json`, { access: "private", useCache: false }); return g ? JSON.parse(await new Response(g.stream).text()) : []; } catch { return []; } }));
    const asks = parts.flat().filter(a => a && a.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-200);
    cache = { at: Date.now(), body: { asks, tracked: true } };
    return res.status(200).json(cache.body);
  } catch (e) { return res.status(200).json({ asks: [], tracked: true, error: String(e.message).slice(0, 120) }); }
}
