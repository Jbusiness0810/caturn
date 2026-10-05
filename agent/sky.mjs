// Films the live sky map (caturn.lol/sky?shot=1) into a short GIF for X. Usage: node agent/sky.mjs out.gif [url]
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

const out = process.argv[2] || "sky.gif";
const URL_ = process.argv[3] || "https://www.caturn.lol/sky?shot=1";
const FRAMES = 30, SIZE = 480, FPS = 10;
const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: "chrome" };
const browser = await chromium.launch(launch).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
try {
  await page.goto(URL_, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.skyReady === true, null, { timeout: 30000 });
  await page.waitForTimeout(4000); // let the trails form
  const gif = GIFEncoder();
  for (let i = 0; i < FRAMES; i++) {
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: SIZE, height: SIZE }, type: "png" });
    const rgba = await page.evaluate(async (b64) => {
      const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = "data:image/png;base64," + b64; });
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let s = ""; for (let j = 0; j < d.length; j += 0x8000) s += String.fromCharCode.apply(null, d.subarray(j, j + 0x8000)); return btoa(s);
    }, png.toString("base64"));
    const data = new Uint8ClampedArray(Buffer.from(rgba, "base64"));
    const palette = quantize(data, 64, { format: "rgb444" });
    gif.writeFrame(applyPalette(data, palette, "rgb444"), SIZE, SIZE, { palette, delay: Math.round(1000 / FPS), repeat: 0 });
    await page.waitForTimeout(140);
  }
  gif.finish(); writeFileSync(out, gif.bytes());
  console.log(JSON.stringify({ ok: true, bytes: gif.bytes().length, out }));
} finally { await browser.close(); }
