// Rent the cat's brain: sign in with a wallet, deposit ETH, USDG or $CTRN on Robinhood Chain (credited automatically from the chain), chat with frontier models, and optionally connect a GitHub repo so the model can read and write files that you commit with your own token.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  if (!$("[data-term]")) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
  var err = $("[data-term-error]"), wbtn = $("[data-wallet-btn]"), winfo = $("[data-wallet-info]");
  var token = store.get("caturn:termtoken"), wallet = null, provider = null, info = null, busy = false;
  var chat = []; try { chat = JSON.parse(store.get("caturn:termchat") || "[]"); } catch (e) { chat = []; }
  var showErr = function (m) { err.textContent = m; err.hidden = !m; };
  var api = function (body) { return fetch("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); }); };
  var money = function (n) { n = Number(n) || 0; return "$" + (n < 10 ? n.toFixed(3) : n.toFixed(2)); };

  // wallets: EIP-6963 announcements, then the old globals
  var found = [];
  window.addEventListener("eip6963:announceProvider", function (e) { var d = e.detail; if (d && d.provider && !found.some(function (f) { return f.provider === d.provider; })) found.push({ name: (d.info && d.info.name) || "wallet", provider: d.provider }); });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) {}
  function wallets() {
    var list = found.slice(), add = function (p, n) { if (p && p.request && !list.some(function (f) { return f.provider === p; })) list.push({ name: n, provider: p }); };
    add(window.ethereum, "browser wallet"); add(window.phantom && window.phantom.ethereum, "Phantom"); return list;
  }
  function choose() {
    if (provider) return Promise.resolve(provider);
    var list = wallets();
    if (!list.length) return Promise.reject(new Error("no wallet in this browser. on a phone, open caturn.lol/terminal inside your wallet app's browser."));
    if (list.length === 1) return Promise.resolve(provider = list[0].provider);
    return new Promise(function (resolve) {
      winfo.innerHTML = "pick a wallet: " + list.map(function (f, i) { return '<button type="button" class="btn btn--small btn--ghost" data-pick="' + i + '">' + esc(f.name) + "</button>"; }).join(" ");
      winfo.querySelectorAll("[data-pick]").forEach(function (b) { b.addEventListener("click", function () { resolve(provider = list[Number(b.getAttribute("data-pick"))].provider); }); });
    });
  }
  var readable = function (e) { var m = (e && (e.message || (e.data && e.data.message))) || String(e || ""); return e && e.code === 4001 || /reject|denied|cancel/i.test(m) ? "cancelled in the wallet." : m.slice(0, 160); };
  function signIn() {
    return choose().then(function (p) { return p.request({ method: "eth_requestAccounts" }); }).then(function (a) {
      wallet = String((a && a[0]) || "").toLowerCase();
      var time = new Date().toISOString(), msg = "caturn terminal\nwallet: " + wallet + "\ntime: " + time;
      var hex = "0x" + Array.prototype.map.call(new TextEncoder().encode(msg), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      return provider.request({ method: "personal_sign", params: [hex, wallet] }).catch(function (e) { if (e && e.code === 4001) throw e; return provider.request({ method: "personal_sign", params: [wallet, hex] }); })
        .then(function (sig) { return api({ action: "login", wallet: wallet, time: time, sig: sig }); });
    }).then(function (x) {
      if (!x.ok) throw new Error(x.j.error || "sign in failed.");
      token = x.j.token; store.set("caturn:termtoken", token); load();
    });
  }
  wbtn.addEventListener("click", function () { showErr(""); if (token) { token = null; store.set("caturn:termtoken", null); load(); return; } signIn().catch(function (e) { showErr(readable(e)); }); });

  function render(d) {
    info = d;
    $("[data-term-addr]").textContent = d.payTo;
    var sel = $("[data-term-model]"); if (!sel.options.length) { sel.innerHTML = d.models.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + "</option>"; }).join(""); var saved = store.get("caturn:termmodel"); if (saved) sel.value = saved; }
    var a = d.account;
    if (a) {
      wbtn.textContent = a.wallet.slice(0, 6) + "…" + a.wallet.slice(-4) + " · sign out";
      winfo.textContent = money(a.credit) + " of compute left · " + money(a.spent) + " used";
      $("[data-term-credit]").textContent = money(a.credit) + " of compute";
      if (!depBusy) $("[data-term-dep-note]").textContent = "deposits from " + a.wallet.slice(0, 6) + "…" + a.wallet.slice(-4) + " are credited as soon as they confirm.";
    } else {
      wbtn.textContent = "Connect wallet"; winfo.textContent = "sign in with any EVM wallet. one signature, no gas.";
      $("[data-term-credit]").textContent = "not signed in";
      $("[data-term-dep-note]").textContent = "connect a wallet first.";
    }
    var as = $("[data-term-asset]"); if (!as.options.length && d.assets) as.innerHTML = d.assets.map(function (x) { return '<option value="' + esc(x.symbol) + '">' + esc(x.symbol) + "</option>"; }).join("");
    if (!d.open) showErr("the cat's compute is reserved for the cat right now. top ups still work; chat opens again soon.");
    if (d.deposits) $("[data-term-deps]").innerHTML = d.deposits.map(function (r) {
      return '<li><span>' + esc(r.amount + " " + r.asset) + ' · <a href="https://robinhoodchain.blockscout.com/tx/' + esc(r.tx_hash) + '" target="_blank" rel="noopener">tx</a></span><span class="st st-credited">credited ' + money(r.credit) + "</span></li>";
    }).join("");
  }
  function load() {
    return fetch("/api/terminal" + (token ? "?token=" + encodeURIComponent(token) : "")).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) return showErr(d.error);
      if (token && !d.account) { token = null; store.set("caturn:termtoken", null); }
      render(d);
    }).catch(function () { showErr("the terminal is not answering."); });
  }

  // github (optional): the token lives in this browser and talks to api.github.com directly; the cat's server never sees it
  var gh = null; try { gh = JSON.parse(store.get("caturn:gh") || "null"); } catch (e) { gh = null; }
  var ghFiles = {}, pending = {}, SKIP = /(^|\/)(node_modules|\.git|dist|build|vendor|\.next|coverage)\//;
  function ghApi(path, opts) {
    opts = opts || {};
    return fetch("https://api.github.com" + path, { method: opts.method || "GET", headers: Object.assign({ Authorization: "Bearer " + gh.token, Accept: "application/vnd.github+json" }, opts.headers || {}), body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error("github " + r.status + ": " + (j.message || "refused")); }); return opts.raw ? r.text() : r.json(); });
  }
  var enc = function (p) { return p.split("/").map(encodeURIComponent).join("/"); };
  function ghTree() {
    return ghApi("/repos/" + gh.repo + "/git/trees/" + encodeURIComponent(gh.branch) + "?recursive=1").then(function (t) {
      gh.tree = (t.tree || []).filter(function (x) { return x.type === "blob" && !SKIP.test(x.path); }).map(function (x) { return x.path; }).slice(0, 1500);
    });
  }
  function ghRead(path) {
    if (ghFiles[path] != null) return Promise.resolve(ghFiles[path]);
    return ghApi("/repos/" + gh.repo + "/contents/" + enc(path) + "?ref=" + encodeURIComponent(gh.branch), { raw: true, headers: { Accept: "application/vnd.github.raw+json" } })
      .then(function (t) { ghFiles[path] = String(t).slice(0, 60000); return ghFiles[path]; });
  }
  function ghRender() {
    var on = !!(gh && gh.repo);
    $("[data-gh-form]").hidden = on; $("[data-gh-on]").hidden = !on;
    $("[data-gh-state]").textContent = on ? gh.repo + " · " + gh.branch : "not connected";
    if (on) { $("[data-gh-info]").textContent = "connected to " + gh.repo + " on " + gh.branch + " · " + (gh.tree || []).length + " files"; $("[data-gh-auto]").checked = !!gh.auto; }
    $("[data-term-text]").placeholder = on ? "ask anything, or tell it what to build in " + gh.repo : "ask anything";
    var n = Object.keys(pending).length, bar = $("[data-gh-changes]");
    bar.hidden = !(on && n);
    if (n) $("[data-gh-changes-label]").textContent = n + " file change" + (n > 1 ? "s" : "") + " → " + gh.repo + "@" + gh.branch;
  }
  function ghSave() { store.set("caturn:gh", gh ? JSON.stringify({ repo: gh.repo, branch: gh.branch, token: gh.token, auto: !!gh.auto, tree: gh.tree }) : null); }
  $("[data-gh-form]").addEventListener("submit", function (e) {
    e.preventDefault(); var f = e.target, repo = f.repo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return showErr("write the repo as owner/name.");
    gh = { repo: repo, branch: f.branch.value.trim(), token: f.token.value.trim(), auto: false };
    showErr(""); $("[data-gh-state]").textContent = "connecting…";
    ghApi("/repos/" + repo).then(function (r) {
      if (r.permissions && !r.permissions.push) throw new Error("that token can read " + repo + " but not write to it. give it Contents: read and write.");
      gh.repo = r.full_name; gh.branch = gh.branch || r.default_branch || "main";
      return ghTree();
    }).then(function () { f.token.value = ""; ghFiles = {}; pending = {}; ghSave(); ghRender(); })
      .catch(function (er) { gh = null; ghRender(); showErr(String(er.message || er).slice(0, 200)); });
  });
  $("[data-gh-off]").addEventListener("click", function () { gh = null; ghFiles = {}; pending = {}; ghSave(); ghRender(); });
  $("[data-gh-auto]").addEventListener("change", function (e) { if (gh) { gh.auto = e.target.checked; ghSave(); } });
  $("[data-gh-discard]").addEventListener("click", function () { pending = {}; ghRender(); });
  function ghCommit() {
    var paths = Object.keys(pending); if (!gh || !paths.length) return Promise.resolve();
    var msg = $("[data-gh-msg]").value.trim() || "Update " + (paths.length === 1 ? paths[0] : paths.length + " files") + " from the caturn terminal";
    var ref = "/repos/" + gh.repo + "/git/refs/heads/" + enc(gh.branch), head;
    $("[data-gh-commit]").disabled = true;
    return ghApi(ref).then(function (r) { head = r.object.sha; return ghApi("/repos/" + gh.repo + "/git/commits/" + head); })
      .then(function (c) {
        return ghApi("/repos/" + gh.repo + "/git/trees", { method: "POST", body: { base_tree: c.tree.sha, tree: paths.map(function (p) { return pending[p] == null ? { path: p, mode: "100644", type: "blob", sha: null } : { path: p, mode: "100644", type: "blob", content: pending[p] }; }) } });
      })
      .then(function (t) { return ghApi("/repos/" + gh.repo + "/git/commits", { method: "POST", body: { message: msg, tree: t.sha, parents: [head] } }); })
      .then(function (c) { return ghApi(ref, { method: "PATCH", body: { sha: c.sha } }).then(function () { return c; }); })
      .then(function (c) {
        paths.forEach(function (p) { if (pending[p] == null) { delete ghFiles[p]; gh.tree = (gh.tree || []).filter(function (x) { return x !== p; }); } else { ghFiles[p] = pending[p]; if ((gh.tree || []).indexOf(p) < 0) (gh.tree = gh.tree || []).push(p); } });
        pending = {}; $("[data-gh-msg]").value = ""; ghSave();
        chat.push({ role: "assistant", sys: true, content: "committed " + paths.length + " file" + (paths.length > 1 ? "s" : "") + " to " + gh.repo + "@" + gh.branch + ": https://github.com/" + gh.repo + "/commit/" + c.sha });
        store.set("caturn:termchat", JSON.stringify(chat.slice(-30))); draw(); ghRender();
      })
      .catch(function (er) { showErr("commit failed: " + String(er.message || er).slice(0, 180)); })
      .then(function () { $("[data-gh-commit]").disabled = false; });
  }
  $("[data-gh-commit]").addEventListener("click", ghCommit);

  // the transcript: plain text, fenced code, and the file blocks the model writes when a repo is connected
  var BLOCK = /^=== (FILE|DELETE|READ): (.+?) ===[ \t]*$/;
  function parse(text) {
    var out = [], lines = String(text).split("\n"), buf = [];
    var flush = function () { if (buf.length) { out.push({ t: "text", v: buf.join("\n") }); buf = []; } };
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(BLOCK);
      if (!m) { buf.push(lines[i]); continue; }
      flush(); var path = m[2].trim().replace(/^\/+/, "");
      if (m[1] === "FILE") { var body = []; i++; while (i < lines.length && !/^=== END FILE ===\s*$/.test(lines[i])) body.push(lines[i++]); out.push({ t: "file", path: path, v: body.join("\n") + "\n" }); }
      else out.push({ t: m[1] === "DELETE" ? "del" : "read", path: path });
    }
    flush(); return out;
  }
  function fmtText(text) {
    var parts = String(text).split(/```/), out = "";
    parts.forEach(function (p, i) { if (i % 2) { var body = p.replace(/^[a-z0-9+#-]*\n/i, ""); out += "<pre><code>" + esc(body) + "</code></pre>"; } else if (p.trim()) out += "<p>" + esc(p.trim()).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>"; });
    return out;
  }
  function fmt(text) {
    return parse(text).map(function (s) {
      if (s.t === "text") return fmtText(s.v);
      if (s.t === "file") return '<details class="term-file"><summary>✎ ' + esc(s.path) + " · " + (function (n) { return n + (n === 1 ? " line" : " lines"); })(s.v.split("\n").length - 1) + "</summary><pre><code>" + esc(s.v) + "</code></pre></details>";
      if (s.t === "del") return '<details class="term-file del"><summary>✕ delete ' + esc(s.path) + "</summary></details>";
      return '<p class="term-read">reading ' + esc(s.path) + "…</p>";
    }).join("");
  }
  function draw() {
    var log = $("[data-term-log]");
    log.innerHTML = chat.length ? chat.map(function (m) {
      if (m.sys || m.auto) return '<p class="term-sys">' + esc(m.sys ? m.content : m.label || "attached files").replace(/(https:\/\/github\.com\/[\w.\/-]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>') + "</p>";
      return '<div class="term-msg term-' + m.role + '"><span class="who">' + (m.role === "user" ? "you" : esc(m.model || "cat")) + "</span>" + (m.role === "user" ? fmtText(m.content) : fmt(m.content)) + "</div>";
    }).join("") : '<p class="term-sys">caturn terminal. connect a wallet, top up, then ask anything.</p>';
    log.scrollTop = log.scrollHeight;
  }
  $("[data-term-model]").addEventListener("change", function (e) { store.set("caturn:termmodel", e.target.value); });
  $("[data-term-new]").addEventListener("click", function () { chat = []; ghFiles = {}; pending = {}; store.set("caturn:termchat", "[]"); draw(); ghRender(); $("[data-term-cost]").textContent = ""; });
  var ta = $("[data-term-text]");
  ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("[data-term-form]").requestSubmit(); } });
  function repoPayload() {
    if (!gh || !gh.repo) return null;
    return { name: gh.repo, branch: gh.branch, tree: gh.tree || [], files: Object.keys(ghFiles).map(function (p) { return { path: p, content: ghFiles[p] }; }) };
  }
  function attach(paths) { return Promise.all(paths.slice(0, 8).map(function (p) { return ghRead(p).then(function () { return p; }, function () { return null; }); })).then(function (ok) { return ok.filter(Boolean); }); }
  function ask(rounds) {
    var model = $("[data-term-model]").value, name = ($("[data-term-model]").selectedOptions[0] || {}).textContent;
    $("[data-term-log]").insertAdjacentHTML("beforeend", '<p class="term-sys term-wait">' + esc(name) + " is thinking…</p>");
    return api({ action: "chat", token: token, model: model, repo: repoPayload(), messages: chat.filter(function (m) { return !m.sys; }).map(function (m) { return { role: m.role, content: m.content }; }) }).then(function (x) {
      if (!x.ok) { var e = new Error(x.j.error || "that did not go through."); e.status = x.status; throw e; }
      chat.push({ role: "assistant", content: x.j.reply || "(no answer)", model: name });
      store.set("caturn:termchat", JSON.stringify(chat.slice(-30))); draw();
      $("[data-term-cost]").textContent = "last answer cost " + money(x.j.cost) + (x.j.finish === "length" ? " · cut off at your balance or the length cap" : "");
      if (info && x.j.account) render(Object.assign({}, info, { account: x.j.account }));
      if (!gh || !gh.repo) return;
      var segs = parse(x.j.reply || ""), reads = [];
      segs.forEach(function (s) { if (s.t === "file") pending[s.path] = s.v; else if (s.t === "del") pending[s.path] = null; else if (s.t === "read") reads.push(s.path); });
      ghRender();
      if (reads.length && rounds < 3) return attach(reads).then(function (got) {
        chat.push({ role: "user", auto: true, label: got.length ? "attached " + got.join(", ") : "could not read " + reads.join(", "), content: got.length ? "(attached: " + got.join(", ") + ". continue.)" : "(those files do not exist: " + reads.join(", ") + ". continue without them.)" });
        draw(); return ask(rounds + 1);
      });
      if (gh.auto && Object.keys(pending).length) return ghCommit();
    });
  }
  $("[data-term-form]").addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var text = ta.value.trim(); if (!text) return;
    if (!token) { showErr("connect a wallet first."); return; }
    showErr(""); busy = true; $("[data-term-send]").disabled = true;
    var before = chat.length;
    chat.push({ role: "user", content: text }); ta.value = ""; ta.style.height = "auto"; draw();
    var mentions = gh && gh.tree ? (text.match(/@[\w.\/-]+/g) || []).map(function (m) { return m.slice(1).replace(/[.,]$/, ""); }).filter(function (p) { return gh.tree.indexOf(p) >= 0; }) : [];
    (mentions.length ? attach(mentions) : Promise.resolve()).then(function () { return ask(0); }).catch(function (er) {
      if (chat.length === before + 1) { chat.pop(); ta.value = text; }
      draw();
      if (er.status === 401) { token = null; store.set("caturn:termtoken", null); load(); }
      showErr(er.status ? er.message : "the terminal did not answer. nothing was charged.");
    }).then(function () { busy = false; $("[data-term-send]").disabled = false; });
  });

  // deposits: the user signs a transfer to the cat's wallet; the server reads it back from the chain
  var depBusy = false, depNote = $("[data-term-dep-note]");
  $("[data-term-copy]").addEventListener("click", function () { var a = $("[data-term-addr]").textContent, b = this; try { navigator.clipboard.writeText(a); b.textContent = "copied"; } catch (e) {} });
  function units(amount, decimals) {
    var m = String(amount).trim().match(/^(\d*)(?:\.(\d*))?$/); if (!m || !(m[1] || m[2])) return null;
    var frac = (m[2] || "").slice(0, decimals); while (frac.length < decimals) frac += "0";
    var v = BigInt((m[1] || "0") + frac); return v > 0n ? v : null;
  }
  var pad = function (h) { return ("0".repeat(64) + h).slice(-64); };
  function onChain() {
    var hexId = "0x" + info.chainId.toString(16);
    return provider.request({ method: "eth_chainId" }).then(function (c) {
      if (String(c).toLowerCase() === hexId) return;
      return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] }).catch(function (e) {
        if (e && e.code === 4001) throw e;
        return provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: hexId, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [info.rpc], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }] });
      });
    });
  }
  function confirm(tx, tries) {
    return api({ action: "deposit", token: token, tx: tx }).then(function (x) {
      if (x.status === 202 || (!x.ok && x.status >= 500)) {
        if (tries > 60) throw new Error("still waiting on the chain. reload in a minute; it credits once it confirms.");
        return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { return confirm(tx, tries + 1); });
      }
      if (!x.ok) throw new Error(x.j.error || "that deposit did not check out.");
      return x.j;
    });
  }
  $("[data-term-dep]").addEventListener("submit", function (e) {
    e.preventDefault(); if (depBusy) return;
    if (!token || !info || !info.account) { showErr("connect a wallet first."); return; }
    var f = e.target, asset = (info.assets || []).filter(function (x) { return x.symbol === f.asset.value; })[0];
    if (!asset) return showErr("pick a coin.");
    var amt = units(f.amount.value, asset.native ? 18 : asset.decimals); if (!amt) return showErr("enter an amount.");
    if (asset.usd && Number(f.amount.value) * asset.usd < info.minUsd) return showErr("the minimum is $" + info.minUsd + ".");
    showErr(""); depBusy = true; $("[data-term-dep-btn]").disabled = true; depNote.textContent = "check your wallet…";
    var from = info.account.wallet;
    choose().then(onChain).then(function () {
      var tx = asset.native ? { from: from, to: info.payTo, value: "0x" + amt.toString(16) }
        : { from: from, to: asset.address, value: "0x0", data: "0xa9059cbb" + pad(info.payTo.slice(2)) + pad(amt.toString(16)) };
      return provider.request({ method: "eth_sendTransaction", params: [tx] });
    }).then(function (hash) {
      depNote.textContent = "sent. waiting for the chain to confirm…";
      return confirm(String(hash), 0);
    }).then(function (j) {
      f.amount.value = "";
      return load().then(function () { depNote.textContent = j.already ? "that deposit was already credited." : "credited " + money(j.credited) + " of compute. go ask it something."; });
    }).catch(function (e) { depNote.textContent = ""; showErr(readable(e)); })
      .then(function () { depBusy = false; $("[data-term-dep-btn]").disabled = false; });
  });

  draw(); ghRender(); load();
})();
