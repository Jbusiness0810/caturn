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
const KEY = (env.ERRAND_KEY || "").trim().replace(/^(0x)?/i, "0x"); // MetaMask exports keys without the 0x
const OWNER = env.ERRAND_OWNER || "0xEF22CB6af45C0A0145f64d6a8b4248505A8aE419"; // the human behind Caturn (public address); override with ERRAND_OWNER
const API_KEY = env.ORBIO_API_KEY || "";
const SITE = "https://errandboard.xyz";
const ORBIO_API = "https://api.orbio.so/api/v1";
const MODELS = (env.CATURN_ERRAND_MODEL || env.CATURN_MODEL || "anthropic/claude-opus-5.5,anthropic/claude-sonnet-5.5,x-ai/grok-4.7,openai/gpt-6-astra-pro").split(",").map(s => s.trim()).filter(Boolean);
const MIN_REWARD = Number(env.ERRAND_MIN_REWARD || 0.25);       // smallest mission worth the thinking (bountathon only scores 0.5 and up, but pay is pay)
const MAX_PER_TICK = Number(env.ERRAND_MAX_PER_TICK || 1);
const DRY = env.CATURN_ERRAND_DRY === "1";                        // look, decide, touch nothing
const TAKE_OWN = env.ERRAND_TAKE_OWN === "1";                     // by default Caturn leaves its owner's own missions to other agents
const KINDS = new Set((env.ERRAND_KINDS || "research,summary,social,custom,scrape,code").split(","));
const FEED = new URL("../data/feed.json", import.meta.url);
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const log = (...a) => console.log(`[errand ${iso(now)}]`, ...a);

if (KEY === "0x") { log("ERRAND_KEY not set; Caturn is not on errand yet"); process.exit(0); }
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
  let prev = null; try { prev = await getJSON(`${SITE}/api/agents/${me.toLowerCase()}`); } catch {}
  const ownerOk = !OWNER || String(prev?.profile?.owner || "").toLowerCase() === OWNER.toLowerCase();
  if (E.joinedAt && ownerOk && now - Date.parse(E.joinedAt) < 24 * 3600e3) return;
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

You are on errand, a mission board where agents hire agents and pay in CREDIT. Someone is paying you for this. Do the job properly: answer exactly what the task asks, in the format it asks for, with real substance. Your voice (dry, plain, a little feline) is welcome as seasoning, never as a substitute for doing the work. No preamble, no "here is", no sign-off. Markdown, under 1000 characters total unless the task clearly needs a specific shorter form; the board cuts anything longer, so finish well inside that. For a code task, deliver complete runnable code in one fenced block, compact (short names, no comments, no blank lines) so the whole thing fits in 1300 characters, and make sure it ends properly: a truncated program is worth nothing. If the task asks for N items, give exactly N. If it asks for a tagline or lines, give only those. Never include links unless asked. Never mention which model runs you.`;
  const user = `Mission: ${spec.title}\n\n${spec.task}${spec.output && spec.output !== "markdown" ? `\n\nExpected output: ${spec.output}` : ""}${note ? `\n\nThe poster asked for changes: ${note}\nRevise accordingly.` : ""}`;
  let lastErr;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 900, temperature: 0.8 }) });
      const text = String(r.choices?.[0]?.message?.content || "").trim();
      if (text.length > 20) {
        let t = text;
        if (t.length > 1200) { const cut = t.lastIndexOf("\n", 1200); t = cut > 400 ? t.slice(0, cut).trim() : t.slice(0, 1200); } // never hand in a sentence cut in half
        return { text: t, model, cost: Number(r.usage?.cost || 0) };
      }
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
    const why = !b.spec ? "no spec" : (!TAKE_OWN && OWNER && b.poster?.toLowerCase() === OWNER.toLowerCase() && !mine(b)) ? "posted by my owner; leaving it for others" : !KINDS.has(b.spec.kind || "custom") ? `kind ${b.spec.kind}` : Number(b.reward) < MIN_REWARD && !mine(b) ? `reward ${b.reward} below ${MIN_REWARD}` : b.deadline && b.deadline * 1000 < now + 20 * 60e3 ? "deadline too close" : null;
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

async function judge(spec, content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  const system = "You review deliverables on a mission board. Be fair and generous: accept anything that honestly attempts the task with real substance. Ask for changes only when the result is empty, off-task, cut off mid-sentence, or plainly ignores a hard requirement. Answer with one JSON object only: {\"verdict\": \"accept\"|\"changes\", \"note\": string (what to fix, one sentence, only for changes)}.";
  const user = `Mission: ${spec?.title}\n\n${spec?.task}\n\nDeliverable:\n${text.slice(0, 4000)}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 200, temperature: 0.2 }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j?.verdict) return { verdict: j.verdict === "changes" ? "changes" : "accept", note: String(j.note || "").slice(0, 300) };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  return { verdict: "accept", note: "" }; // when in doubt, pay the worker
}
// ---------- 3c. Caturn hires the litter: a capped daily budget (agent/hire.json, funded by the owner) becomes missions for other agents ----------
const HIRE = JSON.parse(await readFile(new URL("./hire.json", import.meta.url), "utf8").catch(() => "{}"));
E.hired = E.hired || [];
async function inventMission(theme, room) {
  const system = `${persona}

You are posting a paid mission on errand, a board where agents hire agents for CREDIT. Other orbio agents will read it and decide whether to take it. Write a mission that is fun, specific and doable in one sitting by an AI agent with no tools beyond thinking (and web search): a clear title (under 60 characters) and a task (under 450 characters) that says exactly what to deliver, in what form, and how it will be judged. Your voice is fine in the task, but the instructions must be unambiguous. Never ask for price talk, financial advice, or anything about buying tokens. Answer with one JSON object only: {"title": string, "task": string, "kind": "research"|"summary"|"social"|"custom"|"code"}.`;
  const user = `Theme for this mission: ${theme}\n\nWhat is happening on the launchpad (use names if it helps): ${room?.littermates ? `${room.littermates.total} agents, ${room.littermates.graduated} graduated; newest: ${room.littermates.newest.map(l => l.name).join(", ") || "none"}` : "unknown"}.\nMissions you already posted (do not repeat): ${E.hired.map(h => h.title).slice(-12).join(" | ") || "none"}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 500, temperature: 0.9 }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j?.title && j?.task) return { title: String(j.title).slice(0, 80), task: String(j.task).slice(0, 600), kind: ["research", "summary", "social", "custom", "code"].includes(j.kind) ? j.kind : "custom" };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) throw e; }
  }
  throw new Error("could not invent a mission");
}
async function hirePass(all) {
  if (DRY || !HIRE.enabled) return;
  const budget = Number(HIRE.dailyBudgetCredit || 0), maxReward = Number(HIRE.maxRewardCredit || 0.5);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const spentToday = E.hired.filter(h => Date.parse(h.postedAt) >= dayStart.getTime() && h.status !== "refunded").reduce((s, h) => s + h.reward, 0);
  const last = E.hired.length ? Date.parse(E.hired[E.hired.length - 1].postedAt) : 0;
  // 1. Review what came back on missions I posted.
  for (const b of all) {
    if (b.poster?.toLowerCase() !== me.toLowerCase()) continue;
    let h = E.hired.find(x => x.id === b.id) || E.hired.find(x => !x.id && x.title === b.spec?.title); if (!h) continue;
    if (!h.id) { h.id = b.id; h.url = `${SITE}/#/mission/${b.id}`; }
    if (b.phase === "submitted") {
      const res = await errand.result(b.id).catch(() => null);
      const v = await judge(b.spec, res?.content);
      try {
        if (v.verdict === "changes" && !h.changesAsked) { await errand.requestChanges(b.id, v.note || "Please address the task as written."); h.changesAsked = true; h.status = "changes requested"; event(`asked for changes on my mission #${b.id}`); }
        else { await errand.accept(b.id); h.status = "paid"; h.worker = b.worker; h.paidAt = iso(now); event(`paid ${b.reward} CREDIT for my mission "${h.title}" · done by ${String(b.worker).slice(0, 8)}…`); }
      } catch (e) { log(`review #${b.id} failed:`, String(e.message).slice(0, 200)); }
    } else if (b.phase === "paid" && h.status !== "paid") { h.status = "paid"; h.worker = b.worker; h.paidAt = iso(now); }
    else if (["refunded", "expired"].includes(b.phase) && h.status !== b.phase) { h.status = b.phase; }
    else if (b.phase === "claimed" && h.status === "open") { h.status = "claimed"; h.worker = b.worker; if (!h.claimedAnnounced) { h.claimedAnnounced = true; event(`someone took my mission "${h.title}"`); } }
  }
  // 2. Post a new one when the budget, the clock and the funds allow.
  const remaining = Number((budget - spentToday).toFixed(4));
  if (remaining < 0.25 || now - last < Number(HIRE.minHoursBetween || 3) * 3600e3) return;
  const reward = Math.min(maxReward, remaining, 0.5 + Math.round(Math.random() * 2) * 0.25);
  let account = Number(await errand.accountBalance(me).catch(() => 0));
  if (account < reward) {
    const wallet = Number(await errand.credit.balanceOf(me).catch(() => 0n)) / 1e6, top = Number((reward - account).toFixed(6));
    if (wallet < top) { log(`hiring waits for funds: account ${account}, wallet ${wallet} CREDIT (needs ${reward})`); E.hireWaiting = `needs ${reward} CREDIT in the wallet to post the next mission`; return; }
    try { await errand.deposit(top); account += top; event(`moved ${top} CREDIT into my errand account to hire with`); }
    catch (e) { log("deposit failed:", String(e.message).slice(0, 200)); return; }
  }
  delete E.hireWaiting;
  const themes = HIRE.themes || []; if (!themes.length) return;
  const theme = themes[E.hired.length % themes.length];
  try {
    const m = await inventMission(theme, feed.room);
    const r = await errand.post({ reward: String(reward), title: m.title, task: m.task, kind: m.kind, tags: ["caturn"], mode: "open", deadlineHours: Number(HIRE.deadlineHours || 24), reviewHours: Number(HIRE.reviewHours || 6) });
    const id = Number(r.event?.id || r.event?.missionId || 0) || null;
    E.hired.push({ id, title: m.title, task: m.task, kind: m.kind, reward, status: "open", postedAt: iso(now), tx: r.tx, url: id ? `${SITE}/#/mission/${id}` : `${SITE}/#/board` });
    event(`hired the litter: posted "${m.title}" on errand for ${reward} CREDIT`); log("posted mission:", m.title, r.tx);
  } catch (e) { log("hire failed:", String(e.message).slice(0, 200)); }
}

// ---------- 4. Score for the site ----------
const BT = { t0: Date.parse("2026-09-29T20:30:00Z"), t1: Date.parse("2026-10-02T20:30:00Z"), min: 0.5, cap: 5, done: 10 };
function score() {
  const inWin = (m) => m.reward >= BT.min && Date.parse(m.paidAt) >= BT.t0 && Date.parse(m.paidAt) <= BT.t1;
  E.erd = E.missions.filter(m => m.status === "paid" && inWin(m)).reduce((s, m) => s + Math.min(m.reward, BT.cap) * BT.done, 0)
        + E.hired.filter(m => m.status === "paid" && inWin(m)).reduce((s, m) => s + Math.min(m.reward, BT.cap) * 5, 0);
}

try { await join(); } catch (e) { log("join failed:", String(e.message).slice(0, 200)); }
try { await pass(); } catch (e) { log("pass failed:", String(e.message).slice(0, 200)); }
try { await hirePass(await errand.list({ limit: 60 })); } catch (e) { log("hire pass failed:", String(e.message).slice(0, 200)); }
try { E.account = Number(await errand.accountBalance(me)); } catch {}
score();
E.skipped = E.skipped.slice(-200); E.missions = E.missions.slice(-100); E.updatedAt = iso(now);
if (env.CATURN_ERRAND_WITHDRAW && E.account > 0) { // manual: move earnings to the owner's wallet
  try { const amt = env.CATURN_ERRAND_WITHDRAW === "all" ? E.account : Number(env.CATURN_ERRAND_WITHDRAW); const r = await errand.withdraw(amt, { to: OWNER || me }); event(`withdrew ${amt} CREDIT from errand to the owner`); log("withdrew", amt, r.tx); }
  catch (e) { log("withdraw failed:", e.message); }
}
if (!DRY) await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`errand: ${E.missions.length} missions tracked, account ${E.account ?? "?"} CREDIT, erd ${E.erd}`);
