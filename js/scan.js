// The scanner page: paste a token, get a read.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $("[data-scan-form]"), input = $("[data-scan-input]"), btn = $("[data-scan-btn]"), out = $("[data-scan-result]"), err = $("[data-scan-error]");
  if (!form) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var usd = function (v) { return v == null ? "—" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "m" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + Number(v).toFixed(v < 10 ? 2 : 0); };
  var num = function (v) { return v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); };
  var short = function (a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; };
  var busy = false;

  function extract(s) { var m = String(s || "").match(/0x[a-fA-F0-9]{40}/); return m ? m[0].toLowerCase() : null; }

  function scan(token) {
    if (busy) return; busy = true;
    err.hidden = true; out.hidden = true; btn.disabled = true; btn.textContent = "reading the chain…";
    fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok || x.j.error) { err.textContent = x.j.error || "something went wrong."; err.hidden = false; return; }
        render(x.j);
        try { history.replaceState(null, "", "/scan?t=" + token); } catch (e) {}
      })
      .catch(function () { err.textContent = "the chain did not answer. try again in a moment."; err.hidden = false; })
      .then(function () { busy = false; btn.disabled = false; btn.textContent = "Scan"; });
  }

  function render(r) {
    out.hidden = false;
    $("[data-scan-risk]").textContent = r.risk;
    var dial = $("[data-dial]"), circ = 2 * Math.PI * 50; dial.style.strokeDasharray = circ; dial.style.strokeDashoffset = circ * (1 - r.risk / 100);
    dial.setAttribute("data-grade", r.grade);
    $("[data-scan-name]").textContent = r.name; $("[data-scan-sym]").textContent = "$" + r.symbol;
    var g = $("[data-scan-grade]"); g.textContent = r.grade + " rug likelihood"; g.setAttribute("data-grade", r.grade);
    var v = $("[data-scan-verdict]"); if (r.verdict) { v.textContent = "“" + r.verdict + "”"; v.hidden = false; } else v.hidden = true;
    var links = []; if (r.facts.orbio) links.push('<a class="textlink" href="' + esc(r.facts.orbio.url) + '" target="_blank" rel="noopener">orbio</a>'); if (r.facts.pair) links.push('<a class="textlink" href="' + esc(r.facts.pair) + '" target="_blank" rel="noopener">dexscreener</a>'); links.push('<a class="textlink" href="https://robinhoodchain.blockscout.com/token/' + esc(r.token) + '" target="_blank" rel="noopener">explorer</a>');
    $("[data-scan-links]").innerHTML = links.join(" · ");
    var fails = r.checks.filter(function (c) { return c.level === "fail"; }).length, warns = r.checks.filter(function (c) { return c.level === "warn"; }).length;
    $("[data-scan-count]").textContent = fails + " red · " + warns + " amber · " + (r.checks.length - fails - warns) + " clear";
    $("[data-scan-checks]").innerHTML = r.checks.map(function (c) { return '<li class="c-' + c.level + '"><i></i><div><b>' + esc(c.title) + (c.points ? ' <span class="pts">+' + c.points + '</span>' : "") + "</b><p>" + esc(c.detail) + "</p></div></li>"; }).join("");
    var f = r.facts, rows = [
      ["holders", num(f.holders)], ["transfers", num(f.transfers)], ["supply", num(f.supply)],
      ["market cap", usd(f.marketCapUsd)], ["liquidity", f.graduated ? usd(f.liquidityUsd) : "on the curve"], ["24h volume", f.graduated ? usd(f.volume24hUsd) : "—"],
      ["age", f.ageHours == null ? "—" : f.ageHours < 48 ? Math.round(f.ageHours) + " hours" : Math.round(f.ageHours / 24) + " days"],
      ["creator", f.creator ? short(f.creator) + (f.creatorShare != null ? " · holds " + f.creatorShare.toFixed(1) + "%" : "") : "—"],
      ["launch", f.orbio ? "orbio agent " + esc(f.orbio.agentId || "") + (f.orbio.graduated ? " · graduated" : " · " + f.orbio.progressPct.toFixed(0) + "% to graduation") : f.graduated ? "graduated" : "bonding curve"],
      ["template match", f.templateSim + "%"]
    ];
    $("[data-scan-facts]").innerHTML = rows.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + x[1] + "</dd>"; }).join("");
    $("[data-scan-holders]").innerHTML = (f.top || []).map(function (h) { return "<li><span>" + short(h.address) + (h.contract ? ' <em>contract</em>' : "") + "</span><b>" + h.share.toFixed(2) + "%</b><i style=\"width:" + Math.min(100, h.share) + "%\"></i></li>"; }).join("") || "<li>no holders yet</li>";
    $("[data-scan-at]").textContent = new Date(r.scannedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    out.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); var t = extract(input.value); if (!t) { err.textContent = "paste a token contract address, 0x and 40 characters."; err.hidden = false; return; } scan(t); });
  document.querySelectorAll("[data-try]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); input.value = a.getAttribute("data-try"); scan(a.getAttribute("data-try")); }); });
  var q = new URLSearchParams(location.search).get("t"); if (q && extract(q)) { input.value = extract(q); scan(extract(q)); }
})();
