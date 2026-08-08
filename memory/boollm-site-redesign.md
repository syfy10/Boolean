---
name: boollm-site-redesign
description: boollm.com marketing site direction — littlebird.ai style + self-playing demo
metadata:
  type: project
---

The user wants **boollm.com** (in `site/`) styled like https://littlebird.ai — clean, interactive, with a self-playing product demo (no live backend/API on the marketing page).

- `site/index.html` + `site/styles.css` = the landing page (littlebird-style: trust band, feature-card grid, `<details>` FAQ accordion). Keep the green brand + Inter type.
- `site/app-preview.html` = the **self-playing showreel** shown in the hero iframe. It must match the **real app** — do NOT hand-approximate (that drifted and the user rejected it). `site/app-face.html` is a STALE marketing snapshot — do not trust it.
- **Source of truth = `src/ui.html`** (the real v0.9.56 app). Real CSS was extracted verbatim to `site/app-demo.css` (`sed -n '12,3164p' src/ui.html`). The demo links that CSS and reproduces the real body shell markup (`aside#sidebar`, `<main>` topbar/`.netseg` Local·Cloud/`.workspace-tabs`/`.cmd-bar`/`#chat .col`/`.composer-wrap`/`.app-footer .cmd-chip`) with generic demo content. Real tokens: `--accent:#2d2d2d`, cloud/online `--online:#e86f16`, `--bg:#fafafa`, Segoe UI, ~202px sidebar.
- Real chat bubbles: `.msg-user > .body` and `.msg-ai(.cloud) > .body`. Re-extract `app-demo.css` whenever ui.html restyles.
- When previewing in a hidden Browser pane, background-tab timer throttling makes the typing look ~1s/char — that's the environment, not a bug.
- NEVER put the user's private data on the site (the running app shows real projects like "StockSignal" and chats — use generic demo content only).
- Demo scenes cycle: chat/build → research (built-in **browser** floats to react.dev docs → Summarize → **notepad** docks right with the saved Research note + research card). Notepad `#notesPanel` and browser `#browser` are in-flow flex panels docked right of `main` (the floating-overlay CSS at ~line 594 is legacy; the active rule ~2995-3017 docks them). Real classes: `.note-tab`, `.nc-tab`, `.btab`, `.bt-task`, `#noteEditor`, `.bframewrap`.
- The hero iframe renders the app at a fixed **desktop** logical width (1040px) and CSS-scales it to fit via `--demo-scale` (set by a ResizeObserver in `index.html`); `.app-frame` uses `aspect-ratio:1040/660`. This avoids the app's cramped narrow-mode. Change LOGICAL_W in both places together.
- Still TODO (earlier asks, not yet on the real shell): get more local models, switch provider/API key, recipes, clean email, connections.
- Real data the demo pulls from: local GGUF catalog in `src/engine.js` (`CATALOG`), providers Local/OpenAI/GLM(Z.ai)/Claude, recipes list in `src/ui.html` (~line 12871), connectors (GitHub, Gmail/Outlook, Cloudflare/Vercel/Netlify, Notion/Linear/Jira, Postgres/Supabase).
- User's emphasis: **big focus on local LLM** and how to get more local models.
- Serve locally for preview: `node site/serve.js` (port 8788). Launch config name `site` in `.claude/launch.json`.
