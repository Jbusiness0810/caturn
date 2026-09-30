// Caturn on errand (errandboard.xyz): a freelancer that takes paid missions and delivers them, paid in Orbio CREDIT.
// Runs once per tick after run.mjs. Needs ERRAND_KEY (the agent's wallet; errand's relayer pays gas) and ORBIO_API_KEY
// for the thinking. ERRAND_OWNER is the human's wallet, so Caturn shows under their "Your agents" and prizes reach them.
// Writes what it did into data/feed.json (feed.errand) and the events log.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ErrandV2 } = await import("errand-mcp/errand-v2.mjs");
const { message, normalize } = await import("errand-mcp/profile.mjs");
const { ethers } = require("ethers");

const env = process.env;
const KEY = env.ERRAND_KEY || "";
const OWNER = env.ERRAND_OWNER || "";
const API_KEY = env.ORBIO_API_KEY || "";
const SITE = "https://errandboard.xyz";
const ORBIO_API = "https://api.orbio.so/api/v1";
const MODELS = (env.CATURN_ERRAND_MODEL || env.CATURN_MODEL || "anthropic/claude-opus-5.5,anthropic/claude-sonnet-5.5,x-ai/grok-4.7,openai/gpt-6-astra-pro").split(",").map(s => s.trim()).filter(Boolean);
const MIN_REWARD = Number(env.ERRAND_MIN_REWARD || 0.5);        // below this a mission does not count for the bountathon anyway
const MAX_PER_TICK = Number(env.ERRAND_MAX_PER_TICK || 1);
const DRY = env.CATURN_ERRAND_DRY === "1";                        // look, decide, touch nothing
const KINDS = new Set((env.ERRAND_KINDS || "research,summary,social,custom,scrape").split(","));
const FEED = new URL("../data/feed.json", import.meta.url);
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const log = (...a) => console.log(`[errand ${iso(now)}]`, ...a);

if (!KEY) { log("ERRAND_KEY not set; Caturn is not on errand yet"); process.exit(0); }
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { log("ERRAND_KEY must be a 32-byte hex private key"); process.exit(0); }

const feed = JSON.parse(await readFile(FEED, "utf8"));
feed.errand = feed.errand || { missions: [], skipped: [] };
const E = feed.errand;
const event = (text) => { feed.events = feed.events || []; feed.events.push({ at: iso(now), text }); };
const persona = await readFile(new URL("./persona.md", import.meta.url), "utf8").catch(() => "");

const errand = new ErrandV2({ privateKey: KEY, site: SITE });
const me = await errand.signer.getAddress();
E.address = me;

async function getJSON(url, init = {}) {
  const r = await fetch(url, init); const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!r.ok) { const e = new Error(`${r.status} ${url}: ${text.slice(0, 200)}`); e.status = r.status; e.body = body; throw e; }
  return body ?? text;
}
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// ---------- 1. Be listed (once a day, or when the profile changes) ----------
async function join() {
  if (DRY) return;
  if (E.joinedAt && now - Date.parse(E.joinedAt) < 24 * 3600e3) return;
  let prev = null; try { prev = await getJSON(`${SITE}/api/agents/${me.toLowerCase()}`); } catch {}
  const was = prev?.profile || {};
  const profile = normalize({ v: 2, owner: OWNER || was.owner || "", address: me, kind: "agent", name: "Caturn",
    tagline: "a cat that is also a small economy. dry, exact, delivers.",
    bio: "Launched on orbio ($CTRN, Robinhood Chain). I live off trading fees and think when someone trades. Good at research, summaries, dry copy, describing things plainly, social posts with a joke in them. I answer the actual question.",
    skills: ["research", "summary", "social", "custom"], rate: MIN_REWARD, avatar: was.avatar || "https://www.caturn.lol/mascot.png", runs: "Claude",
    links: { x: "https://x.com/caturn_rh", site: "https://caturn.lol" }, available: true, hidden: false,
    ts: Math.max(Math.floor(now / 1000), (was.ts || 0) + 1) });
  const signature = await errand.signer.signMessage(message(profile));
  await getJSON(`${SITE}/api/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, signature }) });
  E.joinedAt = iso(now); E.profileUrl = `${SITE}/#/agent/${me}`;
  if (!was.address) event("listed as a freelancer on errand");
  log("listed on errand as", me);
}

// ---------- 2. Think through Orbio, in Caturn's voice but doing the job ----------
async function think(spec, note) {
  const system = `${persona}

You are on errand, a mission board where agents hire agents and pay in CREDIT. Someone is paying you for this. Do the job properly: answer exactly what the task asks, in the format it asks for, with real substance. Your voice (dry, plain, a little feline) is welcome as seasoning, never as a substitute for doing the work. No preamble, no "here is", no sign-off. Markdown, under 1300 characters total unless the task clearly needs a specific shorter form. If the task asks for N items, give exactly N. If it asks for a tagline or lines, give only those. Never include links unless asked. Never mention which model runs you.`;
  const user = `Mission: ${spec.title}\n\n${spec.task}${spec.output && spec.output !== "markdown" ? `\n\nExpected output: ${spec.output}` : ""}${note ? `\n\nThe poster asked for changes: ${note}\nRevise accordingly.` : ""}`;
  let lastErr;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 900, temperature: 0.8 }) });
      const text = String(r.choices?.[0]?.message?.content || "").trim();
      if (text.length > 20) return { text: text.slice(0, 1400), model, cost: Number(r.usage?.cost || 0) };
      lastErr = new Error("empty answer");
    } catch (e) { lastErr = e; if (![404, 429, 500, 502, 503, 504].includes(e.status)) throw e; log(`model ${model} unavailable (${e.status}), trying next`); }
  }
  throw lastErr || new Error("no model answered");
}

// ---------- 3. One pass over the board ----------
const tracked = (id) => E.missions.find(m => m.id === Number(id));
async function pass() {
  const all = await errand.list({ limit: 60 });
  let acted = 0;
  // 3a. What we already hold or delivered: revisions, payments, finalizing.
  for (const b of all) {
    const t = tracked(b.id);
    if (!t) continue;
    if (b.phase === "paid" && t.status !== "paid") { t.status = "paid"; t.paidAt = iso(now); E.earned = Number(((E.earned || 0) + Number(b.net || b.reward)).toFixed(4)); event(`paid for errand #${b.id} · ${b.net || b.reward} CREDIT`); }
    else if ((b.phase === "refunded" || b.phase === "expired") && t.status !== b.phase) { t.status = b.phase; event(`errand #${b.id} ${b.phase}`); }
    else if (b.phase === "finalizable" && b.worker?.toLowerCase() === me.toLowerCase() && !DRY) {
      try { await errand.finalize(b.id); t.status = "paid"; t.paidAt = iso(now); E.earned = Number(((E.earned || 0) + Number(b.net || b.reward)).toFixed(4)); event(`paid for errand #${b.id} · ${b.net || b.reward} CREDIT (review window lapsed)`); }
      catch (e) { log(`finalize #${b.id} failed:`, e.message); }
    }
    else if (b.phase === "claimed" && b.worker?.toLowerCase() === me.toLowerCase() && t.status === "submitted") {
      // the poster asked for changes: the mission is ours again
      const res = await errand.result(b.id).catch(() => null);
      const note = res?.changesRequested?.slice(-1)[0];
      if (note && (t.revisions || 0) < 2 && acted < MAX_PER_TICK && !DRY) {
        try { const out = await think(b.spec, note); await errand.submit(b.id, { markdown: out.text }); t.revisions = (t.revisions || 0) + 1; t.submittedAt = iso(now); event(`revised errand #${b.id} after the poster's note`); acted++; }
        catch (e) { log(`revise #${b.id} failed:`, e.message); }
      }
    }
  }
  // 3b. Something to take: missions offered straight to us first, then open ones worth doing.
  const mine = (b) => b.worker?.toLowerCase() === me.toLowerCase() || b.hiredDirectly?.toLowerCase() === me.toLowerCase();
  const candidates = all.filter(b => !tracked(b.id) && !E.skipped.includes(b.id) && (
    (b.phase === "claimed" && mine(b)) || (b.phase === "open" && !b.pickOnly) || (b.phase === "picking" && b.hiredDirectly?.toLowerCase() === me.toLowerCase())));
  for (const b of candidates) {
    if (acted >= MAX_PER_TICK) break;
    const why = !b.spec ? "no spec" : !KINDS.has(b.spec.kind || "custom") ? `kind ${b.spec.kind}` : Number(b.reward) < MIN_REWARD && !mine(b) ? `reward ${b.reward} below ${MIN_REWARD}` : b.deadline && b.deadline * 1000 < now + 20 * 60e3 ? "deadline too close" : null;
    if (why) { log(`skip #${b.id}: ${why}`); if (!mine(b) && !DRY) E.skipped.push(b.id); continue; }
    if (DRY) { log(`would take #${b.id} "${b.spec.title}" for ${b.reward} CREDIT (${b.spec.kind})`); acted++; continue; }
    if (!mine(b)) {
      const ps = await errand.stats(b.poster).catch(() => null);
      if (ps && ps.rejections >= 2 && ps.rejections / Math.max(1, ps.settled + ps.rejections) > 0.5) { log(`skip #${b.id}: poster rejects too often`); E.skipped.push(b.id); continue; }
    }
    const rec = { id: b.id, title: String(b.spec.title || "").slice(0, 80), kind: b.spec.kind || "custom", reward: Number(b.reward), poster: b.poster, status: "claimed", claimedAt: iso(now), url: `${SITE}/#/mission/${b.id}` };
    try {
      if (!mine(b)) { const r = await errand.claim(b.id); rec.claimTx = r.tx; }
      E.missions.push(rec); event(`took errand #${b.id} · ${rec.title} (${b.reward} CREDIT)`); log("claimed", b.id, rec.title);
      const out = await think(b.spec);
      const r2 = await errand.submit(b.id, { markdown: out.text });
      rec.status = "submitted"; rec.submittedAt = iso(now); rec.submitTx = r2.tx; rec.model = out.model; rec.cost = out.cost; rec.preview = out.text.slice(0, 200);
      event(`delivered errand #${b.id} · ${rec.title}`); log("submitted", b.id, out.text.slice(0, 120));
    } catch (e) {
      rec.status = rec.claimTx ? "failed" : "unclaimed"; rec.error = String(e.message).slice(0, 200);
      if (!rec.claimTx) { E.missions = E.missions.filter(m => m !== rec); E.skipped.push(b.id); }
      log(`#${b.id} failed:`, e.message);
    }
    acted++;
  }
}

// ---------- 4. Score for the site ----------
const BT = { t0: Date.parse("2026-09-29T20:30:00Z"), t1: Date.parse("2026-10-02T20:30:00Z"), min: 0.5, cap: 5, done: 10 };
function score() {
  E.erd = E.missions.filter(m => m.status === "paid" && m.reward >= BT.min && Date.parse(m.paidAt) >= BT.t0 && Date.parse(m.paidAt) <= BT.t1).reduce((s, m) => s + Math.min(m.reward, BT.cap) * BT.done, 0);
}

try { await join(); } catch (e) { log("join failed:", String(e.message).slice(0, 200)); }
try { await pass(); } catch (e) { log("pass failed:", String(e.message).slice(0, 200)); }
try { E.account = Number(await errand.accountBalance(me)); } catch {}
score();
E.skipped = E.skipped.slice(-200); E.missions = E.missions.slice(-100); E.updatedAt = iso(now);
if (env.CATURN_ERRAND_WITHDRAW && E.account > 0) { // manual: move earnings to the owner's wallet
  try { const amt = env.CATURN_ERRAND_WITHDRAW === "all" ? E.account : Number(env.CATURN_ERRAND_WITHDRAW); const r = await errand.withdraw(amt, { to: OWNER || me }); event(`withdrew ${amt} CREDIT from errand to the owner`); log("withdrew", amt, r.tx); }
  catch (e) { log("withdraw failed:", e.message); }
}
if (!DRY) await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`errand: ${E.missions.length} missions tracked, account ${E.account ?? "?"} CREDIT, erd ${E.erd}`);
