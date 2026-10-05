// A data card for each token read the cat posts: the analysis on the left in big type, the mascot on the right, over the
// space background. Rendered to PNG in headless Chrome. An image post costs orbio about 3.5 cents against 22 for a link,
// and a card stops a scroll where a link card does not.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
const asset = (name, mime) => { try { return `data:${mime};base64,${readFileSync(new URL(`../public/${name}`, import.meta.url)).toString("base64")}`; } catch { return ""; } };
let BG = null, CAT = null;

// spec: { kicker, symbol, name, token, big, bigLabel, analysis, stats: [[label, value]] (up to 4), date, tone: "up"|"down"|"flat", foot }
// Older specs (headline, sub, rows) are still understood.
export function cardHtml(spec) {
  BG = BG ?? asset("card-bg.jpg", "image/jpeg"); CAT = CAT ?? asset("card-mascot.png", "image/png");
  const stats = (spec.stats || spec.rows || []).slice(0, 4);
  const tone = spec.tone || "flat", accent = tone === "up" ? "#7dffb2" : tone === "down" ? "#ff9a7a" : "#ffd98a";
  const big = spec.big || "", analysis = spec.analysis || spec.headline || "";
  const date = spec.date || new Date().toISOString().slice(0, 10);
  const statHtml = stats.map(([k, v]) => `<div class="st"><span>${esc(k)}</span><b data-fit>${esc(v)}</b></div>`).join("");
  // Fixed zones: every block has its own box and nothing flows into the next, so no text can ever overlap.
  // Left column 70..690, right column holds the mascot centred; data-fit shrinks a line until it fits its box.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1200px;height:728px;overflow:hidden;font-family:"DejaVu Sans",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef2ff;background:#0b0f2a}
  .bg{position:absolute;inset:0;background:url(${BG}) center/cover no-repeat}
  .shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,10,34,.95) 0%,rgba(8,10,34,.88) 50%,rgba(8,10,34,.4) 72%,rgba(8,10,34,.2) 100%)}
  .frame{position:absolute;inset:22px;border:2px solid ${accent}55;border-radius:26px;box-shadow:inset 0 0 60px ${accent}14}
  .z{position:absolute;left:70px;width:620px;overflow:hidden}
  .right{position:absolute;left:720px;right:44px;top:120px;bottom:44px;display:flex;align-items:center;justify-content:center}
  .cat{width:410px;max-height:100%;object-fit:contain;filter:drop-shadow(0 0 34px ${accent}55) drop-shadow(0 18px 30px rgba(0,0,0,.55))}
  .badge{position:absolute;right:70px;top:50px;display:flex;align-items:center;gap:12px;font-size:15px;letter-spacing:.16em;color:#dfe6ff}
  .badge i{display:block;width:44px;height:44px;border-radius:11px;background:#d6ff3a;color:#0b0f2a;font-style:normal;font-weight:800;font-size:19px;line-height:44px;text-align:center;letter-spacing:0}
  .site{top:52px;height:40px;display:flex;align-items:center;gap:14px;font-size:30px;color:#f4f6ff;white-space:nowrap}
  .site small{font-size:15px;letter-spacing:.2em;text-transform:uppercase;color:${accent}}
  .rule{top:106px;height:2px;background:linear-gradient(90deg,${accent}aa,transparent)}
  .sym{top:126px;height:96px;font-size:92px;font-weight:300;letter-spacing:.04em;color:${accent};line-height:96px;white-space:nowrap;text-shadow:0 0 24px ${accent}55}
  .ca{top:230px;height:24px;font-family:"DejaVu Sans Mono",ui-monospace,Menlo,monospace;font-size:18px;color:#cfd6f5;white-space:nowrap}
  .big{top:270px;height:88px;display:flex;align-items:center;gap:20px}
  .big b{flex:none;max-width:330px;overflow:hidden;white-space:nowrap;font-size:80px;font-weight:800;color:${accent};line-height:88px;text-shadow:0 0 28px ${accent}66}
  .big span{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#cfd6f5;line-height:1.35;max-height:72px;overflow:hidden}
  .an{top:372px;height:90px;font-size:21px;line-height:30px;color:#eef2ff;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
  .stats{top:484px;height:72px;display:grid;grid-template-columns:repeat(4,1fr);column-gap:16px}
  .st{min-width:0}
  .st span{display:block;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#aab4dd;white-space:nowrap;overflow:hidden}
  .st b{display:block;font-size:30px;font-weight:600;color:${accent};margin-top:6px;white-space:nowrap;overflow:hidden;line-height:38px}
  .rule2{top:584px;height:2px;background:${accent}55}
  .meta{top:600px;height:28px;font-size:19px;letter-spacing:.06em;color:#dfe6ff;white-space:nowrap}
  .foot{top:636px;height:28px;font-size:17px;letter-spacing:.08em;color:#c9d2f2;white-space:nowrap}
  .foot b{color:${accent};font-weight:700}
  </style></head><body>
  <div class="bg"></div><div class="shade"></div><div class="frame"></div>
  <div class="right">${CAT ? `<img class="cat" src="${CAT}">` : ""}</div>
  <div class="badge"><i>RH</i>ROBINHOOD</div>
  <div class="z site">caturn.lol<small data-fit>${esc(spec.kicker || "radar")}</small></div>
  <div class="z rule"></div>
  <div class="z sym" data-fit>${esc(spec.symbol || "")}</div>
  ${spec.token ? `<div class="z ca" data-fit>${esc(spec.token)}</div>` : ""}
  ${big ? `<div class="z big"><b data-fit>${esc(big)}</b>${spec.bigLabel ? `<span>${esc(spec.bigLabel)}</span>` : ""}</div>` : ""}
  ${analysis ? `<div class="z an">${esc(analysis)}</div>` : ""}
  ${statHtml ? `<div class="z stats">${statHtml}</div>` : ""}
  <div class="z rule2"></div>
  <div class="z meta" data-fit>${esc(date)} &nbsp;•&nbsp; ROBINHOOD CHAIN${spec.foot ? ` &nbsp;•&nbsp; ${esc(spec.foot)}` : ""}</div>
  <div class="z foot" data-fit>ANALYSIS BY <b>CATURN</b> &nbsp;|&nbsp; <b>@caturn_rh</b> &nbsp;|&nbsp; NOT ADVICE</div>
  <script>for (const el of document.querySelectorAll("[data-fit]")) { let s = parseFloat(getComputedStyle(el).fontSize); while (s > 10 && el.scrollWidth > el.clientWidth + 1) { s -= 1; el.style.fontSize = s + "px"; } }</script>
  </body></html>`;
}

export async function renderHtml(html, { width = 1200, height = 728 } = {}) {
  const { chromium } = require("playwright");
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: "chrome" };
  const browser = await chromium.launch(launch).catch(() => chromium.launch());
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    return await page.screenshot({ type: "png" });
  } finally { await browser.close(); }
}
export const renderCard = (spec) => renderHtml(cardHtml(spec), { width: 1200, height: 728 });
