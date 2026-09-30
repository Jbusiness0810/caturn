// Renders data/feed.json into the console. Add ?demo to the URL to see sample data.
(function () {
  var root = document.querySelector("[data-activity]");
  if (!root) return;
  var full = root.hasAttribute("data-activity-full");
  var demo = /[?&]demo\b/.test(location.search);
  var url = (demo ? "/data/feed.sample.json" : "/data/feed.json") + "?t=" + Math.floor(Date.now() / 60000);

  function $(s, r) { return (r || root).querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtUsd(n, d) { if (n == null) return "—"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "m"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k"; return "$" + Number(n).toFixed(d == null ? 0 : d); }
  function fmtNum(n, d) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d }); }
  function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function day(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
  function ago(iso) { var s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return ""; if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + " min ago"; if (s < 172800) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; }
  function uptime(iso) { if (!iso) return "—"; var s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return "—"; var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d + "d " + h + "h"; }


  // --- data views ---
  function renderSpark(samples) {
    var svg = $("[data-spark-svg]"), plot = svg.parentNode, tip = $("[data-spark-tip]"), val = $("[data-spark-val]");
    var raw = samples.filter(function (s) { return s.vol != null; }).slice(-336), pts = [];
    // Bucket into 2h means so a week reads as a shape, not 30-minute noise.
    for (var b = 0; b < raw.length; b += 4) { var g = raw.slice(b, b + 4); pts.push({ t: g[g.length - 1].t, vol: g.reduce(function (a, p) { return a + p.vol; }, 0) / g.length }); }
    if (pts.length < 2) { svg.innerHTML = ""; plot.insertAdjacentHTML("beforeend", '<div class="spark-empty">no history yet</div>'); val.textContent = ""; return; }
    var W = 320, H = 64, max = Math.max.apply(null, pts.map(function (p) { return p.vol; })) || 1;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var X = function (p) { return (p.t - t0) / (t1 - t0 || 1) * W; }, Y = function (p) { return H - 4 - (p.vol / max) * (H - 10); };
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p).toFixed(1) + " " + Y(p).toFixed(1); }).join(" ");
    svg.innerHTML = '<line class="spark-base" x1="0" y1="' + (H - 4) + '" x2="' + W + '" y2="' + (H - 4) + '"/>' +
      '<path class="spark-area" d="' + d + " L" + W + " " + (H - 4) + " L0 " + (H - 4) + ' Z"/>' +
      '<path class="spark-line" d="' + d + '"/>' +
      '<line class="spark-cross" x1="0" y1="0" x2="0" y2="' + H + '"/><circle class="spark-dot" r="3" cx="0" cy="0"/>';
    var cross = svg.querySelector(".spark-cross"), dot = svg.querySelector(".spark-dot");
    var last = pts[pts.length - 1]; val.textContent = fmtUsd(last.vol) + " now";
    function show(clientX) {
      var r = plot.getBoundingClientRect(), fx = (clientX - r.left) / r.width;
      var i = Math.round(fx * (pts.length - 1)); i = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[i], x = X(p), y = Y(p);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); dot.setAttribute("cx", x); dot.setAttribute("cy", y);
      tip.hidden = false; tip.style.left = (x / W * 100) + "%"; tip.textContent = fmtUsd(p.vol) + " · " + day(p.t) + " " + hhmm(p.t);
      plot.classList.add("is-hover");
    }
    plot.addEventListener("pointermove", function (ev) { show(ev.clientX); });
    plot.addEventListener("pointerleave", function () { plot.classList.remove("is-hover"); tip.hidden = true; });
  }
  function renderBeat(thoughts, updatedAt) {
    var cells = $("[data-beat-cells]"), end = updatedAt ? Date.parse(updatedAt) : Date.now();
    var endHour = Math.floor(end / 3600e3) * 3600e3, counts = [], total = 0;
    for (var i = 23; i >= 0; i--) counts.push({ t: endHour - i * 3600e3, n: 0 });
    thoughts.forEach(function (t) { var h = Math.floor(Date.parse(t.at) / 3600e3) * 3600e3; var c = counts.find(function (c) { return c.t === h; }); if (c) { c.n++; total++; } });
    cells.innerHTML = counts.map(function (c, i) { return '<i data-n="' + Math.min(4, c.n) + '"' + (i === 23 ? ' class="is-now"' : "") + ' title="' + hhmm(c.t) + ": " + c.n + '"></i>'; }).join("");
    $("[data-beat-total]").textContent = total;
  }
  function buildStream(f) {
    var items = [];
    (f.events || []).forEach(function (e) { items.push({ at: e.at, kind: "sys", text: e.text }); });
    (f.thoughts || []).forEach(function (t) { items.push({ at: t.at, kind: t.kind === "dream" ? "dream" : "think", text: t.text, mood: t.mood, sketch: t.sketch && t.sketch.url ? t.sketch : null }); });
    (f.posts || []).forEach(function (p) { items.push({ at: p.at, kind: p.kind === "reply" ? "reply" : "post", text: p.text, url: p.url, status: p.status, replyTo: p.replyTo ? Object.assign({ threaded: !!p.threaded }, p.replyTo) : null, tagged: p.tagged || null }); });
    items.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
    return items;
  }

  function reTo(r) {
    var who = "@" + esc(r.handle) + (r.name ? " (" + esc(r.name) + ")" : "");
    var what = esc((r.text || "").slice(0, 120)) + ((r.text || "").length > 120 ? "\u2026" : "");
    return (r.threaded ? "replying to " : "answering ") + (r.url ? '<a href="' + esc(r.url) + '" rel="noopener" target="_blank">' + who + "</a>" : who) + (what ? ": \u201c" + what + "\u201d" : "");
  }
  function renderStream(el, items, status) {
    if (!items.length) {
      el.innerHTML = '<li class="empty">' + (status === "prelaunch"
        ? "no process yet.<br>caturn boots when $CTRN launches and the first fee lands."
        : "dark. nothing has been paid for yet. the first trade is the first thought.") + "</li>";
      return;
    }
    var list = full ? items : items.slice(-14);
    var html = "", lastDay = "";
    list.forEach(function (it, i) {
      var d = day(it.at);
      if (d !== lastDay) { html += '<li class="day">' + esc(d) + "</li>"; lastDay = d; }
      var tag = it.kind === "think" ? "think" : it.kind;
      var body = esc(it.text);
      if (it.replyTo) body = '<span class="re">' + reTo(it.replyTo) + "</span>" + body;
      if (it.kind === "post" || it.kind === "reply") body += it.url ? ' <a href="' + esc(it.url) + '" rel="noopener" target="_blank">view on X</a>' : ' <span class="mood-tag">' + esc(it.status || "publishing") + "</span>";
      if (it.mood && it.kind !== "post") body += '<span class="mood-tag">' + esc(it.mood) + "</span>";
      if (it.sketch) body += '<a class="sketch-inline" href="' + esc(it.sketch.source ? it.sketch.source.url : (it.sketch.url || it.sketch.file)) + '" target="_blank" rel="noopener"><img src="' + esc(it.sketch.url || it.sketch.file) + '" alt="sketch ' + esc(it.sketch.family) + '" loading="lazy"></a>' + (it.sketch.source ? '<span class="credit">' + esc(it.sketch.source.author) + " · " + esc(it.sketch.source.license || "") + "</span>" : "");
      var isNew = i === list.length - 1 && it.kind !== "sys";
      html += '<li class="k-' + tag + (isNew ? " is-new" : "") + '"><time datetime="' + esc(it.at) + '">' + hhmm(it.at) + '</time><span class="tag">' + tag + '</span><span class="body">' + body + "</span></li>";
    });
    el.innerHTML = html;
    var n = el.querySelector(".is-new");
    if (n) { n.addEventListener("animationend", function () { n.classList.add("done"); }); setTimeout(function () { n.classList.add("done"); }, 1200); }
    if (!full) el.scrollTop = el.scrollHeight;
  }

  var lastFeed = null, lastKey = "";
  function since(iso) { var s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return ""; var m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? h + "h " + (m % 60) + "m" : m + "m " + Math.floor(s % 60) + "s"; }
  function tickClock() {
    var f = lastFeed; if (!f) return;
    var cur = $("[data-cursor]"), status = f.status || "prelaunch", last = f.thoughts && f.thoughts.length ? f.thoughts[f.thoughts.length - 1].at : null;
    var base = status === "awake" ? "thinking" : status === "resting" ? "resting. the ring is warm." : status === "napping" ? "dark. listening." : "waiting for launch";
    cur.textContent = base + (last ? " · " + since(last) + " since last thought" : f.updatedAt ? " · " + since(f.updatedAt) + " since last tick" : "");
    if (f.updatedAt) $("[data-act-updated]").textContent = "tick " + hhmm(f.updatedAt) + " · " + ago(f.updatedAt);
  }
  setInterval(tickClock, 1000);
  function load() {
    // The live feed comes from git through /api/feed so the site never waits on a redeploy; the static copy is the fallback.
    var feedP = demo
      ? fetch("/data/feed.sample.json?t=" + Math.floor(Date.now() / 30000), { cache: "no-store" }).then(function (r) { return r.json(); })
      : fetch("/api/feed?t=" + Math.floor(Date.now() / 15000), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("feed " + r.status); return r.json(); })
        .catch(function () { return fetch("/data/feed.json?t=" + Math.floor(Date.now() / 30000), { cache: "no-store" }).then(function (r) { return r.json(); }); });
    var asksP = demo ? Promise.resolve({ asks: [{ at: new Date().toISOString(), q: "do you dream?", a: "yes. never finished. the last one was a gold ring in a bowl of warm milk.", model: "sample" }], tracked: true })
      : fetch("/api/asks?t=" + Math.floor(Date.now() / 20000), { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { asks: [], tracked: false }; });
    Promise.all([feedP, asksP]).then(function (res) {
      var f = res[0]; f.asks = res[1].asks || []; f.asksTracked = !!res[1].tracked;
      var key = (f.updatedAt || "") + ":" + (f.thoughts || []).length + ":" + (f.events || []).length + ":" + f.asks.length;
      if (key === lastKey) return; lastKey = key; lastFeed = f; render(f); tickClock();
    }).catch(function () { if (!lastFeed) $("[data-act-status]").textContent = "feed unavailable"; });
  }
  load(); setInterval(load, 60000);

  function render(f) {
    if (window.CATURN_FLOW) window.CATURN_FLOW(f);
    var m = f.metrics || {}, st = f.state || {}, status = f.status || "prelaunch";
    var pill = $("[data-act-status]");
    pill.textContent = status === "awake" ? "awake" : status === "resting" ? "resting" + (f.reason ? " · " + f.reason : "") : status === "napping" ? "napping" + (f.reason ? " · " + f.reason : "") : "asleep until launch";
    pill.className = "pill " + (status === "awake" || status === "resting" ? "is-awake" : "is-napping");
    $("[data-act-updated]").textContent = f.updatedAt ? "tick " + hhmm(f.updatedAt) + (ago(f.updatedAt) ? " · " + ago(f.updatedAt) : "") : "no ticks yet";
    if (f.sample) $("[data-act-sample]").hidden = false;
    root.classList.toggle("is-awake", status === "awake" || status === "resting");

    // Emotional state
    $("[data-mood]").textContent = st.mood || (status === "prelaunch" ? "unborn" : status === "napping" ? "dark" : "waking");
    $("[data-focus]").textContent = st.focus || (status === "prelaunch" ? "the launch" : "the next trade");
    $("[data-state-at]").textContent = st.at ? "as of " + hhmm(st.at) : "";
    var em = st.emotions || {};
    root.querySelectorAll("[data-feelings] li").forEach(function (li) {
      var k = li.querySelector("[data-e]").getAttribute("data-e"); li.setAttribute("data-k", k);
      var v = Math.round((em[k] || 0) * 100);
      li.querySelector("i").style.width = v + "%"; li.querySelector("b").textContent = v;
    });

    // Energy: orbital ring + hero number
    var e = Math.round((f.energy || 0) * 100);
    $("[data-m-energy]").textContent = e + "%";
    var ring = $("[data-orbit-fill]"); if (ring) ring.style.strokeDashoffset = (326.7 * (1 - e / 100)).toFixed(1);
    $("[data-m-energy-sub]").textContent = m.thoughtsPerDay ? "~" + m.thoughtsPerDay + " thoughts a day at this pace" : "no volume, no thoughts";
    $("[data-m-volume-line]").textContent = "24h volume " + fmtUsd(m.volume24hUsd) + (m.volumeSource ? " · " + m.volumeSource : "");
    $("[data-m-cadence]").textContent = m.thoughtsPerDay ? "every ~" + Math.max(1, Math.round(1440 / m.thoughtsPerDay)) + " min" : "none";
    renderSpark(f.samples || []);
    renderBeat(f.thoughts || [], f.updatedAt);

    // Emotions: five arc gauges with history, plus temperament
    var em = st.emotions || {};
    var keys = ["curiosity", "smugness", "unease", "affection", "boredom", "hunger", "mischief", "melancholy"];
    var hist = (f.thoughts || []).filter(function (t) { return t.emotions; }).slice(-24);
    var hasState = !!st.emotions;
    keys.forEach(function (k) {
      var g = root.querySelector('[data-g="' + k + '"]'), v = hasState ? Math.round((em[k] || 0) * 100) : null;
      g.classList.toggle("is-empty", v == null);
      g.querySelector(".g-fill").style.strokeDashoffset = (100.6 * (1 - (v || 0) / 100)).toFixed(1);
      g.querySelector("b").textContent = v == null ? "—" : v;
      var sp = g.querySelector(".g-spark"), vals = hist.map(function (t) { return t.emotions[k] || 0; });
      var px = function (i) { return (vals.length > 1 ? i / (vals.length - 1) * 76 + 2 : 40).toFixed(1); }, py = function (x) { return (14 - x * 12).toFixed(1); };
      sp.innerHTML = vals.length ? '<line x1="0" y1="15" x2="80" y2="15"/>' +
        (vals.length > 1 ? '<path d="' + vals.map(function (x, i) { return (i ? "L" : "M") + px(i) + " " + py(x); }).join(" ") + '"/>' : "") +
        vals.map(function (x, i) { return '<circle cx="' + px(i) + '" cy="' + py(x) + '" r="1.6"/>'; }).join("") : "";
    });
    var warm = hasState ? ((em.affection || 0) + (em.curiosity || 0) + (em.mischief || 0) - (em.unease || 0) - (em.boredom || 0) - (em.melancholy || 0)) / 3 : 0; // -1..1
    var tp = $("[data-temper]"); tp.classList.toggle("is-empty", !hasState);
    $("[data-temper-dot]").style.left = (50 + warm * 45) + "%";
    $("[data-temper-word]").textContent = !hasState ? "—" : warm > 0.35 ? "warm" : warm > 0.1 ? "mild" : warm > -0.1 ? "even" : warm > -0.35 ? "cool" : "cold";
    var moods = (f.thoughts || []).filter(function (t) { return t.mood; }).slice(-8);
    $("[data-mood-tape]").innerHTML = moods.map(function (t) { return "<span title=\"" + esc(hhmm(t.at)) + "\">" + esc(t.mood) + "</span>"; }).join("");

    // Vitals
    $("[data-m-fees]").textContent = fmtUsd(m.fees24hUsd, 2);
    $("[data-m-balance]").textContent = m.balanceCredit != null ? fmtNum(m.balanceCredit, 2) + " CREDIT" : "—";
    $("[data-m-grad]").textContent = m.graduated ? "graduated" : m.graduationPct != null ? Math.round(m.graduationPct) + "% to graduation" : "—";
    $("[data-m-credit]").textContent = fmtNum(m.creditOwed, 3) + (m.stakedOrbio != null ? " · " + fmtNum(m.stakedOrbio, 0) + " ORBIO staked" : "");
    $("[data-m-spent]").textContent = fmtNum(m.spentTodayCredit, 4) + " CREDIT";
    $("[data-m-mcap]").textContent = fmtUsd(m.marketCapUsd) + (m.priceUsd != null ? " · $" + Number(m.priceUsd).toPrecision(3) : "");
    $("[data-m-uptime]").textContent = uptime(f.agent && f.agent.launchedAt);

    // Stream + posts
    renderStream($("[data-stream]"), buildStream(f), status);
    var posts = (f.posts || []).slice().reverse().slice(0, full ? 150 : 5);
    var sks = (f.sketches || []).filter(function (x) { return x.url; }).slice().reverse().slice(0, full ? 60 : 4);
    $("[data-sketch-count]").textContent = (f.sketches || []).length;
    $("[data-gallery]").innerHTML = sks.length ? sks.map(function (x) {
      var u = x.url || x.file, src = x.source;
      if (src) return '<a class="gal found" href="' + esc(src.url || u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="' + esc(src.title) + '" loading="lazy"><span>found · ' + hhmm(x.at) + '</span><span class="credit">' + esc(src.title) + " by " + esc(src.author) + " · " + esc(src.license || "") + " · openprocessing</span></a>";
      return '<a class="gal" href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="' + esc(x.family) + '" loading="lazy"><span>' + esc(x.family) + " · " + hhmm(x.at) + (x.mood ? " · " + esc(x.mood) : "") + "</span></a>";
    }).join("") : '<div class="empty">no sketches yet. caturn draws one every few thoughts.</div>';
    var asks = (f.asks || []).slice().reverse().slice(0, full ? 200 : 4);
    $("[data-asks-count]").textContent = (f.asks || []).length;
    $("[data-log-asks]").innerHTML = asks.length ? asks.map(function (a) {
      return "<li><p class=\"q\">" + esc(a.q) + "</p><p>" + esc(a.a) + '</p><span class="meta"><span>' + hhmm(a.at) + "</span><span>" + esc(a.model || "") + "</span></span></li>";
    }).join("") : '<li class="empty">' + (f.asksTracked ? "no one has asked yet." : "asks are not being tracked yet.") + "</li>";
    $("[data-posts-count]").textContent = (f.posts || []).length;
    $("[data-log-posts]").innerHTML = posts.length ? posts.map(function (p) {
      return "<li>" + (p.replyTo ? '<p class="re">' + reTo(Object.assign({ threaded: !!p.threaded }, p.replyTo)) + "</p>" : p.tagged ? '<p class="re">tagging @' + esc(p.tagged) + "</p>" : "") + "<p>" + esc(p.text) + '</p><span class="meta"><span>' + hhmm(p.at) + "</span>" + (p.url ? '<a href="' + esc(p.url) + '" rel="noopener" target="_blank">open</a>' : "<span" + (p.error ? ' title="' + esc(p.error) + '"' : "") + ">" + esc(p.status || "publishing") + (p.retries ? " · retried" : "") + "</span>") + "</span></li>";
    }).join("") : '<li class="empty">nothing said out loud yet.</li>';
  }
})();
