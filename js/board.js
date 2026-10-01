// The board: suggest what the cat does next, vote, watch today's pick get done.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $("[data-board-form]"); if (!form) return;
  var input = $("[data-board-input]"), btn = $("[data-board-btn]"), err = $("[data-board-error]"), note = $("[data-board-note]");
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var ago = function (iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
  var safeUrl = function (u) { return /^https:\/\/(www\.)?caturn\.lol\//.test(String(u || "")) ? u : ""; };
  var voted = {}; try { voted = JSON.parse(localStorage.getItem("caturn:boardvoted") || "{}"); } catch (e) {}
  var nextPick = null;

  function showErr(m) { err.textContent = m; err.hidden = false; }
  function post(body) { return fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }

  form.addEventListener("submit", function (e) {
    e.preventDefault(); err.hidden = true;
    var text = input.value.trim(); if (text.length < 8) return showErr("say a little more than that.");
    btn.disabled = true; btn.textContent = "telling…";
    post({ action: "submit", text: text }).then(function (x) {
      if (!x.ok || x.j.error) return showErr(x.j.error || "something went wrong.");
      if (x.j.rejected) return showErr("not that one. " + (x.j.reason || ""));
      if (x.j.id) { voted[x.j.id] = 1; try { localStorage.setItem("caturn:boardvoted", JSON.stringify(voted)); } catch (e) {} }
      input.value = ""; note.textContent = "on the board as “" + (x.j.title || text) + "”. your vote is in. get people to vote for it: the top one at 17:00 UTC is what happens.";
      load();
    }).catch(function () { showErr("the board did not answer. try again in a moment."); })
      .then(function () { btn.disabled = false; btn.textContent = "Tell the cat"; });
  });

  function vote(id, el) {
    if (voted[id]) return;
    post({ action: "vote", id: id }).then(function (x) {
      if (!x.ok || x.j.error) return;
      voted[id] = 1; try { localStorage.setItem("caturn:boardvoted", JSON.stringify(voted)); } catch (e) {}
      el.classList.add("is-voted"); if (x.j.votes != null) el.querySelector("b").textContent = x.j.votes;
    });
  }

  function tick() {
    var el = $("[data-countdown]"); if (!el || !nextPick || el.getAttribute("data-fixed")) return;
    var s = Math.max(0, Math.round((Date.parse(nextPick) - Date.now()) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    el.textContent = s ? h + "h " + (m < 10 ? "0" : "") + m + "m " + (sec < 10 ? "0" : "") + sec + "s" : "picking now";
  }

  function render(d) {
    nextPick = d.nextPick;
    var count = $("[data-countdown]"), q = d.queued || [];
    if (d.doing) {
      $("[data-today-label]").textContent = "doing it now";
      $("[data-today-when]").textContent = d.doing.at ? "picked " + ago(d.doing.at) : "";
      count.setAttribute("data-fixed", "1"); count.textContent = d.doing.title || d.doing.text;
      $("[data-today-sub]").innerHTML = "“" + esc(d.doing.text) + "” · " + (d.doing.votes != null ? d.doing.votes + " votes · " : "") + "being built right now. the result lands here and on X.";
    } else {
      count.removeAttribute("data-fixed");
      $("[data-today-label]").textContent = "next pick";
      $("[data-today-when]").textContent = "17:00 UTC";
      $("[data-today-sub]").innerHTML = q.length ? "on top right now: <b>" + esc(q[0].title || q[0].text) + "</b> with " + q[0].votes + " vote" + (q[0].votes === 1 ? "" : "s") + ". it could still lose." : "nothing on the board yet. if it stays empty, the cat picks.";
      tick();
    }

    $("[data-queue-count]").textContent = q.length ? q.length + " waiting" : "empty";
    $("[data-queue]").innerHTML = q.map(function (i, k) {
      return '<li' + (k === 0 ? ' class="is-top"' : '') + '><button class="vote' + (voted[i.id] ? " is-voted" : "") + '" data-vote="' + i.id + '" aria-label="vote"><b>' + i.votes + '</b></button><div><span class="q-title">' + esc(i.title || i.text) + '</span><span class="q-text">' + esc(i.text) + '</span><span class="q-meta">' + (k === 0 ? "on top · " : "#" + (k + 1) + " · ") + ago(i.created_at) + '</span></div></li>';
    }).join("") || "<li class='empty'>nothing yet. be the first to tell a cat what to do.</li>";
    document.querySelectorAll("[data-vote]").forEach(function (b) { b.addEventListener("click", function () { vote(Number(b.getAttribute("data-vote")), b); }); });

    var done = (d.log || []).filter(function (e) { return e.status === "done"; });
    $("[data-done-count]").textContent = done.length ? done.length + " done" : "none yet";
    $("[data-done]").innerHTML = done.map(function (i) {
      var u = safeUrl(i.url);
      return '<li><div class="s-row"><div class="s-main"><span class="s-title">' + esc(i.title || i.text) + '</span><span class="s-text">' + esc(i.summary || i.text) + '</span><span class="s-meta">done ' + ago(i.at) + (i.votes != null ? ' · ' + i.votes + ' votes' : '') + (i.by === "cat" ? ' · the cat picked (empty board)' : '') + '</span></div>' + (u ? '<span class="s-actions"><a class="btn btn--small" href="' + esc(u) + '" target="_blank" rel="noopener">see it</a></span>' : '') + '</div></li>';
    }).join("") || "<li class='empty'>the first one gets done at 17:00 UTC.</li>";
  }

  function load() {
    fetch("/api/board").then(function (r) { return r.json(); }).then(function (d) { if (d.error) showErr(d.error); else render(d); }).catch(function () { showErr("the board is not answering."); });
  }
  load(); setInterval(load, 60000); setInterval(tick, 1000);
})();
