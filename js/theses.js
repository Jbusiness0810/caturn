// Renders feed.theses (every thesis the agent posted, in full) at /theses. The live feed comes through /api/feed,
// the static copy is the fallback. ?t=SYMBOL scrolls to and highlights that token's latest thesis.
(function () {
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(v) { v = Number(v); if (!isFinite(v)) return "—"; return v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + Math.round(v); }
  function when(iso) { var d = new Date(iso); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + " · " + d.toISOString().slice(11, 16) + " utc"; }
  function model(m) { return String(m || "").split("/").pop().replace(/^claude-/, "claude ").replace(/-(\d)/g, " $1"); }
  var stance = "all", all = [], want = (new URLSearchParams(location.search).get("t") || "").toUpperCase();

  function card(t) {
    var n = t.numbers || {};
    var cls = "thesis thesis--" + (t.stance || "mixed") + (want && String(t.symbol).toUpperCase() === want ? " is-want" : "");
    return '<article class="' + cls + '" id="t-' + esc(t.id) + '">' +
      '<header class="thesis-head">' +
        '<div><span class="thesis-sym">$' + esc(t.symbol) + '</span><span class="thesis-name">' + esc(t.name && t.name !== t.symbol ? t.name : "") + '</span></div>' +
        '<div class="thesis-tags"><span class="tag tag--' + esc(t.stance) + '">' + esc(t.stance) + '</span><span class="tag">grade ' + esc(t.grade) + ' · ' + esc(t.score) + '/100</span></div>' +
      '</header>' +
      '<p class="thesis-meta">' + esc(when(t.at)) + (n.orbioRank ? ' · #' + n.orbioRank + ' of ' + n.orbioCount + ' ' + (n.pool || 'orbio launches') + ' by volume' : '') + ' · written by ' + esc(model(t.model)) + '</p>' +
      '<div class="thesis-body">' +
        '<div class="thesis-text">' +
          '<p class="thesis-hook">' + esc(t.hook) + '</p>' +
          '<p>' + esc(t.evidence) + '</p>' +
          '<p>' + esc(t.risk) + '</p>' +
        '</div>' +
        (t.card ? '<a class="thesis-card" href="' + esc(t.url || "#") + '" target="_blank" rel="noopener"><img src="' + esc(t.card) + '" alt="thesis card for $' + esc(t.symbol) + '" loading="lazy"></a>' : '') +
      '</div>' +
      '<dl class="thesis-nums">' +
        '<div><dt>market cap</dt><dd>' + usd(n.marketCapUsd) + '</dd></div>' +
        '<div><dt>liquidity</dt><dd>' + usd(n.liquidityUsd) + '</dd></div>' +
        '<div><dt>24h volume</dt><dd>' + usd(n.volume24hUsd) + '</dd></div>' +
        '<div><dt>holders</dt><dd>' + (n.holders != null ? Number(n.holders).toLocaleString() : "—") + '</dd></div>' +
        '<div><dt>top 10</dt><dd>' + (n.top10Pct != null ? n.top10Pct + "%" : "—") + '</dd></div>' +
        '<div><dt>deployer</dt><dd>' + (n.deployerPct != null ? n.deployerPct + "%" : "—") + '</dd></div>' +
        '<div><dt>rug score</dt><dd>' + (n.rugScore != null ? n.rugScore + "/100" : "—") + '</dd></div>' +
      '</dl>' +
      '<footer class="thesis-foot">' +
        (t.url ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener">the thread on x</a>' : '') +
        '<a href="/scan?t=' + esc(t.token) + '">scan it</a>' +
        '<span class="hash">ca: ' + esc(t.token) + '</span>' +
      '</footer>' +
    '</article>';
  }

  function render() {
    var box = $("[data-theses]");
    var list = all.filter(function (t) { return stance === "all" || t.stance === stance; });
    $("[data-theses-count]").textContent = list.length ? list.length + (list.length === 1 ? " thesis" : " theses") : "";
    if (!list.length) { box.innerHTML = '<p class="theses-empty">' + (all.length ? "none with that stance yet." : "no theses yet. the first one lands within a few hours of the cat waking up.") + "</p>"; return; }
    box.innerHTML = list.map(card).join("");
    var w = $(".is-want"); if (w) { w.scrollIntoView({ block: "start" }); want = ""; }
  }

  function load() {
    fetch("/api/feed?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("feed " + r.status); return r.json(); })
      .catch(function () { return fetch("/data/feed.json?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" }).then(function (r) { return r.json(); }); })
      .then(function (f) { all = (f.theses || []).slice().reverse(); render(); })
      .catch(function () { $("[data-theses]").innerHTML = '<p class="theses-empty">feed unavailable.</p>'; });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-stance]"); if (!b) return;
    stance = b.getAttribute("data-stance");
    document.querySelectorAll("[data-stance]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
    render();
  });
  load(); setInterval(load, 120000);
})();
