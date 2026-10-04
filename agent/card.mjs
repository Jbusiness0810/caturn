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
  const statHtml = stats.map(([k, v]) => `<div class="st"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1200px;height:728px;font-family:"DejaVu Sans",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef2ff;background:#0b0f2a}
  .bg{position:absolute;inset:0;background:url(${BG}) center/cover no-repeat}
  .shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,10,34,.94) 0%,rgba(8,10,34,.86) 52%,rgba(8,10,34,.35) 78%,rgba(8,10,34,.15) 100%)}
  .frame{position:absolute;inset:22px;border:2px solid ${accent}55;border-radius:26px;box-shadow:inset 0 0 60px ${accent}14}
  .cat{position:absolute;right:18px;bottom:30px;width:470px;filter:drop-shadow(0 0 34px ${accent}55) drop-shadow(0 18px 30px rgba(0,0,0,.55))}
  .badge{position:absolute;right:56px;top:52px;text-align:center;font-size:15px;letter-spacing:.16em;color:#dfe6ff}
  .badge i{display:block;width:62px;height:62px;margin:0 auto 8px;border-radius:14px;background:#d6ff3a;color:#0b0f2a;font-style:normal;font-weight:800;font-size:26px;line-height:62px;letter-spacing:0}
  .l{position:absolute;left:70px;top:56px;width:690px}
  .site{font-size:30px;letter-spacing:.02em;color:#f4f6ff}
  .site small{font-size:16px;letter-spacing:.2em;text-transform:uppercase;color:${accent};margin-left:14px;vertical-align:middle}
  .rule{height:2px;background:linear-gradient(90deg,${accent}aa,transparent);margin:20px 0 22px}
  .sym{font-size:${String(spec.symbol || "").length > 7 ? 72 : 92}px;font-weight:300;letter-spacing:.04em;color:${accent};line-height:1;text-shadow:0 0 24px ${accent}55}
  .ca{font-family:"DejaVu Sans Mono",ui-monospace,Menlo,monospace;font-size:19px;color:#cfd6f5;margin-top:12px}
  .big{display:flex;align-items:center;gap:18px;margin-top:20px}
  .big b{white-space:nowrap;font-size:${big.length > 6 ? 56 : 84}px;font-weight:800;color:${accent};line-height:1;text-shadow:0 0 28px ${accent}66}
  .big span{font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#cfd6f5;max-width:300px;line-height:1.3}
  .an{font-size:22px;line-height:1.36;color:#eef2ff;margin-top:16px;max-width:640px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .stats{position:absolute;left:70px;bottom:150px;margin-top:0 !important;display:grid;grid-template-columns:repeat(${Math.min(4, Math.max(1, stats.length))},auto);gap:10px 36px;margin-top:24px;justify-content:start}
  .st span{display:block;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#aab4dd}
  .st b{display:block;font-size:30px;font-weight:600;color:${accent};margin-top:4px}
  .meta{position:absolute;left:70px;bottom:104px;font-size:21px;letter-spacing:.06em;color:#dfe6ff}
  .foot{position:absolute;left:70px;right:520px;bottom:52px;padding-top:16px;border-top:2px solid ${accent}55;font-size:19px;letter-spacing:.08em;color:#dfe6ff;white-space:nowrap}
  .foot b{color:${accent};font-weight:700}
  </style></head><body>
  <div class="bg"></div><div class="shade"></div><div class="frame"></div>
  ${CAT ? `<img class="cat" src="${CAT}">` : ""}
  <div class="badge"><i>RH</i>ROBINHOOD</div>
  <div class="l">
    <div class="site">caturn.lol<small>${esc(spec.kicker || "radar")}</small></div>
    <div class="rule"></div>
    <div class="sym">${esc(spec.symbol || "")}</div>
    ${spec.token ? `<div class="ca">${esc(spec.token)}</div>` : ""}
    ${big ? `<div class="big"><b>${esc(big)}</b>${spec.bigLabel ? `<span>${esc(spec.bigLabel)}</span>` : ""}</div>` : ""}
    ${analysis ? `<div class="an">${esc(analysis)}</div>` : ""}
  </div>
  ${statHtml ? `<div class="stats">${statHtml}</div>` : ""}
  <div class="meta">${esc(date)} &nbsp;•&nbsp; ROBINHOOD CHAIN${spec.foot ? ` &nbsp;•&nbsp; ${esc(spec.foot)}` : ""}</div>
  <div class="foot">ANALYSIS BY <b>CATURN</b> &nbsp;|&nbsp; <b>@caturn_rh</b> &nbsp;|&nbsp; NOT ADVICE</div>
  </body></html>`;
}

export async function renderCard(spec) {
  const { chromium } = require("playwright");
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" };
  const browser = await chromium.launch(launch).catch(() => chromium.launch());
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 728 }, deviceScaleFactor: 1 });
    await page.setContent(cardHtml(spec), { waitUntil: "load" });
    return await page.screenshot({ type: "png" });
  } finally { await browser.close(); }
}
