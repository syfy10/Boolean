# Boolean project rules

## Architecture
- Node.js desktop AI workspace. Electron-style shell (C#) hosting a Node backend.
- `src/` is the runtime: agent.js (model loop + tools), controller.js (task state), server.js (HTTP API), engine.js (llama.cpp), providers.js (cloud), config.js (defaults).
- `site/` is the marketing site. `backend/` is the Cloudflare Worker for accounts.
- `shell/` is the C# WinUI/WebView2 app. `assets/` holds icons and launchers.

## Build & test commands
- **Run tests:** `node --test test/controller.test.mjs` (PowerShell blocks npm scripts; use `node` directly).
- **PowerShell note:** `&&` is not valid; use `;` between commands.
- No deployment from this repo. Everything runs offline on this folder.

## Coding style
- Prefer small targeted edits (edit_file) over full rewrites.
- Export new functions so they can be unit-tested.
- Add or update tests in `test/controller.test.mjs` for controller/agent logic changes.
- Keep the UI (`src/ui.html`) in sync with config defaults in `src/config.js`.

## Never do this
- Do not deploy, push, or publish anything. Local offline development only.
- Do not rewrite whole files when a small edit works.
- Do not use `&&` in PowerShell commands.
- Do not run `npm` scripts directly (execution policy blocks them); use `node --test` or `node <script>`.
