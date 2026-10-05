// Mindshare: once a day, the share of attention each Robinhood Chain token gets on X, drawn as a treemap.
// Size is the token's share of all the attention measured; color is how that share moved against yesterday.
// The measuring (reads through orbio's X reader) lives in run.mjs; this file ranks, lays out and draws.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// One token's attention from a sample of its latest posts: each post counts once plus its reach, and a sample that
// covers less than a day is scaled up to a day's rate (capped, so a burst of ten posts in a minute is not a week's worth).
export function attention(posts, now = Date.now()) {
  const day = posts.filter(p => p.at && now - Date.parse(p.at) < 24 * 3600e3 && now - Date.parse(p.at) > -600e3);
  if (!day.length) return { score: 0, posts: 0, reach: 0 };
  const reach = day.reduce((s, p) => s + (p.likes || 0) + 2 * (p.reposts || 0) + (p.replies || 0) + (p.views || 0) / 100, 0);
  let score = day.reduce((s, p) => s + 1 + Math.log2(1 + (p.likes || 0) + 2 * (p.reposts || 0) + (p.replies || 0) + (p.views || 0) / 100), 0);
  const oldest = Math.min(...day.map(p => Date.parse(p.at))), spanH = Math.max(0.5, (now - oldest) / 3600e3);
  if (day.length >= 4 && day.length === posts.length && spanH < 24) score *= Math.min(6, 24 / spanH); // the sample ran out before the day did
  return { score, posts: day.length, reach: Math.round(reach) };
}

// Shares over everything measured, deltas against yesterday's shares by symbol, top n kept for the picture.
export function rank(samples, prevShares = {}, n = 50) {
  const total = samples.reduce((s, x) => s + x.score, 0) || 1;
  return samples.map(x => ({ ...x, share: x.score / total * 100 }))
    .sort((a, b) => b.share - a.share).slice(0, n)
    .map(x => ({ ...x, delta: prevShares[x.symbol] != null ? x.share - prevShares[x.symbol] : null }));
}

// Squarified treemap: items (value v, sorted by v descending) fill the rectangle; each strip is laid along the shorter side.
export function squarify(items, x, y, w, h) {
  const out = []; let rest = items.filter(i => i.v > 0); let rx = x, ry = y, rw = w, rh = h;
  while (rest.length && rw > 0 && rh > 0) {
    const scale = (rw * rh) / rest.reduce((s, i) => s + i.v, 0);
    const vertical = rw >= rh, side = vertical ? rh : rw; // a vertical strip when the space is wider than tall
    let row = [], rowSum = 0, best = Infinity;
    for (const it of rest) {
      const sum = rowSum + it.v, len = sum * scale / side;
      let worst = 0; for (const c of [...row, it]) { const l = c.v * scale / len; worst = Math.max(worst, len / l, l / len); }
      if (worst <= best) { row.push(it); rowSum = sum; best = worst; } else break;
    }
    const len = rowSum * scale / side; let off = 0;
    for (const c of row) { const l = c.v * scale / len; out.push(vertical ? { ...c, x: rx, y: ry + off, w: len, h: l } : { ...c, x: rx + off, y: ry, w: l, h: len }); off += l; }
    if (vertical) { rx += len; rw -= len; } else { ry += len; rh -= len; }
    rest = rest.slice(row.length);
  }
  return out;
}

const tileColor = (d) => {
  if (d == null || Math.abs(d) < 0.25) return "#262a31";
  const k = Math.min(1, Math.abs(d) / 6); // six points of share is the full color
  return d > 0 ? `rgb(${Math.round(40 + 10 * k)}, ${Math.round(80 + 70 * k)}, ${Math.round(60 + 30 * k)})` : `rgb(${Math.round(120 + 70 * k)}, ${Math.round(50 + 10 * k)}, ${Math.round(50 + 10 * k)})`;
};
const fmtDelta = (d) => d == null ? "" : `${d > 0 ? "+" : ""}${d.toFixed(2)}`;

export function mindshareHtml({ rows, date, postsRead, tokensRead, title }) {
  const W = 1200, H = 675, PAD = 20, TOP = 64, FOOT = 40;
  const tiles = squarify(rows.map(r => ({ ...r, v: r.share })), PAD, TOP, W - 2 * PAD, H - TOP - FOOT);
  const tileHtml = tiles.map(t => {
    const area = t.w * t.h, big = area > 26000, mid = area > 9000, small = area > 3200;
    const fs = big ? 30 : mid ? 22 : small ? 16 : 12, sub = big ? 17 : mid ? 14 : 11;
    const show = t.w > 56 && t.h > 30;
    return `<div class="tile" style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${Math.max(0, t.w - 3).toFixed(1)}px;height:${Math.max(0, t.h - 3).toFixed(1)}px;background:${tileColor(t.delta)}">
      ${show ? `<div class="sym" style="font-size:${fs}px">$${esc(t.symbol)}</div><div class="num" style="font-size:${sub}px">${t.share.toFixed(2)}%${t.delta != null && (mid || t.w > 110) ? ` <span class="d ${t.delta > 0 ? "up" : t.delta < 0 ? "dn" : ""}">${fmtDelta(t.delta)}</span>` : ""}</div>` : ""}
    </div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0d0f13}
  body{width:${W}px;height:${H}px;position:relative;overflow:hidden;font-family:"DejaVu Sans","Helvetica Neue",Arial,sans-serif;color:#e8eaf0}
  .hd{position:absolute;left:${PAD}px;top:18px;font-size:24px;font-weight:700;letter-spacing:.2px}
  .hd b{color:#8de0b0}
  .hd span{color:#8a90a0;font-weight:400;font-size:16px;margin-left:12px}
  .key{position:absolute;right:${PAD}px;top:24px;font-size:15px;color:#8a90a0}
  .tile{position:absolute;border-radius:4px;box-sizing:border-box;padding:8px 10px;overflow:hidden}
  .sym{font-weight:700;line-height:1.05;white-space:nowrap}
  .num{margin-top:4px;color:#d4d8e2;font-family:"DejaVu Sans Mono",Menlo,monospace;white-space:nowrap}
  .d.up{color:#a8f0c6}.d.dn{color:#ffb3b3}
  .ft{position:absolute;left:${PAD}px;right:${PAD}px;bottom:12px;font-size:13px;color:#8a90a0;display:flex;justify-content:space-between;letter-spacing:.3px}
  .ft b{color:#c9ced9}
  </style></head><body>
  <div class="hd"><b>caturn.lol</b> ${esc(title || `top ${rows.length} by mindshare`)}<span>robinhood chain · ${esc(date)}</span></div>
  <div class="key">size = share of attention · color = change vs yesterday</div>
  ${tileHtml}
  <div class="ft"><div>${tokensRead} tokens measured from ${postsRead} posts on x in the last 24h, weighted by reach</div><div>ANALYSIS BY <b>CATURN</b> &nbsp;|&nbsp; <b>@caturn_rh</b> &nbsp;|&nbsp; NOT ADVICE</div></div>
  <script>for (const el of document.querySelectorAll(".sym,.num")) { let s = parseFloat(getComputedStyle(el).fontSize); const room = el.parentElement.clientWidth - 20; while (s > 9 && el.scrollWidth > room) { s -= 1; el.style.fontSize = s + "px"; } }</script>
  </body></html>`;
}
