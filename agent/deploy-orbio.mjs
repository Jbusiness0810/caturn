// Deploy the runner to an orbio-managed Fly.io machine. Runs in GitHub Actions, where the secrets live:
//   node agent/deploy-orbio.mjs status   -> permissions, pricing, the resource, its funding and machines
//   node agent/deploy-orbio.mjs deploy   -> ensure the app, build and upload the image, create or update the machine
//   node agent/deploy-orbio.mjs logs     -> recent application logs
//   node agent/deploy-orbio.mjs restart  -> restart the machine
//   node agent/deploy-orbio.mjs renew    -> extend the app's funding window
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { infra, act, findIn, findKey, fundingState, renewIfNeeded } from "./orbio-infra.mjs";
const ex = promisify(execFile);
const env = process.env, mode = process.argv[2] || "status";
const log = (...a) => console.log(`[deploy ${new Date().toISOString().slice(11, 19)}]`, ...a);
const NAME = env.CATURN_FLY_APP || "caturn-runner", REGION = env.CATURN_FLY_REGION || "iad";
const DAILY_CAP = env.CATURN_FLY_DAILY_CAP || "2.0";        // ceiling in CREDIT for one 24h funding window
const MEM = Number(env.CATURN_FLY_MEMORY_MB || 1024), CPUS = Number(env.CATURN_FLY_CPUS || 1);
const RUN = env.GITHUB_RUN_ID || String(Date.now());
// what the machine gets; only the ones set here are forwarded (the machine takes at most 32)
const FORWARD = ["ORBIO_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CATURN_AGENT_ID", "CATURN_MODEL", "CATURN_DAILY_CAP", "CATURN_FULL_VOLUME_USD", "CATURN_POST_INTERVAL_MIN", "CATURN_TICK_MIN", "CATURN_TAG_HANDLES", "CATURN_TAG_EVERY", "CATURN_REPLY_EVERY", "CATURN_REPLY_ACCOUNTS", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "ERRAND_KEY", "ERRAND_OWNER", "ERRAND_MIN_REWARD", "ERRAND_TAKE_OWN", "CATURN_FOUND_SKETCHES", "CATURN_FOUND_ARTISTS", "CATURN_FOUND_CURATORS", "CATURN_FOUND_MIN_HEARTS", "CATURN_FOUND_LICENSES", "CATURN_ORBIO_SOCIAL", "CATURN_FLY_DAILY_CAP"];

async function status() {
  const s = await infra("infra.status", {});
  log("agent:", s.agent?.name, s.agent?.id, "| permissions:", (s.permissions || []).join(", ") || "(none)", "| fly configured:", s.providers?.fly, "| setup:", s.setup_url || "");
  log("project budget (micro-usd):", s.project?.budget_micro_usd, "reserved", s.project?.reserved_micro_usd, "spent", s.project?.spent_micro_usd);
  try { const p = await infra("infra.pricing", {}); log("pricing:", JSON.stringify(p).slice(0, 600)); } catch (e) { log("pricing:", e.message); }
  const r = await findResource();
  if (!r) { log("no worker resource named", NAME, "yet"); return null; }
  log("resource:", r.id, r.state, "expires", r.expires_at, "provider id", r.provider_id);
  const f = await fundingState(r.id); log("funded until:", f.fundedUntil, "| windows:", f.items.length);
  const m = await infra("worker.machine.list", { resource_id: r.id }); log("machines:", JSON.stringify(m.items || []).slice(0, 800));
  return r;
}
async function findResource() {
  let before = undefined;
  for (let i = 0; i < 10; i++) {
    const r = await infra("resource.list", { limit: 50, ...(before ? { before } : {}) });
    const hit = (r.items || []).find(x => x.kind === "worker" && x.name === NAME && !["deleted", "deleting"].includes(x.state));
    if (hit) return hit;
    if (!r.next_cursor) return null; before = r.next_cursor;
  }
  return null;
}
async function ensureResource() {
  let r = await findResource();
  if (r) { log("app exists:", r.id, r.state); await renewIfNeeded(r.id, { hours: 20, maxCost: DAILY_CAP, log }); return r; }
  log("creating the app", NAME, "with a 24h window, ceiling", DAILY_CAP, "CREDIT");
  const op = await act("worker.create", { idempotency_key: `create-${NAME}-${RUN}`, max_cost: DAILY_CAP, lifetime_seconds: 86400, name: NAME, on_expiry: "delete" }, { log });
  log("create result:", JSON.stringify(op.result).slice(0, 600));
  r = await findResource(); if (!r) throw new Error("app created but not found in resource.list");
  return r;
}

// ---- image: build with buildx into an OCI layout, upload every blob, publish the manifest ----
async function buildImage() {
  await rm("out/oci", { recursive: true, force: true }); await mkdir("out/oci", { recursive: true });
  log("building the image");
  await ex("docker", ["buildx", "build", "--platform", "linux/amd64", "--provenance=false", "--sbom=false", "--output", "type=oci,dest=out/image.tar", "."], { maxBuffer: 64e6 });
  await ex("tar", ["-xf", "out/image.tar", "-C", "out/oci"]);
  const index = JSON.parse(await readFile("out/oci/index.json", "utf8"));
  let mdesc = index.manifests[0];
  let manifestBytes = await readFile(`out/oci/blobs/sha256/${mdesc.digest.slice(7)}`);
  let manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.manifests) { // an index: take the amd64 manifest
    mdesc = manifest.manifests.find(m => m.platform?.architecture === "amd64") || manifest.manifests[0];
    manifestBytes = await readFile(`out/oci/blobs/sha256/${mdesc.digest.slice(7)}`); manifest = JSON.parse(manifestBytes.toString("utf8"));
  }
  const digest = "sha256:" + createHash("sha256").update(manifestBytes).digest("hex");
  log("manifest", digest, "config", manifest.config.digest, "layers", manifest.layers.length, "total", manifest.layers.reduce((a, l) => a + l.size, 0), "bytes");
  return { digest, manifestBytes, manifest };
}
async function uploadBlob(resourceId, digest, size) {
  const buf = await readFile(`out/oci/blobs/sha256/${digest.slice(7)}`);
  if (buf.length !== size) throw new Error(`blob ${digest} size ${buf.length} != ${size}`);
  const tag = digest.slice(7, 19);
  const begin = await act("worker.image.upload.begin", { idempotency_key: `up-${RUN}-${tag}`, max_cost: "0.20", resource_id: resourceId, digest, size_bytes: size }, { log });
  const res = begin.result || {};
  const uploadId = findKey(res, "upload_id") || begin.id;
  let offset = Number(findKey(res, "offset") ?? findKey(res, "confirmed_offset") ?? 0);
  const state = String(findKey(res, "state") || "");
  if (/complete|present|exists/i.test(state) || offset >= size) { log(`blob ${tag} already present`); return; }
  log(`uploading blob ${tag}: ${size} bytes from offset ${offset}`);
  const CHUNK = 131072;
  while (offset < size) {
    const part = buf.subarray(offset, Math.min(size, offset + CHUNK));
    let confirmed;
    try {
      const op = await act("worker.image.upload.chunk", { idempotency_key: `ch-${RUN}-${tag}-${offset}`, max_cost: "0.05", resource_id: resourceId, upload_id: uploadId, offset, content_base64: part.toString("base64") }, { log, timeoutMs: 300000 });
      confirmed = Number(findKey(op.result || {}, "offset") ?? findKey(op.result || {}, "confirmed_offset") ?? (offset + part.length));
    } catch (e) {
      // a chunk stuck reconciling: the recorded progress says whether the bytes landed; never resend uncertain bytes with a new key
      log(`chunk at ${offset} uncertain (${String(e.message).slice(0, 80)}); reading recorded progress`);
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const g = await infra("worker.image.upload.get", { resource_id: resourceId, upload_id: uploadId });
        const rec = Number(findKey(g, "confirmed_offset") ?? findKey(g, "offset") ?? -1);
        if (rec >= offset + part.length) { confirmed = rec; break; }
      }
      if (confirmed == null) throw e;
    }
    offset = confirmed > offset ? confirmed : offset + part.length;
    if ((offset / CHUNK) % 50 === 0 || offset >= size) log(`  ${tag}: ${offset}/${size}`);
  }
  await act("worker.image.upload.complete", { idempotency_key: `done-${RUN}-${tag}`, max_cost: "0.20", resource_id: resourceId, upload_id: uploadId }, { log });
  log(`blob ${tag} complete`);
}
async function publishImage(resourceId) {
  const { digest, manifestBytes, manifest } = await buildImage();
  await uploadBlob(resourceId, manifest.config.digest, manifest.config.size);
  for (const l of manifest.layers) await uploadBlob(resourceId, l.digest, l.size);
  const op = await act("worker.image.publish", { idempotency_key: `pub-${RUN}-${digest.slice(7, 19)}`, max_cost: "0.50", resource_id: resourceId, digest, manifest_base64: manifestBytes.toString("base64") }, { log });
  log("publish result:", JSON.stringify(op.result).slice(0, 800));
  const ref = findIn(op.result, /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/);
  if (!ref) throw new Error("no image reference in the publish result");
  log("image:", ref);
  return ref;
}
function machineEnv(resourceId) {
  const e = {}; for (const k of FORWARD) if (env[k]) e[k] = env[k];
  e.CATURN_FLY_RESOURCE_ID = resourceId; e.CATURN_RUNNER = "1"; e.CATURN_TICK_MIN = e.CATURN_TICK_MIN || "10"; e.CATURN_POST_INTERVAL_MIN = e.CATURN_POST_INTERVAL_MIN || "10";
  if (Object.keys(e).length > 32) throw new Error(`machine env has ${Object.keys(e).length} keys, the limit is 32`);
  return e;
}
async function deploy() {
  const r = await ensureResource();
  const image = await publishImage(r.id);
  const list = await infra("worker.machine.list", { resource_id: r.id });
  const existing = (list.items || [])[0];
  const configuration = { image, region: existing?.region || REGION, cpu_count: CPUS, memory_mb: MEM, env: machineEnv(r.id) };
  let op;
  if (existing) { log("updating machine", existing.machine_id, "in", existing.region); op = await act("worker.machine.update", { idempotency_key: `upd-${RUN}`, max_cost: "1.0", resource_id: r.id, machine_id: existing.machine_id, configuration }, { log }); }
  else { log("creating a machine in", REGION, `${CPUS} cpu, ${MEM} MB`); op = await act("worker.machine.create", { idempotency_key: `mk-${RUN}`, max_cost: "1.0", resource_id: r.id, ...configuration }, { log }); }
  log("machine result:", JSON.stringify(op.result).slice(0, 800));
  await new Promise(res => setTimeout(res, 20000));
  await logs(r);
}
async function logs(r) {
  r = r || await findResource(); if (!r) { log("no app"); return; }
  const l = await infra("worker.logs", { resource_id: r.id, maximum_bytes: 32768 });
  for (const it of l.items || []) console.log(typeof it === "string" ? it : `${it.timestamp || it.time || ""} ${it.message || it.text || JSON.stringify(it)}`);
}
async function restart() {
  const r = await findResource(); if (!r) throw new Error("no app");
  const m = (await infra("worker.machine.list", { resource_id: r.id })).items?.[0]; if (!m) throw new Error("no machine");
  const op = await act("worker.machine.restart", { idempotency_key: `rs-${RUN}`, max_cost: "0.5", resource_id: r.id, machine_id: m.machine_id }, { log });
  log("restart:", op.state);
}
async function renew() { const r = await findResource(); if (!r) throw new Error("no app"); const f = await renewIfNeeded(r.id, { hours: 23, maxCost: DAILY_CAP, log }); log("funded until", f?.fundedUntil); }

try {
  if (mode === "status") await status();
  else if (mode === "deploy") await deploy();
  else if (mode === "logs") await logs();
  else if (mode === "restart") await restart();
  else if (mode === "renew") await renew();
  else throw new Error("unknown mode " + mode);
} catch (e) { console.error("FAILED:", e.message, e.setupUrl ? `(setup: ${e.setupUrl})` : "", e.op ? JSON.stringify(e.op).slice(0, 800) : ""); process.exit(1); }
