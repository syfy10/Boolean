/* Boolean marketing demo runtime.
 * Injected into a copy of the real app UI (src/ui.html) BEFORE the app's own
 * scripts run. It intercepts window.fetch so every /api/* call is served locally:
 *  - read endpoints return sanitized fixtures (window.__DEMO_FIXTURES__)
 *  - POST /api/chat streams scripted newline-JSON events, exactly like the real
 *    backend, so the real UI renders a genuine assistant reply
 *  - everything else returns a benign 200 so nothing errors
 * No network, no model, no agent powers — replies are pre-written. Purely a
 * clickable showcase of the real interface.
 */
(function () {
  if (!window.__DEMO_FIXTURES__) return;
  var FIX = window.__DEMO_FIXTURES__;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var enc = new TextEncoder();

  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  function pathOf(input) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      return new URL(url, location.href).pathname;
    } catch (e) { return String(input || ""); }
  }

  /* ---------- scripted assistant replies ---------- */
  var LABEL = { provider: "local", model: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", aiLabel: "Llama" };

  function answerFor(msg) {
    var m = (msg || "").toLowerCase();
    if (/\b(build|make|create|app|website|site|todo|to-do|to do|game|landing)\b/.test(m)) {
      return [
        "I'll build a small to-do app you can run right away — one self-contained file, no setup.",
        "",
        "**What it does**",
        "- Add, complete, and delete tasks",
        "- Saves to `localStorage`, so your list survives a refresh",
        "",
        "```html",
        "<!doctype html><title>Tasks</title>",
        "<h1>Tasks</h1>",
        "<form id=f><input id=t placeholder=\"Add a task\" autofocus></form>",
        "<ul id=list></ul>",
        "<script>",
        "  let items = JSON.parse(localStorage.tasks || '[]');",
        "  const save = () => localStorage.tasks = JSON.stringify(items);",
        "  const render = () => list.innerHTML = items.map((it,i) =>",
        "    `<li><label><input type=checkbox ${it.done?'checked':''}",
        "      onchange=\"items[${i}].done=this.checked;save();render()\">",
        "      ${it.text}</label></li>`).join('');",
        "  f.onsubmit = e => { e.preventDefault();",
        "    items.push({ text: t.value, done: false }); t.value='';",
        "    save(); render(); };",
        "  render();",
        "<\/script>",
        "```",
        "",
        "Open the **Preview** tab to try it live. Want me to add due dates or drag-to-reorder next?",
      ].join("\n");
    }
    if (/\b(research|summar|article|news|sources|cite|compare|find out|look up)\b/.test(m)) {
      return [
        "Here's a quick, sourced rundown. In the full app I open the pages in the built-in browser and cite each one.",
        "",
        "**Key points**",
        "1. Local-first tools keep your data on your machine by default — nothing is uploaded unless you opt in. [1]",
        "2. Bringing your own API key means usage is billed to you directly, with no middle-man markup. [2]",
        "3. Running small models locally is now practical on 16 GB laptops for everyday tasks. [3]",
        "",
        "I saved this summary to the **Notepad** so you can keep it. Want me to turn it into a short blog post?",
      ].join("\n");
    }
    if (/\b(email|gmail|outlook|inbox|schedule|automat|remind)\b/.test(m)) {
      return [
        "I can connect Gmail or Outlook and work through your inbox with your approval on anything that sends or deletes.",
        "",
        "For a recurring job, I'd set up an automation like:",
        "- **Every weekday at 8am** — summarize new important email into a note",
        "- Draft replies for you to review (never sent without a click)",
        "",
        "This is a demo, so nothing is connected here — download Boolean to link a real account.",
      ].join("\n");
    }
    return [
      "Happy to help with that. In Boolean I can chat, write and run code, research the web, and keep notes — all in one window on your PC.",
      "",
      "A few things people ask me first:",
      "- “Build me a small web app”",
      "- “Research X and save the sources”",
      "- “Fix the failing test in this project”",
      "",
      "This page is a live demo of the real interface. Try a suggestion below, or download to use it for real.",
    ].join("\n");
  }

  function statusFor(msg) {
    var m = (msg || "").toLowerCase();
    if (/\b(build|make|create|app|website|site|todo|game|landing)\b/.test(m)) return "writing code…";
    if (/\b(research|summar|article|news|sources|cite)\b/.test(m)) return "reading sources…";
    return "thinking…";
  }

  function chatEvents(msg) {
    var events = [];
    events.push({ delay: 220, ev: { type: "status", text: statusFor(msg) } });
    var text = answerFor(msg);
    // Each token repaints (re-renders markdown for) the whole growing message,
    // so cost scales with the NUMBER of tokens, not their size. Emit ~12 chunks
    // total to keep even a long answer with a code block snappy (~2-3s).
    var pieces = text.split(/(\s+)/); // keep whitespace tokens
    var minChunk = Math.max(48, Math.ceil(text.length / 9));
    var chunk = "";
    for (var i = 0; i < pieces.length; i++) {
      chunk += pieces[i];
      if (/\s$/.test(pieces[i]) && chunk.length >= minChunk) { events.push({ delay: 55, ev: { type: "token", text: chunk } }); chunk = ""; }
    }
    if (chunk) events.push({ delay: 55, ev: { type: "token", text: chunk } });
    events.push({ delay: 60, ev: { type: "answer", text: text, provider: LABEL.provider, model: LABEL.model, aiLabel: LABEL.aiLabel } });
    events.push({ delay: 10, ev: { type: "done" } });
    return events;
  }

  function chatStream(msg) {
    var events = chatEvents(msg);
    return new ReadableStream({
      start: function (controller) {
        var i = 0;
        (function step() {
          if (i >= events.length) { try { controller.close(); } catch (e) {} return; }
          var e = events[i++];
          setTimeout(function () {
            try { controller.enqueue(enc.encode(JSON.stringify(e.ev) + "\n")); } catch (err) {}
            step();
          }, e.delay);
        })();
      },
    });
  }

  /* ---------- fetch interceptor ---------- */
  window.fetch = function (input, init) {
    var path = pathOf(input);
    if (path === "/api/chat" || path === "/api/retry" || path === "/api/continue") {
      var body = {};
      try { body = JSON.parse((init && init.body) || (input && input.body) || "{}"); } catch (e) {}
      return Promise.resolve(new Response(chatStream(body.message || ""), {
        status: 200, headers: { "Content-Type": "application/x-ndjson" },
      }));
    }
    if (Object.prototype.hasOwnProperty.call(FIX, path)) return Promise.resolve(jsonResponse(FIX[path]));
    if (path.indexOf("/api/") === 0) return Promise.resolve(jsonResponse({ ok: true }));
    return origFetch ? origFetch(input, init) : Promise.resolve(jsonResponse({}));
  };

  /* ---------- suggestion chips in the empty chat ---------- */
  var SUGGESTIONS = [
    "Build me a to-do list web app",
    "Research local-first AI and save the sources",
    "Draft a friendly launch tweet for my app",
  ];
  function send(text) {
    var inp = document.getElementById("input");
    var btn = document.getElementById("send");
    if (!inp || !btn) return;
    inp.value = text;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    btn.click();
  }
  function mountChips() {
    var col = document.getElementById("col");
    if (!col || document.getElementById("demoChips")) return;
    // only show while the conversation is empty
    if (col.querySelector(".msg-user, .msg-ai, .live-ai")) return;
    var wrap = document.createElement("div");
    wrap.id = "demoChips";
    wrap.setAttribute("style", "display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;padding:22px 16px;");
    var hint = document.createElement("div");
    hint.textContent = "Try it — this is the real interface (replies are scripted for the demo)";
    hint.setAttribute("style", "flex-basis:100%;text-align:center;color:var(--dim,#8a8a8a);font:12px/1.4 var(--ui,system-ui);margin-bottom:2px;");
    wrap.appendChild(hint);
    SUGGESTIONS.forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = s;
      b.setAttribute("style", "border:1px solid var(--border,#e5e5e5);background:var(--bubble,#f6f6f3);color:var(--text,#1a1a1a);border-radius:999px;padding:8px 14px;font:13px var(--ui,system-ui);cursor:pointer;");
      b.onclick = function () { wrap.remove(); send(s); };
      wrap.appendChild(b);
    });
    col.appendChild(wrap);
  }
  function whenReady() {
    if (!document.getElementById("col")) { setTimeout(whenReady, 120); return; }
    var tries = 0;
    var iv = setInterval(function () {
      mountChips();
      if (document.getElementById("demoChips") || ++tries > 30) clearInterval(iv);
    }, 150);
    // re-show chips when the user starts a New chat
    document.addEventListener("click", function () { setTimeout(mountChips, 200); }, true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", whenReady);
  else whenReady();
})();
