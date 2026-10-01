// The workshop page: submit ideas, vote, watch the bench, open shipped builds.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $("[data-build-form]"); if (!form) return;
  var input = $("[data-build-input]"), btn = $("[data-build-btn]"), err = $("[data-build-error]"), note = $("[data-build-note]");
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var ago = function (iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
  var voted = {}; try { voted = JSON.parse(localStorage.getItem("caturn:voted") || "{}"); } catch (e) {}

  function showErr(m) { err.textContent = m; err.hidden = false; }
  function post(body) { return fetch("/api/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }

  form.addEventListener("submit", function (e) {
    e.preventDefault(); err.hidden = true;
    var text = input.value.trim(); if (text.length < 8) return showErr("say a little more than that.");
    btn.disabled = true; btn.textContent = "asking…";
    post({ action: "submit", text: text }).then(function (x) {
      if (!x.ok || x.j.error) return showErr(x.j.error || "something went wrong.");
      if (x.j.rejected) return showErr("not that one. " + (x.j.reason || ""));
      input.value = ""; note.textContent = "in the queue as “" + (x.j.title || text) + "”. vote for it below; the cat builds the top of the queue first.";
      load();
    }).catch(function () { showErr("the workshop did not answer. try again in a moment."); })
      .then(function () { btn.disabled = false; btn.textContent = "Ask the cat"; });
  });

  function vote(id, el) {
    if (voted[id]) return;
    post({ action: "vote", id: id }).then(function (x) {
      if (!x.ok || x.j.error) return;
      voted[id] = 1; try { localStorage.setItem("caturn:voted", JSON.stringify(voted)); } catch (e) {}
      el.classList.add("is-voted"); if (x.j.votes != null) el.querySelector("b").textContent = x.j.votes;
    });
  }

  function render(d) {
    var w = (window.__feedWorkshop || {});
    var m = $("[data-build-meter]");
    $("[data-meter-used]").textContent = w.usedToday != null ? w.usedToday : "—";
    $("[data-meter-budget]").textContent = w.budget != null ? w.budget : "—";
    $("[data-meter-fees]").textContent = w.fees24 != null ? "$" + w.fees24 : "—";
    $("[data-meter-shipped]").textContent = d.shipped ? d.shipped.length : 0;
    $("[data-meter-at]").textContent = w.at ? "as of " + ago(w.at) : "";
    if (w.usdPerStep) $("[data-usd-per-step]").textContent = "$" + w.usdPerStep;
    $("[data-meter-fill]").style.width = (w.budget ? Math.min(100, 100 * (w.usedToday || 0) / w.budget) : 0) + "%";

    var now = $("[data-build-now]");
    if (d.building) {
      now.hidden = false;
      $("[data-now-title]").textContent = d.building.title || d.building.text;
      $("[data-now-text]").textContent = "“" + d.building.text + "”";
      $("[data-now-step]").textContent = "step " + d.building.steps_done + " of " + d.building.steps_total + (w.current && w.current.lastNote ? " · " + w.current.lastNote : "");
      var dl = $("[data-now-download]"); if (dl) { dl.hidden = !d.building.steps_done; dl.href = "/api/build?html=" + d.building.id + "&download=1"; }
      var frame = $("[data-now-frame]"), src = "/b/" + d.building.id + "?v=" + d.building.steps_done;
      if (d.building.steps_done > 0 && frame.getAttribute("src") !== src) frame.setAttribute("src", src); else if (!d.building.steps_done) frame.removeAttribute("src");
      $("[data-now-log]").innerHTML = (d.steps || []).filter(function (s) { return s.idea_id === d.building.id; }).sort(function (a, b) { return a.n - b.n; }).map(function (s) { return "<li><b>" + s.n + "</b> " + esc(s.note) + " <span>" + ago(s.created_at) + "</span></li>"; }).join("") || "<li><b>0</b> picked up. first step on the next tick.</li>";
    } else now.hidden = true;

    var q = d.queued || [];
    $("[data-queue-count]").textContent = q.length ? q.length + " waiting" : "empty";
    $("[data-queue]").innerHTML = q.map(function (i, k) {
      return '<li><button class="vote' + (voted[i.id] ? " is-voted" : "") + '" data-vote="' + i.id + '" aria-label="vote"><b>' + i.votes + '</b></button><div><span class="q-title">' + esc(i.title || i.text) + '</span><span class="q-text">' + esc(i.text) + '</span><span class="q-meta">#' + (k + 1) + ' in line · ' + ago(i.created_at) + '</span></div></li>';
    }).join("") || "<li class='empty'>nothing waiting. ask for something.</li>";
    document.querySelectorAll("[data-vote]").forEach(function (b) { b.addEventListener("click", function () { vote(Number(b.getAttribute("data-vote")), b); }); });

    var s = d.shipped || [];
    $("[data-shipped-count]").textContent = s.length ? s.length + " apps" : "none yet";
    $("[data-shipped]").innerHTML = s.map(function (i) {
      return '<li><div class="s-row"><a class="s-main" href="/b/' + i.id + '" target="_blank" rel="noopener"><span class="s-title">' + esc(i.title || i.text) + '</span><span class="s-text">' + esc(i.text) + '</span><span class="s-meta">shipped ' + ago(i.shipped_at) + ' · ' + i.votes + ' votes</span></a><span class="s-actions"><a class="btn btn--small" href="/b/' + i.id + '" target="_blank" rel="noopener">open</a><a class="btn btn--small btn--ghost" href="/api/build?html=' + i.id + '&download=1" download>download</a></span></div></li>';
    }).join("") || "<li class='empty'>the first one ships when the queue has something and the fees have bought a step.</li>";
  }

  function load() {
    Promise.all([
      fetch("/api/build").then(function (r) { return r.json(); }),
      fetch("/api/feed").then(function (r) { return r.json(); }).then(function (f) { window.__feedWorkshop = f.workshop || {}; }).catch(function () {})
    ]).then(function (x) { if (x[0].error) showErr(x[0].error); else render(x[0]); }).catch(function () { showErr("the workshop is not answering."); });
  }
  load(); setInterval(load, 60000);
})();
