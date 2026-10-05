// Published files (the live feed, cards, sketches) live in a public Supabase Storage bucket when the agent runs outside
// GitHub Actions. The site serves them from caturn.lol (/api/feed, /a/<name>), so no bucket URL appears on the site.
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY || "";
export const BUCKET = process.env.CATURN_BUCKET || "caturn";
export const storageOn = () => !!(SB && KEY);
export const publicUrl = (name) => `${SB}/storage/v1/object/public/${BUCKET}/${name}`;
const H = () => ({ Authorization: `Bearer ${KEY}`, apikey: KEY });

export async function ensureBucket() {
  if (!storageOn()) return false;
  const r = await fetch(`${SB}/storage/v1/bucket`, { method: "POST", headers: { ...H(), "Content-Type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }) });
  if (r.ok || r.status === 409) return true;
  const t = await r.text().catch(() => "");
  if (/already exists|duplicate/i.test(t)) return true;
  throw new Error(`bucket ${r.status}: ${t.slice(0, 200)}`);
}

// upload (or replace) one object; returns its public URL
export async function putObject(name, body, contentType = "application/octet-stream", cacheSeconds = 60) {
  if (!storageOn()) throw new Error("storage not configured");
  const r = await fetch(`${SB}/storage/v1/object/${BUCKET}/${name}`, { method: "POST", headers: { ...H(), "Content-Type": contentType, "x-upsert": "true", "cache-control": `max-age=${cacheSeconds}` }, body, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`storage put ${name}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return publicUrl(name);
}

export async function getObject(name) {
  const r = await fetch(`${publicUrl(name)}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(60000) });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

export const TYPES = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", md: "text/markdown; charset=utf-8", json: "application/json; charset=utf-8" };
export const typeOf = (name) => TYPES[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
