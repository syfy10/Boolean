import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const AUDIT_DIR = path.join(os.homedir(), ".saz");
const AUDIT_FILE = path.join(AUDIT_DIR, "system-actions.jsonl");

const SETTINGS = Object.freeze({
  display: "ms-settings:display",
  advanced_display: "ms-settings:display-advanced",
  graphics: "ms-settings:display-advancedgraphics",
  sound: "ms-settings:sound",
  network: "ms-settings:network-status",
  wifi: "ms-settings:network-wifi",
  ethernet: "ms-settings:network-ethernet",
  bluetooth: "ms-settings:bluetooth",
  printers: "ms-settings:printers",
  apps: "ms-settings:appsfeatures",
  startup_apps: "ms-settings:startupapps",
  windows_update: "ms-settings:windowsupdate",
  storage: "ms-settings:storagesense",
  power: "ms-settings:powersleep",
  privacy: "ms-settings:privacy",
  accounts: "ms-settings:yourinfo"
});

const RESUME_OR_STATUS_ONLY = /^(?:continue|resume|keep going|go on|finish|finish it|try again|retry|go ahead|carry on|keep working|move forward|do it|yes do it|ok do it|okay do it|check now|please continue|continue where you left off|can you do (?:this|it)(?: now| or not| or now)?)\b/i;
const STATUS_QUESTION = /\b(?:are you|r u|you)\s+(?:still\s+)?(?:checking|working|running|doing|stuck|stopped)\b|\b(?:what happened|why did (?:it|you) stop|did (?:it|you) stop|what are you doing|where are we|status update|give me status|can move forward)\b/i;
const TRANSCRIPT_MARKER = /(?:^|\n)\s*(?:You|GPT|GLM|AI|Boolean|Qwen|Claude|Codex)\s*:/i;

function directActionSource(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (RESUME_OR_STATUS_ONLY.test(raw) || STATUS_QUESTION.test(raw)) return "";

  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const longContext = raw.length > 700 || TRANSCRIPT_MARKER.test(raw) || raw.split(/\r?\n/).length > 8;
  if (!longContext) return raw;

  // Long pasted notes, handoff reports, and chat transcripts often mention
  // "settings", "privacy", "open", or "change" as descriptive text. Only
  // allow the deterministic Windows shortcut when the latest visible line
  // itself is the command. Everything else should go to the model/controller.
  return firstLine;
}

// Small/local models are not reliable enough to discover obvious Windows
// Settings actions through tool calling every time. Route only clear,
// allowlisted requests here; everything else still goes through the model.
export function detectWindowsSettingsRequest(input) {
  const source = directActionSource(input);
  if (!source) return null;
  const normalize = (value) => String(value || "")
    .toLowerCase()
    .replace(/\bdesplay\b/g, "display")
    .replace(/\bbluetooths?\b/g, "bluetooth")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const action = /\b(open|show|view|change|adjust|manage|configure|setup|set up|take me to|go to)\b/;
  // Keep actions scoped to the sentence/line that contains the setting. A long
  // project handoff may mention "open the app" on one line and "scanner" on
  // another; treating the whole message as one phrase used to open Printers.
  const clauses = source.split(/[\r\n]+|(?<=[.!?;])\s+/).map(normalize).filter(Boolean);

  const pages = [
    ["advanced_display", /\badvanced display\b/],
    ["graphics", /\b(graphics|gpu) settings?\b/],
    ["display", /\b(display|screen|resolution|scaling|brightness)\b/],
    ["sound", /\b(sound|audio|speaker|microphone|volume)\b/],
    ["wifi", /\bwi ?fi\b/],
    ["ethernet", /\bethernet\b/],
    ["network", /\b(network|internet)\b/],
    ["bluetooth", /\bbluetooth\b/],
    ["printers", /\b(printer|scanner)s?\b/],
    ["startup_apps", /\bstartup apps?\b/],
    ["apps", /\b(apps?|installed apps?|programs?) settings?\b/],
    ["windows_update", /\bwindows updates?\b|\bupdates? settings\b/],
    ["storage", /\b(storage|disk space)\b/],
    ["power", /\b(power|sleep|battery)\b/],
    ["privacy", /\bprivacy\b/],
    ["accounts", /\b(account|profile)s?\b/]
  ];
  for (const clause of clauses) {
    if (!action.test(clause)) continue;
    for (const [page, pattern] of pages) {
      if (pattern.test(clause)) return { name: "windows_settings_open", args: { page } };
    }
  }
  return null;
}

export const SYSTEM_ACTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "windows_system_info",
      description: "Inspect this Windows PC. Returns concise OS, display, network, or installed-app information without changing anything.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["overview", "display", "network", "apps"], description: "Information to inspect. Default: overview." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "windows_settings_open",
      description: "Open an exact Windows Settings page. Use when the user asks to view or change a Windows setting that Boolean cannot safely change directly.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", enum: Object.keys(SETTINGS), description: "Windows Settings page to open." }
        },
        required: ["page"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "windows_app_search",
      description: "Search Microsoft Store or WinGet packages installed through Windows Package Manager. Returns package names and exact IDs. Ratings are not provided by WinGet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "App name or search terms." },
          source: { type: "string", enum: ["msstore", "winget", "all"], description: "Package source. Default: msstore." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "windows_app_install",
      description: "Install one exact Microsoft Store or WinGet package after mandatory user confirmation. Search first and pass the exact package ID; never guess an ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Exact package ID returned by windows_app_search." },
          source: { type: "string", enum: ["msstore", "winget"], description: "Package source. Default: msstore." }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "windows_network_setup",
      description: "Inspect or prepare this PC for a trusted home network. The enable_home_discovery action requires mandatory confirmation and a Windows UAC prompt; it only enables Private-profile, local-subnet discovery/file-sharing rules.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["inspect", "enable_home_discovery"], description: "Network operation." }
        },
        required: ["action"]
      }
    }
  }
];

function audit(action, status, details = {}) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), action, status, ...details }) + "\n");
  } catch { /* Auditing must not crash the requested action. */ }
}

function run(exe, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)} seconds.`.trim() });
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

function powershell(script, timeoutMs) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], timeoutMs);
}

function resultText(result) {
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return `exit code: ${result.code}\n${body || "(no output)"}`;
}

function safePackageId(value) {
  const id = String(value || "").trim();
  return id && /^[A-Za-z0-9][A-Za-z0-9._+:-]{1,180}$/.test(id) ? id : "";
}

async function systemInfo(scope) {
  const scripts = {
    overview: `$ErrorActionPreference='SilentlyContinue'; $os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; $profiles=Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory,IPv4Connectivity; [pscustomobject]@{ComputerName=$env:COMPUTERNAME; Windows=$os.Caption; Version=$os.Version; Architecture=$os.OSArchitecture; Manufacturer=$cs.Manufacturer; Model=$cs.Model; MemoryGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1); Processor=$cpu.Name; IsAdministrator=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); NetworkProfiles=$profiles} | ConvertTo-Json -Depth 5`,
    display: `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,AdapterRAM,DriverVersion | ConvertTo-Json -Depth 4`,
    network: `$ErrorActionPreference='SilentlyContinue'; [pscustomobject]@{Profiles=(Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory,IPv4Connectivity,IPv6Connectivity); Adapters=(Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription,LinkSpeed,MacAddress); Addresses=(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.254*'} | Select-Object InterfaceAlias,IPAddress,PrefixLength)} | ConvertTo-Json -Depth 5`,
    apps: `$ErrorActionPreference='SilentlyContinue'; [pscustomobject]@{Winget=((winget --version) 2>$null); Installed=(Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object DisplayName | Sort-Object DisplayName -Unique | Select-Object -First 150 DisplayName,DisplayVersion,Publisher)} | ConvertTo-Json -Depth 4`
  };
  const selected = scripts[scope] || scripts.overview;
  return resultText(await powershell(selected, 30000));
}

async function openSettings(page) {
  const uri = SETTINGS[page];
  if (!uri) return "error: unsupported Windows Settings page";
  const result = await run("cmd.exe", ["/d", "/c", "start", "", uri], 10000);
  audit("windows_settings_open", result.code === 0 ? "completed" : "failed", { page });
  return result.code === 0 ? `Opened Windows Settings: ${page}.` : resultText(result);
}

async function appSearch(args) {
  const query = String(args.query || "").trim();
  if (!query || query.length > 160) return "error: enter a shorter app search query";
  const source = ["msstore", "winget", "all"].includes(args.source) ? args.source : "msstore";
  const sources = source === "all" ? ["msstore", "winget"] : [source];
  const blocks = [];
  for (const src of sources) {
    const r = await run("winget.exe", ["search", "--query", query, "--source", src, "--count", "10", "--accept-source-agreements", "--disable-interactivity"], 45000);
    blocks.push(`[${src}]\n${resultText(r)}`);
  }
  audit("windows_app_search", "completed", { query, source });
  return blocks.join("\n\n") + "\n\nWinGet does not expose Microsoft Store ratings. Use current web evidence only if the user explicitly asks to compare ratings.";
}

async function appInstall(args, ctx) {
  const id = safePackageId(args.id);
  if (!id) return "error: invalid package ID; call windows_app_search and use its exact ID";
  const source = args.source === "winget" ? "winget" : "msstore";
  const ok = await ctx.approveAlways(`Install ${id} from ${source}. Windows may show an installer or UAC prompt.`);
  if (!ok) { audit("windows_app_install", "declined", { id, source }); return "user declined the app installation"; }
  audit("windows_app_install", "started", { id, source });
  const r = await run("winget.exe", ["install", "--id", id, "--exact", "--source", source, "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"], 15 * 60 * 1000);
  audit("windows_app_install", r.code === 0 ? "completed" : "failed", { id, source, code: r.code });
  return resultText(r);
}

async function elevatedPowerShell(script, timeoutMs = 120000) {
  const resultFile = path.join(os.tmpdir(), `boolean-system-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const wrapped = `$ErrorActionPreference='Stop'; try { & { ${script} } | Out-String | Set-Content -LiteralPath ${JSON.stringify(resultFile)} -Encoding UTF8; exit 0 } catch { $_ | Out-String | Set-Content -LiteralPath ${JSON.stringify(resultFile)} -Encoding UTF8; exit 1 }`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  const launcher = `$p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$args[0]); exit $p.ExitCode`;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launcher, encoded], timeoutMs);
  let elevated = "";
  try { elevated = fs.readFileSync(resultFile, "utf8").trim(); } catch { /* UAC may have been cancelled. */ }
  try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ }
  return { ...r, stdout: elevated || r.stdout };
}

async function networkSetup(args, ctx) {
  if (args.action === "inspect") return await systemInfo("network");
  if (args.action !== "enable_home_discovery") return "error: unsupported network action";
  const ok = await ctx.approveAlways("Prepare this PC for a trusted home network: make connected networks Private, start discovery services, and enable Private/local-subnet discovery and file-sharing firewall rules. Windows will show a UAC prompt.");
  if (!ok) { audit("windows_network_setup", "declined", { action: args.action }); return "user declined the network change"; }
  const script = `
    Get-NetConnectionProfile | Where-Object {$_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected'} | Set-NetConnectionProfile -NetworkCategory Private;
    foreach($svc in @('fdPHost','FDResPub','SSDPSRV','upnphost')) { Set-Service -Name $svc -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service -Name $svc -ErrorAction SilentlyContinue }
    Get-NetFirewallRule -Group '@FirewallAPI.dll,-32752' -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -Profile Private;
    Get-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -Profile Private;
    Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory,IPv4Connectivity | Format-Table -AutoSize
  `;
  audit("windows_network_setup", "started", { action: args.action });
  const r = await elevatedPowerShell(script);
  audit("windows_network_setup", r.code === 0 ? "completed" : "failed", { action: args.action, code: r.code });
  return r.code === 0
    ? `Home-network discovery is enabled for Private networks and local-subnet traffic only. Run this action on each trusted PC.\n${r.stdout.trim()}`
    : `The network action did not complete. The UAC prompt may have been cancelled.\n${resultText(r)}`;
}

export async function executeSystemAction(name, args, ctx) {
  if (!SYSTEM_ACTION_DEFINITIONS.some((x) => x.function.name === name)) return null;
  if (!IS_WINDOWS) return "error: Windows System Actions are only available on Windows";
  if (ctx.config?.ui?.systemActions === false) return "Windows System Actions are disabled in Settings.";
  if (name === "windows_system_info") return await systemInfo(args.scope || "overview");
  if (name === "windows_settings_open") return await openSettings(args.page);
  if (name === "windows_app_search") return await appSearch(args);
  if (name === "windows_app_install") return await appInstall(args, ctx);
  if (name === "windows_network_setup") return await networkSetup(args, ctx);
  return "error: unsupported Windows System Action";
}
