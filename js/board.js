// The board: suggest what the cat does next, vote, watch today's pick get done.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $("[data-board-form]"); if (!form) return;
  var input = $("[data-board-input]"), btn = $("[data-board-btn]"), err = $("[data-board-error]"), note = $("[data-board-note]");
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var ago = function (iso) { var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
  var safeUrl = function (u) { return /^https:\/\/(www\.)?caturn\.lol\//.test(String(u || "")) ? u : ""; };
  var voted = {}; try { voted = JSON.parse(localStorage.getItem("caturn:boardvoted") || "{}"); } catch (e) {}
  var nextPick = null, wallet = null;
  var fmt = function (n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n)); };
  var wbtn = $("[data-wallet-btn]"), winfo = $("[data-wallet-info]");
  var skew = 0; // server clock minus this device's clock, so a phone with the wrong time can still sign
  var signedAt = function () { return new Date(Date.now() + skew).toISOString(); };

  // Every wallet in the browser: EIP-6963 announcements (several extensions side by side), then the old window globals.
  var found = [], provider = null;
  window.addEventListener("eip6963:announceProvider", function (e) {
    var d = e.detail; if (!d || !d.provider || found.some(function (f) { return f.provider === d.provider; })) return;
    found.push({ name: (d.info && d.info.name) || "wallet", icon: d.info && d.info.icon, provider: d.provider });
  });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) {}
  function wallets() {
    var list = found.slice();
    var add = function (p, name) { if (p && p.request && !list.some(function (f) { return f.provider === p; })) list.push({ name: name, provider: p }); };
    var w = window.ethereum;
    if (w && Array.isArray(w.providers)) w.providers.forEach(function (p) { add(p, p.isMetaMask ? "MetaMask" : p.isCoinbaseWallet ? "Coinbase Wallet" : "wallet"); });
    else add(w, w && (w.isRabby ? "Rabby" : w.isPhantom ? "Phantom" : w.isCoinbaseWallet ? "Coinbase Wallet" : w.isMetaMask ? "MetaMask" : "browser wallet"));
    add(window.phantom && window.phantom.ethereum, "Phantom");
    add(window.coinbaseWalletExtension, "Coinbase Wallet");
    return list;
  }
  var readable = function (e) {
    var m = (e && (e.shortMessage || e.message || (e.data && e.data.message))) || String(e || "");
    if (e && e.code === 4001 || /reject|denied|cancel/i.test(m)) return "cancelled in the wallet. nothing was sent.";
    if (e && e.code === -32002 || /already pending/i.test(m)) return "your wallet already has a request open. open the wallet and approve or close it, then try again.";
    return "the wallet said: " + m.slice(0, 140);
  };

  function showWallet(ctrn) {
    wbtn.textContent = wallet.slice(0, 6) + "…" + wallet.slice(-4);
    winfo.textContent = ctrn == null ? "connected. could not read your balance just now" : fmt(ctrn) + " $CTRN · " + (ctrn > 0 ? "you can vote" : "this wallet holds no $CTRN, so it cannot vote");
  }
  function noWallet() {
    var url = location.host + location.pathname;
    err.innerHTML = "no wallet in this browser. on a phone, open the board inside your wallet app: " +
      '<a href="https://metamask.app.link/dapp/' + url + '">MetaMask</a> · ' +
      '<a href="https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent("https://" + url) + '">Coinbase Wallet</a> · ' +
      '<a href="https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent("https://" + url) + '">Trust</a> · ' +
      '<a href="https://phantom.app/ul/browse/' + encodeURIComponent("https://" + url) + '?ref=' + encodeURIComponent("https://" + location.host) + '">Phantom</a>. on a computer, install one (Rabby or MetaMask) and reload.';
    err.hidden = false;
  }
  function choose() {
    var list = wallets();
    if (provider) return Promise.resolve(provider);
    if (!list.length) { noWallet(); return Promise.reject(null); }
    if (list.length === 1) return Promise.resolve(provider = list[0].provider);
    return new Promise(function (resolve) {
      winfo.innerHTML = "pick a wallet: " + list.map(function (f, i) { return '<button type="button" class="btn btn--small btn--ghost" data-pick="' + i + '">' + esc(f.name) + "</button>"; }).join(" ");
      winfo.querySelectorAll("[data-pick]").forEach(function (b) { b.addEventListener("click", function () { provider = list[Number(b.getAttribute("data-pick"))].provider; watch(provider); resolve(provider); }); });
    });
  }
  function watch(p) {
    if (!p || !p.on || p.__caturnWatched) return; p.__caturnWatched = true;
    p.on("accountsChanged", function (a) { wallet = null; if (a && a[0]) connect().catch(function () {}); else { wbtn.textContent = "Connect wallet"; winfo.textContent = "one wallet, one vote. holders only."; } });
  }
  function connect() {
    return choose().then(function (p) {
      watch(p);
      return p.request({ method: "eth_requestAccounts" });
    }).then(function (a) {
      wallet = String((a && a[0]) || "").toLowerCase(); if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error("the wallet did not share an address");
      return fetch("/api/board?wallet=" + wallet).then(function (r) { return r.json(); }).then(function (j) { showWallet(j.ctrn); return wallet; }, function () { showWallet(null); return wallet; });
    });
  }
  wbtn.addEventListener("click", function () { err.hidden = true; connect().catch(function (e) { if (e) showErr(readable(e)); }); });

  // the exact text the API rebuilds and checks (api/board.js message())
  function sign(b) {
    return (wallet ? Promise.resolve(wallet) : connect()).then(function (w) {
      b.wallet = w; b.time = signedAt();
      var msg = "caturn board\naction: " + (b.action === "vote" ? "vote" : "suggest") + "\n" + (b.action === "vote" ? "suggestion: " + b.id : "text: " + b.text) + "\nwallet: " + w + "\ntime: " + b.time;
      var hex = "0x" + Array.prototype.map.call(new TextEncoder().encode(msg), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      // most wallets take [message, address]; a few older ones want them the other way round
      return provider.request({ method: "personal_sign", params: [hex, w] })
        .catch(function (e) { if (e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ""))) throw e; return provider.request({ method: "personal_sign", params: [w, hex] }); })
        .then(function (sig) { b.sig = sig; return b; });
    });
  }

  function showErr(m) { err.textContent = m; err.hidden = false; }
  function post(body) { return fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }

  form.addEventListener("submit", function (e) {
    e.preventDefault(); err.hidden = true;
    var text = input.value.replace(/\s+/g, " ").trim(); if (text.length < 8) return showErr("say a little more than that.");
    btn.disabled = true; btn.textContent = "sign in your wallet…";
    sign({ action: "submit", text: text }).then(function (b) { btn.textContent = "telling…"; return post(b); }).then(function (x) {
      if (!x.ok || x.j.error) return showErr(x.j.error || "something went wrong.");
      if (x.j.rejected) return showErr("not that one. " + (x.j.reason || ""));
      if (x.j.id) { voted[x.j.id] = 1; try { localStorage.setItem("caturn:boardvoted", JSON.stringify(voted)); } catch (e) {} }
      input.value = ""; note.textContent = "on the board as “" + (x.j.title || text) + "”. your vote is in. get people to vote for it: the top one at 17:00 UTC is what happens.";
      load();
    }).catch(function (e) { if (e) showErr(e instanceof TypeError ? "the board did not answer. try again in a moment." : readable(e)); })
      .then(function () { btn.disabled = false; btn.textContent = "Tell the cat"; });
  });

  function vote(id, el) {
    if (voted[id]) return;
    err.hidden = true;
    sign({ action: "vote", id: id }).then(post).then(function (x) {
      if (!x.ok || x.j.error) return showErr(x.j.error || "that vote did not go through.");
      voted[id] = 1; try { localStorage.setItem("caturn:boardvoted", JSON.stringify(voted)); } catch (e) {}
      el.classList.add("is-voted"); load();
    }).catch(function (e) { if (e) showErr(e instanceof TypeError ? "the board did not answer. try again in a moment." : readable(e)); });
  }

  function tick() {
    var el = $("[data-countdown]"); if (!el || !nextPick || el.getAttribute("data-fixed")) return;
    var s = Math.max(0, Math.round((Date.parse(nextPick) - Date.now()) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    el.textContent = s ? h + "h " + (m < 10 ? "0" : "") + m + "m " + (sec < 10 ? "0" : "") + sec + "s" : "picking now";
  }

  function render(d) {
    nextPick = d.nextPick;
    if (d.at) skew = Date.parse(d.at) - Date.now();
    if (d.minSubmit != null) { var ms = $("[data-min-submit]"); if (ms) ms.textContent = Number(d.minSubmit).toLocaleString("en-US"); }
    var count = $("[data-countdown]"), q = d.queued || [];
    if (d.doing) {
      $("[data-today-label]").textContent = "doing it now";
      $("[data-today-when]").textContent = d.doing.at ? "picked " + ago(d.doing.at) : "";
      count.setAttribute("data-fixed", "1"); count.textContent = d.doing.title || d.doing.text;
      $("[data-today-sub]").innerHTML = "“" + esc(d.doing.text) + "” · " + (d.doing.votes != null ? d.doing.votes + " vote" + (d.doing.votes === 1 ? "" : "s") + " · " : "") + "being built right now. the result lands here and on X.";
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

    var done = (d.log || []).filter(function (e) { return e.status === "done"; }).concat((window.__oldShop || []).map(function (i) {
      return { title: i.title || i.text, summary: "“" + i.text + "”", at: i.shipped_at, votes: i.votes, url: "https://www.caturn.lol/b/" + i.id, shop: true };
    }));
    $("[data-done-count]").textContent = done.length ? done.length + " done" : "none yet";
    $("[data-done]").innerHTML = done.map(function (i) {
      var u = safeUrl(i.url);
      return '<li><div class="s-row"><div class="s-main"><span class="s-title">' + esc(i.title || i.text) + '</span><span class="s-text">' + esc(i.summary || i.text) + '</span><span class="s-meta">done ' + ago(i.at) + (i.votes != null ? ' · ' + i.votes + ' votes' : '') + (i.by === "cat" ? ' · the cat picked (empty board)' : '') + (i.shop ? ' · from the old workshop' : '') + '</span></div>' + (u ? '<span class="s-actions"><a class="btn btn--small" href="' + esc(u) + '" target="_blank" rel="noopener">see it</a></span>' : '') + '</div></li>';
    }).join("") || "<li class='empty'>the first one gets done at 17:00 UTC.</li>";
  }

  function load() {
    var shop = window.__oldShop ? Promise.resolve() : fetch("/api/build").then(function (r) { return r.json(); }).then(function (j) { window.__oldShop = j.shipped || []; }).catch(function () { window.__oldShop = []; });
    shop.then(function () { return fetch("/api/board"); }).then(function (r) { return r.json(); }).then(function (d) { if (d.error) showErr(d.error); else render(d); }).catch(function () { showErr("the board is not answering."); });
  }
  load(); setInterval(load, 60000); setInterval(tick, 1000);
})();
