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

// A graduation card: the token's own picture as the planet, wearing a ring, over the space background. The accent colour
// is sampled from the logo in the page, so every card matches its token.
// spec: { symbol, name, logo (data: URI), ordinal, total, took, stats: [[label, value]] (up to 4), date, line }
export function gradCardHtml(spec) {
  BG = BG ?? asset("card-bg.jpg", "image/jpeg");
  const stats = (spec.stats || []).slice(0, 4).map(([k, v]) => `<div class="st"><span>${esc(k)}</span><b data-fit>${esc(v)}</b></div>`).join("");
  const initial = esc(String(spec.symbol || "?").slice(0, 1));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--a:#ffd98a}
  body{width:1200px;height:675px;overflow:hidden;font-family:"DejaVu Sans",Inter,ui-sans-serif,system-ui,sans-serif;color:#eef2ff;background:#070a22}
  .bg{position:absolute;inset:0;background:url(${BG}) center/cover no-repeat;filter:saturate(1.2)}
  .shade{position:absolute;inset:0;background:radial-gradient(circle at 74% 50%,transparent 0,rgba(6,8,30,.35) 30%,rgba(6,8,30,.92) 62%),linear-gradient(90deg,rgba(6,8,30,.96) 0%,rgba(6,8,30,.75) 55%,rgba(6,8,30,.1) 100%)}
  .glow{position:absolute;left:640px;top:40px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,var(--a) 0%,transparent 62%);opacity:.32;filter:blur(20px)}
  .frame{position:absolute;inset:20px;border:2px solid color-mix(in srgb,var(--a) 40%,transparent);border-radius:26px}
  .planet{position:absolute;left:750px;top:157px;width:360px;height:360px}
  .orb{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:#141a44;box-shadow:0 0 0 6px rgba(255,255,255,.08),0 0 70px var(--a),inset -40px -50px 80px rgba(0,0,0,.45)}
  .orb img{width:100%;height:100%;object-fit:cover}
  .orb .ini{display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:180px;font-weight:800;color:var(--a)}
  .ring{position:absolute;left:-120px;right:-120px;top:150px;height:60px;border-radius:50%;border:5px solid var(--a);transform:rotate(-16deg);box-shadow:0 0 26px var(--a)}
  .ring.back{clip-path:inset(0 0 50% 0);opacity:.55}
  .ring.front{clip-path:inset(50% 0 0 0)}
  .stamp{position:absolute;left:880px;top:72px;transform:rotate(8deg);padding:8px 18px;border:3px solid var(--a);border-radius:12px;color:var(--a);font-weight:800;font-size:26px;letter-spacing:.2em;background:rgba(6,8,30,.6);text-shadow:0 0 14px var(--a)}
  .dot{position:absolute;border-radius:50%;background:var(--a);box-shadow:0 0 10px var(--a)}
  .z{position:absolute;left:70px;width:640px;overflow:hidden;white-space:nowrap}
  .kick{top:56px;height:30px;font-size:17px;letter-spacing:.24em;color:var(--a);text-transform:uppercase}
  .sym{top:96px;height:120px;font-size:112px;font-weight:800;line-height:120px;color:#fff;text-shadow:0 0 30px color-mix(in srgb,var(--a) 60%,transparent)}
  .name{top:222px;height:34px;font-size:26px;color:#cfd6f5}
  .line{top:276px;height:76px;white-space:normal;font-size:30px;line-height:38px;color:#fff}
  .line b{color:var(--a)}
  .stats{top:370px;height:150px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px 24px}
  .st{min-width:0}
  .st span{display:block;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:#aab4dd;overflow:hidden}
  .st b{display:block;font-size:32px;font-weight:700;color:var(--a);margin-top:4px;overflow:hidden;line-height:38px}
  .rule{top:548px;height:2px;background:linear-gradient(90deg,var(--a),transparent)}
  .foot{top:566px;height:26px;font-size:17px;letter-spacing:.08em;color:#c9d2f2}
  .foot b{color:var(--a)}
  </style></head><body>
  <div class="bg"></div><div class="shade"></div><div class="glow"></div><div class="frame"></div>
  ${[[700, 120, 6], [1120, 110, 5], [1150, 470, 7], [720, 540, 5], [960, 580, 4], [690, 330, 4], [1080, 40, 4]].map(([x, y, s]) => `<i class="dot" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px"></i>`).join("")}
  <div class="planet"><div class="ring back"></div><div class="orb">${spec.logo ? `<img id="logo" src="${spec.logo}">` : `<div class="ini">${initial}</div>`}</div><div class="ring front"></div></div>
  <div class="stamp">GRADUATED</div>
  <div class="z kick" data-fit>orbio agent launchpad · graduate #${esc(spec.ordinal)}${spec.total ? ` of ${esc(Number(spec.total).toLocaleString("en-US"))}` : ""}</div>
  <div class="z sym" data-fit>$${esc(spec.symbol || "")}</div>
  <div class="z name" data-fit>${esc(spec.name || "")}</div>
  <div class="z line">${spec.line || `off the bonding curve. <b>into a real pool.</b>`}</div>
  ${stats ? `<div class="z stats">${stats}</div>` : ""}
  <div class="z rule"></div>
  <div class="z foot" data-fit>${esc(spec.date || new Date().toISOString().slice(0, 10))} · ROBINHOOD CHAIN · <b>caturn.lol</b> · <b>@caturn_rh</b> · NOT ADVICE</div>
  <script>
  for (const el of document.querySelectorAll("[data-fit]")) { let s = parseFloat(getComputedStyle(el).fontSize); while (s > 10 && el.scrollWidth > el.clientWidth + 1) { s -= 1; el.style.fontSize = s + "px"; } }
  // the accent is the logo's most saturated bright colour, so the ring and type match the token
  const img = document.getElementById("logo");
  window.__ready = new Promise(res => {
    if (!img) return res();
    const go = () => { try {
      const c = document.createElement("canvas"); c.width = c.height = 32; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 32, 32);
      const d = x.getImageData(0, 0, 32, 32).data; let best = null, bs = -1;
      for (let i = 0; i < d.length; i += 4) { const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]]; if (a < 200) continue; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const sat = mx ? (mx - mn) / mx : 0, score = sat * 2 + mx / 255; if (mx > 90 && score > bs) { bs = score; best = [r, g, b]; } }
      if (best && bs > 1.2) { const k = 255 / Math.max(...best); document.documentElement.style.setProperty("--a", "rgb(" + best.map(v => Math.round(Math.min(255, v * k * .95 + 20))).join(",") + ")"); }
    } catch {} res(); };
    img.complete ? go() : (img.onload = go, img.onerror = () => res());
  });
  </script>
  </body></html>`;
}

export async function renderHtml(html, { width = 1200, height = 728 } = {}) {
  const { chromium } = require("playwright");
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: "chrome" };
  const browser = await chromium.launch(launch).catch(() => chromium.launch());
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.__ready).catch(() => {});
    return await page.screenshot({ type: "png" });
  } finally { await browser.close(); }
}
export const renderCard = (spec) => renderHtml(cardHtml(spec), { width: 1200, height: 728 });
export const renderGradCard = (spec) => renderHtml(gradCardHtml(spec), { width: 1200, height: 675 });
