---
name: interactive-demo-pipeline
description: How the site's interactive "Try the live demo" is built and how to refresh it when the app UI changes
metadata:
  type: project
---

The homepage hero has a **"Try the live demo"** button that opens a modal with a fully interactive, client-side copy of the real app UI. Replies are **scripted** (no backend, no model, no agent powers) — a safe marketing showcase, not the real agent.

**Build pipeline (all under `build/demo/`, output to `site/`):**
- `gen-fixtures.mjs` — sanitizes a live `/api/*` capture into `build/demo/fixtures.json` (clean threads, keys off, no personal data; forces backendUp/providerReady + the selected local model `installed:true` so the app shows "Ready"). Run: `node build/demo/gen-fixtures.mjs <captureDir>`.
- `demo-runtime.js` — a `window.fetch` shim: serves fixtures for reads, streams newline-JSON events for `POST /api/chat` (status → token chunks → `answer`), catch-alls the rest as `{ok:true}`. Also injects suggestion chips that call the real send path (`#input` + `#send`).
- `build-demo.mjs` — inlines fixtures + runtime into `<head>` of `src/ui.html` → **`site/app-live-demo.html`**. Run: `node build/demo/build-demo.mjs`.

**To refresh after the app UI changes:** capture live `/api/state`,`/api/status`,`/api/about` etc. from a running app (`node src/index.js ui --port 8737 --no-open`), rerun `gen-fixtures.mjs` then `build-demo.mjs`, then redeploy the site.

**Gotchas:**
- Chat streaming paints via `requestAnimationFrame`, so it looks stalled in headless/non-composited probes but is ~1-2s for real visible users. Keep token chunks few/large (~9).
- `md()` needs a complete ```` ``` ```` fence to render a code block (mid-stream shows literal fence — expected).
- Bump the `?v=` on `styles.css` (and the demo iframe src) in `site/index.html` when their contents change — Pages serves them `max-age=14400`, so returning visitors get stale CSS otherwise. See [[deploy-site-cloudflare]].

Old unused demo assets still in `site/`: `app-preview.html` (looping fake), `app-face.html` (older inert clone), `win11-main.html` — not referenced by index.html; safe to delete later.
