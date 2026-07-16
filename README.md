# Boolean

**A local-first Windows AI workspace developed by saz3 Labs.**

Boolean combines chat, coding and project tools, a notepad, an embedded browser,
Windows actions, local GGUF models, and optional cloud providers. Its built-in
llama.cpp engine runs supported GGUF models directly. No separate model runner,
API key, or internet connection is required after a local model is installed.

Available providers (Settings or `/provider`):

| provider | what it is | needs |
|---|---|---|
| **local** (default) | built-in llama.cpp engine, GGUF models in `~/.saz/models` | nothing — self-contained |
| **openai** | OpenAI cloud API | API key (`/key openai sk-...`) |
| **glm** | Z.AI standard GLM API | API key (`/key glm ...`) |
| **Z.AI Coding Plan** | separate Z.AI coding-plan endpoint | API key and provider-approved/supported use |
| **claude** | Anthropic Claude API | API key |

Settings > Third-party connections can also test and store remote Streamable
HTTP MCP servers. Boolean exposes tools from enabled servers to the selected AI.
MCP servers are independent third parties; their terms, data handling, and
charges apply.

Cloud mode also includes **Compare (Beta)** in the message composer. Pick two
saved API models and send one prompt to both. Replies stream
into separate labeled bubbles; one provider can fail without cancelling the
other. Compare is answer-only and never duplicates tools or computer actions.

It can control **PowerShell, cmd, winget, git, npm, and dotnet**, inspect and
edit project files, search a project, maintain a task plan, capture a running
project preview, and use the embedded browser and notepad. Ask me first is the
safe default; Auto-approve allows supported actions to proceed without each
individual confirmation.

Boolean can install curated models or a public GGUF from a direct Hugging Face
URL into its managed model folder. It validates the GGUF before use. Vision
models require a compatible matching `.mmproj` projector.

### Windows System Actions

Boolean provides typed, allowlisted Windows tools for common PC work:

- inspect Windows, display, network, and installed-app information
- open exact Windows Settings pages
- search Microsoft Store and WinGet packages by name and exact package ID
- install an exact selected package after confirmation
- prepare a trusted home PC for network discovery and file sharing

Boolean does not run permanently as administrator. Read-only inspection and
Settings navigation run as the signed-in user. App installs always require
confirmation and may invoke the package installer's own elevation flow. Network
changes always require confirmation and a Windows UAC prompt, even when Full
access is enabled. Those actions are limited to Private network profiles and
local-subnet firewall rules, and are recorded locally in
`~/.saz/system-actions.jsonl`.

Microsoft Store ratings are not exposed by WinGet, so Boolean must use current
web sources when a user explicitly asks to compare ratings. Boolean does not
automatically create broad folder shares, change passwords, disable security,
or bypass Windows consent prompts.

## Install it (like a normal Windows app)

Run **`dist\Boolean-setup.exe`** on any Windows 10/11 PC. It:

- installs per-user (no admin rights needed) to `%LOCALAPPDATA%\Programs\Boolean`
- adds `saz` to your PATH and creates Start-menu / optional desktop shortcuts
- includes a full uninstaller (Settings → Apps → Boolean)
- needs **nothing pre-installed** for standard local use — not Node.js, .NET,
  Ollama, Python, or the Microsoft Visual C++ Redistributable.

Official Windows installers are published on the GitHub Releases page. Boolean
0.9.1 and later check that release feed in the background. When a newer
manifest is available, Boolean downloads the installer, verifies its SHA-256
hash, and applies it after the app closes. A successful update reopens Boolean;
a failed update remains pending and is retried on the next close, with an install
log saved under `%LOCALAPPDATA%\saz3\updates`. Chats, settings, models, notepad
data, browser data, and learned preferences remain in the user's profile and
are not stored inside the installation folder.

The first move from an older build to 0.9.1 still requires one manual install.
After that, normal updates do not require users to download and reinstall the
app themselves.

## Runtime requirements

Required:

- Windows 10 or Windows 11 on an x64 PC
- Microsoft Edge WebView2 Runtime if it is not already installed

Minimum system requirements:

- Cloud mode: 4 GB RAM, internet connection, WebView2, and a supported
  third-party provider API key
- Lightest local LLM mode: 8 GB RAM recommended, 2 GB free disk space, and a
  CPU with AVX2 preferred
- Recommended local agent use: 16 GB RAM and 20 GB free disk space for models,
  project files, downloads, and update staging
- Starter model mode: very small bundled models such as SmolLM2-135M can run on
  lower-end PCs, but answer quality and tool reliability are limited

Bundled with Boolean:

- the Boolean desktop app
- embedded Node.js backend
- llama.cpp CPU inference engine
- app-local runtime DLLs required by the engine

Not required for the standard local app:

- Node.js
- .NET runtime
- Ollama
- Python
- Microsoft Visual C++ Redistributable

Optional:

- internet access for web browsing, model downloads, and cloud providers
- API keys for online providers
- winget, git, npm, dotnet, or similar tools only when the user asks Boolean to
  run workflows that depend on them

If we bundle the smallest practical starter LLM, the installer would likely add
about 94 MB raw and land around 155-170 MB compressed, with installed size around
350 MB. That starter should be treated as a basic prompt model; Qwen2.5-3B or
larger is still recommended for serious chat, coding, browser control, and tools.

## Account backend

Boolean's local app stays usable offline. Optional account features live in the
separate Cloudflare Worker backend under `backend/`:

- Google Sign-In
- user sessions
- account administration and ban management
- legacy token/billing schema retained for migration compatibility

Secrets such as Google client secrets belong only in the backend. User-supplied
AI provider keys are saved locally by the desktop app.

Optional Boolean account sign-in is separate from AI access. Local mode remains
offline. Cloud AI uses the third-party provider API key selected by the user;
provider terms, billing, quotas, and privacy policies apply independently.

### Building the installer from source

```
npm install
npm run build:exe        # → dist\saz.exe   (standalone, ~88 MB)
npm run build:installer  # -> dist\Boolean-setup.exe (~67 MB, needs Inno Setup)
```

(Inno Setup: `winget install JRSoftware.InnoSetup`)

### Publishing a release

The public repository includes a free GitHub Actions release workflow. Set the
same internal version in `package.json`, `package-lock.json`, `src/config.js`,
`shell/SazShell.csproj`, `build/set-icon.cjs`, and `build/installer.iss`, then
push a matching tag. The shell reads its displayed version from assembly
metadata; do not maintain a separate hard-coded version in `shell/Program.cs`.

```powershell
$version = "0.9.12"
git tag "v$version"
git push origin "v$version"
```

GitHub builds the Windows installer, verifies `update.json`, and publishes both
files to the release. Existing updater-enabled installations discover it on
their next background update check.

## Run from source (development)

```
npm start
```

## Two ways to use it

**App window (like the Ollama app):** launch **Boolean** from the Start menu or
desktop shortcut — or run `saz ui` in a terminal. You get a chat window with
a model picker in the message box, Allow/Deny cards for every command it wants
to run, an auto-approve toggle in Settings, and automatic light/dark theme.
(The window is served locally from the exe and opened in an Edge app window —
nothing leaves your machine.)

**Terminal (like Codex CLI):** run `saz` in any terminal.

Just type what you want:

```
you › create a python virtual env in ./demo and install requests
you › what's using port 8080? kill it
you › install 7zip with winget
you › read src/agent.js and explain the tool loop
```

Before the agent runs a command or writes a file it shows you exactly what it
wants to do and asks `[y]es / [n]o / [a]lways this session`.

### Slash commands (terminal mode)

| command | what it does |
|---|---|
| `/provider [name]` | switch provider: local, OpenAI, GLM, Z.AI Coding Plan, or Claude |
| `/model <name>` | switch model for the current provider |
| `/models` | list models for the current provider |
| `/pull <id>` | download a local model (e.g. `/pull gemma4-e4b`) |
| `/import <path>` | add any .gguf model from a USB drive or folder |
| `/key <p> <key>` | set an API key (`/key openai sk-...`) |
| `/auto` | toggle auto-approve (runs commands without asking) |
| `/clear` | start a fresh conversation |
| `/exit` | quit |

## License & privacy

The installer shows and requires acceptance of `LICENSE.txt` (as-is, no
warranty, user responsible for approved commands). First launch asks for
in-app acceptance too. `PRIVACY.txt`: local mode has no telemetry/tracking, and
data leaves the machine only when the user chooses a network feature such as a
cloud provider, Boolean account sign-in, a remote MCP server, model download, web browse,
software install, update, or screenshot/page content sent to an online model.

## Config

Stored at `~/.saz/config.json`:

```json
{
  "host": "http://localhost:11434",
  "model": "qwen2.5-coder:7b",
  "autoApprove": false,
  "maxToolTurns": 0,
  "commandTimeoutMs": 120000
}
```

`maxToolTurns` is retained for compatibility with older config files. Boolean
now keeps working until the model finishes or the user presses Stop. Tool
progress is checkpointed, with a guard for repeated identical actions.

## How it works

- `src/index.js` — terminal REPL, approval prompts, slash commands, `ui` launcher
- `src/server.js` — local HTTP server for the app window (NDJSON streaming,
  approval round-trips)
- `src/ui.html` — the chat UI (embedded into the exe as a SEA asset)
- `src/agent.js` — the agent loop: sends chat + tool schemas to Ollama, executes
  returned tool calls, feeds results back until the model gives a final answer.
  Handles native tool calls, fenced-JSON and bare-JSON tool calls (small models
  are inconsistent); models without tool support fall back to a text protocol.
- `src/tools.js` — project, command, browser, screenshot, notepad, model,
  Windows, planning, and connector tools
- `src/setup.js` — first-run local-engine and model setup
- `src/config.js` — config load/save

Zero runtime npm dependencies — Node built-ins only.

## Notes on small models

Small local models (4B–14B) are far more error-prone than cloud models. Keep
approval ON for anything risky, and prefer `qwen2.5-coder:7b` or larger for
actual agent work — the 1.5b models often fumble tool calls.
