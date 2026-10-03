// "Sign in with GitHub" for the terminal, through a GitHub App (Contents: read and write). The user picks which repos the
// app may touch when they install it, so the login only ever reaches those. This route does the one OAuth code exchange and
// hands the user's token to their browser in the URL fragment (never logged, never stored here).
// GET /api/github                -> { enabled, installUrl }
// GET /api/github?action=start   -> redirect to GitHub's sign-in
// GET /api/github?code=&state=   -> GitHub's callback: exchange the code, then back to /terminal#gh=<token>
import { randomBytes } from "node:crypto";

const ID = process.env.GITHUB_CLIENT_ID || "", SECRET = process.env.GITHUB_CLIENT_SECRET || "", SLUG = process.env.GITHUB_APP_SLUG || "";
const SITE = "https://www.caturn.lol";

export default async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Cache-Control", "no-store");
  if (!ID || !SECRET) {
    if (q.action || q.code) return res.redirect(302, `${SITE}/terminal#gh_error=${encodeURIComponent("github sign-in is not set up yet")}`);
    return res.status(200).json({ enabled: false });
  }
  if (q.action === "start") {
    const state = randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `gh_state=${state}; Path=/api/github; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
    return res.redirect(302, `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(ID)}&redirect_uri=${encodeURIComponent(SITE + "/api/github")}&state=${state}`);
  }
  if (q.code) {
    // installs started from GitHub's own page arrive without our state; those carry setup_action=install
    const cookie = (String(req.headers.cookie || "").match(/(?:^|;\s*)gh_state=([a-f0-9]+)/) || [])[1];
    if (!(q.setup_action === "install" || (cookie && cookie === q.state))) return res.redirect(302, `${SITE}/terminal#gh_error=${encodeURIComponent("that sign-in link expired. try again.")}`);
    const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: ID, client_secret: SECRET, code: String(q.code), redirect_uri: SITE + "/api/github" }) });
    const j = await r.json().catch(() => ({}));
    res.setHeader("Set-Cookie", "gh_state=; Path=/api/github; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    if (!j.access_token) return res.redirect(302, `${SITE}/terminal#gh_error=${encodeURIComponent(j.error_description || "github did not sign you in")}`);
    return res.redirect(302, `${SITE}/terminal#gh=${encodeURIComponent(j.access_token)}`);
  }
  return res.status(200).json({ enabled: true, installUrl: SLUG ? `https://github.com/apps/${SLUG}/installations/new` : null });
}
