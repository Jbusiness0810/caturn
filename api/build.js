// The workshop: ideas in, small browser apps out. Storage is Supabase (service key, server side only).
// GET  /api/build            -> queue, current build, shipped list, the dev-hours meter
// GET  /api/build?html=<id>  -> the built app itself, served sandboxed (rewritten from /b/<id>)
// POST /api/build {action:"submit", text} | {action:"vote", id}
import { createHash } from "node:crypto";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ORBIO_API = "https://api.orbio.so/api/v1";
const MODELS = (process.env.ASK_MODELS || "anthropic/claude-sonnet-5.5,x-ai/grok-4.7,anthropic/claude-opus-5.5").split(",").map(s => s.trim()).filter(Boolean);
const MAX_IDEA = 200, PER_IP_PER_DAY = 3;
const hits = new Map(); // burst limiter per IP, in memory
const now = () => Date.now();

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e = new Error(`supabase ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 300)); e.status = r.status; throw e; }
  return body;
}
const ipHash = (ip) => createHash("sha256").update("caturn-build|" + ip + "|" + SB_KEY.slice(0, 24)).digest("hex").slice(0, 32);

// A quick read of the idea: safe to build, and a working title.
async function moderate(text) {
  const key = process.env.ORBIO_API_KEY; if (!key) return { ok: true, title: text.slice(0, 48) };
  const system = `You screen ideas for a free public workshop where an AI cat builds tiny single-file browser apps (games, toys, tools, generators) that run with no network, no accounts, no wallets. Reject: anything hateful, sexual, violent, illegal, harassing or targeting a person; anything that imitates a real brand, company or person; anything that asks for passwords, seed phrases, wallets, payments or personal data; anything that needs a server, a login, live data or an API. Accept everything else, including silly things. Answer with one JSON object only: {"ok": true|false, "reason": "one short dry line if rejected, else empty", "title": "a 2 to 5 word title for the app, lowercase"}.`;
  for (const model of MODELS) {
    try {
      const r = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: 120, temperature: 0.2 }) });
      const body = await r.json().catch(() => ({})); if (!r.ok) continue;
      const m = String(body.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); if (!m) continue;
      const j = JSON.parse(m[0]); return { ok: !!j.ok, reason: String(j.reason || "").slice(0, 160), title: String(j.title || text.slice(0, 48)).toLowerCase().slice(0, 48) };
    } catch {}
  }
  return { ok: true, title: text.slice(0, 48) }; // the builder screens again before it writes code
}

function sandboxHeaders(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https://www.caturn.lol https://caturn.lol http://localhost:*");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Cache-Control", "public, max-age=60");
}

export default async function handler(req, res) {
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: "the workshop has no shelves yet (no database configured)." });
  try {
    if (req.method === "GET" && req.query.html) {
      const id = Number(req.query.html); if (!Number.isFinite(id)) return res.status(400).send("no such build");
      const steps = await sb(`build_steps?idea_id=eq.${id}&order=n.desc&limit=1&select=html,n`);
      const html = steps?.[0]?.html; if (!html) { res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.status(404).send("<p style='font-family:sans-serif;padding:2em'>nothing built here yet. the cat is asleep or thinking.</p>"); }
      if (req.query.download) { // the export: the same file, saved to run anywhere (a double-click opens it; no server needed)
        const row = (await sb(`ideas?id=eq.${id}&select=title`))[0]; const slug = String(row?.title || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="caturn-${slug}.html"`); res.setHeader("Cache-Control", "public, max-age=60");
        return res.status(200).send(html);
      }
      sandboxHeaders(res); return res.status(200).send(html);
    }
    if (req.method === "GET") {
      const [queued, building, shipped, recentSteps] = await Promise.all([
        sb(`ideas?status=eq.queued&order=votes.desc,created_at.asc&limit=30&select=id,text,votes,created_at,title`),
        sb(`ideas?status=eq.building&order=created_at.asc&limit=1&select=id,text,title,steps_done,steps_total,votes,created_at`),
        sb(`ideas?status=eq.shipped&order=shipped_at.desc&limit=24&select=id,text,title,shipped_at,votes,build_id`),
        sb(`build_steps?order=created_at.desc&limit=8&select=idea_id,n,note,created_at,cost`)
      ]);
      res.setHeader("Cache-Control", "public, max-age=15");
      return res.status(200).json({ queued, building: building[0] || null, shipped, steps: recentSteps, at: new Date().toISOString() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const h = (hits.get(ip) || []).filter(t => now() - t < 60e3); if (h.length >= 10) return res.status(429).json({ error: "slow down. the cat is one cat." }); h.push(now()); hits.set(ip, h);
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const who = ipHash(ip);
    if (b.action === "vote") {
      const id = Number(b.id); if (!Number.isFinite(id)) return res.status(400).json({ error: "which one?" });
      try { await sb("votes", { method: "POST", body: JSON.stringify({ idea_id: id, ip_hash: who }), prefer: "return=minimal" }); }
      catch (e) { if (e.status === 409) return res.status(200).json({ ok: true, already: true }); throw e; }
      const cur = await sb(`ideas?id=eq.${id}&select=votes`); const votes = Number(cur?.[0]?.votes || 0) + 1;
      await sb(`ideas?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ votes }), prefer: "return=minimal" });
      return res.status(200).json({ ok: true, votes });
    }
    if (b.action === "submit") {
      const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_IDEA);
      if (text.length < 8) return res.status(400).json({ error: "say a little more than that." });
      if (/https?:\/\/|0x[a-f0-9]{40}/i.test(text)) return res.status(400).json({ error: "no links or addresses. describe the thing." });
      const since = new Date(now() - 86400e3).toISOString();
      const mine = await sb(`ideas?ip_hash=eq.${who}&created_at=gte.${encodeURIComponent(since)}&select=id`);
      if (mine.length >= PER_IP_PER_DAY) return res.status(429).json({ error: "three ideas a day per person. the cat has one keyboard." });
      const dup = await sb(`ideas?status=in.(queued,building)&text=ilike.${encodeURIComponent("%" + text.slice(0, 40).replace(/[%_]/g, "") + "%")}&select=id&limit=1`);
      if (dup.length) return res.status(409).json({ error: "that one is already in the queue. vote for it instead." });
      const m = await moderate(text);
      const row = await sb("ideas", { method: "POST", body: JSON.stringify({ text, ip_hash: who, status: m.ok ? "queued" : "rejected", reject_reason: m.ok ? null : m.reason, title: m.title }) });
      if (!m.ok) return res.status(200).json({ ok: false, rejected: true, reason: m.reason || "not that one." });
      return res.status(200).json({ ok: true, id: row?.[0]?.id, title: m.title });
    }
    return res.status(400).json({ error: "what?" });
  } catch (e) {
    console.error("build api:", e.message);
    return res.status(502).json({ error: "the shelf wobbled. try again in a moment." });
  }
}
