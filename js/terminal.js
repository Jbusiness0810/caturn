// Rent the cat's brain: sign in with a wallet, deposit ETH, USDG or $CTRN on Robinhood Chain (credited automatically from the chain), chat with frontier models.
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

  // the transcript
  function fmt(text) {
    var parts = String(text).split(/```/), out = "";
    parts.forEach(function (p, i) { if (i % 2) { var body = p.replace(/^[a-z0-9+#-]*\n/i, ""); out += "<pre><code>" + esc(body) + "</code></pre>"; } else out += "<p>" + esc(p).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>"; });
    return out;
  }
  function draw() {
    var log = $("[data-term-log]");
    log.innerHTML = chat.length ? chat.map(function (m) { return '<div class="term-msg term-' + m.role + '"><span class="who">' + (m.role === "user" ? "you" : esc(m.model || "cat")) + "</span>" + fmt(m.content) + "</div>"; }).join("") : '<p class="term-sys">caturn terminal. connect a wallet, top up, then ask anything.</p>';
    log.scrollTop = log.scrollHeight;
  }
  $("[data-term-model]").addEventListener("change", function (e) { store.set("caturn:termmodel", e.target.value); });
  $("[data-term-new]").addEventListener("click", function () { chat = []; store.set("caturn:termchat", "[]"); draw(); $("[data-term-cost]").textContent = ""; });
  var ta = $("[data-term-text]");
  ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("[data-term-form]").requestSubmit(); } });
  $("[data-term-form]").addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var text = ta.value.trim(); if (!text) return;
    if (!token) { showErr("connect a wallet first."); return; }
    showErr(""); busy = true; $("[data-term-send]").disabled = true;
    var model = $("[data-term-model]").value, name = ($("[data-term-model]").selectedOptions[0] || {}).textContent;
    chat.push({ role: "user", content: text }); ta.value = ""; ta.style.height = "auto"; draw();
    $("[data-term-log]").insertAdjacentHTML("beforeend", '<p class="term-sys term-wait">' + esc(name) + " is thinking…</p>");
    api({ action: "chat", token: token, model: model, messages: chat.map(function (m) { return { role: m.role, content: m.content }; }) }).then(function (x) {
      if (!x.ok) { chat.pop(); ta.value = text; draw(); if (x.status === 401) { token = null; store.set("caturn:termtoken", null); load(); } showErr(x.j.error || "that did not go through."); return; }
      chat.push({ role: "assistant", content: x.j.reply || "(no answer)", model: name });
      store.set("caturn:termchat", JSON.stringify(chat.slice(-30))); draw();
      $("[data-term-cost]").textContent = "last answer cost " + money(x.j.cost) + (x.j.finish === "length" ? " · cut off at your balance or the length cap" : "");
      if (info && x.j.account) render(Object.assign({}, info, { account: x.j.account }));
    }).catch(function () { chat.pop(); ta.value = text; draw(); showErr("the terminal did not answer. nothing was charged."); })
      .then(function () { busy = false; $("[data-term-send]").disabled = false; });
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

  draw(); load();
})();
