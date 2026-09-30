// Renders one Caturn sketch to an animated GIF. Usage: node agent/sketch.mjs '<json state>' out.gif
// Uses headless Chrome (system Chrome on GitHub runners, or CHROME_PATH) plus a pure-JS GIF encoder.
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

const here = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(process.argv[2] || "{}"), out = process.argv[3] || "sketch.gif";
const FRAMES = Number(state.frames || 24), SIZE = Number(state.size || 480), FPS = 12;
const families = ["orbit", "field", "loaf", "rings"];
const family = state.family || families[Math.floor((state.seed || 0) % families.length)];
const params = new URLSearchParams({ family, seed: String(state.seed || Date.now() % 100000), energy: String(state.energy ?? 0.5), size: String(SIZE) });
for (const k of ["curiosity","smugness","unease","affection","boredom","hunger","mischief","melancholy"]) if (state.emotions?.[k] != null) params.set(k, String(state.emotions[k]));

const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" };
const browser = await chromium.launch(launch).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "sketch", "index.html")).href + "?" + params.toString());
await page.waitForFunction(() => window.frameReady === true, null, { timeout: 20000 });

const gif = GIFEncoder();
for (let i = 0; i < FRAMES; i++) {
  await page.evaluate((f) => window.renderFrame(f), i);
  const b64 = await page.evaluate(() => { const c = document.querySelector("canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = ""; for (let j = 0; j < d.length; j += 0x8000) s += String.fromCharCode.apply(null, d.subarray(j, j + 0x8000)); return btoa(s); });
  const rgba = new Uint8ClampedArray(Buffer.from(b64, "base64"));
  const palette = quantize(rgba, 48, { format: "rgb444" });
  const index = applyPalette(rgba, palette, "rgb444");
  gif.writeFrame(index, SIZE, SIZE, { palette, delay: Math.round(1000 / FPS), repeat: 0 });
}
gif.finish();
writeFileSync(out, gif.bytes());
await browser.close();
console.log(JSON.stringify({ ok: true, family, seed: params.get("seed"), bytes: gif.bytes().length, out }));
