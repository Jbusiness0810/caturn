// Flywheel map: particle streams from inputs into the orb and out to outputs. Plain canvas.
(function () {
  var root = document.querySelector("[data-flow]");
  if (!root) return;
  var canvas = root.querySelector("[data-flow-canvas]"), ctx = canvas.getContext("2d");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var state = { energy: 0, status: "prelaunch" };
  var streams = [], W = 0, H = 0, dpr = 1, visible = false, raf = null, last = 0;

  function rel(el) { var r = el.getBoundingClientRect(), b = root.getBoundingClientRect(); return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }; }
  function layout() {
    var b = root.getBoundingClientRect(); W = b.width; H = b.height; dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var orb = rel(root.querySelector("[data-flow-orb]")), cx = orb.x + orb.w / 2, cy = orb.y + orb.h / 2, R = orb.w / 2 - 4, Rr = R + 22;
    streams = [];
    var left = root.querySelectorAll(".flow-left .fnode"), right = root.querySelectorAll(".flow-right .fnode");
    // Streams land on the outer ring in the same vertical order as their nodes, so nothing crosses.
    left.forEach(function (n, i) {
      var r = rel(n), x0 = r.x + r.w + 6, y0 = r.y + r.h / 2;
      var ang = Math.PI - (i - (left.length - 1) / 2) * 0.3, x1 = cx + Math.cos(ang) * Rr, y1 = cy + Math.sin(ang) * Rr;
      var mx = (x0 + x1) / 2;
      streams.push({ p0: [x0, y0], c0: [mx, y0], c1: [mx, y1], p1: [x1, y1], particles: [] });
    });
    right.forEach(function (n, i) {
      var r = rel(n), x1 = r.x - 6, y1 = r.y + r.h / 2;
      var ang = (i - (right.length - 1) / 2) * 0.3, x0 = cx + Math.cos(ang) * Rr, y0 = cy + Math.sin(ang) * Rr;
      var mx = (x0 + x1) / 2;
      streams.push({ p0: [x0, y0], c0: [mx, y0], c1: [mx, y1], p1: [x1, y1], particles: [] });
    });
    root.orb = { cx: cx, cy: cy, R: R };
  }
  function bez(s, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * s.p0[0] + b * s.c0[0] + c * s.c1[0] + d * s.p1[0], a * s.p0[1] + b * s.c0[1] + c * s.c1[1] + d * s.p1[1]];
  }
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    var e = state.energy, awake = state.status === "awake" || state.status === "resting";
    var lineA = state.status === "prelaunch" ? 0.18 : 0.28 + e * 0.25;
    var o = root.orb;
    // orbit ring around the orb, slowly rotating dashes
    ctx.save(); ctx.translate(o.cx, o.cy); ctx.rotate((t / 9000) % (Math.PI * 2));
    ctx.strokeStyle = "rgba(176,138,62,.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 9]);
    ctx.beginPath(); ctx.arc(0, 0, o.R + 10, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = "rgba(176,138,62,.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, o.R + 22, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    // streams
    streams.forEach(function (s) {
      ctx.strokeStyle = "rgba(176,138,62," + lineA.toFixed(2) + ")"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(s.p0[0], s.p0[1]); ctx.bezierCurveTo(s.c0[0], s.c0[1], s.c1[0], s.c1[1], s.p1[0], s.p1[1]); ctx.stroke();
      ctx.fillStyle = "rgba(176,138,62,.8)"; [s.p0, s.p1].forEach(function (q) { ctx.beginPath(); ctx.arc(q[0], q[1], 2.2, 0, Math.PI * 2); ctx.fill(); });
      if (reduce) return;
      var want = state.status === "prelaunch" ? 0 : state.status === "napping" ? 1 : 2 + Math.round(e * 9);
      while (s.particles.length < want) s.particles.push({ t: Math.random(), v: 0.0012 + Math.random() * 0.0015 + e * 0.003, r: 1 + Math.random() * 1.4 });
      if (s.particles.length > want) s.particles.length = want;
      s.particles.forEach(function (p) {
        p.t += p.v * (awake ? 1 : 0.35); if (p.t > 1) p.t -= 1;
        var a = bez(s, p.t), b = bez(s, Math.max(0, p.t - 0.06));
        ctx.strokeStyle = "rgba(176,138,62,.28)"; ctx.lineWidth = p.r * 0.9; ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(a[0], a[1]); ctx.stroke();
        ctx.fillStyle = "rgba(140,106,44,.85)"; ctx.beginPath(); ctx.arc(a[0], a[1], p.r * 0.9, 0, Math.PI * 2); ctx.fill();
      });
    });
  }
  function loop(t) { if (!visible) { raf = null; return; } draw(t); raf = reduce ? null : requestAnimationFrame(loop); }
  function start() { if (!raf && visible) raf = requestAnimationFrame(loop); }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { es.forEach(function (x) { visible = x.isIntersecting; if (visible) { layout(); start(); } }); }, { threshold: 0.05 }).observe(root);
  } else { visible = true; layout(); start(); }
  window.addEventListener("resize", function () { layout(); if (reduce) draw(0); });
  if (reduce) { layout(); draw(0); }

  function fmtUsd(n, d) { if (n == null) return "—"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "m"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k"; return "$" + Number(n).toFixed(d == null ? 0 : d); }
  function fmtNum(n, d) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d }); }
  window.CATURN_FLOW = function (f) {
    var m = f.metrics || {}, st = f.status || "prelaunch";
    state.energy = f.energy || 0; state.status = st;
    var set = function (k, v) { var el = root.querySelector('[data-fv="' + k + '"]'); if (el) el.textContent = v; };
    var today = f.updatedAt ? f.updatedAt.slice(0, 10) : "";
    var th = (f.thoughts || []).filter(function (t) { return t.at.slice(0, 10) === today; });
    set("trades", fmtUsd(m.volume24hUsd)); set("fees", fmtUsd(m.fees24hUsd, 2));
    set("stake", m.stakedOrbio != null ? fmtNum(m.stakedOrbio, 0) + " ORBIO" : "—");
    set("balance", m.balanceCredit != null ? fmtNum(m.balanceCredit, 2) + " CR" : "—");
    set("launchpad", m.fees24hUsd != null ? fmtUsd(m.fees24hUsd * 0.05, 2) : "—");
    set("thoughts", th.filter(function (t) { return t.kind !== "dream"; }).length);
    set("dreams", th.filter(function (t) { return t.kind === "dream"; }).length);
    set("posts", (f.posts || []).length);
    set("credit", m.creditOwed != null ? fmtNum(m.creditOwed, 3) : "—");
    var e = Math.round(state.energy * 100);
    root.querySelector("[data-flow-energy-fill]").style.height = e + "%"; root.querySelector("[data-flow-energy-n]").textContent = e + "%";
    root.querySelector("[data-flow-status]").textContent = st === "awake" ? "thinking" : st === "resting" ? "resting" : st === "napping" ? "dark" : "asleep until launch";
    root.classList.toggle("is-awake", st === "awake" || st === "resting");
    // light up the nodes that moved this tick
    var ev = (f.events || []).slice(-3).map(function (x) { return x.text; }).join(" ");
    root.querySelectorAll(".fnode").forEach(function (n) { n.classList.remove("is-hot"); });
    if (/offering/.test(ev)) ["trades", "fees", "stake", "balance", "launchpad"].forEach(function (k) { var n = root.querySelector('[data-fnode="' + k + '"]'); if (n) n.classList.add("is-hot"); });
    if (/posted to X/.test(ev)) { var p = root.querySelector('[data-fnode="posts"]'); if (p) p.classList.add("is-hot"); }
    if (th.length) { var q = root.querySelector('[data-fnode="thoughts"]'); if (q) q.classList.add("is-hot"); }
    layout();
  };
})();
