// Long-term memory in Supabase: people the cat has talked to, things worth remembering, a full history, and how posts landed.
// Everything here is best-effort: when the database is missing or down the tick carries on without memory.
const env = process.env;
const SB_URL = (env.SUPABASE_URL || "").replace(/\/$/, ""), SB_KEY = env.SUPABASE_SERVICE_KEY || "";
export const MEMORY_ON = !!(SB_URL && SB_KEY);
const log = (...a) => console.log(`[memory]`, ...a);
const iso = (t) => new Date(t).toISOString();

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: init.prefer || "return=representation" } });
  const text = await r.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`supabase ${r.status}: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 160)}`);
  return body;
}
const STOP = new Set("the a an and or of to in on at for with from by is are was were be i me my you your it its this that these those as if so not no yes we they them their he she his her who what when where why how do did does have has had will would can could just very about into over under than then there here out up down off".split(" "));
export function tagsFor(...texts) {
  const tags = new Set();
  for (const t of texts.filter(Boolean)) {
    for (const m of String(t).matchAll(/@(\w{1,15})/g)) tags.add(m[1].toLowerCase());
    for (const m of String(t).matchAll(/\$([a-z]{2,10})\b/gi)) tags.add(m[1].toLowerCase());
    for (const w of String(t).toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").split(/\s+/)) if (w.length >= 4 && !STOP.has(w)) tags.add(w);
  }
  return [...tags].slice(0, 24);
}

// ---- first run: seed what the cat should already know ----
export async function seed(feed, seeds) {
  if (!MEMORY_ON || feed.memory?.seeded) return;
  try {
    const existing = await sb("memories?select=id&limit=1");
    if (!existing.length && seeds?.length) await sb("memories", { method: "POST", body: JSON.stringify(seeds.map(s => ({ kind: s.kind || "fact", text: s.text, importance: s.importance || 4, tags: tagsFor(s.text, ...(s.tags || [])), source: "seed" }))), prefer: "return=minimal" });
    feed.memory = { ...(feed.memory || {}), seeded: true }; log("seeded", existing.length ? 0 : seeds.length);
  } catch (e) { log("seed failed:", e.message); feed.memory = { ...(feed.memory || {}), lastError: `seed: ${String(e.message).slice(0, 120)}` }; }
}

// ---- recall: what to put in front of the model this tick ----
export async function recall(ctx, feed) {
  if (!MEMORY_ON) return null;
  try {
    const handle = ctx.replyTo?.handle ? String(ctx.replyTo.handle).toLowerCase() : null;
    const roomNames = (ctx.room?.littermates?.newest || []).map(l => l.name).concat((ctx.room?.ecosystem || []).map(e => e.name)).filter(Boolean);
    const contextTags = tagsFor(ctx.replyTo?.text, ctx.errandNews, ctx.milestone, handle ? "@" + handle : "", ...roomNames.slice(0, 12));
    const out = { lines: [], used: [] };
    const [person, strong, matched, landed] = await Promise.all([
      handle ? sb(`people?handle=eq.${encodeURIComponent(handle)}&select=handle,name,summary,interactions,last_reply_at,met_how`) : [],
      sb(`memories?order=importance.desc,created_at.desc&limit=8&select=id,text,kind,importance,created_at`),
      contextTags.length ? sb(`memories?tags=ov.{${contextTags.map(t => `"${t.replace(/"/g, "")}"`).join(",")}}&order=importance.desc,created_at.desc&limit=6&select=id,text,kind,importance,created_at`) : [],
      sb(`history?kind=eq.post&likes=not.is.null&at=gte.${encodeURIComponent(iso(Date.now() - 7 * 86400e3))}&order=likes.desc,replies.desc&limit=3&select=text,likes,replies,views,at`)
    ]);
    if (person?.[0]) { const p = person[0]; out.lines.push(`- about @${p.handle}${p.name ? ` (${p.name})` : ""}: you have exchanged ${p.interactions} message${p.interactions === 1 ? "" : "s"}${p.last_reply_at ? `, last ${ago(p.last_reply_at)}` : ""}. ${p.summary || ""}${p.met_how ? ` (${p.met_how})` : ""}`.trim()); out.person = p; }
    else if (handle) out.lines.push(`- about @${handle}: first time you two have talked.`);
    const seen = new Set(); const mems = [];
    for (const m of [...(matched || []), ...(strong || [])]) if (!seen.has(m.id)) { seen.add(m.id); mems.push(m); }
    for (const m of mems.slice(0, 10)) { out.lines.push(`- ${m.text} (${ago(m.created_at)})`); out.used.push(m.id); }
    if (landed?.length) out.lines.push(`- what landed this week, by likes: ${landed.map(p => `"${String(p.text).replace(/\s+/g, " ").slice(0, 70)}" (${p.likes} likes, ${p.replies} replies)`).join("; ")}. More of what makes those work, never the same joke.`);
    if (out.used.length) sb(`memories?id=in.(${out.used.join(",")})`, { method: "PATCH", body: JSON.stringify({ last_used: iso(Date.now()) }), prefer: "return=minimal" }).catch(() => {});
    return out.lines.length ? out : null;
  } catch (e) { log("recall failed:", e.message); feed.memory = { ...(feed.memory || {}), lastError: `recall: ${String(e.message).slice(0, 120)}` }; return null; }
}
function ago(t) { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; }

// ---- remember: write the tick down ----
export async function remember({ feed, thought, post, ctx, model }) {
  if (!MEMORY_ON) return;
  try {
    const rows = [];
    if (thought) rows.push({ at: thought.at, kind: thought.kind || "thought", text: thought.text, meta: { mood: thought.mood, focus: thought.focus, cost: thought.cost } });
    if (post) rows.push({ at: post.at, kind: post.kind === "reply" ? "reply" : "post", text: post.text, x_id: post.id ? String(post.id) : null, meta: { via: post.via, kind: post.kind, replyTo: post.replyTo ? { handle: post.replyTo.handle, id: post.replyTo.id } : null, tagged: post.tagged || null, sketch: post.sketch ? { family: post.sketch.family, author: post.sketch.source?.author || null } : null } });
    if (rows.length) await sb("history", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
    // the person on the other end
    if (post?.replyTo?.handle) {
      const h = String(post.replyTo.handle).toLowerCase();
      const cur = (await sb(`people?handle=eq.${encodeURIComponent(h)}&select=handle,interactions,summary,notes`))[0];
      const note = { at: post.at, they: String(post.replyTo.text || "").slice(0, 140), me: String(post.text || "").slice(0, 140) };
      const body = { handle: h, name: post.replyTo.name || cur?.name || null, interactions: (cur?.interactions || 0) + 1, last_seen: post.at, last_reply_at: post.at,
        summary: model?.aboutThem ? String(model.aboutThem).slice(0, 240) : (cur?.summary || null), met_how: cur ? undefined : (post.replyTo.why || "on x"), notes: [...(cur?.notes || []), note].slice(-8) };
      if (body.met_how === undefined) delete body.met_how;
      await sb("people", { method: "POST", headers: {}, body: JSON.stringify(body), prefer: "resolution=merge-duplicates,return=minimal" });
    }
    // what the model asked to keep
    const keep = (model?.remember || []).map(s => String(s).trim()).filter(s => s.length > 12 && s.length < 240).slice(0, 2);
    if (keep.length) await sb("memories", { method: "POST", body: JSON.stringify(keep.map(text => ({ kind: "note", text, importance: 3, tags: tagsFor(text, ctx?.replyTo?.handle ? "@" + ctx.replyTo.handle : ""), source: "tick" }))), prefer: "return=minimal" });
  } catch (e) { log("remember failed:", e.message); feed.memory = { ...(feed.memory || {}), lastError: `remember: ${String(e.message).slice(0, 120)}` }; }
}
export async function rememberEvent(text, kind = "event", importance = 3, extraTags = []) {
  if (!MEMORY_ON) return;
  try { await sb("memories", { method: "POST", body: JSON.stringify([{ kind, text: String(text).slice(0, 240), importance, tags: tagsFor(text, ...extraTags), source: kind }]), prefer: "return=minimal" }); } catch (e) { log("event memory failed:", e.message); }
}

// ---- measure: how did the recent posts do (read back through orbio, a few cents an hour) ----
export async function measure(feed, readX) {
  if (!MEMORY_ON) return 0;
  const last = feed.memory?.measuredAt ? Date.parse(feed.memory.measuredAt) : 0;
  if (Date.now() - last < 55 * 60e3) return 0;
  feed.memory = { ...(feed.memory || {}), measuredAt: iso(Date.now()) };
  try {
    const mine = await readX({ handle: "caturn_rh", limit: 20 });
    const byId = new Map(mine.map(t => [t.id, t]));
    const rows = await sb(`history?x_id=in.(${[...byId.keys()].map(i => `"${i}"`).join(",")})&select=id,x_id,likes`);
    let n = 0;
    for (const r of rows) { const t = byId.get(r.x_id); if (!t) continue; await sb(`history?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ likes: t.likes, replies: t.replies, reposts: t.reposts, views: t.views, measured_at: iso(Date.now()) }), prefer: "return=minimal" }); n++; }
    log(`measured ${n} posts`);
    return mine.length * 0.00022;
  } catch (e) { log("measure failed:", e.message); feed.memory = { ...(feed.memory || {}), lastError: `measure: ${String(e.message).slice(0, 120)}` }; return 0; }
}

// ---- reflect: once a day, turn the day into a few memories ----
export async function reflect(feed, chat) {
  if (!MEMORY_ON) return 0;
  const last = feed.memory?.reflectedAt ? Date.parse(feed.memory.reflectedAt) : 0;
  if (Date.now() - last < 24 * 3600e3) return 0;
  feed.memory = { ...(feed.memory || {}), reflectedAt: iso(Date.now()) };
  try {
    const since = iso(Date.now() - 24 * 3600e3);
    const [hist, people] = await Promise.all([
      sb(`history?at=gte.${encodeURIComponent(since)}&order=at.asc&limit=400&select=at,kind,text,likes,replies,meta`),
      sb(`people?last_seen=gte.${encodeURIComponent(since)}&order=interactions.desc&limit=12&select=handle,name,interactions,summary`)
    ]);
    const day = hist.map(h => `${h.at.slice(11, 16)} ${h.kind}${h.meta?.replyTo?.handle ? ` to @${h.meta.replyTo.handle}` : ""}${h.likes != null ? ` [${h.likes} likes, ${h.replies} replies]` : ""}: ${String(h.text || "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n").slice(0, 14000);
    const events = (feed.events || []).filter(e => Date.parse(e.at) > Date.now() - 24 * 3600e3).map(e => e.text).slice(-60).join("\n");
    const system = "You are the memory of Caturn, a cat agent on the Orbio launchpad. Read the last day of its thoughts, posts, replies and events and write down what it should still know next week. Prefer: people worth remembering and why, things that happened to it (money, missions, graduations, fights, favours), bits and jokes that landed (with the numbers), bits that are worn out, lessons about what people reply to, promises it made. Each memory is one plain sentence in the first person, concrete, with names and numbers, no poetry. Answer with one JSON object only: {\"memories\": [{\"text\": string, \"importance\": 1-5, \"kind\": \"person\"|\"event\"|\"lesson\"|\"bit\"|\"promise\"}], \"day\": one sentence summing the day}";
    const user = `The day:\n${day}\n\nEvents:\n${events}\n\nPeople seen today: ${people.map(p => `@${p.handle} (${p.interactions}x${p.summary ? ": " + p.summary : ""})`).join("; ") || "none"}\n\nWrite 3 to 7 memories.`;
    const r = await chat([{ role: "system", content: system }, { role: "user", content: user }], 900);
    const m = String(r.text || "").match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
    const mems = (j?.memories || []).map(x => ({ kind: ["person", "event", "lesson", "bit", "promise"].includes(x.kind) ? x.kind : "lesson", text: String(x.text || "").slice(0, 240), importance: Math.max(1, Math.min(5, Number(x.importance) || 3)), tags: tagsFor(x.text), source: "reflection" })).filter(x => x.text.length > 12);
    if (j?.day) mems.push({ kind: "event", text: `day summary: ${String(j.day).slice(0, 220)}`, importance: 2, tags: tagsFor(j.day), source: "reflection" });
    if (mems.length) await sb("memories", { method: "POST", body: JSON.stringify(mems), prefer: "return=minimal" });
    // old low-value memories fade: anything under importance 3, unused, older than 10 days
    await sb(`memories?importance=lte.2&last_used=is.null&created_at=lt.${encodeURIComponent(iso(Date.now() - 10 * 86400e3))}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
    log(`reflected: ${mems.length} memories`);
    return r.cost || 0;
  } catch (e) { log("reflect failed:", e.message); feed.memory = { ...(feed.memory || {}), lastError: `reflect: ${String(e.message).slice(0, 120)}` }; return 0; }
}
