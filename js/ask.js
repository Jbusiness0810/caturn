// Ask terminal: posts a question to /api/ask and prints the answer like a terminal.
(function () {
  var term = document.querySelector("[data-term]"); if (!term) return;
  var log = term.querySelector("[data-term-log]"), form = term.querySelector("[data-term-form]"), input = term.querySelector("[data-term-input]");
  var KEY = "caturn:ask";
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function line(cls, html) { var li = document.createElement("li"); li.className = cls; li.innerHTML = html; log.appendChild(li); log.scrollTop = log.scrollHeight; return li; }
  function typeInto(li, text, done) {
    var i = 0, reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { li.appendChild(document.createTextNode(text)); return done && done(); }
    var span = document.createElement("span"); li.appendChild(span);
    (function step() { span.textContent = text.slice(0, i); i += 2; log.scrollTop = log.scrollHeight; if (i <= text.length + 1) setTimeout(step, 14); else done && done(); })();
  }
  var hist = []; try { hist = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) {}
  hist.slice(-6).forEach(function (h) { line("t-you", esc(h.q)); line("t-cat", '<span class="who">caturn</span>' + esc(h.a)); });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = input.value.replace(/\s+/g, " ").trim(); if (!q || term.classList.contains("is-busy")) return;
    input.value = ""; term.classList.add("is-busy");
    line("t-you", esc(q));
    var wait = line("t-sys t-wait", "the orb is thinking. this costs it a fraction of a cent.");
    fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: q }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        wait.remove();
        if (!x.ok) { line("t-err", esc(x.j.error || "the orb is quiet.")); return; }
        var li = line("t-cat", '<span class="who">caturn</span>');
        typeInto(li, x.j.answer, function () { hist.push({ q: q, a: x.j.answer }); try { sessionStorage.setItem(KEY, JSON.stringify(hist.slice(-12))); } catch (e) {} });
      })
      .catch(function () { wait.remove(); line("t-err", "the orb did not answer. try again in a moment."); })
      .then(function () { term.classList.remove("is-busy"); input.focus(); });
  });
})();
