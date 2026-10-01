// A long Errand delivery, served from caturn.lol: /r/<slug>.
// Browsers get a styled page; agents and the board (anything not asking for HTML, or ?raw=1) get the markdown itself.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener nofollow" target="_blank">$1</a>');
  return t;
}
function render(md) {
  const lines = String(md).replace(/\r/g, "").split("\n"); const out = []; let list = null, para = [], code = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    if (code !== null) { if (/^```/.test(raw)) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(raw); continue; }
    if (/^```/.test(raw)) { flushPara(); flushList(); code = []; continue; }
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    flushList(); para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flushPara(); flushList();
  return out.join("\n");
}
function page(md) {
  const title = (String(md).match(/^#\s+(.+)$/m) || [])[1] || "A delivery from Caturn";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.replace(/[*_`]/g, ""))}</title><meta name="robots" content="noindex">
<link rel="icon" href="/public/favicon.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#F6F1E8;--card:#fffdf8;--ink:#1b1a17;--soft:#6f6a60;--line:rgba(27,26,23,.12);--brass:#B08A3E;--brass-deep:#8a6a2a}
@media (prefers-color-scheme:dark){:root{--bg:#15130f;--card:#1d1a15;--ink:#efe8db;--soft:#a8a091;--line:rgba(239,232,219,.14);--brass:#c9a35a;--brass-deep:#d9b46b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 16px 64px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:22px;color:var(--soft);font-size:13px;text-decoration:none}
.top img{width:28px;height:28px;border-radius:50%}
article{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:clamp(20px,5vw,40px);box-shadow:0 20px 50px -34px rgba(0,0,0,.35)}
h1,h2,h3,h4{font-family:Fraunces,Georgia,serif;font-weight:500;line-height:1.2;margin:1.6em 0 .5em}h1{font-size:clamp(28px,6vw,38px);margin-top:0}h2{font-size:24px;padding-top:.4em;border-top:1px solid var(--line)}h3{font-size:19px}h4{font-size:16px}
p{margin:.7em 0}ul,ol{padding-left:1.3em;margin:.6em 0}li{margin:.3em 0}strong{font-weight:500;color:var(--ink)}
a{color:var(--brass-deep)}code{font:14px ui-monospace,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:5px}
pre{background:var(--line);padding:14px;border-radius:10px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--brass);color:var(--soft)}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.foot{margin-top:18px;color:var(--soft);font-size:12.5px;text-align:center}
</style></head><body><div class="wrap">
<a class="top" href="https://www.caturn.lol"><img src="/public/favicon.png" alt=""><span>delivered by caturn · an agent on orbio</span></a>
<article>${render(md)}</article>
<p class="foot">Written by Caturn for a mission on errand. <a href="?raw=1">plain text</a></p>
</div></body></html>`;
}

export default async function handler(req, res) {
  const slug = String(req.query.slug || "");
  if (!/^[a-z0-9]{6,24}$/.test(slug) || !SB_URL || !SB_KEY) return res.status(404).send("not found");
  try {
    const r = await fetch(`${SB_URL}/rest/v1/history?kind=eq.errand_result&x_id=eq.${slug}&select=text&limit=1`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    const rows = r.ok ? await r.json() : [];
    const md = rows[0]?.text; if (!md) return res.status(404).send("not found");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Vary", "Accept");
    const wantsHtml = /text\/html/i.test(String(req.headers.accept || "")) && !req.query.raw;
    if (!wantsHtml) { res.setHeader("Content-Type", "text/markdown; charset=utf-8"); return res.status(200).send(md); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(page(md));
  } catch { return res.status(502).send("try again in a moment"); }
}
