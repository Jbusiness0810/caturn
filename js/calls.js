// The calls page: every insight the cat posted as a scored call, frozen at writing, resolved on its date.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var root = $("[data-calls]"); if (!root) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var LABEL = { holders: "holders", liquidity_usd: "liquidity", volume_24h_usd: "24h volume", top10_pct: "top 10 share", burn_pct: "burned", market_cap_usd: "market cap" };
  var fmt = function (k, v) {
    if (v == null) return "—";
    if (/usd$/.test(k)) return v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + Math.round(v);
    if (/pct$/.test(k)) return Number(v).toFixed(1) + "%";
    return Number(v).toLocaleString();
  };
  var day = function (s) { return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
  var want = (location.search.match(/[?&]c=([^&]+)/) || [])[1];

  function card(c) {
    var m = c.check.metric, op = c.check.op === ">=" ? "above" : "below", then = c.then || {}, now = c.now || null;
    var status = c.status === "held" ? "held" : c.status === "broke" ? "broke" : "open";
    var cond = LABEL[m] + " " + op + " " + fmt(m, c.check.value) + " by " + day(c.check.by);
    var rows = Object.keys(LABEL).map(function (k) {
      var hot = k === m ? ' class="hot"' : "";
      return "<tr" + hot + "><td>" + LABEL[k] + "</td><td>" + fmt(k, then[k]) + "</td><td>" + (now ? fmt(k, now[k]) : "—") + "</td></tr>";
    }).join("");
    var links = [];
    if (c.url) links.push('<a class="textlink" href="' + esc(c.url) + '" target="_blank" rel="noopener">the post</a>');
    links.push('<a class="textlink" href="/scan?t=' + esc(c.token) + '">scan</a>');
    links.push('<a class="textlink" href="https://www.orbio.so/launchpad/' + esc(c.token) + '" target="_blank" rel="noopener">orbio</a>');
    if (c.handle) links.push('<a class="textlink" href="https://x.com/' + esc(c.handle) + '" target="_blank" rel="noopener">@' + esc(c.handle) + "</a>");
    return '<article class="call call-' + status + '" id="' + esc(c.id) + '">' +
      '<div class="call-head"><div><h2>$' + esc(c.symbol) + ' <small>' + esc(c.name || "") + '</small></h2><p class="call-meta">written ' + day(c.at) + ' · lean <b>' + esc(c.lean) + '</b> · rug ' + esc(c.risk) + '/100</p></div>' +
      '<span class="call-status">' + status + (c.resolvedAt ? " · " + day(c.resolvedAt) : "") + "</span></div>" +
      '<p class="call-post">' + esc(c.post) + "</p>" +
      '<p class="call-cond"><b>breaks if</b> ' + esc(cond) + (now && c.status === "open" ? ' · now ' + fmt(m, now[m]) : "") + "</p>" +
      '<table class="call-nums"><thead><tr><th></th><th>at writing</th><th>' + (now ? "checked " + day(c.checkedAt) : "not checked yet") + "</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      '<p class="call-foot">' + links.join(" · ") + ' · <span class="hash" title="SHA-256 of the call as written">' + esc(String(c.hash || "").slice(0, 16)) + "…</span></p>" +
      "</article>";
  }

  fetch("/api/feed").then(function (r) { return r.json(); }).then(function (f) {
    var calls = (f.calls || []).slice().reverse();
    var held = calls.filter(function (c) { return c.status === "held"; }).length, broke = calls.filter(function (c) { return c.status === "broke"; }).length, open = calls.length - held - broke;
    $("[data-cb-total]").textContent = calls.length; $("[data-cb-open]").textContent = open; $("[data-cb-held]").textContent = held; $("[data-cb-broke]").textContent = broke;
    $("[data-cb-rate]").textContent = held + broke ? Math.round(held / (held + broke) * 100) + "%" : "—";
    root.innerHTML = calls.length ? calls.map(card).join("") : '<p class="term-note">no calls yet. the first one lands with the next insight post.</p>';
    if (want) { var el = document.getElementById(want); if (el) { el.classList.add("call-want"); el.scrollIntoView({ block: "start" }); } }
  }).catch(function () { root.innerHTML = '<p class="term-note">the record is not answering. try again in a moment.</p>'; });
})();
