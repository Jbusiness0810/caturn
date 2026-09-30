// Finds an open-licensed p5.js sketch on OpenProcessing, runs it in headless Chrome, and writes a GIF.
// Usage: node agent/found.mjs '{"ids":[123,456],"seed":42}' out.gif
// Only sketches licensed CC0, CC BY or CC BY-SA are used, with no external libraries or loaded assets.
// The author, title, licence and source link are printed so the site can credit them.
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

const here = dirname(fileURLToPath(import.meta.url));
const opts = JSON.parse(process.argv[2] || "{}"), out = process.argv[3] || "found.gif";
const FRAMES = Number(opts.frames || 24), SIZE = Number(opts.size || 480), FPS = 12, STEPS_PER_FRAME = 2;
const LICENSE_NAMES = { "cc0": "CC0", "by": "CC BY", "by-sa": "CC BY-SA", "by-nc": "CC BY-NC", "by-nc-sa": "CC BY-NC-SA", "by-nd": "CC BY-ND", "by-nc-nd": "CC BY-NC-ND" };
// Default: only licences that allow reuse anywhere. Non-commercial ones can be opted into with opts.licenses (the owner's call).
const OK_LICENSES = Object.fromEntries((opts.licenses || ["cc0", "by", "by-sa"]).map(k => [String(k).toLowerCase(), LICENSE_NAMES[String(k).toLowerCase()] || String(k).toUpperCase()]));
const API = "https://openprocessing.org/api";
const NEEDS_ASSETS = /\b(loadImage|loadFont|loadSound|loadJSON|loadStrings|loadTable|loadXML|loadBytes|loadModel|loadShader|createCapture|createVideo|createAudio|httpGet|httpDo|fetch|XMLHttpRequest|WebSocket|importScripts|socket|ml5|tf\.)\b/;
const NEEDS_INPUT_ONLY = /\bfunction\s+(mousePressed|mouseClicked|keyPressed|touchStarted)\b/;
const log = (...a) => console.error("[found]", ...a);

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "caturn.lol sketch finder (contact via github.com/Jbusiness0810/caturn)" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error(`not json: ${url}`);
  return r.json();
}

// A candidate is usable when it is public, p5.js, permissively licensed, and self-contained.
async function inspect(id) {
  const m = await getJSON(`${API}/sketch/${id}`);
  if (!m || !m.visualID || m.isPrivate || m.isDraft || m.mode !== "p5js") return null;
  const lic = OK_LICENSES[String(m.license || "").toLowerCase()];
  if (!lic) return null;
  if ((m.libraries || []).length) return null;
  const files = await getJSON(`${API}/sketch/${id}/files`).catch(() => []);
  if (Array.isArray(files) && files.length) return null;
  const codes = await getJSON(`${API}/sketch/${id}/code`);
  const code = (codes || []).filter(c => !/\.html?$/i.test(c.title || "")).map(c => c.code || "").join("\n\n");
  if (code.length < 400 || code.length > 60000) return null;
  if (NEEDS_ASSETS.test(code)) return null;
  if (!/function\s+draw\s*\(/.test(code)) return null;
  if (!/createCanvas\s*\(/.test(code)) return null;
  if (NEEDS_INPUT_ONLY.test(code) && !/\bframeCount\b|\bnoise\(|\brandom\(|\bmillis\(|\bsin\(|\bcos\(/.test(code)) return null; // click-to-draw sketches stay blank
  // Popularity is the one quality signal the API gives: skip sketches nobody has hearted.
  const hearts = await getJSON(`${API}/sketch/${id}/hearts`).catch(() => []);
  const nHearts = Array.isArray(hearts) ? hearts.length : 0;
  if (nHearts < Number(opts.minHearts ?? 12)) return null;
  const user = await getJSON(`${API}/user/${m.userID}`).catch(() => ({}));
  return {
    hearts: nHearts,
    id: m.visualID, title: String(m.title || "untitled").slice(0, 80), author: String(user.fullname || user.username || "unknown").slice(0, 60),
    license: lic, url: `https://openprocessing.org/sketch/${m.visualID}`, authorUrl: `https://openprocessing.org/user/${m.userID}`, code
  };
}

async function findCandidate() {
  if (opts.codeFile) { // local test of the renderer with our own code
    const { readFileSync } = await import("node:fs");
    return { id: opts.title ? 1 : 0, title: opts.title || "local test", author: opts.author || "caturn", license: opts.license || "CC0", url: opts.url || "", authorUrl: "", code: readFileSync(opts.codeFile, "utf8") };
  }
  const ids = [...(opts.ids || [])].map(Number).filter(n => n > 0);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // Curators: people with taste. The sketches they hearted are the best pool there is, still licence- and hearts-checked.
  const curators = [...(opts.curators || [])].map(Number).filter(n => n > 0);
  if (curators.length) {
    const uid = curators[Math.floor(Math.random() * curators.length)];
    try {
      const liked = shuffle((await getJSON(`${API}/user/${uid}/hearts`)).filter(x => x.visualID)).slice(0, 60);
      ids.push(...liked.map(x => x.visualID));
    } catch (e) { log("curator list failed", uid, e.message); }
  }
  // Favourite artists first, about half the time: a few random public sketches of theirs, still licence-checked.
  const artists = [...(opts.artists || [])].map(Number).filter(n => n > 0);
  if (artists.length && (opts.preferArtists ?? Math.random() < 0.5)) {
    const uid = artists[Math.floor(Math.random() * artists.length)];
    try {
      const list = (await getJSON(`${API}/user/${uid}/sketches`)).filter(x => x.userID === uid && x.mode === "p5js" && !x.isPrivate && !x.isDraft);
      shuffle(list);
      for (const x of list.slice(0, 15)) ids.unshift(x.visualID);
    } catch (e) { log("artist list failed", uid, e.message); }
  }
  for (const id of ids) { try { const c = await inspect(id); if (c) return c; } catch (e) { log("skip", id, e.message); } }
  // Random probing: sketch ids are sequential; most of the last few years' ids are p5.js.
  let rnd = Number(opts.seed || Date.now()) % 2147483647;
  const next = () => (rnd = (rnd * 48271) % 2147483647);
  for (let i = 0; i < Number(opts.probes || 60); i++) {
    const id = 900000 + (next() % 1700000);
    try { const c = await inspect(id); if (c) return c; } catch (e) { if (!/404/.test(e.message)) log("skip", id, e.message); }
  }
  return null;
}

// Render: sketch code first, then p5 (p5 starts itself once the document is loaded), then step draw() by hand with redraw().
async function render(c) {
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" };
  const browser = await chromium.launch(launch).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
  await page.route(/^https?:\/\//, r => r.abort()); // self-contained only: no network from inside a stranger's sketch
  page.on("pageerror", e => log("sketch error:", String(e.message).slice(0, 120)));
  try {
    await page.goto(pathToFileURL(join(here, "sketch", "found.html")).href);
    await page.addScriptTag({ content: c.code });
    await page.addScriptTag({ path: join(here, "..", "public", "vendor", "p5.min.js") });
    await page.waitForFunction(() => document.querySelector("canvas") && typeof window.frameCount === "number" && window.frameCount > 0, null, { timeout: 15000 });
    await page.evaluate(() => { window.noLoop(); });
    const box = await page.evaluate(() => { const cv = document.querySelector("canvas"); const r = cv.getBoundingClientRect(); return { w: cv.width, h: cv.height, x: r.left, y: r.top, cw: r.width, ch: r.height }; });
    if (box.w < 100 || box.h < 100) throw new Error(`canvas too small ${box.w}x${box.h}`);
    const gif = GIFEncoder();
    const frames = [];
    for (let i = 0; i < FRAMES; i++) {
      // A slow circle of the mouse keeps mouse-driven sketches alive.
      const a = (i / FRAMES) * Math.PI * 2;
      await page.mouse.move(box.x + box.cw * (0.5 + 0.3 * Math.cos(a)), box.y + box.ch * (0.5 + 0.3 * Math.sin(a)));
      for (let s = 0; s < STEPS_PER_FRAME; s++) await page.evaluate(() => window.redraw());
      const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.cw, 900), height: Math.min(box.ch, 900) }, type: "png", timeout: 10000 });
      frames.push(png);
    }
    // Square, resized in the page so nothing else is needed.
    const scaled = await page.evaluate(async ({ pngs, size, credit, duotone }) => {
      const outc = document.createElement("canvas"); outc.width = size; outc.height = size; const g = outc.getContext("2d");
      const res = [];
      for (const b64 of pngs) {
        const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = "data:image/png;base64," + b64; });
        const side = Math.min(img.width, img.height); g.fillStyle = "#f3ecdd"; g.fillRect(0, 0, size, size);
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        if (duotone) { // every found piece is printed in the site's own ink: cream paper, brass, dark umber
          const id = g.getImageData(0, 0, size, size), d = id.data;
          const stops = [[243, 236, 221], [214, 186, 120], [176, 138, 62], [90, 69, 32]]; // light -> dark
          for (let i = 0; i < d.length; i += 4) {
            const l = 1 - (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; // 0 light .. 1 dark
            const x = l * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
            d[i] = stops[k][0] + (stops[k + 1][0] - stops[k][0]) * f; d[i + 1] = stops[k][1] + (stops[k + 1][1] - stops[k][1]) * f; d[i + 2] = stops[k][2] + (stops[k + 1][2] - stops[k][2]) * f;
          }
          g.putImageData(id, 0, 0);
        }
        if (credit) { // a faint credit line along the bottom edge, so the artist's name travels with the image
          g.font = "10px ui-monospace, Menlo, monospace"; g.textBaseline = "bottom";
          g.fillStyle = "rgba(255,250,240,0.55)"; g.fillText(credit, 9, size - 6);
          g.fillStyle = "rgba(70,52,22,0.42)"; g.fillText(credit, 8, size - 7);
        }
        const d = g.getImageData(0, 0, size, size).data; let s = ""; for (let j = 0; j < d.length; j += 0x8000) s += String.fromCharCode.apply(null, d.subarray(j, j + 0x8000)); res.push(btoa(s));
      }
      return res;
    }, { pngs: frames.map(f => f.toString("base64")), size: SIZE, duotone: opts.duotone !== false, credit: c.id ? `${c.title} · ${c.author} · ${c.license}${opts.codeFile ? "" : " · openprocessing"}`.slice(0, 90) : "" });
    // Reject a blank or frozen result.
    const first = Buffer.from(scaled[0], "base64"), last = Buffer.from(scaled[scaled.length - 1], "base64");
    let varSum = 0; for (let j = 0; j < first.length; j += 64) varSum += Math.abs(first[j] - first[first.length - 1 - j]);
    if (varSum / (first.length / 64) < 2) throw new Error("blank canvas");
    let moved = 0; for (let j = 0; j < first.length; j += 64) if (first[j] !== last[j]) moved++;
    const still = moved < first.length / 64 / 200;
    for (const b64 of (still ? scaled.slice(0, 1) : scaled)) {
      const rgba = new Uint8ClampedArray(Buffer.from(b64, "base64"));
      const palette = quantize(rgba, 48, { format: "rgb444" });
      const index = applyPalette(rgba, palette, "rgb444");
      gif.writeFrame(index, SIZE, SIZE, { palette, delay: Math.round(1000 / FPS), repeat: 0 });
    }
    gif.finish();
    writeFileSync(out, gif.bytes());
    return { bytes: gif.bytes().length, still };
  } finally { await browser.close(); }
}

if (opts.inspectOnly) { // list what the filter would accept, without running anything
  const c = await findCandidate();
  console.log(JSON.stringify(c ? { ...c, code: `${c.code.length} chars` } : null)); process.exit(0);
}
let tries = 0, result = null, last = null;
while (tries++ < Number(opts.attempts || 4) && !result) {
  const c = await findCandidate(); if (!c) break;
  last = c; opts.ids = (opts.ids || []).filter(i => Number(i) !== c.id); opts.seed = (Number(opts.seed || 1) * 7 + tries) % 2147483647;
  try { const r = await render(c); result = { ok: true, ...r, source: { id: c.id, title: c.title, author: c.author, license: c.license, url: c.url, authorUrl: c.authorUrl, hearts: c.hearts || 0 }, out }; }
  catch (e) { log("render failed for", c.id, c.title, "-", String(e.message).slice(0, 120)); }
}
if (!result) { console.log(JSON.stringify({ ok: false, tried: tries - 1, last: last && last.id })); process.exit(2); }
console.log(JSON.stringify(result));
