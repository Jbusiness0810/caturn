// Renders data/feed.json into the activity dashboard. Add ?demo to the URL to see sample data.
(function () {
  var root = document.querySelector("[data-activity]");
  if (!root) return;
  var full = root.hasAttribute("data-activity-full");
  var demo = /[?&]demo\b/.test(location.search);
  var url = (demo ? "/data/feed.sample.json" : "/data/feed.json") + "?t=" + Math.floor(Date.now() / 60000);

  function $(s, r) { return (r || root).querySelector(s); }
  function fmtUsd(n, d) { if (n == null) return "—"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "m"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k"; return "$" + Number(n).toFixed(d == null ? 0 : d); }
  function fmtNum(n, d) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d }); }
  function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function dayLabel(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function renderList(el, items, kind, limit) {
    var list = items.slice().reverse().slice(0, limit || items.length);
    if (!list.length) {
      el.innerHTML = '<div class="empty">' + (kind === "posts" ? "No posts yet. Caturn posts when the wheel spins." : "No thoughts yet. The first one costs a fraction of a cent, and someone has to trade first.") + "</div>";
      return;
    }
    el.innerHTML = "<ol>" + list.map(function (t) {
      var meta = "";
      if (kind === "posts") meta = '<span class="meta">' + (t.url ? '<a href="' + esc(t.url) + '" rel="noopener" target="_blank">View on X</a>' : esc(t.status || "publishing")) + "</span>";
      else if (t.energy != null) meta = '<span class="meta">energy ' + Math.round(t.energy * 100) + "%" + (t.model ? " · " + esc(t.model.split("/").pop()) : "") + "</span>";
      return "<li><time datetime=\"" + esc(t.at) + "\" title=\"" + dayLabel(t.at) + "\">" + hhmm(t.at) + "</time><div><p>" + esc(t.text) + "</p>" + meta + "</div></li>";
    }).join("") + "</ol>";
  }

  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (f) {
    var m = f.metrics || {};
    var status = f.status || "prelaunch";
    var pill = $("[data-act-status]");
    pill.textContent = status === "awake" ? "Awake" : status === "napping" ? "Napping" + (f.reason ? " · " + f.reason : "") : "Asleep until launch";
    pill.className = "pill " + (status === "awake" ? "is-awake" : "is-napping");
    $("[data-act-updated]").textContent = f.updatedAt ? "Updated " + dayLabel(f.updatedAt) + " " + hhmm(f.updatedAt) : "Not started";
    if (f.sample) $("[data-act-sample]").hidden = false;

    var e = Math.round((f.energy || 0) * 100);
    $("[data-m-energy]").textContent = e + "%";
    $("[data-m-energy-bar]").style.width = e + "%";
    $("[data-m-energy-sub]").textContent = m.thoughtsPerDay ? "about " + m.thoughtsPerDay + " thoughts a day" : "no volume, no thoughts";
    $("[data-m-volume]").textContent = fmtUsd(m.volume24hUsd);
    $("[data-m-volume-sub]").textContent = m.fees24hUsd != null ? "fees " + fmtUsd(m.fees24hUsd, 2) : "24h, from the pair";
    $("[data-m-credit]").textContent = fmtNum(m.creditOwed, 3);
    $("[data-m-credit-sub]").textContent = m.stakedOrbio != null ? fmtNum(m.stakedOrbio, 0) + " $ORBIO staked" : "earned by the stake";
    $("[data-m-spent]").textContent = fmtNum(m.spentTodayCredit, 4);
    $("[data-m-spent-sub]").textContent = (f.posts || []).filter(function (p) { return f.updatedAt && p.at.slice(0, 10) === f.updatedAt.slice(0, 10); }).length + " posts today";

    var tl = $("[data-log-thoughts]"), pl = $("[data-log-posts]");
    renderList(tl, f.thoughts || [], "thoughts", full ? 300 : 6);
    renderList(pl, f.posts || [], "posts", full ? 150 : 4);
    var cur = $("[data-cursor]");
    if (cur) { cur.textContent = status === "awake" ? "caturn is thinking" : status === "napping" ? "zzz" : "waiting for launch"; }
    root.querySelectorAll(".log").forEach(function (l) { l.classList.toggle("is-awake", status === "awake"); });
  }).catch(function () {
    $("[data-act-status]").textContent = "Feed unavailable";
  });
})();
