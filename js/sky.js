// The sky over orbio: every launchpad agent as a planet. p5.js, global mode, cream and brass.
// ?shot=1 renders a square 480px frame with no HUD, for the loop to film and post.
(function () {
  var q = new URLSearchParams(location.search), SHOT = q.get("shot") === "1";
  var CREAM = [246, 241, 232], INK = [43, 35, 22], BRASS = [176, 138, 62], BRASS_DEEP = [140, 105, 40], UMBER = [90, 69, 32], DUST = [214, 200, 170];
  var agents = [], meta = { at: null }, layout = [], stars = null, core = null, W = 0, H = 0, cx = 0, cy = 0, t0 = 0, hover = null, pinned = null, dataReady = false;
  var ME = (window.CATURN && window.CATURN.ca || "0x9b4e217f8759cb758664ac3b0ee730a4d15e7f6a").toLowerCase();
  var $ = function (s) { return document.querySelector(s); };
  var fmtUsd = function (v) { return v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + v.toFixed(v < 10 ? 2 : 0); };
  var hash = function (s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

  function load() {
    fetch("/api/sky?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      agents = (d.agents || []); meta = d; dataReady = true; place();
      if (!SHOT) {
        $("[data-sky-count]").textContent = agents.length;
        $("[data-sky-lit]").textContent = agents.filter(function (a) { return a.fees > 0; }).length;
        $("[data-sky-grad]").textContent = agents.filter(function (a) { return a.graduated; }).length;
        $("[data-sky-at]").textContent = new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    }).catch(function () {});
  }

  // Orbit radius from fee rank (busy inside), size from market cap, speed from fees, phase from the token.
  var TILT = 0.34; // how flat the disc is: a wide screen sees it edge-on, a phone sees it from above
  function place() {
    var portrait = H > W * 1.05;
    TILT = SHOT ? 0.5 : portrait ? 0.9 : 0.34;
    var scale = SHOT ? 0.6 : portrait ? 0.62 : 1;
    var lit = agents.filter(function (a) { return a.fees > 0; }).sort(function (a, b) { return b.fees - a.fees; });
    var dark = agents.filter(function (a) { return !(a.fees > 0); });
    var R = Math.min(W, H) * 0.47, r0 = Math.min(W, H) * 0.075;
    var maxMcap = Math.max(1, Math.max.apply(null, agents.map(function (a) { return a.mcap; })));
    var maxFees = Math.max(1, lit.length ? lit[0].fees : 1);
    layout = [];
    lit.forEach(function (a, i) {
      var k = lit.length > 1 ? i / (lit.length - 1) : 0;                 // 0 busiest .. 1 quietest
      var orbit = r0 + (R * 0.78 - r0) * Math.pow(k, 0.72);
      var size = scale * (2.2 + 12 * Math.sqrt(Math.log10(1 + a.mcap) / Math.log10(1 + maxMcap)));
      var speed = 0.10 + 1.15 * Math.pow(Math.log10(1 + a.fees) / Math.log10(1 + maxFees), 1.6); // radians per minute-ish
      layout.push({ a: a, orbit: orbit, size: size, speed: speed, phase: hash(a.token) * Math.PI * 2, tilt: TILT + 0.12 * hash(a.token + "t"), lit: true, wob: hash(a.token + "w") });
    });
    dark.forEach(function (a) {
      var band = R * (0.84 + 0.14 * hash(a.token + "b"));
      layout.push({ a: a, orbit: band, size: 1.4 + 3 * Math.sqrt(Math.log10(1 + a.mcap) / Math.log10(1 + maxMcap)), speed: 0.03 + 0.03 * hash(a.token + "s"), phase: hash(a.token) * Math.PI * 2, tilt: TILT, lit: false, wob: hash(a.token + "w") });
    });
  }

  function makeStars() {
    stars = createGraphics(W, H); stars.noStroke();
    for (var i = 0; i < W * H / 2600; i++) { var x = Math.random() * W, y = Math.random() * H, s = Math.random(); stars.fill(UMBER[0], UMBER[1], UMBER[2], 40 + 90 * s); stars.circle(x, y, 0.6 + 1.6 * s); }
    for (var j = 0; j < 90; j++) { stars.fill(BRASS[0], BRASS[1], BRASS[2], 10 + 14 * Math.random()); stars.circle(Math.random() * W, Math.random() * H, 1.2 + 1.8 * Math.random()); }
  }

  window.setup = function () {
    var host = SHOT ? document.body : $("[data-sky-canvas]");
    W = SHOT ? 480 : host.clientWidth; H = SHOT ? 480 : host.clientHeight;
    var c = createCanvas(W, H); c.parent(host); pixelDensity(SHOT ? 1 : Math.min(2, window.devicePixelRatio || 1));
    if (SHOT) { document.body.classList.add("sky-shot"); c.style("position", "fixed"); c.style("left", "0"); c.style("top", "0"); c.style("z-index", "50"); }
    cx = W / 2; cy = H / 2; t0 = millis(); makeStars();
    background(CREAM[0], CREAM[1], CREAM[2]);
    load(); setInterval(load, 120000);
  };
  window.windowResized = function () { if (SHOT) return; var host = $("[data-sky-canvas]"); W = host.clientWidth; H = host.clientHeight; resizeCanvas(W, H); cx = W / 2; cy = H / 2; makeStars(); place(); background(CREAM[0], CREAM[1], CREAM[2]); };

  function pos(p, tsec) {
    var ang = p.phase + p.speed * tsec / 60 * (p.lit ? 1 : 0.35);
    var wob = 1 + 0.02 * Math.sin(tsec * 0.6 + p.wob * 10);
    return { x: cx + Math.cos(ang) * p.orbit * wob, y: cy + Math.sin(ang) * p.orbit * p.tilt * wob, ang: ang };
  }

  window.draw = function () {
    var tsec = (millis() - t0) / 1000 + 7;
    // trails: the sky is a long exposure
    noStroke(); fill(CREAM[0], CREAM[1], CREAM[2], 18); rect(0, 0, W, H);
    if (stars) { push(); tint(255, 26); image(stars, 0, 0); pop(); }
    // orbit rings, faint
    noFill(); stroke(BRASS[0], BRASS[1], BRASS[2], 14); strokeWeight(1);
    var R = Math.min(W, H) * 0.47; for (var r = Math.min(W, H) * 0.075; r < R * 0.8; r += R * 0.09) ellipse(cx, cy, r * 2, r * 2 * (TILT + 0.06));
    // the core: orbio
    for (var g = 10; g > 0; g--) { noStroke(); fill(190, 150, 70, 5); circle(cx, cy, 30 + g * 9 + 3 * Math.sin(tsec * 1.3)); }
    noStroke(); fill(BRASS_DEEP[0], BRASS_DEEP[1], BRASS_DEEP[2]); circle(cx, cy, 22); fill(246, 241, 232, 200); circle(cx - 4, cy - 4, 7);
    // planets, back to front by y
    var pts = layout.map(function (p) { var q = pos(p, tsec); return { p: p, x: q.x, y: q.y }; }).sort(function (a, b) { return a.y - b.y; });
    var mx = mouseX, my = mouseY, near = null, nd = 18;
    pts.forEach(function (o) {
      var p = o.p, a = p.a, me = a.token.toLowerCase() === ME, d = dist(mx, my, o.x, o.y);
      if (d < nd + p.size) { nd = d; near = o; }
      if (p.lit) {
        // glow
        for (var k = 2; k > 0; k--) { fill(BRASS[0], BRASS[1], BRASS[2], me ? 20 : 6); circle(o.x, o.y, p.size + k * (me ? 9 : 4)); }
        // marble disc with a lit edge
        fill(DUST[0], DUST[1], DUST[2]); circle(o.x, o.y, p.size);
        fill(246, 241, 232); circle(o.x - p.size * 0.18, o.y - p.size * 0.18, p.size * 0.62);
        if (a.graduated) { noFill(); stroke(BRASS[0], BRASS[1], BRASS[2], 170); strokeWeight(1.2); circle(o.x, o.y, p.size + 7); noStroke(); }
        if (me) {
          push(); translate(o.x, o.y); rotate(-0.45); noFill(); stroke(BRASS[0], BRASS[1], BRASS[2], 230); strokeWeight(2.2); ellipse(0, 0, p.size * 2.9, p.size * 0.95); pop(); noStroke();
          fill(INK[0], INK[1], INK[2], 210); textFont("Fraunces, serif"); textSize(SHOT ? 13 : 14); textAlign(CENTER, TOP); text("caturn", o.x, o.y + p.size * 0.7 + 8);
        }
      } else {
        fill(UMBER[0], UMBER[1], UMBER[2], 60); circle(o.x, o.y, p.size);
      }
    });
    if (!SHOT) hover = near;
    var show = pinned || hover;
    if (show && !SHOT) { stroke(INK[0], INK[1], INK[2], 90); strokeWeight(1); noFill(); circle(show.x, show.y, show.p.size + 14); noStroke(); tip(show); }
    else if (!SHOT) { $("[data-sky-tip]").hidden = true; }
    if (SHOT && dataReady) window.skyReady = true;
  };

  function tip(o) {
    var a = o.p.a, el = $("[data-sky-tip]");
    el.hidden = false;
    el.innerHTML = "<b>" + esc(a.name) + "</b> <span class=\"sym\">$" + esc(a.symbol) + "</span>" +
      "<div class=\"rows\"><span>market cap</span><span>" + fmtUsd(a.mcap) + "</span><span>lifetime fees</span><span>" + fmtUsd(a.fees) + "</span><span>age</span><span>" + (a.ageH == null ? "?" : a.ageH < 48 ? Math.round(a.ageH) + "h" : Math.round(a.ageH / 24) + "d") + "</span><span>state</span><span>" + (a.graduated ? "graduated" : a.fees > 0 ? "earning" : "dark") + "</span></div>" +
      "<a class=\"textlink\" href=\"https://www.orbio.so/launchpad/" + esc(a.token) + "\" target=\"_blank\" rel=\"noopener\">open on orbio</a>" + (a.x ? " · <a class=\"textlink\" href=\"https://x.com/" + esc(a.x) + "\" target=\"_blank\" rel=\"noopener\">@" + esc(a.x) + "</a>" : "");
    var left = Math.min(W - 250, Math.max(8, o.x + 16)), top = Math.min(H - 150, Math.max(8, o.y - 20));
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); }
  window.mousePressed = function () { if (SHOT) return; if (hover) { pinned = pinned && pinned.p === hover.p ? null : hover; } else pinned = null; };
  window.touchStarted = function () { if (SHOT) return; var tsec = (millis() - t0) / 1000 + 7, best = null, bd = 28; layout.forEach(function (p) { var q = pos(p, tsec), d = dist(mouseX, mouseY, q.x, q.y); if (d < bd) { bd = d; best = { p: p, x: q.x, y: q.y }; } }); pinned = best; return false; };
})();
