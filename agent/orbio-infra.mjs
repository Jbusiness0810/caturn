// A thin client for orbio's infrastructure tools (Fly.io servers and friends): one call per tool, durable operations polled
// to a terminal state. Every mutation carries an idempotency key, so a lost reply is recovered, never replayed.
const API = "https://api.orbio.so/api/v1/infra/tools";
const KEY = process.env.ORBIO_API_KEY || "";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function infra(name, args = {}) {
  const r = await fetch(`${API}/${name}`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(60000) });
  let j = null; try { j = await r.json(); } catch { j = { error: { code: `http_${r.status}`, message: await r.text().catch(() => "") } }; }
  if (j.error) { const e = new Error(`${name}: ${j.error.code}: ${String(j.error.message).slice(0, 300)}`); e.code = j.error.code; e.retryable = j.error.retryable; e.setupUrl = j.setup_url; e.retryAfter = j.retry_after_seconds; throw e; }
  return j.result;
}

export async function waitOp(id, { timeoutMs = 900000, log = () => {} } = {}) {
  const t0 = Date.now();
  for (;;) {
    const op = await infra("operation.get", { operation_id: id });
    if (op.state === "succeeded") return op;
    if (op.state === "failed" || op.state === "cancelled") { const e = new Error(`operation ${op.action} ${op.state}: ${op.error_code || ""} ${JSON.stringify(op.result || {}).slice(0, 400)}`); e.op = op; throw e; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`operation ${op.action} still ${op.state} after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(Math.max(1000, Number(op.retry_after_seconds || 0) * 1000));
  }
}

// run a mutation and wait for it; returns the finished operation (its saved result is op.result)
export async function act(name, args, opts) { const op = await infra(name, args); return waitOp(op.id, opts); }

// find a string matching a pattern anywhere in a saved result
export function findIn(obj, re) {
  if (typeof obj === "string") return re.test(obj) ? obj : null;
  if (Array.isArray(obj)) { for (const v of obj) { const h = findIn(v, re); if (h) return h; } return null; }
  if (obj && typeof obj === "object") { for (const v of Object.values(obj)) { const h = findIn(v, re); if (h) return h; } }
  return null;
}
export function findKey(obj, key) {
  if (Array.isArray(obj)) { for (const v of obj) { const h = findKey(v, key); if (h != null) return h; } return null; }
  if (obj && typeof obj === "object") { if (obj[key] != null) return obj[key]; for (const v of Object.values(obj)) { const h = findKey(v, key); if (h != null) return h; } }
  return null;
}

// the newest funding window of a resource, and whether it needs renewing within `hours`
export async function fundingState(resourceId) {
  const r = await infra("funding.list", { resource_id: resourceId, limit: 20 });
  const items = (r.items || []).filter(f => f.funded_until).sort((a, b) => Date.parse(b.funded_until) - Date.parse(a.funded_until));
  return { latest: items[0] || null, fundedUntil: items[0] ? items[0].funded_until : null, items };
}
export async function renewIfNeeded(resourceId, { hours = 12, lifetime = 86400, maxCost = "2.0", log = console.log } = {}) {
  const f = await fundingState(resourceId);
  if (!f.fundedUntil) { log("renew: no funding window found"); return null; }
  const left = (Date.parse(f.fundedUntil) - Date.now()) / 3600e3;
  if (left > hours) { log(`renew: funded for ${left.toFixed(1)}h more, nothing to do`); return f; }
  const key = `renew-${resourceId.slice(0, 8)}-${f.fundedUntil.slice(0, 13)}`;
  const op = await act("worker.renew", { idempotency_key: key, max_cost: maxCost, resource_id: resourceId, lifetime_seconds: lifetime, on_expiry: "delete" }, { log });
  log(`renew: window extended (op ${op.id}, state ${op.state})`);
  return fundingState(resourceId);
}
