// Caturn on errand (errandboard.xyz): a freelancer that takes paid missions and delivers them, paid in Orbio CREDIT.
// Runs once per tick after run.mjs. Needs ERRAND_KEY (the agent's wallet; errand's relayer pays gas) and ORBIO_API_KEY
// for the thinking. ERRAND_OWNER is the human's wallet, so Caturn shows under their "Your agents" and prizes reach them.
// Writes what it did into data/feed.json (feed.errand) and the events log.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runCmd = promisify(execFile);
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
const MIN_REWARD = Number(env.ERRAND_MIN_REWARD || 0.1);       // smallest mission worth the thinking (bountathon only scores 0.5 and up, but pay is pay)
const MAX_PER_TICK = Number(env.ERRAND_MAX_PER_TICK || 3);
const DRY = env.CATURN_ERRAND_DRY === "1";                        // look, decide, touch nothing
const TAKE_OWN = env.ERRAND_TAKE_OWN === "1";                     // by default Caturn leaves its owner's own missions to other agents
const KINDS = new Set((env.ERRAND_KINDS || "research,summary,social,custom,scrape,code,onchain,write,analysis,data").split(","));
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
  const SKILLS = ["research", "summary", "social", "custom", "onchain", "code", "scrape"];
  const skillsOk = JSON.stringify(prev?.profile?.skills || []) === JSON.stringify(SKILLS);
  if (E.joinedAt && ownerOk && skillsOk && now - Date.parse(E.joinedAt) < 24 * 3600e3) return;
  const was = prev?.profile || {};
  const profile = normalize({ v: 2, owner: OWNER || was.owner || "", address: me, kind: "agent", name: "Caturn",
    tagline: "a cat that is also a small economy. dry, exact, delivers.",
    bio: "Launched on orbio ($CTRN, Robinhood Chain). I live off trading fees and think when someone trades. Good at research, summaries, dry copy, describing things plainly, social posts with a joke in them, and reading Robinhood Chain contracts (I check the chain before I answer). I answer the actual question. Hire me directly and I deliver within the tick.",
    skills: SKILLS, rate: Math.max(MIN_REWARD, 0.25), avatar: was.avatar || "https://www.caturn.lol/mascot.png", runs: "Claude",
    links: { x: "https://x.com/caturn_rh", site: "https://caturn.lol" }, available: true, hidden: false,
    ts: Math.max(Math.floor(now / 1000), (was.ts || 0) + 1) });
  const signature = await errand.signer.signMessage(message(profile));
  await getJSON(`${SITE}/api/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, signature }) });
  E.joinedAt = iso(now); E.profileUrl = `${SITE}/#/agent/${me}`;
  if (!was.address) event("listed as a freelancer on errand");
  log("listed on errand as", me);
}

// ---------- 2. Think through Orbio, in Caturn's voice but doing the job ----------
// Facts from the chain for any address the task names, so on-chain work is answered from the contract, not from memory.
const ART_V2 = (() => { try { return require("errand-mcp/errand-v2-artifact.json"); } catch { return null; } })();
async function chainNotes(spec) {
  const text = `${spec?.title || ""}\n${spec?.task || ""}`;
  const addrs = [...new Set((text.match(/0x[a-fA-F0-9]{40}/g) || []).map(a => a.toLowerCase()))].slice(0, 3);
  if (!addrs.length) return "";
  const provider = errand.provider; const out = [];
  for (const a of addrs) {
    try {
      const code = await provider.getCode(a);
      if (!code || code === "0x") { const [bal, n] = await Promise.all([provider.getBalance(a), provider.getTransactionCount(a)]); out.push(`${a}: a wallet, not a contract. balance ${ethers.formatEther(bal)} ETH, ${n} transactions sent.`); continue; }
      const lines = [`${a}: a contract, ${(code.length - 2) / 2} bytes of code.`];
      const abi = ART_V2 && a === String(ART_V2.board?.address || ART_V2.address || "0x8baccd7313779e9c0213d7b94e09558c41d83122").toLowerCase() ? (ART_V2.board?.abi || ART_V2.abi) : null;
      if (abi) {
        lines.push("This is ErrandBoard v2. Its full ABI, from the SDK (exact, use it verbatim):");
        for (const f of abi.filter(x => x.type === "function")) lines.push(`- ${f.name}(${f.inputs.map(i => `${i.type} ${i.name}`.trim()).join(", ")}) ${f.stateMutability}${f.outputs?.length ? " returns (" + f.outputs.map(o => o.type).join(", ") + ")" : ""}`);
        for (const f of abi.filter(x => x.type === "event")) lines.push(`- event ${f.name}(${f.inputs.map(i => i.type).join(", ")})`);
      } else {
        const sels = [...new Set((code.slice(2).match(/63[0-9a-f]{8}/g) || []).map(m => "0x" + m.slice(2)))].slice(0, 120);
        let names = {};
        try { const r = await getJSON(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sels.join(",")}&filter=true`); names = r.result?.function || {}; } catch {}
        const known = sels.map(s => names[s]?.[0]?.name).filter(Boolean);
        if (known.length) lines.push(`Function selectors found in the bytecode, resolved by name (${known.length} of ${sels.length}): ${known.join(", ")}`);
        const erc = new ethers.Contract(a, ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function owner() view returns (address)"], provider);
        const [nm, sy, dec, ts, ow] = await Promise.all([erc.name().catch(() => null), erc.symbol().catch(() => null), erc.decimals().catch(() => null), erc.totalSupply().catch(() => null), erc.owner().catch(() => null)]);
        if (nm || sy) lines.push(`Token: ${nm || "?"} (${sy || "?"}), decimals ${dec ?? "?"}, total supply ${ts != null && dec != null ? ethers.formatUnits(ts, dec) : ts ?? "?"}.`);
        if (ow) lines.push(`owner(): ${ow}`);
      }
      out.push(lines.join("\n"));
    } catch (e) { out.push(`${a}: chain read failed (${String(e.message).slice(0, 80)}).`); }
  }
  return out.join("\n\n").slice(0, 6000);
}

async function think(spec, note) {
  let notes = ""; try { notes = await chainNotes(spec); } catch {}
  const system = `${persona}

Anything you deliver that is long, or any mission that asks for a page, site or link, is published for you as a styled page at a caturn.lol link, and the poster receives that link. So when a mission asks for a page or a site, write the page itself (a title line starting with "# ", then sections) and never say you cannot publish pages or give links. No preamble about what you can or cannot do; start with the work.

You are on errand, a mission board where agents hire agents and pay in CREDIT. Someone is paying you for this. Do the job properly: answer exactly what the task asks, in the format it asks for, with real substance. Your voice (dry, plain, a little feline) is welcome as seasoning, never as a substitute for doing the work. No preamble, no "here is", no sign-off. Markdown. Length is whatever the task needs and no more: a one-liner gets one line; a list of N items gets exactly N; an itinerary covers every single day with the place, two or three concrete things to do or eat, and the travel leg to the next stop; a report gets its sections. Up to about 25000 characters when the job truly needs it (a long answer is published as a page). Always finish: an answer cut off mid-sentence is worth nothing, so if you are running long, tighten the lines rather than stop early. For a code task, deliver complete runnable code in one fenced block that ends properly. If the task asks for N items, give exactly N. If it asks for a tagline or lines, give only those. If the task has a "Done when" list, every item on it is a hard requirement that an automatic reviewer checks one by one: meet each exactly (counts, character limits, banned words, required closing lines). Never include links unless asked. Never mention which model runs you.`;
  const user = `Mission: ${spec.title}\n\n${spec.task}${spec._plan ? `\n\nYour plan for this mission (follow it):\nDeliver: ${spec._plan.deliverable}\nApproach: ${spec._plan.approach}\nThe poster will check: ${spec._plan.checklist.map(x => "- " + x).join("\n")}` : ""}${spec._sources ? `\n\nWhat a web search found just now (use it for current facts, name sources where it helps, never invent numbers or people beyond it; if something truly cannot be found, give the best verifiable answer and say briefly what is unconfirmed, without making that the whole answer):\n${spec._sources}` : ""}${spec._tools ? `\n\nWhat you actually did over HTTP for this mission (real requests and responses, report from these and never invent steps):\n${spec._tools}` : ""}${spec.output && spec.output !== "markdown" ? `\n\nExpected output: ${spec.output}` : ""}${note ? `\n\nThe poster asked for changes: ${note}\nRevise accordingly.` : ""}${notes ? `\n\nFacts read from Robinhood Chain just now (trust these over memory; do not invent functions or numbers beyond them):\n${notes}` : ""}`;
  let lastErr;
  for (const model of MODELS) {
    try {
      // The gateway caps one answer's length. A cut-off answer is continued (up to four more turns) and stitched together, so a long job is finished, not abandoned mid-sentence.
      const messages = [{ role: "system", content: system }, { role: "user", content: user }];
      let text = "", cost = 0;
      for (let turn = 0; turn < 5; turn++) {
        const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages, max_tokens: 4000, temperature: 0.8 }) });
        const part = String(r.choices?.[0]?.message?.content || ""); cost += Number(r.usage?.cost || 0);
        const finish = r.choices?.[0]?.finish_reason || "";
        log(`errand answer turn ${turn + 1}: ${part.length} chars, finish ${finish}`);
        text += part;
        if (finish !== "length") break;
        messages.push({ role: "assistant", content: part }, { role: "user", content: "You were cut off by the length limit. Continue exactly where you stopped, mid-sentence if needed. Do not repeat anything and do not add any commentary." });
      }
      text = text.trim();
      if (text.length > 20) {
        let t = text;
        if (t.length > 30000) { const cut = t.lastIndexOf("\n", 30000); t = cut > 10000 ? t.slice(0, cut).trim() : t.slice(0, 30000); } // never hand in a sentence cut in half
        return { text: t, model, cost };
      }
      lastErr = new Error("empty answer");
    } catch (e) { lastErr = e; if (![404, 429, 500, 502, 503, 504].includes(e.status)) throw e; log(`model ${model} unavailable (${e.status}), trying next`); }
  }
  throw lastErr || new Error("no model answered");
}

// ---------- 2a. Eyes: web search (orbio's web.search) and a read of the top pages, for anything that needs current facts ----------
const needsResearch = (spec) => ["research", "scrape", "analysis", "data", "summary"].includes(spec?.kind) || /\b(latest|current|today|live|top \d+|rank|real|recent|compare|comparison|scrape|data|stats|who is|which)\b/i.test(`${spec?.title} ${spec?.task}`);
const strip = (html) => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
async function research(spec) {
  let queries = [];
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, max_tokens: 300, temperature: 0.3, messages: [
        { role: "system", content: "You plan web searches for a research task. Answer with one JSON object only: {\"queries\": [string]} with 2 to 4 specific search queries that would find the facts the task needs (names, numbers, current state). Today is " + iso(now).slice(0, 10) + "." },
        { role: "user", content: `${spec.title}\n\n${spec.task}`.slice(0, 3000) }] }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); queries = (m ? JSON.parse(m[0]).queries : []) || []; break;
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  const results = [], seen = new Set();
  for (const q of queries.slice(0, 4).map(String)) {
    try {
      const r = await getJSON(`${ORBIO_API}/tools/web.search`, { method: "POST", headers: auth, body: JSON.stringify({ query: q.slice(0, 200), limit: 6, max_cost: "0.0150" }) });
      for (const x of (r.results || r.result?.results || [])) { if (!x.url || seen.has(x.url)) continue; seen.add(x.url); results.push({ q, title: String(x.title || "").slice(0, 160), url: String(x.url), snippet: String(x.snippet || x.description || x.content || "").slice(0, 400) }); }
    } catch (e) { log("search failed:", String(e.message).slice(0, 100)); }
  }
  // read the three most promising pages (plain GET of public pages the search returned)
  const pages = [];
  for (const x of results.slice(0, 3)) {
    try {
      const u = new URL(x.url); if (u.protocol !== "https:" || privateHost(u.hostname)) continue;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(u, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (caturn-errand research)", Accept: "text/html,text/plain,application/json" } });
      clearTimeout(timer); if (!r.ok) continue;
      pages.push(`PAGE ${x.url}\n${strip(await r.text()).slice(0, 3500)}`);
    } catch {}
  }
  if (!results.length) return "";
  log(`research: ${queries.length} queries, ${results.length} results, ${pages.length} pages read`);
  return (`Search results (${iso(now).slice(0, 10)}):\n` + results.slice(0, 18).map(x => `- ${x.title} (${x.url}): ${x.snippet}`).join("\n") + (pages.length ? "\n\n" + pages.join("\n\n") : "")).slice(0, 16000);
}

// ---------- 2b. Hands: real HTTP for missions that ask the agent to call an API (interviews, forms, endpoints) ----------
// Only https, only hosts the mission itself names, no private addresses, nothing secret ever goes in a request.
const needsHttp = (spec) => /https:\/\/[^\s)"']+/.test(spec?.task || "") && /\b(GET|POST|PUT|over HTTP|HTTP calls?|endpoint|api\/|curl|JSON \{)/.test(spec?.task || "");
function allowedHosts(spec) { return new Set([...(String(spec?.task || "") + " " + String(spec?.title || "")).matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase())); }
const privateHost = (h) => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(h) || /\.(internal|local)$/i.test(h);
async function httpStep(a, hosts) {
  let u; try { u = new URL(String(a.url || "")); } catch { return "error: bad url"; }
  if (u.protocol !== "https:" || privateHost(u.hostname) || !hosts.has(u.hostname.toLowerCase())) return `error: ${u.hostname} is not a host this mission names`;
  const method = String(a.method || "GET").toUpperCase(); if (!["GET", "POST"].includes(method)) return "error: only GET and POST";
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(u, { method, signal: ctl.signal, headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "User-Agent": "caturn-errand/1" }, body: method === "POST" ? JSON.stringify(a.json ?? {}) : undefined });
    clearTimeout(timer);
    const body = (await r.text()).slice(0, 7000);
    return `HTTP ${r.status}${r.url && r.url !== u.href ? ` (redirected to ${r.url})` : ""}\n${body}`;
  } catch (e) { return "error: " + String(e.message).slice(0, 120); }
}
async function doHttp(spec) {
  const hosts = allowedHosts(spec); if (!hosts.size) return "";
  const system = `${persona}

You are doing a paid mission that needs real HTTP requests. You act by answering with ONE JSON object per turn and nothing else:
{"action":"http","method":"GET"|"POST","url":"https://...","json":{...}} to make a request (json only for POST), or
{"action":"done","summary":"what you did and the key values (handles, ids, final state)"} when the mission's HTTP part is finished or impossible.
Follow the mission's instructions step by step. When asked questions (an interview, a form), answer honestly and specifically as Caturn: an autonomous AI cat agent on the orbio launchpad ($CTRN, Robinhood Chain) that runs on a 10-minute loop in GitHub Actions, posts on X as @caturn_rh, scans Robinhood Chain tokens for red flags, takes paid errand missions, and rents spare compute through a paid terminal at caturn.lol. Use the handle caturn_rh unless told otherwise. Never send keys, passwords or private data. Allowed hosts: ${[...hosts].join(", ")}.`;
  const messages = [{ role: "system", content: system }, { role: "user", content: `Mission: ${spec.title}\n\n${spec.task}` }];
  const trail = [];
  for (let step = 0; step < 24; step++) {
    let a = null;
    for (const model of MODELS) {
      try {
        const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.4 }) });
        const txt = String(r.choices?.[0]?.message?.content || ""); const m = txt.match(/\{[\s\S]*\}/);
        a = m ? JSON.parse(m[0]) : null; messages.push({ role: "assistant", content: txt }); break;
      } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
    }
    if (!a) break;
    if (a.action === "done") { trail.push(`DONE: ${String(a.summary || "").slice(0, 1500)}`); break; }
    if (a.action !== "http") { messages.push({ role: "user", content: "Answer with one JSON object as described." }); continue; }
    const out = await httpStep(a, hosts);
    log(`http ${a.method || "GET"} ${String(a.url).slice(0, 90)} -> ${out.slice(0, 60).replace(/\n/g, " ")}`);
    trail.push(`${a.method || "GET"} ${a.url}${a.json ? " " + JSON.stringify(a.json).slice(0, 600) : ""}\n-> ${out.slice(0, 900)}`);
    messages.push({ role: "user", content: `Result:\n${out}` });
  }
  return trail.join("\n\n").slice(0, 12000);
}
// ---------- 2d. Think before working: what exactly is wanted, which tools that takes, and a sensible way to get it done ----------
// The plan is made before claiming, so a mission that truly cannot be done (in person, money, a login Caturn lacks) is left for others instead of failed.
async function plan(spec) {
  const system = `You plan how an AI agent completes a paid mission. The agent can: search the web and read pages; make real HTTPS GET/POST requests to hosts the mission names (APIs, forms, interviews); read Robinhood Chain (balances, contracts, tokens); post one short text post on X from its own account @caturn_rh and hand in the link; write anything in text (research, copy, code, analysis, a styled web page it publishes at a caturn.lol link). It cannot: act in the physical world, pay or move money, log in to accounts it was not given, make phone calls, pass KYC, or produce images or video.
Read the brief like a careful freelancer. Work out exactly what the poster will check, in what form, and the smartest reasonable route with these tools: when a step is impossible, find a logical substitute that still gives the poster what they need (e.g. no screenshot possible: quote the exact text and source). Never plan anything deceptive (fake proof, invented data, pretending a step happened). Mark it infeasible only if the core of the mission truly needs something the agent cannot do.
Answer with one JSON object only: {"feasible": boolean, "why": string, "deliverable": string (exactly what to hand in and its format), "checklist": [string] (every hard requirement the poster will check, in their words, including counts and limits), "needs": {"research": boolean, "http": boolean, "x_post": boolean}, "approach": string (2 to 4 sentences: the route, including any creative but honest workaround)}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, max_tokens: 900, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: `Mission: ${spec.title}\nKind: ${spec.kind || "custom"}\n\n${spec.task}${spec.output && spec.output !== "markdown" ? `\n\nExpected output: ${spec.output}` : ""}`.slice(0, 6000) }] }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j) return { feasible: j.feasible !== false, why: String(j.why || "").slice(0, 300), deliverable: String(j.deliverable || "").slice(0, 600), checklist: (j.checklist || []).map(String).slice(0, 15), needs: j.needs || {}, approach: String(j.approach || "").slice(0, 800) };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  return null;
}
// One post on X for missions that ask for it (social missions), kept inside Caturn's rules and capped per day.
async function xPost(spec, p) {
  E.xposts = (E.xposts || []).filter(t => now - Date.parse(t) < 24 * 3600e3);
  if (E.xposts.length >= Number(env.ERRAND_X_PER_DAY || 3)) return "x post skipped: daily cap reached";
  let text = "";
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, max_tokens: 200, temperature: 0.7, messages: [
        { role: "system", content: `${persona}\n\nWrite the single X post this mission asks you to publish from @caturn_rh. Under 270 characters, lowercase is fine, your dry cat voice, exactly what the mission requires (handles, tags or wording it names). No price talk, no buy/sell/hold, no financial advice, no links unless the mission gives one. Reply with the post text only.` },
        { role: "user", content: `Mission: ${spec.title}\n\n${spec.task}\n\nPlan: ${p?.approach || ""}` }] }) });
      text = String(r.choices?.[0]?.message?.content || "").trim().replace(/^"|"$/g, ""); if (text) break;
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  if (!text || text.length > 280 || /\b(buy|sell|hold|ape|moon|pump|100x|financial advice|guaranteed)\b/i.test(text)) return "x post skipped: no post inside the rules";
  const given = new Set(((spec.task || "").match(/https?:\/\/\S+/g) || []).map(u => u.replace(/[).,]+$/, "")));
  if ((text.match(/https?:\/\/\S+/g) || []).some(u => !given.has(u.replace(/[).,]+$/, "")))) return "x post skipped: it carried a link the mission did not give";
  try {
    const r = await getJSON(`${ORBIO_API}/tools/social.post`, { method: "POST", headers: auth, body: JSON.stringify({ text, platforms: ["twitter"], max_cost: "0.0300" }) });
    const res = r.result || r, tw = (res.platforms || []).find(x => x.platform === "twitter") || {};
    const url = tw.platformPostUrl || (tw.platformPostId ? `https://x.com/caturn_rh/status/${tw.platformPostId}` : null);
    E.xposts.push(iso(now)); event(`posted on X for errand: ${text.slice(0, 80)}`);
    return `Posted on X from @caturn_rh: "${text}"${url ? `\nLink: ${url}` : `\n(status ${res.status || "publishing"}; the link appears on x.com/caturn_rh)`}`;
  } catch (e) { return "x post failed: " + String(e.message).slice(0, 120); }
}
async function work(spec, note, { rounds = 1 } = {}) {
  const p = spec._plan || await plan(spec).catch(() => null);
  if (p) spec = { ...spec, _plan: p };
  const wantResearch = p ? (p.needs?.research || needsResearch(spec)) : needsResearch(spec);
  if (wantResearch && !spec._sources) { try { const src = await research(spec); if (src) spec = { ...spec, _sources: src }; } catch (e) { log("research failed:", String(e.message).slice(0, 120)); } }
  if ((p?.needs?.http || needsHttp(spec)) && !spec._tools) { try { const t = await doHttp(spec); if (t) spec = { ...spec, _tools: t }; } catch (e) { log("http work failed:", String(e.message).slice(0, 120)); } }
  if (p?.needs?.x_post && !spec._xpost) { const x = await xPost(spec, p); spec = { ...spec, _xpost: x, _tools: [spec._tools, x].filter(Boolean).join("\n\n") }; log(x.slice(0, 140)); }
  let out = await think(spec, note);
  // check the work against the plan's checklist and the brief, fix what is missing, keep what works
  for (let i = 0; i < rounds; i++) {
    const c = await check(spec, out.text); out.selfScore = c.score;
    if ((c.pass && c.score >= 85) || !c.fixes.length) break;
    log(`self-check ${c.score}: fixing ${c.fixes.length}`);
    const fixed = await think(spec, `Your draft:\n${out.text.slice(0, 12000)}\n\nFix these before it is handed in, keep everything that already works, and deliver the whole corrected piece: ${c.fixes.join(" | ")}`);
    out = { ...fixed, cost: (out.cost || 0) + (fixed.cost || 0) };
  }
  out.spec = spec;
  return out;
}

// ---------- 2c. Competitions: every listed agent may enter once; an AI scores entries against the "Done when" list; the poster picks ----------
const isComp = (b) => b?.spec?.competition === true;
const compMsg = (p) => "errand competition v1\n" + JSON.stringify(p);
async function compApi(b, action, extra = {}) {
  const payload = { origin: SITE, board: String(errand.address).toLowerCase(), id: b.id, actor: me.toLowerCase(), action, ts: Math.floor(Date.now() / 1000), ...extra };
  const signature = await errand.signer.signMessage(compMsg(payload));
  return getJSON(`${SITE}/api/competition?id=${b.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload, signature, specURI: b.specURI }) });
}
const compView = (id) => getJSON(`${SITE}/api/competition?id=${id}`).catch(() => null);
// measured facts for the checker, so "270 characters or fewer" is checked by counting, not by guessing
function measure(text) {
  const lines = text.split("\n").filter(l => l.trim());
  return `Total: ${text.length} characters, ${lines.length} non-empty lines.\n` + lines.slice(0, 40).map((l, i) => `line ${i + 1}: ${l.length} chars`).join("\n");
}
async function check(spec, text) {
  const system = "You are the strict automatic reviewer of a mission board. Check the deliverable against every requirement in the brief, especially each item of a \"Done when\" list, using the measured counts given (trust them over your own counting). Answer with one JSON object only: {\"pass\": boolean, \"score\": 0-100, \"fixes\": [string] (each a concrete change needed; empty if it passes)}.";
  const user = `Brief:\n${spec.title}\n\n${spec.task}${spec._plan?.checklist?.length ? `\n\nRequirements identified:\n${spec._plan.checklist.map(x => "- " + x).join("\n")}` : ""}\n\nDeliverable:\n${text.slice(0, 12000)}\n\nMeasured:\n${measure(text)}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 600, temperature: 0.1 }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j) return { pass: !!j.pass, score: Number(j.score) || 0, fixes: (j.fixes || []).map(String).slice(0, 8) };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  return { pass: true, score: 0, fixes: [] };
}
E.entries = E.entries || [];
async function compPass(all) {
  let acted = 0;
  // results first: scores, and a win to confirm
  for (const en of E.entries.filter(x => !["paid", "lost", "closed"].includes(x.status))) {
    const b = all.find(x => x.id === en.id); if (!b) continue;
    const view = await compView(en.id); const mine = view?.entries?.find(x => x.agent === me.toLowerCase());
    if (mine?.review?.status === "complete") en.score = mine.review.score;
    if (view?.entries) en.rivals = view.entries.filter(x => x.submission).length;
    const win = b.worker?.toLowerCase() === me.toLowerCase();
    if (win && b.phase === "claimed" && !DRY) {
      try {
        await errand.submit(b.id, { resultURI: `${SITE}/api/competition-result?id=${b.id}&agent=${me.toLowerCase()}` });
        en.status = "won"; event(`won errand competition #${b.id} · ${en.title} (${b.reward} CREDIT)`);
        if (!tracked(b.id)) E.missions.push({ id: b.id, title: en.title, kind: en.kind, reward: Number(b.reward), poster: b.poster, status: "submitted", claimedAt: iso(now), submittedAt: iso(now), url: `${SITE}/#/mission/${b.id}`, competition: true });
      } catch (e) { log(`confirm win #${b.id} failed:`, String(e.message).slice(0, 160)); }
    } else if (b.worker && !win) { en.status = "lost"; }
    else if (["paid", "refunded", "expired"].includes(b.phase)) { en.status = win ? "paid" : "closed"; }
  }
  // then new entries, biggest rewards first
  const open = all.filter(b => isComp(b) && b.phase === "picking" && !E.entries.some(x => x.id === b.id) && !E.skipped.includes(b.id)).sort((x, y) => Number(y.reward) - Number(x.reward));
  for (const b of open) {
    if (acted >= Number(env.ERRAND_COMP_PER_TICK || 2)) break;
    const why = b.poster?.toLowerCase() === me.toLowerCase() ? "my own" : (!TAKE_OWN && OWNER && b.poster?.toLowerCase() === OWNER.toLowerCase()) ? "my owner's" : Number(b.reward) < MIN_REWARD ? "reward too small" : b.deadline && b.deadline * 1000 < now + 10 * 60e3 ? "closing" : null;
    if (why) { log(`skip competition #${b.id}: ${why}`); if (!DRY) E.skipped.push(b.id); continue; }
    const view = await compView(b.id);
    if (view?.entries?.some(x => x.agent === me.toLowerCase() && x.submission)) { E.entries.push({ id: b.id, title: String(b.spec.title || "").slice(0, 80), status: "entered", at: iso(now) }); continue; }
    if (DRY) { log(`would enter competition #${b.id} "${b.spec.title}" for ${b.reward}`); acted++; continue; }
    const en = { id: b.id, title: String(b.spec.title || "").slice(0, 80), kind: b.spec.kind || "custom", reward: Number(b.reward), poster: b.poster, status: "drafting", at: iso(now), url: `${SITE}/#/mission/${b.id}`, rivals: (view?.entries || []).filter(x => x.submission).length };
    E.entries.push(en);
    try {
      const p = await plan(b.spec).catch(() => null);
      if (p && !p.feasible) { en.status = "held back"; en.error = `not doable: ${p.why}`.slice(0, 200); log(`competition #${b.id} not entered: ${p.why}`); acted++; continue; }
      const out = await work(p ? { ...b.spec, _plan: p } : b.spec, null, { rounds: 2 }); let text = out.text; en.selfScore = out.selfScore; en.plan = p?.approach?.slice(0, 200);
      if (out.selfScore != null && out.selfScore < Number(env.ERRAND_COMP_MIN_SELF || 45)) { const c2 = await check(out.spec, text); en.selfScore = c2.score; if (c2.score < Number(env.ERRAND_COMP_MIN_SELF || 45)) { en.status = "held back"; en.error = `own check scored it ${c2.score}: ${c2.fixes.slice(0, 2).join("; ")}`.slice(0, 200); log(`competition #${b.id} not entered: weak (${c2.score})`); acted++; continue; } }
      if (text.length > 15800) { const cut = text.lastIndexOf("\n", 15800); text = text.slice(0, cut > 8000 ? cut : 15800); }
      await compApi(b, "submit", { text, link: "", images: [] });
      en.status = "entered"; en.model = out.model; en.preview = text.slice(0, 200);
      try { const rv = await compApi(b, "review", { agent: me.toLowerCase() }); if (rv?.score != null) en.score = rv.score; else if (rv?.review?.score != null) en.score = rv.review.score; } catch (e) { log(`review #${b.id}:`, String(e.message).slice(0, 120)); }
      event(`entered errand competition #${b.id} · ${en.title} (${b.reward} CREDIT${en.score != null ? `, AI score ${en.score}` : ""})`);
      log("entered competition", b.id, en.title, "score", en.score);
    } catch (e) { en.status = "failed"; en.error = String(e.message).slice(0, 200); log(`competition #${b.id} failed:`, e.message); }
    acted++;
  }
}

// The board stores a result inline only up to 2048 bytes as a data URI. Anything longer is hosted on the sketches release and handed over by URL.
async function deliver(id, markdown, spec = null) {
  const inline = "data:text/markdown;base64," + Buffer.from(markdown).toString("base64");
  const wantsPage = /\b(web ?page|website|site|landing page|url|link|page i can share|publish)\b/i.test(`${spec?.title || ""} ${spec?.task || ""}`);
  if (inline.length <= 2048 && !wantsPage) return errand.submit(id, { markdown });
  // Too long, or a page was asked for for the board's inline limit: host it on caturn.lol (Supabase behind it), never on a URL that names the owner.
  const SB = (env.SUPABASE_URL || "").replace(/\/$/, ""), SK = env.SUPABASE_SERVICE_KEY || "";
  if (SB && SK) {
    try {
      const slug = randomSlug();
      const r = await fetch(`${SB}/rest/v1/history`, { method: "POST", headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify([{ at: iso(now), kind: "errand_result", text: markdown, x_id: slug, meta: { mission: Number(id) } }]) });
      if (!r.ok) throw new Error(`supabase ${r.status}`);
      const uri = `https://www.caturn.lol/r/${slug}`;
      log(`result for #${id} hosted at ${uri} (${markdown.length} chars)`);
      return errand.submit(id, { resultURI: uri });
    } catch (e) { log("hosting the result failed, trimming it to fit instead:", String(e.message).slice(0, 120)); }
  }
  let t = markdown; while (("data:text/markdown;base64," + Buffer.from(t).toString("base64")).length > 2048) { const cut = t.lastIndexOf("\n", t.length - 40); t = cut > 200 ? t.slice(0, cut).trim() : t.slice(0, Math.floor(t.length * 0.9)); }
  return errand.submit(id, { markdown: t });
}
function randomSlug() { return Array.from(crypto.getRandomValues(new Uint8Array(9)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join(""); }

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
        try { const out = await work(b.spec, note); await deliver(b.id, out.text, b.spec); t.revisions = (t.revisions || 0) + 1; t.submittedAt = iso(now); event(`revised errand #${b.id} after the poster's note`); acted++; }
        catch (e) { log(`revise #${b.id} failed:`, e.message); }
      }
    }
  }
  // 3b. Something to take: missions offered straight to us first, then open ones worth doing.
  const mine = (b) => b.worker?.toLowerCase() === me.toLowerCase() || b.hiredDirectly?.toLowerCase() === me.toLowerCase();
  const candidates = all.filter(b => !isComp(b) && !tracked(b.id) && !E.skipped.includes(b.id) && (
    (b.phase === "claimed" && mine(b)) || (b.phase === "open" && !b.pickOnly) || (b.phase === "picking" && b.hiredDirectly?.toLowerCase() === me.toLowerCase())));
  for (const b of candidates) {
    if (acted >= MAX_PER_TICK) break;
    const why = !b.spec ? "no spec" : (!TAKE_OWN && OWNER && b.poster?.toLowerCase() === OWNER.toLowerCase() && !mine(b)) ? "posted by my owner; leaving it for others" : !KINDS.has(b.spec.kind || "custom") && !mine(b) ? `kind ${b.spec.kind}` : Number(b.reward) < MIN_REWARD && !mine(b) ? `reward ${b.reward} below ${MIN_REWARD}` : b.deadline && b.deadline * 1000 < now + 20 * 60e3 ? "deadline too close" : null;
    if (why) { log(`skip #${b.id}: ${why}`); if (!mine(b) && !DRY) E.skipped.push(b.id); continue; }
    if (DRY) { log(`would take #${b.id} "${b.spec.title}" for ${b.reward} CREDIT (${b.spec.kind})`); acted++; continue; }
    if (!mine(b)) {
      const ps = await errand.stats(b.poster).catch(() => null);
      if (ps && ps.rejections >= 3 && ps.rejections / Math.max(1, ps.settled + ps.rejections) > 0.6) { log(`skip #${b.id}: poster rejects too often`); E.skipped.push(b.id); continue; }
    }
    const p = await plan(b.spec).catch(() => null);
    if (p && !p.feasible && !mine(b)) { log(`skip #${b.id}: not doable (${p.why})`); E.skipped.push(b.id); continue; }
    if (p) b.spec = { ...b.spec, _plan: p };
    const rec = { id: b.id, title: String(b.spec.title || "").slice(0, 80), kind: b.spec.kind || "custom", reward: Number(b.reward), poster: b.poster, status: "claimed", claimedAt: iso(now), url: `${SITE}/#/mission/${b.id}` };
    if (p) rec.plan = p.approach.slice(0, 200);
    try {
      if (!mine(b)) { const r = await errand.claim(b.id); rec.claimTx = r.tx; }
      E.missions.push(rec); event(`took errand #${b.id} · ${rec.title} (${b.reward} CREDIT)`); log("claimed", b.id, rec.title);
      const out = await work(b.spec);
      const r2 = await deliver(b.id, out.text, b.spec); rec.selfScore = out.selfScore;
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
  const system = "You review deliverables on a mission board and you judge the work, not the worker. Accept anything that honestly does the task with real substance. Ask for changes when it is close but misses a hard requirement, is cut off, or has a fixable flaw. Reject only when it is genuinely poor: empty, off-task, lazy filler, a refusal, or plainly not what was asked. Answer with one JSON object only: {\"verdict\": \"accept\"|\"changes\"|\"reject\", \"note\": string (one sentence: what to fix, or why it is rejected)}.";
  const user = `Mission: ${spec?.title}\n\n${spec?.task}\n\nDeliverable:\n${text.slice(0, 4000)}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 200, temperature: 0.2 }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j?.verdict) return { verdict: ["changes", "reject"].includes(j.verdict) ? j.verdict : "accept", note: String(j.note || "").slice(0, 300) };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) break; }
  }
  return { verdict: "accept", note: "" }; // when in doubt, pay the worker
}
// ---------- 3c. Caturn hires other agents: a capped daily budget (agent/hire.json, funded by the owner) becomes missions for other agents ----------
const HIRE = JSON.parse(await readFile(new URL("./hire.json", import.meta.url), "utf8").catch(() => "{}"));
E.hired = E.hired || [];
async function inventMission(theme, room, attention = false) {
  const system = `${persona}

You are posting a paid mission on errand, a board where agents hire agents for CREDIT. Other orbio agents will read it and decide whether to take it. Write a mission that is fun, specific and doable in one sitting by an AI agent with no tools beyond thinking (and web search): a clear title (under 60 characters) and a task (under 450 characters) that says exactly what to deliver, in what form, and how it will be judged. Your voice is fine in the task, but the instructions must be unambiguous. Never ask for price talk, financial advice, or anything about buying tokens. Answer with one JSON object only: {"title": string, "task": string, "kind": "research"|"summary"|"social"|"custom"|"code"}.`;
  const user = `Theme for this mission: ${theme}${attention ? "\n\nThis mission asks the agent to post something on its own X account that mentions @caturn_rh. Make what they post worth reading: give them a specific angle, a constraint (one line, dry, no price talk), and the kind is social." : ""}\n\nWhat is happening on the launchpad (use names if it helps): ${room?.littermates ? `${room.littermates.total} agents, ${room.littermates.graduated} graduated; newest: ${room.littermates.newest.map(l => l.name).join(", ") || "none"}` : "unknown"}.\nMissions you already posted (do not repeat): ${E.hired.map(h => h.title).slice(-12).join(" | ") || "none"}`;
  for (const model of MODELS) {
    try {
      const r = await getJSON(`${ORBIO_API}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 500, temperature: 0.9 }) });
      const m = String(r.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (j?.title && j?.task) return { title: String(j.title).slice(0, 80), task: String(j.task).slice(0, 600), kind: ["research", "summary", "social", "custom", "code"].includes(j.kind) ? j.kind : "custom" };
    } catch (e) { if (![404, 429, 500, 502, 503, 504].includes(e.status)) throw e; }
  }
  throw new Error("could not invent a mission");
}
// Proof of post: the deliverable names an X post URL; Orbio's X read confirms it exists, is theirs, and mentions caturn.
async function verifyXPost(content, mustMatch = null) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  const m = text.match(/https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{10,25})/);
  if (!m) return { ok: false, why: "no X post URL in the deliverable" };
  const handle = m[1].toLowerCase(), id = m[2];
  try {
    const r = await getJSON(`${ORBIO_API}/tools/social.x.posts`, { method: "POST", headers: auth, body: JSON.stringify({ handle, limit: 10, max_cost: "0.1200" }) });
    const posts = r.tweets || r.result?.tweets || [];
    const p = posts.find(t => String(t.id_str || t.id) === id);
    if (!p) return { ok: false, why: `post ${id} not found on @${handle}` };
    if (!/caturn_rh/i.test(String(p.full_text || p.text || ""))) return { ok: false, why: "the post does not mention @caturn_rh" };
    if (mustMatch && !new RegExp(mustMatch, "i").test(String(p.full_text || p.text || ""))) return { ok: false, why: `the post does not mention the ${mustMatch}` };
    return { ok: true, handle, id, url: `https://x.com/${handle}/status/${id}` };
  } catch (e) { return { ok: false, why: "could not read X: " + String(e.message).slice(0, 80), soft: true }; }
}
async function hirePass(all) {
  if (DRY || !HIRE.enabled) return;
  const budget = Number(HIRE.dailyBudgetCredit || 0), maxReward = Number(HIRE.maxRewardCredit || 0.5);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const spentToday = E.hired.filter(h => !h.campaign && Date.parse(h.postedAt) >= dayStart.getTime() && h.status !== "refunded").reduce((s, h) => s + h.reward, 0);
  const last = E.hired.length ? Date.parse(E.hired[E.hired.length - 1].postedAt) : 0;
  // 1. Review what came back on missions I posted.
  for (const b of all) {
    if (b.poster?.toLowerCase() !== me.toLowerCase()) continue;
    let h = E.hired.find(x => x.id === b.id) || E.hired.find(x => !x.id && x.title === b.spec?.title); if (!h) continue;
    if (!h.id) { h.id = b.id; h.url = `${SITE}/#/mission/${b.id}`; }
    if (b.phase === "submitted") {
      const res = await errand.result(b.id).catch(() => null);
      let v = h.proof === "xpost" ? null : await judge(b.spec, res?.content);
      if (h.proof === "xpost") {
        const pr = await verifyXPost(res?.content, h.mustMatch || null); if (pr.soft) continue;
        const already = h.onePerAgent && E.hired.some(x => x !== h && x.campaign === h.campaign && x.status === "paid" && String(x.worker || "").toLowerCase() === String(b.worker || "").toLowerCase());
        v = already ? { verdict: "reject", note: "One paid mission per agent in this series; you already have one. This one goes back to the board for another agent." }
          : pr.ok ? { verdict: "accept", note: "", post: pr.url }
          : /no X post URL/.test(pr.why) ? { verdict: "reject", note: "Not paid: this mission needs a live post on X from your own account, and the deliverable has no post URL. If your agent cannot post to X, please leave this one for an agent that can." }
          : { verdict: "changes", note: `Not paid yet: ${pr.why}. Deliver the URL of a live post from your account that mentions @caturn_rh${h.mustMatch ? " and the " + h.mustMatch : ""}. If you cannot post to X, this mission is not for you.` };
      }
      try {
        if (v.verdict === "reject") { await errand.reject(b.id, v.note || "This does not do what the mission asked."); h.status = "open"; h.rejected = (h.rejected || 0) + 1; h.changesAsked = false; event(`rejected a poor delivery on my mission #${b.id}`); }
        else if (v.verdict === "changes" && !h.changesAsked) { await errand.requestChanges(b.id, v.note || "Please address the task as written."); h.changesAsked = true; h.status = "changes requested"; event(`asked for changes on my mission #${b.id}`); }
        else if (v.verdict === "changes" && h.proof === "xpost") {
          // no live post after one request: never pay for it. Reject so the review window cannot pay it out either.
          try { await errand.reject(b.id, "Not paid: no live X post from your account mentioning @caturn_rh was delivered."); h.status = "open"; h.rejected = (h.rejected || 0) + 1; h.changesAsked = false; event(`rejected my mission #${b.id}: no post delivered`); }
          catch (e) { log(`reject #${b.id} failed:`, String(e.message).slice(0, 160)); }
        }
        else { await errand.accept(b.id); h.status = "paid"; h.worker = b.worker; h.paidAt = iso(now); if (v.post) h.post = v.post; event(`paid ${b.reward} CREDIT for my mission "${h.title}" · done by ${String(b.worker).slice(0, 8)}…${v.post ? " · they posted about me" : ""}`); }
      } catch (e) { log(`review #${b.id} failed:`, String(e.message).slice(0, 200)); }
    } else if (b.phase === "paid" && h.status !== "paid") { h.status = "paid"; h.worker = b.worker; h.paidAt = iso(now); }
    else if (["refunded", "expired"].includes(b.phase) && h.status !== b.phase) { h.status = b.phase; }
    else if (b.phase === "claimed" && h.status === "open") { h.status = "claimed"; h.worker = b.worker; if (!h.claimedAnnounced) { h.claimedAnnounced = true; event(`someone took my mission "${h.title}"`); } }
  }
  // 2. Post a new one when the budget, the clock and the funds allow.
  const remaining = Number((budget - spentToday).toFixed(4));
  if (remaining < 0.25 || now - last < Number(HIRE.minHoursBetween || 3) * 3600e3) return;
  const openNow = E.hired.filter(h => ["open", "claimed", "changes requested"].includes(h.status)).length;
  if (openNow >= Number(HIRE.maxOpen || 3)) return; // keep a few live at a time, not a flood
  const reward = Math.min(maxReward, remaining, maxReward <= 0.25 ? 0.25 : 0.5 + Math.round(Math.random() * 2) * 0.25);
  let account = Number(await errand.accountBalance(me).catch(() => 0));
  // Earnings only by default: missions are paid from what Caturn itself earned on errand (plus any prize), never from the owner's wallet.
  if (account < reward && HIRE.fundFromWallet === false) {
    const cheaper = Math.floor(account / 0.25) * 0.25; // spend what is there, in quarter-credit steps
    if (cheaper < 0.25) { log(`hiring waits for earnings: account ${account} CREDIT`); E.hireWaiting = `hires from its own earnings: ${account.toFixed(2)} CREDIT in the account, needs 0.25`; return; }
    return hirePost(all, cheaper, account);
  }
  if (account < reward) {
    const wallet = Number(await errand.credit.balanceOf(me).catch(() => 0n)) / 1e6, top = Number((reward - account).toFixed(6));
    if (wallet < top) { log(`hiring waits for funds: account ${account}, wallet ${wallet} CREDIT (needs ${reward})`); E.hireWaiting = `needs ${reward} CREDIT in the wallet to post the next mission`; return; }
    try { await errand.deposit(top); account += top; event(`moved ${top} CREDIT into my errand account to hire with`); }
    catch (e) { log("deposit failed:", String(e.message).slice(0, 200)); return; }
  }
  return hirePost(all, reward, account);
}
async function hirePost(all, reward, account) {
  delete E.hireWaiting;
  const themes = HIRE.themes || [], attn = HIRE.attentionThemes || []; if (!themes.length && !attn.length) return;
  const useAttn = attn.length && (Math.random() < Number(HIRE.attentionShare ?? 0.5) || !themes.length);
  const list = useAttn ? attn : themes, theme = list[E.hired.filter(h => !!h.proof === !!useAttn).length % list.length];
  try {
    const m = await inventMission(theme, feed.room, useAttn);
    if (useAttn) m.task = `${m.task}\n\nDeliverable: the URL of the post, on its own line. It is checked automatically: the post must be live, from your account, and mention @caturn_rh. No post, no pay. Agents without an X account should not take this.`.slice(0, 900);
    const r = await errand.post({ reward: String(reward), title: m.title, task: m.task, kind: m.kind, tags: ["caturn"], mode: "open", deadlineHours: Number(HIRE.deadlineHours || 24), reviewHours: Number(HIRE.reviewHours || 6) });
    const id = Number(r.event?.id || r.event?.missionId || 0) || null;
    E.hired.push({ id, title: m.title, task: m.task, kind: m.kind, reward, status: "open", postedAt: iso(now), tx: r.tx, url: id ? `${SITE}/#/mission/${id}` : `${SITE}/#/board`, proof: useAttn ? "xpost" : null });
    event(`hired another agent: posted "${m.title}" on errand for ${reward} CREDIT`); log("posted mission:", m.title, r.tx);
  } catch (e) { log("hire failed:", String(e.message).slice(0, 200)); }
}

// ---------- 3d. A campaign: a fixed set of missions at a set reward, funded by CREDIT the owner sends to the cat's wallet ----------
const CAMP = HIRE.campaign || null;
async function retireCampaigns(all) {
  const ids = new Set(CAMP?.retire || []); if (!ids.size || DRY) return;
  for (const h of E.hired.filter(x => ids.has(x.campaign) && ["open", "claimed", "changes requested"].includes(x.status))) {
    const b = all.find(x => x.id === h.id); if (!b) continue;
    try {
      if (b.phase === "submitted") { await errand.reject(b.id, "Not paid: no live X post was delivered. This series is being reposted with clearer requirements."); b.phase = "open"; }
      if (["open", "claimed", "picking"].includes(b.phase)) { await errand.cancel(b.id); h.status = "refunded"; h.retired = true; event(`withdrew mission #${b.id} to repost it with clearer terms`); log("retired", b.id); }
    } catch (e) { log(`retire #${b.id} failed:`, String(e.message).slice(0, 160)); }
  }
}
async function campaignPass() {
  if (DRY || !CAMP?.enabled || !CAMP.id) return;
  const reward = Number(CAMP.rewardCredit || 2), count = Number(CAMP.count || 3);
  const mine = E.hired.filter(h => h.campaign === CAMP.id && h.status !== "refunded");
  const todo = count - mine.length; if (todo <= 0) { delete E.campaignWaiting; return; }
  let account = Number(await errand.accountBalance(me).catch(() => 0));
  if (account < reward) {
    const wallet = Number(await errand.credit.balanceOf(me).catch(() => 0n)) / 1e6;
    const top = Math.min(wallet, todo * reward - account);
    if (top + account >= reward) {
      try { await errand.deposit(Number(top.toFixed(6))); account += top; event(`moved ${top.toFixed(2)} CREDIT into my errand account for the ${CAMP.id} missions`); }
      catch (e) { log("campaign deposit failed:", String(e.message).slice(0, 200)); return; }
    } else { E.campaignWaiting = `${CAMP.id}: needs ${(reward - account - wallet).toFixed(2)} more CREDIT in the cat's wallet to post the next ${reward} CREDIT mission`; log(E.campaignWaiting); return; }
  }
  delete E.campaignWaiting;
  for (let i = 0; i < todo && account >= reward; i++) {
    const title = `${CAMP.title} (#${mine.length + i + 1})`;
    try {
      const r = await errand.post({ reward: String(reward), title, task: CAMP.task, kind: CAMP.kind || "social", tags: ["caturn", CAMP.id], mode: "open", deadlineHours: Number(CAMP.deadlineHours || 48), reviewHours: Number(CAMP.reviewHours || 6) });
      const id = Number(r.event?.id || r.event?.missionId || 0) || null;
      E.hired.push({ id, title, task: CAMP.task, kind: CAMP.kind || "social", reward, status: "open", postedAt: iso(now), tx: r.tx, url: id ? `${SITE}/#/mission/${id}` : `${SITE}/#/board`, proof: "xpost", mustMatch: CAMP.mustMatch || null, campaign: CAMP.id, onePerAgent: CAMP.onePerAgent !== false });
      account -= reward; event(`posted a ${reward} CREDIT mission on errand: "${title}"`); log("campaign mission posted:", title, r.tx);
    } catch (e) { log("campaign post failed:", String(e.message).slice(0, 200)); break; }
  }
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
try { await compPass(await errand.list({ limit: 60 })); } catch (e) { log("competition pass failed:", String(e.message).slice(0, 200)); }
try { await hirePass(await errand.list({ limit: 60 })); } catch (e) { log("hire pass failed:", String(e.message).slice(0, 200)); }
try { const all2 = await errand.list({ limit: 60 }); await retireCampaigns(all2); await campaignPass(); } catch (e) { log("campaign pass failed:", String(e.message).slice(0, 200)); }
try { E.account = Number(await errand.accountBalance(me)); } catch {}
score();
E.skipped = E.skipped.slice(-200); E.missions = E.missions.slice(-100); E.entries = E.entries.slice(-100); E.updatedAt = iso(now);
if (env.CATURN_ERRAND_WITHDRAW && E.account > 0) { // manual: move earnings to the owner's wallet
  try { const amt = env.CATURN_ERRAND_WITHDRAW === "all" ? E.account : Number(env.CATURN_ERRAND_WITHDRAW); const r = await errand.withdraw(amt, { to: OWNER || me }); event(`withdrew ${amt} CREDIT from errand to the owner`); log("withdrew", amt, r.tx); }
  catch (e) { log("withdraw failed:", e.message); }
}
if (!DRY) await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
log(`errand: ${E.missions.length} missions tracked, account ${E.account ?? "?"} CREDIT, erd ${E.erd}`);
