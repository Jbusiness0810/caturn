// GET /api/kick?key=KICK_SECRET -> starts a "Caturn tick" workflow run on GitHub.
// For an external scheduler (cron-job.org, UptimeRobot, etc.) because GitHub's own cron is unreliable.
// Needs GITHUB_DISPATCH_TOKEN (fine-grained token, Actions: read and write on this repo) and KICK_SECRET in Vercel env.
const OWNER = "Jbusiness0810", REPO = "caturn", WORKFLOW = "caturn.yml", REF = "master";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.GITHUB_DISPATCH_TOKEN, secret = process.env.KICK_SECRET;
  if (!token || !secret) return res.status(503).json({ ok: false, error: "kick is not configured" });
  const key = (req.query && req.query.key) || (req.body && req.body.key);
  if (key !== secret) return res.status(403).json({ ok: false });
  try {
    // Skip if a loop is already running or queued, so kicks never pile up.
    const runs = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }).then(r => r.json());
    const active = (runs.workflow_runs || []).filter(r => r.status === "in_progress" || r.status === "queued" || r.status === "waiting" || r.status === "pending");
    if (active.length) return res.status(200).json({ ok: true, skipped: true, active: active.length });
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: REF, inputs: { say: "" } })
    });
    if (r.status !== 204) return res.status(502).json({ ok: false, status: r.status, body: (await r.text()).slice(0, 200) });
    return res.status(200).json({ ok: true, started: true });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) }); }
}
