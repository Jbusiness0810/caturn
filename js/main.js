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

/* ---------- Orbit theme: scroll rail, drifting stars, hero parallax, nap ---------- */
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var doc = document.documentElement;
  var sections = ["top", "contract", "how", "paper"].map(function (id) { return document.getElementById(id); }).filter(Boolean);

  function progress() {
    var max = doc.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }

  // Scroll rail: Caturn travels down a thin gold orbit as you read.
  var rail = document.querySelector("[data-rail]");
  var ship = rail && rail.querySelector(".rail-ship");
  var nodes = rail ? Array.prototype.slice.call(rail.querySelectorAll(".rail-node")) : [];
  var zzz = rail && rail.querySelector(".rail-zzz");
  function updateRail() {
    if (!rail) return;
    var p = progress();
    ship.style.top = (p * 100) + "%";
    var mid = window.scrollY + window.innerHeight * 0.4, active = 0;
    sections.forEach(function (s, i) { if (s.offsetTop <= mid) active = i; });
    nodes.forEach(function (n, i) { n.classList.toggle("is-active", i === active); n.classList.toggle("is-past", i < active); });
    var atEnd = p > 0.985;
    rail.classList.toggle("is-napping", atEnd);
  }

  // Hero mascot: gentle tilt and lift as you scroll away from it.
  var heroMascot = document.querySelector(".hero .mascot");
  function updateHero() {
    if (!heroMascot || reduce) return;
    var y = Math.min(window.scrollY, 600);
    heroMascot.style.transform = "translateY(" + (y * -0.18) + "px) rotate(" + (y * 0.02) + "deg)";
    heroMascot.style.opacity = String(Math.max(0, 1 - y / 700));
  }

  // Stars: a faint brass constellation on a fixed canvas, parallax by depth.
  var canvas = document.querySelector("[data-stars]");
  var ctx = canvas && canvas.getContext("2d");
  var stars = [], dpr = 1, W = 0, H = 0;
  function seed() {
    W = window.innerWidth; H = window.innerHeight; dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round((W * H) / 22000);
    stars = [];
    for (var i = 0; i < n; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, r: 0.6 + Math.random() * 1.2, tw: Math.random() * Math.PI * 2, spark: Math.random() < 0.08 });
    }
  }
  function drawStars(t) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    var sy = window.scrollY;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var y = (s.y - sy * s.z * 0.25) % H; if (y < 0) y += H;
      var a = 0.25 + 0.2 * Math.sin(t / 900 + s.tw);
      ctx.fillStyle = "rgba(176,138,62," + a.toFixed(3) + ")";
      if (s.spark) {
        var r = s.r * 3.2;
        ctx.beginPath(); ctx.moveTo(s.x, y - r); ctx.lineTo(s.x + r * .28, y); ctx.lineTo(s.x, y + r); ctx.lineTo(s.x - r * .28, y); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(s.x - r, y); ctx.lineTo(s.x, y - r * .28); ctx.lineTo(s.x + r, y); ctx.lineTo(s.x, y + r * .28); ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  var raf = null;
  function frame(t) { drawStars(t); raf = reduce ? null : requestAnimationFrame(frame); }
  if (canvas && ctx) {
    seed(); window.addEventListener("resize", function () { seed(); drawStars(0); });
    if (reduce) drawStars(0); else raf = requestAnimationFrame(frame);
  }

  // Reveal sections softly as they enter.
  var revealables = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
  } else { revealables.forEach(function (el) { el.classList.add("is-in"); }); }

  var ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { updateRail(); updateHero(); ticking = false; });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  updateRail(); updateHero();
})();

/* ---------- Sound: opt-in background track with a header toggle ---------- */
(function () {
  var btn = document.querySelector("[data-sound]");
  var audio = document.querySelector("[data-audio]");
  if (!btn || !audio) return;
  var KEY = "caturn:sound";
  audio.volume = 0.35;
  function render(on) {
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.querySelector(".sound-label").textContent = on ? "Sound on" : "Sound off";
  }
  function start() {
    var p = audio.play();
    if (p && p.then) p.then(function () { render(true); try { localStorage.setItem(KEY, "1"); } catch (e) {} },
                              function () { render(false); });
    else render(true);
  }
  function stop() { audio.pause(); render(false); try { localStorage.setItem(KEY, "0"); } catch (e) {} }
  btn.addEventListener("click", function () { audio.paused ? start() : stop(); });
  render(false);
  // If the visitor turned sound on before, resume at the first interaction (autoplay is blocked until then).
  var want = false; try { want = localStorage.getItem(KEY) === "1"; } catch (e) {}
  if (want) {
    var once = function () { start(); ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.removeEventListener(ev, once); }); };
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.addEventListener(ev, once, { once: true, passive: true }); });
  }
})();
