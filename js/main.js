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

/* ---------- Orbit theme: one eased loop drives the rail, stars and hero (transforms only) ---------- */
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var doc = document.documentElement;
  var sections = ["top", "contract", "how", "paper"].map(function (id) { return document.getElementById(id); }).filter(Boolean);

  var rail = document.querySelector("[data-rail]");
  var ship = rail && rail.querySelector(".rail-ship");
  var nodes = rail ? Array.prototype.slice.call(rail.querySelectorAll(".rail-node")) : [];
  var heroMascot = document.querySelector(".hero .mascot");
  var canvas = document.querySelector("[data-stars]");
  var ctx = canvas && canvas.getContext("2d", { alpha: true });

  // Smoothed scroll: the visuals chase the real scroll position with a little inertia.
  var target = window.scrollY, smooth = target, maxScroll = 1, railH = 0, active = -1, napping = false;
  var stars = [], W = 0, H = 0, dpr = 1;

  function measure() {
    maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
    railH = rail ? rail.clientHeight : 0;
    if (canvas && ctx) {
      W = window.innerWidth; H = window.innerHeight; dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.round((W * H) / 26000); stars = [];
      for (var i = 0; i < n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, r: 0.6 + Math.random() * 1.2, tw: Math.random() * 6.283, spark: Math.random() < 0.08 });
    }
  }

  function drawStars(t) {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var y = (s.y - smooth * s.z * 0.25) % H; if (y < 0) y += H;
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(t / 900 + s.tw);
      ctx.fillStyle = "#B08A3E";
      if (s.spark) {
        var r = s.r * 3.2;
        ctx.beginPath(); ctx.moveTo(s.x, y - r); ctx.lineTo(s.x + r * .28, y); ctx.lineTo(s.x, y + r); ctx.lineTo(s.x - r * .28, y); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(s.x - r, y); ctx.lineTo(s.x, y - r * .28); ctx.lineTo(s.x + r, y); ctx.lineTo(s.x, y + r * .28); ctx.closePath(); ctx.fill();
      } else { ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, 6.283); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }

  function updateRail() {
    if (!rail) return;
    var p = Math.min(1, Math.max(0, smooth / maxScroll));
    ship.style.transform = "translate(-50%, -50%) translateY(" + (p * railH).toFixed(2) + "px)";
    var mid = target + window.innerHeight * 0.4, a = 0;
    for (var i = 0; i < sections.length; i++) if (sections[i].offsetTop <= mid) a = i;
    if (a !== active) { active = a; nodes.forEach(function (n, i) { n.classList.toggle("is-active", i === a); n.classList.toggle("is-past", i < a); }); }
    var nap = target / maxScroll > 0.985;
    if (nap !== napping) { napping = nap; rail.classList.toggle("is-napping", nap); }
  }

  function updateHero() {
    if (!heroMascot) return;
    var y = Math.min(smooth, 600);
    heroMascot.style.transform = "translate3d(0," + (y * -0.18).toFixed(2) + "px,0) rotate(" + (y * 0.02).toFixed(3) + "deg)";
    heroMascot.style.opacity = Math.max(0, 1 - y / 700).toFixed(3);
  }

  var running = false;
  function loop(t) {
    smooth += (target - smooth) * 0.14;
    if (Math.abs(target - smooth) < 0.05) smooth = target;
    if (ctx) drawStars(t);
    updateRail(); updateHero();
    if (!document.hidden) requestAnimationFrame(loop); else running = false;
  }
  function start() { if (!running) { running = true; requestAnimationFrame(loop); } }

  window.addEventListener("scroll", function () { target = window.scrollY; }, { passive: true });
  window.addEventListener("resize", measure);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) start(); });
  window.addEventListener("load", measure);
  measure();

  if (reduce) {
    // No inertia, no twinkle: draw once and update on scroll only.
    if (ctx) drawStars(0);
    if (heroMascot) heroMascot.style.transform = "none";
    var onScroll = function () { target = smooth = window.scrollY; updateRail(); };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  } else { start(); }

  // Reveal sections softly as they enter.
  var revealables = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
  } else { revealables.forEach(function (el) { el.classList.add("is-in"); }); }
})();

/* ---------- Sound: on by default, muted until the first gesture, remembered per visitor ---------- */
(function () {
  var btn = document.querySelector("[data-sound]");
  var audio = document.querySelector("[data-audio]");
  if (!btn || !audio) return;
  var KEY = "caturn:sound";
  var label = btn.querySelector(".sound-label");
  var GESTURES = ["pointerdown", "keydown", "touchend"];
  audio.volume = 0.35;

  function pref() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function render(state) { // "on" | "off" | "armed"
    btn.classList.toggle("is-on", state === "on");
    btn.classList.toggle("is-armed", state === "armed");
    btn.setAttribute("aria-pressed", String(state === "on"));
    label.textContent = state === "on" ? "Sound on" : state === "armed" ? "Tap for sound" : "Sound off";
  }
  function disarm() { GESTURES.forEach(function (ev) { window.removeEventListener(ev, onGesture, true); }); }
  function arm() { GESTURES.forEach(function (ev) { window.addEventListener(ev, onGesture, { capture: true, passive: true }); }); }
  function onGesture() { disarm(); unmute(); }

  function unmute() {
    audio.muted = false;
    var p = audio.paused ? audio.play() : Promise.resolve();
    (p && p.then ? p : Promise.resolve()).then(function () { render("on"); }, function () { render("armed"); arm(); });
  }
  function off() { audio.pause(); audio.muted = true; disarm(); render("off"); save("0"); }
  function on(fromUser) {
    if (fromUser) save("1");
    // Autoplay with sound is blocked until the page has a user gesture; muted autoplay is allowed.
    // Start muted now so the track is already rolling, then unmute on the first tap or click anywhere.
    audio.muted = true;
    var p = audio.play();
    (p && p.then ? p : Promise.resolve()).then(function () {
      if (fromUser) unmute(); else { render("armed"); arm(); }
    }, function () { render("armed"); arm(); });
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (btn.classList.contains("is-on")) off(); else on(true);
  });

  // Default is on. Only a visitor who switched it off stays off.
  if (pref() === "0") render("off"); else on(false);

  // Pause when the tab is hidden, resume when it returns (only if sound is on).
  document.addEventListener("visibilitychange", function () {
    if (!btn.classList.contains("is-on")) return;
    if (document.hidden) audio.pause(); else audio.play().catch(function () {});
  });
})();
