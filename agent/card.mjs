// A data card for a post: the move in big numbers, a small table and a sparkline, rendered to PNG in headless Chrome.
// An image post costs orbio about 3.5 cents against 22 for a link, and a chart stops a scroll where a link card does not.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

function spark(points, w = 520, h = 120) {
  const ys = points.filter(Number.isFinite); if (ys.length < 2) return "";
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || hi || 1;
  const xy = ys.map((y, i) => [Math.round(i / (ys.length - 1) * w), Math.round(h - 8 - (y - lo) / span * (h - 16))]);
  const up = ys[ys.length - 1] >= ys[0], color = up ? "#3f8f4f" : "#b4533c";
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${line} L${w},${h} L0,${h} Z" fill="${color}" opacity=".12"/><path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0]}" cy="${xy[xy.length - 1][1]}" r="5" fill="${color}"/></svg>`;
}

// spec: { kicker, symbol, name, headline, sub, rows: [[label, value]], series: [numbers], seriesLabel, foot }
export function cardHtml(spec) {
  const rows = (spec.rows || []).slice(0, 6).map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1200px;height:675px;background:#f6f1e8;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1a16;display:flex}
  .card{margin:36px;flex:1;background:#fffdf8;border:1px solid #e6dccb;border-radius:28px;padding:44px 52px;display:flex;flex-direction:column;position:relative;overflow:hidden}
  .k{font-size:20px;letter-spacing:.22em;text-transform:uppercase;color:#9a7b3c}
  .t{display:flex;align-items:baseline;gap:18px;margin-top:14px}
  .sym{font-family:Georgia,"Times New Roman",serif;font-size:72px;line-height:1}
  .nm{font-size:26px;color:#8a8070}
  .h{font-family:Georgia,"Times New Roman",serif;font-size:50px;line-height:1.1;margin-top:20px;max-width:1000px}
  .s{font-size:24px;color:#6f665a;margin-top:12px;max-width:1000px}
  .mid{display:flex;gap:40px;margin-top:auto;align-items:flex-end}
  .grid{display:grid;grid-template-columns:repeat(3,auto);gap:14px 34px}
  .r span{display:block;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#9b917f}
  .r b{display:block;font-size:30px;font-weight:600;margin-top:2px}
  .sp{margin-left:auto;text-align:right}
  .sp small{display:block;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#9b917f;margin-bottom:6px}
  .f{display:flex;justify-content:space-between;align-items:center;margin-top:26px;padding-top:18px;border-top:1px solid #eee4d3;font-size:19px;color:#8a8070}
  .f b{color:#1d1a16;font-weight:600}
  .ring{position:absolute;right:-90px;top:-90px;width:320px;height:320px;border-radius:50%;border:14px solid #e9dcbf;opacity:.55}
  </style></head><body><div class="card"><div class="ring"></div>
  <div class="k">${esc(spec.kicker || "caturn radar · robinhood chain")}</div>
  <div class="t"><span class="sym">$${esc(spec.symbol)}</span><span class="nm">${esc(spec.name || "")}</span></div>
  <div class="h">${esc(spec.headline)}</div>
  ${spec.sub ? `<div class="s">${esc(spec.sub)}</div>` : ""}
  <div class="mid"><div class="grid">${rows}</div>${(spec.series || []).length >= 2 ? `<div class="sp"><small>${esc(spec.seriesLabel || "price, last hours")}</small>${spark(spec.series)}</div>` : ""}</div>
  <div class="f"><span>${esc(spec.foot || "")}</span><span><b>@caturn_rh</b> · caturn.lol</span></div>
  </div></body></html>`;
}

export async function renderCard(spec) {
  const { chromium } = require("playwright");
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" };
  const browser = await chromium.launch(launch).catch(() => chromium.launch());
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
    await page.setContent(cardHtml(spec), { waitUntil: "load" });
    return await page.screenshot({ type: "png" });
  } finally { await browser.close(); }
}
