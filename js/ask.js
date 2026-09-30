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

  var POW_BITS = 15;
  // Compact synchronous SHA-256 (hex) so the stamp takes well under a second even on a phone.
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256hex(str) {
    var bytes = new TextEncoder().encode(str), l = bytes.length, padLen = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(padLen); buf.set(bytes); buf[l] = 0x80;
    var dv = new DataView(buf.buffer); dv.setUint32(padLen - 4, (l * 8) >>> 0); dv.setUint32(padLen - 8, Math.floor(l * 8 / 4294967296));
    var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Uint32Array(64);
    for (var off = 0; off < padLen; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) { var s0 = ((w[i-15]>>>7)|(w[i-15]<<25)) ^ ((w[i-15]>>>18)|(w[i-15]<<14)) ^ (w[i-15]>>>3), s1 = ((w[i-2]>>>17)|(w[i-2]<<15)) ^ ((w[i-2]>>>19)|(w[i-2]<<13)) ^ (w[i-2]>>>10); w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for (i = 0; i < 64; i++) { var S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7)), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0, S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10)), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0; hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; }
      h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0; h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
    }
    return h.map(function (x) { return ("00000000" + x.toString(16)).slice(-8); }).join("");
  }
  function zeroBitsHex(hex) { var n = 0; for (var i = 0; i < hex.length; i++) { var v = parseInt(hex[i], 16); if (v === 0) { n += 4; continue; } n += Math.clz32(v) - 28; break; } return n; }
  function stamp(q, ts) {
    // Proof of work: find a nonce so sha256(q|ts|nonce) starts with POW_BITS zero bits. Runs in slices so the page stays responsive.
    var nonce = Math.floor(Math.random() * 1e9);
    return new Promise(function (resolve) {
      (function slice() {
        var end = Date.now() + 40;
        while (Date.now() < end) { var n = nonce++; if (zeroBitsHex(sha256hex(q + "|" + ts + "|" + n)) >= POW_BITS) return resolve(String(n)); }
        setTimeout(slice, 0);
      })();
    });
  }
  var hp = document.createElement("input"); hp.type = "text"; hp.name = "website"; hp.tabIndex = -1; hp.autocomplete = "off"; hp.setAttribute("aria-hidden", "true"); hp.style.cssText = "position:absolute;left:-9999px;opacity:0;height:0;width:0"; form.appendChild(hp);

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = input.value.replace(/\s+/g, " ").trim(); if (!q || term.classList.contains("is-busy")) return;
    input.value = ""; term.classList.add("is-busy");
    line("t-you", esc(q));
    var wait = line("t-sys t-wait", "the orb weighs your question.");
    var ts = Date.now();
    stamp(q, ts).then(function (nonce) {
      wait.textContent = "the orb is thinking. this costs it a fraction of a cent.";
      return fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: q, ts: ts, nonce: nonce, website: hp.value }) });
    })
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
