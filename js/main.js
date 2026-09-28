(function () {
  var C = window.CATURN || {};
  var hasCA = typeof C.ca === "string" && C.ca.trim().length > 0;
  var ca = hasCA ? C.ca.trim() : "";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function truncate(addr) {
    return addr.length > 14 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;
  }

  // Mascot: prefer /public/mascot.png, fall back to the CSS orb if the file is missing.
  $all("[data-mascot]").forEach(function (wrap) {
    var img = $("img", wrap);
    if (!img) return;
    function show() { wrap.classList.add("has-image"); }
    if (img.complete && img.naturalWidth > 0) show();
    img.addEventListener("load", show);
    img.addEventListener("error", function () { wrap.classList.remove("has-image"); });
  });

  // Status pill
  $all("[data-status]").forEach(function (el) {
    el.textContent = hasCA ? "Live on " + C.chain : "Contract pending launch";
    el.classList.toggle("is-live", hasCA);
  });

  // Contract card
  var pending = $("[data-ca-pending]");
  var live = $("[data-ca-live]");
  if (pending && live) {
    pending.hidden = hasCA;
    live.hidden = !hasCA;
    if (hasCA) {
      $("[data-ca-short]", live).textContent = truncate(ca);
      $("[data-ca-short]", live).setAttribute("title", ca);
      $("[data-ca-full]", live).textContent = ca;
      var exp = $("[data-ca-explorer]", live);
      if (exp) {
        if (C.explorer) { exp.href = C.explorer + ca; exp.hidden = false; }
        else { exp.hidden = true; }
      }
    }
  }

  // Chain facts
  $all("[data-chain]").forEach(function (el) { el.textContent = C.chain; });
  $all("[data-chain-id]").forEach(function (el) { el.textContent = C.chainId; });
  $all("[data-pair]").forEach(function (el) { el.textContent = C.pair; });

  // Copy buttons
  $all("[data-copy]").forEach(function (btn) {
    var label = btn.textContent;
    btn.disabled = !hasCA;
    btn.setAttribute("aria-disabled", String(!hasCA));
    if (!hasCA) btn.title = "Contract address not published yet";
    btn.addEventListener("click", function () {
      if (!hasCA) return;
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = label; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ca).then(done, function () { fallback(); done(); });
      } else { fallback(); done(); }
    });
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = ca; ta.setAttribute("readonly", ""); ta.style.position = "absolute"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
    }
  });

  // Optional links: show only when set
  function link(sel, href, text) {
    $all(sel).forEach(function (a) {
      if (href) { a.href = href; a.hidden = false; if (text) a.textContent = text; }
      else if (a.hasAttribute("data-keep")) { /* placeholder stays visible, no href */ a.removeAttribute("href"); a.classList.add("is-placeholder"); }
      else { a.hidden = true; }
    });
  }
  link("[data-link-launchpad]", C.launchpad);
  link("[data-link-orbiofun]", C.orbioFun, "orbio.fun");
  link("[data-link-x]", C.x, "X");
  link("[data-link-tx]", C.launchTx);

  // Secondary hero text: "later" wording flips when links exist
  $all("[data-later]").forEach(function (el) {
    el.textContent = C.orbioFun ? "Trade on orbio.fun" : "Launchpad later / orbio.fun later";
    if (C.orbioFun) el.href = C.orbioFun; else if (C.launchpad) el.href = C.launchpad;
  });

  // Footer year
  $all("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
