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

  function buildStream(f) {
    var items = [];
    (f.events || []).forEach(function (e) { items.push({ at: e.at, kind: "sys", text: e.text }); });
    (f.thoughts || []).forEach(function (t) { items.push({ at: t.at, kind: t.kind === "dream" ? "dream" : "think", text: t.text, mood: t.mood }); });
    (f.posts || []).forEach(function (p) { items.push({ at: p.at, kind: "post", text: p.text, url: p.url, status: p.status }); });
    items.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
    return items;
  }

  function renderStream(el, items, status) {
    if (!items.length) {
      el.innerHTML = '<li class="empty">' + (status === "prelaunch"
        ? "no process yet.<br>caturn boots when $CTRN launches and the first fee lands."
        : "quiet. nothing has been paid for yet.") + "</li>";
      return;
    }
    var list = full ? items : items.slice(-14);
    var html = "", lastDay = "";
    list.forEach(function (it, i) {
      var d = day(it.at);
      if (d !== lastDay) { html += '<li class="day">' + esc(d) + "</li>"; lastDay = d; }
      var tag = it.kind === "think" ? "think" : it.kind;
      var body = esc(it.text);
      if (it.kind === "post") body += it.url ? ' <a href="' + esc(it.url) + '" rel="noopener" target="_blank">view on X</a>' : ' <span class="mood-tag">' + esc(it.status || "publishing") + "</span>";
      if (it.mood && it.kind !== "post") body += '<span class="mood-tag">' + esc(it.mood) + "</span>";
      var isNew = i === list.length - 1 && it.kind !== "sys";
      html += '<li class="k-' + tag + (isNew ? " is-new" : "") + '"><time datetime="' + esc(it.at) + '">' + hhmm(it.at) + '</time><span class="tag">' + tag + '</span><span class="body">' + body + "</span></li>";
    });
    el.innerHTML = html;
    var n = el.querySelector(".is-new");
    if (n) { n.addEventListener("animationend", function () { n.classList.add("done"); }); setTimeout(function () { n.classList.add("done"); }, 1200); }
    if (!full) el.scrollTop = el.scrollHeight;
  }

  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (f) {
    var m = f.metrics || {}, st = f.state || {}, status = f.status || "prelaunch";
    var pill = $("[data-act-status]");
    pill.textContent = status === "awake" ? "awake" : status === "napping" ? "napping" + (f.reason ? " · " + f.reason : "") : "asleep until launch";
    pill.className = "pill " + (status === "awake" ? "is-awake" : "is-napping");
    $("[data-act-updated]").textContent = f.updatedAt ? "tick " + hhmm(f.updatedAt) + (ago(f.updatedAt) ? " · " + ago(f.updatedAt) : "") : "no ticks yet";
    if (f.sample) $("[data-act-sample]").hidden = false;
    root.classList.toggle("is-awake", status === "awake");

    // Emotional state
    $("[data-mood]").textContent = st.mood || (status === "prelaunch" ? "unborn" : status === "napping" ? "asleep" : "—");
    $("[data-focus]").textContent = st.focus || (status === "prelaunch" ? "the launch" : "nothing in particular");
    $("[data-state-at]").textContent = st.at ? "as of " + hhmm(st.at) : "";
    var em = st.emotions || {};
    root.querySelectorAll("[data-feelings] li").forEach(function (li) {
      var k = li.querySelector("[data-e]").getAttribute("data-e"); li.setAttribute("data-k", k);
      var v = Math.round((em[k] || 0) * 100);
      li.querySelector("i").style.width = v + "%"; li.querySelector("b").textContent = v;
    });

    // Vitals
    var e = Math.round((f.energy || 0) * 100);
    $("[data-m-energy]").textContent = e + "%"; $("[data-m-energy-bar]").style.width = e + "%";
    $("[data-m-volume]").textContent = fmtUsd(m.volume24hUsd);
    $("[data-m-fees]").textContent = fmtUsd(m.fees24hUsd, 2);
    $("[data-m-credit]").textContent = fmtNum(m.creditOwed, 3) + (m.stakedOrbio != null ? " · " + fmtNum(m.stakedOrbio, 0) + " ORBIO staked" : "");
    $("[data-m-spent]").textContent = fmtNum(m.spentTodayCredit, 4) + " CREDIT";
    $("[data-m-cadence]").textContent = m.thoughtsPerDay ? "~" + m.thoughtsPerDay + " thoughts / day" : "none";
    $("[data-m-uptime]").textContent = uptime(f.agent && f.agent.launchedAt);

    // Stream + posts
    renderStream($("[data-stream]"), buildStream(f), status);
    var posts = (f.posts || []).slice().reverse().slice(0, full ? 150 : 5);
    $("[data-posts-count]").textContent = (f.posts || []).length;
    $("[data-log-posts]").innerHTML = posts.length ? posts.map(function (p) {
      return "<li><p>" + esc(p.text) + '</p><span class="meta"><span>' + hhmm(p.at) + "</span>" + (p.url ? '<a href="' + esc(p.url) + '" rel="noopener" target="_blank">open</a>' : "<span>" + esc(p.status || "publishing") + "</span>") + "</span></li>";
    }).join("") : '<li class="empty">nothing said out loud yet.</li>';
    var cur = $("[data-cursor]");
    cur.textContent = status === "awake" ? "thinking" + (m.thoughtsPerDay ? " · next in ~" + Math.max(1, Math.round(1440 / m.thoughtsPerDay)) + " min" : "") : status === "napping" ? "zzz" : "waiting for launch";
  }).catch(function () { $("[data-act-status]").textContent = "feed unavailable"; });
})();
