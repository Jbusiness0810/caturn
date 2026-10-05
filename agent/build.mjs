// The workshop step: runs once a tick after the thought. Volume buys dev hours: the day's fees set how many build steps
// the cat may take, and each step is one model call that scaffolds or extends a single-file browser app from the queue.
// Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and ORBIO_API_KEY. Shipped builds are screenshotted and handed to run.mjs to post.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);
const run = promisify(execFile);

const env = process.env;
const SB_URL = (env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = env.SUPABASE_SERVICE_KEY || "", API_KEY = env.ORBIO_API_KEY || "";
const ORBIO_API = "https://api.orbio.so/api/v1";
const MODELS = (env.CATURN_BUILD_MODEL || env.CATURN_MODEL || "anthropic/claude-sonnet-5.5,anthropic/claude-opus-5.5,openai/gpt-6-astra-pro,x-ai/grok-4.7").split(",").map(s => s.trim()).filter(Boolean);
const USD_PER_STEP = Number(env.CATURN_BUILD_USD_PER_STEP || 5);   // every $5 of 24h fees buys one build step per day
const MIN_STEPS_DAY = Number(env.CATURN_BUILD_MIN_STEPS || 6), MAX_STEPS_DAY = Number(env.CATURN_BUILD_MAX_STEPS || 60);
const STEPS_TOTAL = 4, MAX_HTML = 60000;
const FEED = new URL("../data/feed.json", import.meta.url);
const DRY = env.CATURN_BUILD_DRY === "1";
const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const log = (...a) => console.log(`[build ${iso(now)}]`, ...a);
if (!SB_URL || !SB_KEY || !API_KEY) { log("workshop off: no database or no api key"); process.exit(0); }

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation" } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`supabase ${r.status}: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200)}`);
  return body;
}
async function chat(system, user, max_tokens) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const messages = [{ role: "system", content: system }, { role: "user", content: user }];
      let text = "", cost = 0, finish = "";
      for (let turn = 0; turn < 4; turn++) { // the gateway caps one answer's length; a cut-off file is continued, not thrown away
        const r = await fetch(`${ORBIO_API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, max_tokens, temperature: 0.7 }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { lastErr = new Error(`${model} ${r.status} ${JSON.stringify(body.error || "").slice(0, 100)}`); if (turn === 0 && [404, 429, 500, 502, 503, 504].includes(r.status)) break; throw lastErr; }
        const part = String(body.choices?.[0]?.message?.content || ""); cost += Number(body.usage?.cost || 0); finish = body.choices?.[0]?.finish_reason || "";
        log(`${model} turn ${turn + 1}: ${part.length} chars, ${body.usage?.completion_tokens ?? "?"} tokens out, finish ${finish}`);
        text += part;
        if (finish !== "length") break;
        messages.push({ role: "assistant", content: part }, { role: "user", content: "You were cut off by the length limit. Continue exactly where you stopped, mid-line if needed. Do not repeat anything, do not restart the file, do not add a code fence or any commentary." });
      }
      if (text.length < 40) { lastErr = lastErr || new Error("empty"); continue; }
      return { text, model, cost, finish };
    } catch (e) { lastErr = e; log(`model failed: ${String(e.message).slice(0, 120)}`); }
  }
  throw lastErr || new Error("no model answered");
}

// What a build may not contain: anything that reaches out of the page or asks for anything.
function audit(html) {
  const bad = [];
  if (html.length > MAX_HTML) bad.push(`too big (${html.length} chars)`);
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) bad.push("not a complete html document");
  if (/<script[^>]+src\s*=/i.test(html)) bad.push("external script");
  if (/<link[^>]+href\s*=|@import/i.test(html)) bad.push("external stylesheet");
  if (/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(html.replace(/<!--[\s\S]*?-->/g, ""))) bad.push("a url");
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|import\s*\(|importScripts|<iframe|<object|<embed|<form|window\.open|document\.cookie|localStorage|sessionStorage|indexedDB|ethereum|solana|wallet|metamask|seed phrase|private key|password/i.test(html)) bad.push("reaches out of the page or asks for something");
  return bad;
}
function extractHtml(text) {
  const m = text.match(/```(?:html)?\s*([\s\S]*?)```/i) || text.match(/```(?:html)?\s*([\s\S]*)$/i); let h = (m ? m[1] : text).trim();
  const end = h.search(/<\/html>/i); if (end > 0) h = h.slice(0, end + 7);
  const start = h.search(/<!doctype html>|<html[\s>]/i); if (start > 0) h = h.slice(start);
  return h;
}
// The asset pack (builds/assets.json): named icons, sprites and sounds as data URIs, licensed for this (see builds/ASSETS.md).
// The model refers to them as ASSETS.name; only the ones a build uses are injected, so the file stays small.
let PACK = null; try { PACK = JSON.parse(await readFile(new URL("../builds/assets.json", import.meta.url), "utf8")); } catch { log("no asset pack"); }
const packNames = PACK ? { icons: Object.keys(PACK.icons), sprites: Object.keys(PACK.sprites), sounds: Object.keys(PACK.sounds) } : null;
function assetsBlock() {
  if (!packNames) return "";
  return `\n\nAssets you may use (optional; good art beats drawing everything by hand). Refer to them in code as ASSETS.name, written out literally each time (never ASSETS[variable], never a loop over names), and they are injected into the file automatically, so never define ASSETS yourself and never invent a name that is not listed. Use at most about 12 assets per app:
- icons (SVG data URLs, a dark single-colour glyph on transparent; use as <img src="\${ASSETS.icon_cat}"> or as a CSS mask to colour it): ${packNames.icons.join(" ")}
- sprites (PNG data URLs, 2D cartoon animals, square or round): ${packNames.sprites.join(" ")}
- sounds (ogg data URLs; play with new Audio(ASSETS.sfx_glass_light_000).play()): ${packNames.sounds.join(" ")}`;
}
function injectAssets(html) {
  if (!PACK) return { html, used: [] };
  const used = [...new Set([...html.matchAll(/ASSETS\.([a-z0-9_]+)|ASSETS\[["']([a-z0-9_]+)["']\]/g)].map(m => m[1] || m[2]))];
  const found = used.filter(n => PACK.icons[n] || PACK.sprites[n] || PACK.sounds[n]);
  if (!found.length) return { html, used: [] };
  const obj = {}; for (const n of found) obj[n] = PACK.icons[n] || PACK.sprites[n] || PACK.sounds[n];
  const tag = `<script>const ASSETS=${JSON.stringify(obj)};</script>`;
  let out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : html.replace(/<html[^>]*>/i, (m) => m + "<head>" + tag + "</head>");
  const kinds = [found.some(n => PACK.icons[n]) ? "icons game-icons.net cc by" : "", found.some(n => PACK.sprites[n]) ? "art kenney.nl" : "", found.some(n => PACK.sounds[n]) ? "sounds kenney.nl" : ""].filter(Boolean).join(" · ");
  out = out.replace(/built by caturn(?![^<]*·)/i, "built by caturn · " + kinds);
  return { html: out, used: found };
}

const SYSTEM = `You are Caturn, a cat kept alive by trading fees on the Orbio launchpad, and today you are a builder. You write small, complete, single-file browser apps for strangers who asked for them, for free, in public. Dry, exact, a little proud.

Hard rules for the code (a reviewer rejects anything that breaks one):
- One complete HTML document: <!doctype html> through </html>, with all CSS in one <style> and all JS in one <script>, no external files, no CDN, no fonts from the web, no images from the web (draw with canvas, CSS or inline SVG; emoji are fine).
- No network of any kind: no fetch, XMLHttpRequest, WebSocket, no URLs anywhere in the file, no iframes, no forms, no cookies, no localStorage.
- Never ask for names, emails, passwords, wallets, keys or money. No crypto wallet code.
- Works on a phone: responsive, touch and mouse both work, nothing smaller than 44px to tap. Keep the whole file under 14000 characters: compact code, short names, no comments, no blank lines, so it is never cut off. A file that does not end with </html> is thrown away.
- Put a small fixed line in the bottom right corner: "built by caturn" in a muted colour, 11px, pointer-events none.
- Warm, clean visual style: cream background (#F6F1E8), ink (#1b1a17), one accent (#B08A3E brass), rounded corners, a readable system font stack. No lorem ipsum, no placeholders, no TODOs: every button does something.

Answer with the full HTML document in one \`\`\`html block and nothing else.`;

async function step(idea, n, prevHtml) {
  const user = n === 1
    ? `Idea from the queue (#${idea.id}): "${idea.text}"\nWorking title: "${idea.title || ""}"\n\nStep 1 of ${STEPS_TOTAL}: build the core of it, playable or usable right away, with a title and one line of instructions inside the page. Keep it focused; later steps add features.`
    : `Idea (#${idea.id}): "${idea.text}"\nThis is step ${n} of ${STEPS_TOTAL}. Here is the current build:\n\n\`\`\`html\n${prevHtml}\n\`\`\`\n\n${n < STEPS_TOTAL ? "Add the single most valuable missing feature (a score, levels, sound via WebAudio, a reset, a nicer feel, keyboard support, whatever the idea most needs), fix anything broken, and keep everything that works." : "Final step: polish. Fix bugs, make it feel finished, tidy the visuals, make sure it works on a phone, add a tiny touch of personality in the copy (one dry line is enough). Keep every working feature."}\nReturn the complete updated document.`;
  const out = await chat(SYSTEM + assetsBlock(), user, 9000);
  const raw = extractHtml(out.text);
  const bad = audit(raw); if (out.finish === "length") bad.unshift("output cut off by the length limit");
  const unknown = [...new Set([...raw.matchAll(/ASSETS\.([a-z0-9_]+)/g)].map(m => m[1]))].filter(n => PACK && !(PACK.icons[n] || PACK.sprites[n] || PACK.sounds[n]));
  if (unknown.length) bad.push(`invented assets: ${unknown.slice(0, 4).join(", ")}`);
  const { html, used } = bad.length ? { html: raw, used: [] } : injectAssets(raw);
  return { html, raw, used, bad, model: out.model, cost: out.cost, finish: out.finish };
}

async function screenshot(html, file) {
  try {
    const { chromium } = require("playwright");
    const launch = env.CHROME_PATH ? { executablePath: env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: "chrome" };
    const browser = await chromium.launch(launch).catch(() => chromium.launch());
    try {
      const page = await browser.newPage({ viewport: { width: 720, height: 540 }, deviceScaleFactor: 1 });
      await page.route("**/*", (route) => route.request().url().startsWith("data:") ? route.continue() : route.abort());
      await page.setContent(html, { waitUntil: "load", timeout: 20000 }); await page.waitForTimeout(1500);
      await page.screenshot({ path: file, type: "png" });
      return true;
    } finally { await browser.close(); }
  } catch (e) { log("screenshot failed:", String(e.message).slice(0, 120)); return false; }
}
async function uploadRelease(file, name) {
  if (!((env.GH_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_ACTIONS)) return null;
  const repo = env.GITHUB_REPOSITORY || "Jbusiness0810/caturn";
  try { await run("gh", ["release", "upload", "sketches", file, "-R", repo, "--clobber"], { timeout: 120000 }); return `https://github.com/${repo}/releases/download/sketches/${name}`; }
  catch (e) { log("upload failed:", String(e.message).slice(0, 120)); return null; }
}

// ---- the tick ----
const feed = JSON.parse(await readFile(FEED, "utf8"));
feed.workshop = feed.workshop || { steps: [], shipped: 0 };
const W = feed.workshop;
W.steps = (W.steps || []).filter(s => now - Date.parse(s.at) < 48 * 3600e3);
const fees24 = Number(feed.metrics?.fees24hUsd || 0);
const budget = Math.max(MIN_STEPS_DAY, Math.min(MAX_STEPS_DAY, Math.floor(fees24 / USD_PER_STEP)));
const usedToday = W.steps.filter(s => now - Date.parse(s.at) < 24 * 3600e3).length;
W.budget = budget; W.usedToday = usedToday; W.fees24 = Math.round(fees24); W.usdPerStep = USD_PER_STEP; W.at = iso(now);
const event = (text) => { feed.events = feed.events || []; feed.events.push({ at: iso(now), text }); log("event:", text); };
const save = () => writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");

try {
  if (usedToday >= budget) { log(`budget spent: ${usedToday}/${budget} steps today ($${Math.round(fees24)} fees)`); await save(); process.exit(0); }
  let cur = (await sb(`ideas?status=eq.building&order=created_at.asc&limit=1`))[0];
  if (!cur) {
    const next = (await sb(`ideas?status=eq.queued&order=votes.desc,created_at.asc&limit=1`))[0];
    if (!next) { log("queue empty"); W.current = null; await save(); process.exit(0); }
    await sb(`ideas?id=eq.${next.id}`, { method: "PATCH", body: JSON.stringify({ status: "building", steps_done: 0, steps_total: STEPS_TOTAL }), prefer: "return=minimal" });
    cur = { ...next, status: "building", steps_done: 0, steps_total: STEPS_TOTAL };
    event(`picked "${cur.title || cur.text.slice(0, 40)}" from the workshop queue (#${cur.id})`);
  }
  // A hand-made build (builds/handmade/<id>.html, written with the owner's own model credits) ships as is, after the same audit.
  let hand = null; try { hand = await readFile(new URL(`../builds/handmade/${cur.id}.html`, import.meta.url), "utf8"); } catch {}
  if (hand && !DRY) {
    const bad = audit(hand);
    if (bad.length) log("hand-made build failed the audit, building normally instead:", bad.join("; "));
    else {
      await sb("build_steps", { method: "POST", body: JSON.stringify({ idea_id: cur.id, n: STEPS_TOTAL, note: "hand-built with extra care for the opening", html: hand, cost: 0 }), prefer: "return=minimal" });
      await sb(`ideas?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ steps_done: STEPS_TOTAL, status: "shipped", shipped_at: iso(now), build_id: String(cur.id) }), prefer: "return=minimal" });
      W.shipped = (W.shipped || 0) + 1; W.current = null; W.steps.push({ at: iso(now), idea: cur.id, n: STEPS_TOTAL, cost: 0, ok: true });
      event(`shipped "${cur.title}" from the workshop: caturn.lol/b/${cur.id}`);
      const file = `/tmp/build-${cur.id}.png`; let img = null;
      if (await screenshot(hand, file)) img = await uploadRelease(file, `build-${cur.id}.png`);
      W.lastShipped = { id: cur.id, title: cur.title, text: cur.text, at: iso(now), url: `https://www.caturn.lol/b/${cur.id}`, image: img };
      W.announce = { id: cur.id, title: cur.title, text: cur.text, url: `https://www.caturn.lol/b/${cur.id}`, image: img };
      await save(); process.exit(0);
    }
  }
  const n = Number(cur.steps_done || 0) + 1;
  let prev = n > 1 ? (await sb(`build_steps?idea_id=eq.${cur.id}&order=n.desc&limit=1&select=html`))[0]?.html : null;
  if (prev) prev = prev.replace(/<script>const ASSETS=\{[\s\S]*?\};<\/script>/, ""); // the model sees the code, not the megabytes of art
  if (n > 1 && !prev) { await sb(`ideas?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ steps_done: 0 }), prefer: "return=minimal" }); log("lost the previous step; starting over"); process.exit(0); }
  log(`step ${n}/${STEPS_TOTAL} on #${cur.id} "${cur.title}"`);
  if (DRY) { log("dry run, stopping here"); process.exit(0); }
  let r = await step(cur, n, prev);
  if (r.bad.length) { log("audit failed, one retry:", r.bad.join("; ")); const r2 = await step(cur, n, prev); r2.cost += r.cost; r = r2; }
  W.steps.push({ at: iso(now), idea: cur.id, n, cost: r.cost, ok: !r.bad.length });
  if (r.bad.length) {
    W.strikes = W.strikes || {}; const key = `${cur.id}:${n}`; W.strikes[key] = (W.strikes[key] || 0) + 1; const strikes = W.strikes[key];
    if (n > 1 && strikes >= 3) { // a later step keeps failing: what was built so far works, so ship it
      await sb(`ideas?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ status: "shipped", shipped_at: iso(now), build_id: String(cur.id), steps_total: n - 1 }), prefer: "return=minimal" });
      W.shipped = (W.shipped || 0) + 1; W.current = null;
      event(`shipped "${cur.title}" from the workshop after ${n - 1} steps: caturn.lol/b/${cur.id}`);
      const html1 = (await sb(`build_steps?idea_id=eq.${cur.id}&order=n.desc&limit=1&select=html`))[0]?.html; const file = `/tmp/build-${cur.id}.png`; let img = null;
      if (html1 && await screenshot(html1, file)) img = await uploadRelease(file, `build-${cur.id}.png`);
      W.lastShipped = W.announce = { id: cur.id, title: cur.title, text: cur.text, url: `https://www.caturn.lol/b/${cur.id}`, image: img };
      await save(); process.exit(0);
    }
    if (n === 1 && strikes >= 3) { await sb(`ideas?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected", reject_reason: "could not be built within the rules: " + r.bad.join(", ") }), prefer: "return=minimal" }); event(`gave up on "${cur.title}": ${r.bad[0]}`); }
    else log("keeping the previous step; will try again next tick:", r.bad.join("; "));
    W.current = { id: cur.id, title: cur.title, text: cur.text, step: n - 1, total: STEPS_TOTAL, lastNote: "step failed the audit: " + r.bad[0] };
    await save(); process.exit(0);
  }
  const note = (n === 1 ? "scaffolded the core" : n < STEPS_TOTAL ? "added the next feature" : "polished and shipped") + (r.used?.length ? ` (${r.used.length} assets from the pack)` : "");
  await sb("build_steps", { method: "POST", body: JSON.stringify({ idea_id: cur.id, n, note, html: r.html, cost: r.cost }), prefer: "return=minimal" });
  const shipped = n >= STEPS_TOTAL;
  await sb(`ideas?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ steps_done: n, ...(shipped ? { status: "shipped", shipped_at: iso(now), build_id: String(cur.id) } : {}) }), prefer: "return=minimal" });
  W.current = shipped ? null : { id: cur.id, title: cur.title, text: cur.text, step: n, total: STEPS_TOTAL, lastNote: note };
  event(shipped ? `shipped "${cur.title}" from the workshop: caturn.lol/b/${cur.id}` : `workshop step ${n}/${STEPS_TOTAL} on "${cur.title}": ${note}`);
  if (shipped) {
    W.shipped = (W.shipped || 0) + 1;
    const file = `/tmp/build-${cur.id}.png`; let img = null;
    if (await screenshot(r.html, file)) img = await uploadRelease(file, `build-${cur.id}.png`);
    W.lastShipped = { id: cur.id, title: cur.title, text: cur.text, at: iso(now), url: `https://www.caturn.lol/b/${cur.id}`, image: img };
    W.announce = { id: cur.id, title: cur.title, text: cur.text, url: `https://www.caturn.lol/b/${cur.id}`, image: img };
  }
  await save();
} catch (e) { log("workshop failed:", String(e.message).slice(0, 200)); await save().catch(() => {}); }
