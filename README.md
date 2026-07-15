# Boolean

**The offline coding agent — developed by saz3 Labs.**

A local, offline coding agent for Windows — like Codex or Claude Code, but with
its own **built-in inference engine** (llama.cpp) running GGUF models directly.
No Ollama required, no API keys, no internet needed once models are downloaded,
and your code never leaves your PC.

Four interchangeable providers (Settings or `/provider`):

| provider | what it is | needs |
|---|---|---|
| **local** (default) | built-in llama.cpp engine, GGUF models in `~/.saz/models` | nothing — self-contained |
| **ollama** | your existing Ollama install & models | Ollama running |
| **openai** | OpenAI cloud API | API key (`/key openai sk-...`) |
| **glm** | Z.ai / Zhipu GLM cloud API | API key (`/key glm ...`) |

It can control **PowerShell, cmd, winget, git, npm, dotnet** — anything you can
run in a terminal — plus read and write files, with an approval prompt before
every command so you stay in control.

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
hash, and applies it after the app closes. Chats, settings, models, notepad
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

- Cloud/online mode: 4 GB RAM, internet connection, WebView2, and a provider
  API key or Boolean Cloud account
- Lightest local LLM mode: 8 GB RAM recommended, 2 GB free disk space, and a
  CPU with AVX2 preferred
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

## Cloud backend

Boolean's local app stays usable offline. Paid cloud features live in the
separate Cloudflare Worker backend under `backend/`:

- Google Sign-In
- user sessions
- token balance storage
- 100k free signup cloud tokens for the first 1,000 new cloud signups
- 10k/day free-tier usage cap
- word-based cloud metering for now: one word counts as one token
- free-tier default model metadata for GLM-4.7-Flash on Workers AI
- future Stripe checkout/webhooks
- future cloud AI proxy

Secrets such as Google client secrets, Stripe secrets, and paid LLM provider keys
belong only in the backend, never inside the Windows installer.

Optional cloud accounts change the privacy model only for cloud features. Local
mode remains offline. If a user signs in with Google or uses cloud tokens,
Boolean Cloud may store account identity, token balance, usage counters,
free-grant expiration, default cloud model access such as GLM-4.7-Flash,
Stripe billing status if enabled, and cloud request metadata needed to
provide and protect the service.

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
`shell/SazShell.csproj`, `shell/Program.cs`, `build/set-icon.cjs`, and
`build/installer.iss`, then push a matching tag:

```powershell
$version = "0.9.4"
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
| `/provider [name]` | switch provider: local, ollama, openai, glm |
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
data leaves the machine only when the user chooses cloud providers, Boolean
Cloud sign-in/tokens, model downloads, web browsing, or installation helpers.

## Config

Stored at `~/.saz/config.json`:

```json
{
  "host": "http://localhost:11434",
  "model": "qwen2.5-coder:7b",
  "autoApprove": false,
  "maxToolTurns": 12,
  "commandTimeoutMs": 120000
}
```

## How it works

- `src/index.js` — terminal REPL, approval prompts, slash commands, `ui` launcher
- `src/server.js` — local HTTP server for the app window (NDJSON streaming,
  approval round-trips)
- `src/ui.html` — the chat UI (embedded into the exe as a SEA asset)
- `src/agent.js` — the agent loop: sends chat + tool schemas to Ollama, executes
  returned tool calls, feeds results back until the model gives a final answer.
  Handles native tool calls, fenced-JSON and bare-JSON tool calls (small models
  are inconsistent); models without tool support fall back to a text protocol.
- `src/tools.js` — the four tools: `run_command` (PowerShell/cmd), `read_file`,
  `write_file`, `list_dir`
- `src/setup.js` — first-run wizard (installs Ollama, downloads a model)
- `src/config.js` — config load/save

Zero runtime npm dependencies — Node built-ins only.

## Notes on small models

Small local models (4B–14B) are far more error-prone than cloud models. Keep
approval ON for anything risky, and prefer `qwen2.5-coder:7b` or larger for
actual agent work — the 1.5b models often fumble tool calls.
