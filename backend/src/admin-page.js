// Boolean Admin console — self-contained page served by the Worker at /admin.
// Signs in with the same Google device flow the desktop app uses; every API
// call goes through requireAdmin on the Worker.
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Boolean Admin</title>
<style>
  :root{ --bg:#101210; --card:#181b18; --border:#262b26; --text:#e8ece8; --dim:#8a938a; --green:#3fb950; --red:#e5534b; --amber:#d4a72c; }
  *{ box-sizing:border-box; margin:0; }
  body{ background:var(--bg); color:var(--text); font:14px/1.45 "Segoe UI",system-ui,sans-serif; padding:28px 20px 60px; }
  .wrap{ max-width:1060px; margin:0 auto; }
  h1{ font-size:19px; display:flex; align-items:center; gap:10px; margin-bottom:18px; }
  h1 .dot{ width:10px; height:10px; border-radius:50%; background:var(--green); }
  h1 .who{ margin-left:auto; font-size:12px; color:var(--dim); font-weight:400; }
  h1 .who button{ margin-left:10px; }
  .cards{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:20px; }
  .card{ background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .card .n{ font-size:22px; font-weight:600; }
  .card .l{ font-size:11px; color:var(--dim); margin-top:2px; }
  .bar{ display:flex; gap:8px; margin-bottom:12px; }
  input[type=text]{ flex:1; background:var(--card); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:8px 12px; font:inherit; outline:0; }
  button{ background:var(--card); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:7px 12px; font:12px inherit; cursor:pointer; }
  button:hover{ border-color:var(--dim); }
  button.primary{ background:var(--green); border-color:var(--green); color:#08130a; font-weight:600; padding:10px 18px; font-size:14px; }
  button.danger{ color:var(--red); }
  table{ width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th,td{ text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); font-size:12.5px; vertical-align:middle; }
  th{ color:var(--dim); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  tr:last-child td{ border-bottom:0; }
  .badge{ display:inline-block; border-radius:999px; padding:1px 8px; font-size:10.5px; margin-left:6px; }
  .badge.admin{ background:#1d3323; color:var(--green); }
  .badge.banned{ background:#38201e; color:var(--red); }
  .badge.unl{ background:#332b16; color:var(--amber); }
  .acts{ display:flex; gap:4px; flex-wrap:wrap; }
  .acts button{ padding:4px 8px; font-size:11px; }
  .muted{ color:var(--dim); }
  #signin{ text-align:center; padding:80px 0; }
  #signin p{ color:var(--dim); margin:12px 0 24px; }
  #toast{ position:fixed; left:50%; bottom:26px; transform:translateX(-50%); background:var(--card); border:1px solid var(--border);
    border-radius:999px; padding:9px 16px; font-size:12.5px; opacity:0; transition:opacity .18s; pointer-events:none; max-width:80vw; }
  #toast.on{ opacity:1; }
  #toast.err{ border-color:var(--red); color:var(--red); }
</style>
</head>
<body>
<div class="wrap">
  <div id="signin" hidden>
    <h1 style="justify-content:center"><span class="dot"></span> Boolean Admin</h1>
    <p>Sign in with an admin Google account to manage users, tokens, and access.</p>
    <button class="primary" id="loginBtn">Sign in with Google</button>
    <p id="loginState"></p>
  </div>
  <div id="panel" hidden>
    <h1><span class="dot"></span> Boolean Admin <span class="who" id="who"><button id="logout">Sign out</button></span></h1>
    <div class="cards" id="cards"></div>
    <div class="bar">
      <input type="text" id="q" placeholder="Search email or name...">
      <button id="reload">Refresh</button>
    </div>
    <table>
      <thead><tr><th>User</th><th>Plan</th><th>Balance</th><th>Used today</th><th>Joined</th><th>Actions</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>
<div id="toast"></div>
<script>
(function(){
  var base = location.pathname.replace(/\\/admin$/, "");
  var token = localStorage.getItem("boolAdminToken") || "";
  var me = null;
  function $(id){ return document.getElementById(id); }
  function toast(msg, err){ var t=$("toast"); t.textContent=msg; t.className=err?"on err":"on";
    clearTimeout(t._h); t._h=setTimeout(function(){ t.className=""; }, 3200); }
  function api(pathname, opts){
    opts = opts || {};
    opts.headers = Object.assign({ "authorization": "Bearer " + token }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") { opts.body = JSON.stringify(opts.body); opts.method = opts.method || "POST"; }
    return fetch(base + pathname, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){
        if (!r.ok) throw new Error(data.error || data.message || ("HTTP " + r.status));
        return data;
      });
    });
  }
  function fmt(n){ return Number(n||0).toLocaleString(); }
  function esc(s){ return String(s||"").replace(/[&<>"']/g, function(c){
    return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]; }); }

  function show(id){ $("signin").hidden = id !== "signin"; $("panel").hidden = id !== "panel"; }

  function loadStats(){
    return api("/admin/api/stats").then(function(s){
      var cards = [
        [s.users, "users"], [s.admins, "admins"], [s.banned, "banned"],
        [fmt(s.outstanding_tokens), "tokens outstanding"],
        [fmt(s.tokens_used_7d), "tokens used, 7 days"],
        [s.free_signup_grants_used, "signup grants used"]
      ];
      $("cards").innerHTML = cards.map(function(c){
        return '<div class="card"><div class="n">' + c[0] + '</div><div class="l">' + c[1] + '</div></div>';
      }).join("");
    });
  }

  function row(u){
    var tr = document.createElement("tr");
    var badges = (u.role === "admin" ? '<span class="badge admin">admin</span>' : "")
      + (u.banned ? '<span class="badge banned" title="' + esc(u.banned_reason) + '">banned</span>' : "")
      + (u.unlimited ? '<span class="badge unl">unlimited</span>' : "");
    tr.innerHTML = '<td><div>' + esc(u.email) + badges + '</div><div class="muted">' + esc(u.name) + '</div></td>'
      + '<td>' + esc(u.plan) + '</td>'
      + '<td>' + (u.unlimited ? "&#8734;" : fmt(u.balance_tokens)) + '</td>'
      + '<td>' + fmt(u.daily_used_tokens) + '</td>'
      + '<td class="muted">' + new Date(u.created_at * 1000).toLocaleDateString() + '</td>'
      + '<td class="acts"></td>';
    var acts = tr.querySelector(".acts");
    function act(label, fn, cls){
      var b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls;
      b.onclick = function(){ fn(b); }; acts.appendChild(b);
    }
    act("Tokens", function(){
      var v = prompt("Add tokens to " + u.email + " (negative to remove):", "100000");
      if (v === null) return;
      var delta = Math.trunc(Number(v));
      if (!delta) return toast("Enter a non-zero number", true);
      api("/admin/api/user/tokens", { body: { user_id: u.id, delta: delta } })
        .then(function(r){ toast("Balance for " + u.email + ": " + fmt(r.balance_tokens)); refresh(); })
        .catch(function(e){ toast(e.message, true); });
    });
    act(u.unlimited ? "Limit" : "Unlimited", function(){
      api("/admin/api/user/unlimited", { body: { user_id: u.id, unlimited: !u.unlimited } })
        .then(function(){ toast((u.unlimited ? "Removed unlimited from " : "Unlimited tokens for ") + u.email); refresh(); })
        .catch(function(e){ toast(e.message, true); });
    });
    act(u.banned ? "Unban" : "Ban", function(){
      if (u.banned) {
        api("/admin/api/user/ban", { body: { user_id: u.id, banned: false } })
          .then(function(){ toast("Unbanned " + u.email); refresh(); })
          .catch(function(e){ toast(e.message, true); });
        return;
      }
      var reason = prompt("Ban " + u.email + "? Their sessions end immediately.\\nReason (optional):", "");
      if (reason === null) return;
      api("/admin/api/user/ban", { body: { user_id: u.id, banned: true, reason: reason } })
        .then(function(){ toast("Banned " + u.email); refresh(); })
        .catch(function(e){ toast(e.message, true); });
    }, u.banned ? "" : "danger");
    act(u.role === "admin" ? "Remove admin" : "Make admin", function(){
      if (!confirm((u.role === "admin" ? "Remove admin role from " : "Make ") + u.email + (u.role === "admin" ? "?" : " an admin?"))) return;
      api("/admin/api/user/role", { body: { user_id: u.id, role: u.role === "admin" ? "user" : "admin" } })
        .then(function(){ toast("Updated role for " + u.email); refresh(); })
        .catch(function(e){ toast(e.message, true); });
    });
    act("Delete", function(){
      if (!confirm("Permanently delete " + u.email + "? This removes their account, sessions, tokens, and history.")) return;
      if (prompt('Type DELETE to confirm removing ' + u.email) !== "DELETE") return;
      api("/admin/api/user/delete", { body: { user_id: u.id } })
        .then(function(){ toast("Deleted " + u.email); refresh(); })
        .catch(function(e){ toast(e.message, true); });
    }, "danger");
    return tr;
  }

  function loadUsers(){
    var q = encodeURIComponent($("q").value.trim());
    return api("/admin/api/users?limit=100&q=" + q).then(function(r){
      var tb = $("rows"); tb.innerHTML = "";
      if (!r.users.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">No users found.</td></tr>'; return; }
      r.users.forEach(function(u){ tb.appendChild(row(u)); });
    });
  }

  function refresh(){
    return Promise.all([loadStats(), loadUsers()]).catch(function(e){
      if (/unauthorized|forbidden|account_banned/i.test(e.message)) { signout(); }
      else toast(e.message, true);
    });
  }

  function signout(){
    localStorage.removeItem("boolAdminToken"); token = ""; me = null;
    show("signin");
  }

  function boot(){
    if (!token) { show("signin"); return; }
    api("/admin/api/me").then(function(r){
      me = r.user;
      if (!me.is_admin) { show("signin"); $("loginState").textContent = me.email + " is not an admin account."; token=""; localStorage.removeItem("boolAdminToken"); return; }
      $("who").insertAdjacentText("afterbegin", me.email + " ");
      show("panel"); refresh();
    }).catch(function(){ signout(); });
  }

  $("loginBtn").onclick = function(){
    $("loginState").textContent = "Opening Google sign-in...";
    api("/auth/device/start", { method: "POST", body: {} }).then(function(start){
      window.open(start.auth_url, "booleanAdminSignIn");
      $("loginState").textContent = "Waiting for Google sign-in to finish...";
      var tries = 0;
      var poll = setInterval(function(){
        tries++;
        if (tries > 150) { clearInterval(poll); $("loginState").textContent = "Sign-in timed out. Try again."; return; }
        fetch(base + "/auth/device/status?device_id=" + encodeURIComponent(start.device_id))
          .then(function(r){ return r.json(); })
          .then(function(st){
            if (st.status === "complete" && st.session_token) {
              clearInterval(poll);
              token = st.session_token; localStorage.setItem("boolAdminToken", token);
              boot();
            } else if (st.status === "expired") {
              clearInterval(poll); $("loginState").textContent = "Sign-in expired. Try again.";
            }
          }).catch(function(){});
      }, 2000);
    }).catch(function(e){ $("loginState").textContent = "Could not start sign-in: " + e.message; });
  };
  $("logout").onclick = function(){ api("/auth/logout", { method: "POST", body: {} }).catch(function(){}); signout(); };
  $("reload").onclick = refresh;
  var qTimer; $("q").addEventListener("input", function(){ clearTimeout(qTimer); qTimer = setTimeout(loadUsers, 300); });
  boot();
})();
</script>
</body>
</html>`;
