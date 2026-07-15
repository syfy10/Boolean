// Boolean native shell: a WinForms window we own (so the taskbar shows OUR icon),
// hosting the existing web UI in a WebView2 on the left and a REAL Chromium
// browser (native WebView2, full internet — Outlook/Gmail included) on the
// right. The Node backend runs as a child ("core") process; the window just
// points a WebView2 at http://127.0.0.1:<port>.
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace SazShell;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

sealed class TabItem
{
    public WebView2 View = new();
    public string Url = "";
    public string Title = "New tab";
    public Button Chip = new();
}

sealed class MainForm : Form
{
    // derived from AssemblyVersion (SazShell.csproj) so it can never drift from
    // the shipped version again — a stale hardcoded value here made 0.9.9
    // think it was 0.9.8 and re-download itself forever
    static readonly string AppVersion =
        typeof(MainForm).Assembly.GetName().Version is { } av ? $"{av.Major}.{av.Minor}.{av.Build}" : "0.0.0";
    const string UpdateManifestUrl = "https://github.com/syfy10/Boolean/releases/latest/download/update.json";

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetClipboardSequenceNumber();

    // borderless custom chrome: the web top bar is the title bar. These let the
    // web UI start a native window move (drag) via a WM_NCLBUTTONDOWN caption hit.
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ReleaseCapture();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    const int WM_NCLBUTTONDOWN = 0xA1;
    const int HTCAPTION = 2;

    // Keep the window resizable + Aero-snappable even though it has no caption.
    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_MINIMIZEBOX = 0x20000, WS_MAXIMIZEBOX = 0x10000, WS_THICKFRAME = 0x40000;
            var cp = base.CreateParams;
            cp.Style |= WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
            return cp;
        }
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct NCCALCSIZE_PARAMS { public RECT r0, r1, r2; public IntPtr lppos; }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

    // Reclaim the top frame in a normal window. When maximized, MaximizedBounds already keeps
    // the window inside the work area, so reclaim the entire resize frame to avoid edge gaps.
    protected override void WndProc(ref Message m)
    {
        const int WM_NCCALCSIZE = 0x0083;
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            var before = System.Runtime.InteropServices.Marshal.PtrToStructure<NCCALCSIZE_PARAMS>(m.LParam);
            base.WndProc(ref m);
            var after = System.Runtime.InteropServices.Marshal.PtrToStructure<NCCALCSIZE_PARAMS>(m.LParam);
            if (WindowState == FormWindowState.Maximized)
                after.r0 = before.r0;
            else
                after.r0.top = before.r0.top;
            System.Runtime.InteropServices.Marshal.StructureToPtr(after, m.LParam, false);
            return;
        }
        base.WndProc(ref m);
    }

    void ApplyBorderlessDwm()
    {
        try
        {
            int none = unchecked((int)0xFFFFFFFE); // DWMWA_COLOR_NONE — drop the gray border hairline
            DwmSetWindowAttribute(Handle, 34 /*DWMWA_BORDER_COLOR*/, ref none, 4);
            int round = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(Handle, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, ref round, 4);
        }
        catch { }
    }

    void ApplyDwmChromeColor(Color color)
    {
        try
        {
            int caption = ColorTranslator.ToWin32(color);
            DwmSetWindowAttribute(Handle, 35 /*DWMWA_CAPTION_COLOR*/, ref caption, 4);
            int border = ColorTranslator.ToWin32(color);
            DwmSetWindowAttribute(Handle, 34 /*DWMWA_BORDER_COLOR*/, ref border, 4);
        }
        catch { }
    }

    void HandleWindowCommand(System.Text.Json.JsonElement root)
    {
        var action = root.TryGetProperty("action", out var ap) ? ap.GetString() : null;
        switch (action)
        {
            case "drag":
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                break;
            case "min": WindowState = FormWindowState.Minimized; break;
            case "maxtoggle": ToggleMaximize(); break;
            case "close": Close(); break;
        }
    }

    void ToggleMaximize()
    {
        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea; // don't cover the taskbar
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }

    // layout
    readonly SplitContainer _split = new() { Orientation = Orientation.Vertical, SplitterWidth = 4 };
    readonly WebView2 _chat = new() { Dock = DockStyle.Fill };
    readonly Panel _browserPane = new() { Dock = DockStyle.Fill };
    readonly Panel _startup = new() { Dock = DockStyle.Fill, BackColor = Color.FromArgb(245, 245, 243) };
    readonly Label _startupTitle = new() { AutoSize = true, Font = new Font("Segoe UI", 18f, FontStyle.Bold), ForeColor = Color.FromArgb(18, 24, 20) };
    readonly Label _startupText = new() { AutoSize = false, Font = new Font("Segoe UI", 10f), ForeColor = Color.FromArgb(96, 100, 96) };
    readonly Button _startupClose = new() { Text = "Close", Width = 92, Height = 34, FlatStyle = FlatStyle.Flat, Visible = false };
    readonly Panel _browserTitleBar = new() { Dock = DockStyle.Top, Height = 0 };
    readonly Panel _toolbar = new() { Dock = DockStyle.Top, Height = 26 };
    readonly FlowLayoutPanel _tabStrip = new() { Dock = DockStyle.Top, Height = 44, WrapContents = false, AutoScroll = false };
    readonly Panel _content = new() { Dock = DockStyle.Fill };
    readonly TextBox _addr = new();
    readonly List<TabItem> _tabs = new();
    int _active = -1;
    bool _full = false;
    ContextMenuStrip _menu = null!;
    Button _menuBtn = null!;
    Button _addTabBtn = new();
    Button _browserCloseBtn = null!;
    Panel _tabBar = new() { Dock = DockStyle.Top, Height = 44 };

    // themeable chrome (follows the app's light/dark theme)
    readonly List<Button> _barBtns = new();
    FlowLayoutPanel _rightPanel = null!;
    Palette _pal = Palette.Light;
    const int BrowserTopInset = 0;

    readonly record struct Palette(Color PaneBg, Color BarBg, Color BtnBg, Color BtnBorder,
        Color Text, Color AddrBg, Color Splitter, Color ActiveTab, Color Hover)
    {
        public static Palette Light => new(
            Color.White, Color.White, Color.White, Color.FromArgb(224, 224, 221),
            Color.FromArgb(26, 26, 26), Color.White, Color.FromArgb(230, 230, 227), Color.FromArgb(245, 245, 245), Color.FromArgb(242, 242, 242));
        public static Palette Dark => new(
            Color.FromArgb(28, 28, 28), Color.FromArgb(24, 24, 24), Color.FromArgb(34, 34, 34), Color.FromArgb(58, 58, 58),
            Color.Gainsboro, Color.FromArgb(38, 38, 38), Color.FromArgb(40, 40, 40), Color.FromArgb(46, 46, 46), Color.FromArgb(48, 48, 48));
    }

    CoreWebView2Environment _env = null!;
    Process? _core;
    int _port;
    volatile bool _corePrintedServing;
    string _homeUrl = "https://www.google.com";
    readonly HttpClient _http = new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };
    readonly string _logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "saz3", "logs");
    readonly string _updateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "saz3", "updates");
    string CoreLogPath => Path.Combine(_logDir, "boolean-core.log");
    string? _updateReadyPath;
    bool _updateCheckRunning;

    // browser permissions read from the app config (~/.saz/config.json)
    bool _permDownloads = true, _permCamera = false, _permMic = false, _permGeo = false;

    public MainForm()
    {
        Text = "Boolean";                          // taskbar label only
        FormBorderStyle = FormBorderStyle.None;     // no native caption — the web top bar is the title bar
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1200, 800);
        Width = Math.Min(920, (int)(wa.Width * 0.65));    // roomy by default, still fits the screen
        Height = Math.Min(620, (int)(wa.Height * 0.69));
        StartPosition = FormStartPosition.CenterScreen;
        Opacity = 0;
        BackColor = Color.FromArgb(28, 28, 28);
        TryLoadIcon();
        BuildBrowserPane();
        BuildStartupOverlay();

        _split.Dock = DockStyle.Fill;
        // Keep constructor-time minimums conservative. SplitContainer validates
        // these against its current pre-layout width, so large preferred widths
        // can crash the app before the first window paints.
        _split.Panel1MinSize = 20;
        _split.Panel2MinSize = 20;
        _split.Panel1.Controls.Add(_chat);
        _split.Panel2.Padding = new Padding(0, BrowserTopInset, 0, 0);
        _split.Panel2.Controls.Add(_browserPane);
        Controls.Add(_split);
        Controls.Add(_startup);
        _startup.BringToFront();

        Load += OnLoad;
        Resize += (_, __) => { if (_browserOpen && !_full) FitBrowserSplit(); };
        Deactivate += (_, __) => _menu?.Close();
        FormClosed += (_, __) => { CleanupCoreOnClose(); LaunchPendingUpdate(); };
        Shown += (_, __) => { _split.Panel2Collapsed = true; }; // browser hidden until toggled
    }

    void BuildStartupOverlay()
    {
        _startupClose.FlatAppearance.BorderSize = 0;
        _startupClose.BackColor = Color.FromArgb(18, 24, 20);
        _startupClose.ForeColor = Color.White;
        _startupClose.Click += (_, __) => Close();
        _startup.Controls.Add(_startupTitle);
        _startup.Controls.Add(_startupText);
        _startup.Controls.Add(_startupClose);
        _startup.Resize += (_, __) => LayoutStartupOverlay();
        ShowStartup("Starting Boolean", "Loading the local app...");
    }

    void LayoutStartupOverlay()
    {
        int w = Math.Min(460, Math.Max(260, _startup.ClientSize.Width - 80));
        int left = Math.Max(24, (_startup.ClientSize.Width - w) / 2);
        int top = Math.Max(40, (_startup.ClientSize.Height - 150) / 2);
        _startupTitle.Left = left;
        _startupTitle.Top = top;
        _startupText.Left = left + 2;
        _startupText.Top = _startupTitle.Bottom + 12;
        _startupText.Width = w;
        _startupText.Height = 82;
        _startupClose.Left = left + 2;
        _startupClose.Top = _startupText.Bottom + 12;
    }

    void ShowStartup(string title, string text, bool error = false)
    {
        if (!error)
        {
            _startup.Visible = false;
            return;
        }
        _startupTitle.Text = title;
        _startupText.Text = text;
        _startupText.ForeColor = error ? Color.FromArgb(185, 28, 28) : Color.FromArgb(96, 100, 96);
        _startupClose.Visible = error;
        _startup.Visible = true;
        Opacity = 1;
        _startup.BringToFront();
        LayoutStartupOverlay();
    }

    void CleanupCoreOnClose()
    {
        try
        {
            if (_updateReadyPath is null && KeepLocalWarmEnabled()) return;
            _core?.Kill(true);
            _core?.WaitForExit(2000);
        }
        catch { }
    }

    sealed class UpdateManifest
    {
        public string Version { get; set; } = "";
        public string Url { get; set; } = "";
        public string Sha256 { get; set; } = "";
    }

    static Version ParseVersion(string value)
    {
        var clean = (value ?? "").Trim().TrimStart('v', 'V').Split('-', '+')[0];
        return Version.TryParse(clean, out var parsed) ? parsed : new Version(0, 0);
    }

    static bool IsNewerVersion(string candidate) => ParseVersion(candidate) > ParseVersion(AppVersion);

    static bool IsTrustedUpdateUrl(string value, out Uri? uri)
    {
        uri = null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var parsed) || parsed.Scheme != Uri.UriSchemeHttps) return false;
        var host = parsed.Host.ToLowerInvariant();
        if (host != "github.com" && host != "objects.githubusercontent.com" && !host.EndsWith(".githubusercontent.com")) return false;
        uri = parsed;
        return true;
    }

    void LogUpdate(string message)
    {
        try
        {
            Directory.CreateDirectory(_updateDir);
            var logPath = Path.Combine(_updateDir, "update-check.log");
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 64 * 1024) File.Delete(logPath);
            File.AppendAllText(logPath, $"{DateTime.UtcNow:O} [{AppVersion}] {message}\r\n", Encoding.UTF8);
        }
        catch { }
    }

    string PendingInstallerPath(string version)
    {
        var safe = string.Concat((version ?? "").Where(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_'));
        return Path.Combine(_updateDir, $"Boolean-setup-{safe}.exe");
    }

    async Task CheckForUpdatesAsync()
    {
        if (_updateCheckRunning) return;
        _updateCheckRunning = true;

        // Development builds do not update themselves. Packaged builds always
        // contain the core executable beside the shell.
        if (!File.Exists(Path.Combine(AppContext.BaseDirectory, "saz-core.exe"))) { _updateCheckRunning = false; return; }

        try
        {
            Directory.CreateDirectory(_updateDir);
            var pendingFile = Path.Combine(_updateDir, "pending-update.json");
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

            // reload a fully downloaded pending update, but never let it skip the
            // feed check — a stale pending version must not hide newer releases
            UpdateManifest? pending = null;
            if (File.Exists(pendingFile))
            {
                try
                {
                    var parsed = JsonSerializer.Deserialize<UpdateManifest>(await File.ReadAllTextAsync(pendingFile), options);
                    var hash = parsed?.Sha256?.Trim().ToUpperInvariant() ?? "";
                    if (parsed is not null && IsNewerVersion(parsed.Version) && hash.Length == 64
                        && File.Exists(PendingInstallerPath(parsed.Version))
                        && await HasExpectedHashAsync(PendingInstallerPath(parsed.Version), hash))
                        pending = parsed;
                    else
                        File.Delete(pendingFile);
                }
                catch (Exception ex) { LogUpdate("pending reload failed: " + ex.Message); try { File.Delete(pendingFile); } catch { } }
            }

            // the throttle stamp is only written after a COMPLETED check, so a
            // failed download retries on the next launch instead of waiting 6h
            var checkedFile = Path.Combine(_updateDir, "last-check.txt");
            var throttled = File.Exists(checkedFile)
                && DateTime.UtcNow - File.GetLastWriteTimeUtc(checkedFile) < TimeSpan.FromHours(6);

            if (!throttled)
            {
                using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true })
                {
                    Timeout = TimeSpan.FromMinutes(15)
                };
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Boolean-Windows/" + AppVersion);

                var json = await client.GetStringAsync(UpdateManifestUrl);
                var manifest = JsonSerializer.Deserialize<UpdateManifest>(json, options);

                if (manifest is null || !IsNewerVersion(manifest.Version))
                {
                    LogUpdate($"feed checked: {(manifest?.Version ?? "unreadable")} — up to date");
                }
                else if (pending is not null && ParseVersion(manifest.Version) <= ParseVersion(pending.Version))
                {
                    LogUpdate($"feed checked: {manifest.Version} already downloaded");
                }
                else if (!IsTrustedUpdateUrl(manifest.Url, out var downloadUri) || downloadUri is null)
                {
                    LogUpdate($"feed rejected: untrusted url {manifest.Url}");
                }
                else
                {
                    var expectedHash = manifest.Sha256.Trim().ToUpperInvariant();
                    if (expectedHash.Length != 64 || expectedHash.Any(c => !Uri.IsHexDigit(c)))
                    {
                        LogUpdate($"feed rejected: bad sha256 for {manifest.Version}");
                    }
                    else
                    {
                        var readyPath = PendingInstallerPath(manifest.Version);
                        if (!File.Exists(readyPath) || !await HasExpectedHashAsync(readyPath, expectedHash))
                        {
                            var partialPath = readyPath + ".partial";
                            if (File.Exists(partialPath)) File.Delete(partialPath);
                            await using (var remote = await client.GetStreamAsync(downloadUri))
                            await using (var local = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
                                await remote.CopyToAsync(local);

                            if (!await HasExpectedHashAsync(partialPath, expectedHash))
                            {
                                File.Delete(partialPath);
                                LogUpdate($"download hash mismatch for {manifest.Version}");
                                throw new InvalidOperationException("update download failed verification");
                            }
                            File.Move(partialPath, readyPath, true);
                        }
                        await File.WriteAllTextAsync(pendingFile, JsonSerializer.Serialize(manifest), Encoding.UTF8);
                        pending = manifest;
                        LogUpdate($"downloaded and armed {manifest.Version}");
                    }
                }
                File.WriteAllText(checkedFile, DateTime.UtcNow.ToString("O"), Encoding.UTF8);
            }

            if (pending is not null) SetPendingUpdate(PendingInstallerPath(pending.Version), pending.Version);
        }
        catch (Exception ex)
        {
            // Updates are best-effort and must never delay or block app startup.
            LogUpdate("check failed: " + ex.Message);
        }
        finally
        {
            _updateCheckRunning = false;
        }
    }

    void SetPendingUpdate(string path, string version)
    {
        _updateReadyPath = path;
        if (!IsDisposed)
        {
            BeginInvoke(new Action(() => PostToChat(new
            {
                type = "updateReady",
                version
            })));
        }
    }

    static async Task<bool> HasExpectedHashAsync(string file, string expectedHash)
    {
        try
        {
            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
            using var sha = SHA256.Create();
            var hash = await sha.ComputeHashAsync(stream);
            return Convert.ToHexString(hash).Equals(expectedHash, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    void BackupUserDataForUpdate()
    {
        try
        {
            var source = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".saz");
            if (!Directory.Exists(source)) return;
            var backup = Path.Combine(_updateDir, "backup");
            Directory.CreateDirectory(backup);
            foreach (var name in new[] { "config.json", "threads.json", "usage.json", "preferences.json" })
            {
                var from = Path.Combine(source, name);
                if (File.Exists(from)) File.Copy(from, Path.Combine(backup, name), true);
            }
        }
        catch { }
    }

    void LaunchPendingUpdate()
    {
        if (_updateReadyPath is null || !File.Exists(_updateReadyPath)) return;
        try
        {
            BackupUserDataForUpdate();
            Directory.CreateDirectory(_updateDir);
            var helperPath = Path.Combine(_updateDir, "apply-update.ps1");
            var logPath = Path.Combine(_updateDir, "update-install.log");
            var pendingFile = Path.Combine(_updateDir, "pending-update.json");
            var appExe = Path.Combine(AppContext.BaseDirectory, "saz.exe");
            var script = """
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$AppExe,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$PendingFile
)
$ErrorActionPreference = 'Stop'
try {
  for ($i = 0; $i -lt 120; $i++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 1200
  $quotedLog = '"' + $LogPath.Replace('"','""') + '"'
  $installArgs = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /SP- /LOG=$quotedLog"
  $result = Start-Process -FilePath $Installer -ArgumentList $installArgs -Wait -PassThru
  if ($result.ExitCode -ne 0) {
    Add-Content -LiteralPath $LogPath -Value ("Updater: installer exited with code " + $result.ExitCode)
    exit $result.ExitCode
  }
  Remove-Item -LiteralPath $PendingFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  if (Test-Path -LiteralPath $AppExe) { Start-Process -FilePath $AppExe }
} catch {
  Add-Content -LiteralPath $LogPath -Value ("Updater failed: " + $_.Exception.Message)
  exit 1
}
""";
            File.WriteAllText(helperPath, script, new UTF8Encoding(false));
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            psi.ArgumentList.Add("-NoProfile");
            psi.ArgumentList.Add("-ExecutionPolicy");
            psi.ArgumentList.Add("Bypass");
            psi.ArgumentList.Add("-WindowStyle");
            psi.ArgumentList.Add("Hidden");
            psi.ArgumentList.Add("-File");
            psi.ArgumentList.Add(helperPath);
            psi.ArgumentList.Add("-Installer");
            psi.ArgumentList.Add(_updateReadyPath);
            psi.ArgumentList.Add("-AppExe");
            psi.ArgumentList.Add(appExe);
            psi.ArgumentList.Add("-ParentPid");
            psi.ArgumentList.Add(Environment.ProcessId.ToString());
            psi.ArgumentList.Add("-LogPath");
            psi.ArgumentList.Add(logPath);
            psi.ArgumentList.Add("-PendingFile");
            psi.ArgumentList.Add(pendingFile);
            Process.Start(psi);
        }
        catch { }
    }

    bool KeepLocalWarmEnabled()
    {
        try
        {
            var txt = _http.GetStringAsync($"http://127.0.0.1:{_port}/api/state").GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(txt);
            return doc.RootElement.TryGetProperty("ui", out var ui) &&
                ui.TryGetProperty("keepLocalWarm", out var warm) &&
                warm.ValueKind == JsonValueKind.True;
        }
        catch { return false; }
    }

    void TryLoadIcon()
    {
        try
        {
            var ico = Path.Combine(AppContext.BaseDirectory, "saz.ico");
            if (File.Exists(ico)) Icon = new Icon(ico);
        }
        catch { }
    }

    // ── async init ───────────────────────────────────────────────────
    async void OnLoad(object? s, EventArgs e)
    {
        ApplyBorderlessDwm();
        ReadPerms();
        try
        {
            var udf = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "saz3", "webview2");
            Directory.CreateDirectory(udf);
            var coreTask = StartCoreAsync();
            var webViewTask = CoreWebView2Environment.CreateAsync(null, udf);
            _port = await coreTask;
            _env = await webViewTask;

            await _chat.EnsureCoreWebView2Async(_env);
            _chat.CoreWebView2.WebMessageReceived += OnChatMessage;
            _chat.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _chat.NavigationCompleted += (_, __) =>
            {
                try
                {
                    _startup.Visible = false;
                    Opacity = 1;
                    Activate();
                }
                catch { }
            };
            _chat.CoreWebView2.Navigate($"http://127.0.0.1:{_port}");

            AddTab(_homeUrl, activate: true, navigate: false); // ready but hidden
            _ = CheckForUpdatesAsync();
            // long-lived windows re-check on the same cadence as the feed throttle
            var updateTimer = new System.Windows.Forms.Timer { Interval = (int)TimeSpan.FromHours(6).TotalMilliseconds };
            updateTimer.Tick += (_, __) => _ = CheckForUpdatesAsync();
            updateTimer.Start();
        }
        catch (Exception ex)
        {
            ShowStartup("Boolean could not start", ex.Message + "\n\nLog: " + CoreLogPath + ReadCoreLogTail(), true);
        }
    }

    void ReadPerms()
    {
        try
        {
            var cfg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".saz", "config.json");
            if (!File.Exists(cfg)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(cfg));
            if (doc.RootElement.TryGetProperty("ui", out var ui) &&
                ui.TryGetProperty("browserPerms", out var bp))
            {
                bool Get(string k, bool d) => bp.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.False ? false
                    : bp.TryGetProperty(k, out var t) && t.ValueKind == JsonValueKind.True ? true : d;
                _permDownloads = Get("downloads", true);
                _permCamera = Get("camera", false);
                _permMic = Get("mic", false);
                _permGeo = Get("geo", false);
            }
        }
        catch { }
    }

    // ── start the Node backend and wait until it answers ─────────────
    async Task<int> StartCoreAsync()
    {
        int port = FreePort();
        var (exe, args) = ResolveCore(port);
        _corePrintedServing = false;
        Directory.CreateDirectory(_logDir);
        File.AppendAllText(CoreLogPath,
            "\r\n\r\n[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] starting " + exe + " " + string.Join(" ", args) + "\r\n",
            Encoding.UTF8);
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        _core = Process.Start(psi) ?? throw new Exception("failed to launch: " + exe);
        _core.OutputDataReceived += (_, ev) => { if (ev.Data != null) OnCoreLogLine(ev.Data); };
        _core.ErrorDataReceived += (_, ev) => { if (ev.Data != null) OnCoreLogLine("[err] " + ev.Data); };
        try { _core.BeginOutputReadLine(); _core.BeginErrorReadLine(); } catch { }

        for (int i = 0; i < 60; i++)
        {
            if (_core.HasExited) throw new Exception("engine exited on startup (code " + _core.ExitCode + ")");
            if (i > 0 && i % 10 == 0)
                ShowStartup("Starting Boolean", "Still waiting for the local engine...\n" + ((i / 2) + 1) + " seconds elapsed\nLog: " + CoreLogPath);
            if (_corePrintedServing || await CoreReadyAsync(port)) return port;
            await Task.Delay(500);
        }
        throw new Exception("engine did not become ready in time. Boolean started the engine process, but it did not answer on localhost.");
    }

    void OnCoreLogLine(string line)
    {
        if (line.IndexOf("serving at", StringComparison.OrdinalIgnoreCase) >= 0 &&
            line.IndexOf("127.0.0.1", StringComparison.OrdinalIgnoreCase) >= 0)
            _corePrintedServing = true;
        AppendCoreLog(line);
    }

    async Task<bool> CoreReadyAsync(int port)
    {
        var baseUrl = $"http://127.0.0.1:{port}";
        try
        {
            using var r = await _http.GetAsync(baseUrl + "/api/state");
            if (r.IsSuccessStatusCode) return true;
        }
        catch { }
        try
        {
            using var r = await _http.GetAsync(baseUrl + "/");
            if (r.IsSuccessStatusCode) return true;
        }
        catch { }
        return false;
    }

    void AppendCoreLog(string line)
    {
        try { File.AppendAllText(CoreLogPath, line + "\r\n", Encoding.UTF8); }
        catch { }
    }

    string ReadCoreLogTail()
    {
        try
        {
            if (!File.Exists(CoreLogPath)) return "";
            var lines = File.ReadAllLines(CoreLogPath, Encoding.UTF8);
            var tail = lines.Skip(Math.Max(0, lines.Length - 8)).Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
            return tail.Length == 0 ? "" : "\n\nLast log lines:\n" + string.Join("\n", tail);
        }
        catch { return ""; }
    }

    // packaged: saz-core.exe next to us. dev: node <repo>\src\index.js
    (string exe, string[] args) ResolveCore(int port)
    {
        var dir = AppContext.BaseDirectory;
        var core = Path.Combine(dir, "saz-core.exe");
        string[] tail = { "ui", "--no-open", "--port", port.ToString() };
        if (File.Exists(core)) return (core, tail);

        var index = FindUp(dir, Path.Combine("src", "index.js"));
        if (index != null)
        {
            var node = new[] { index }.Concat(tail).ToArray();
            return ("node", node);
        }
        throw new Exception("saz-core.exe not found and dev src\\index.js not located");
    }

    static string? FindUp(string start, string rel)
    {
        var d = new DirectoryInfo(start);
        for (int i = 0; i < 8 && d != null; i++, d = d.Parent)
        {
            var cand = Path.Combine(d.FullName, rel);
            if (File.Exists(cand)) return cand;
        }
        return null;
    }

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    // ── browser pane UI (native) ─────────────────────────────────────
    void BuildBrowserPane()
    {
        _browserPane.BackColor = Color.FromArgb(28, 28, 28);
        _browserTitleBar.BackColor = Color.FromArgb(22, 22, 22);
        _toolbar.BackColor = Color.FromArgb(22, 22, 22);
        _tabStrip.BackColor = Color.FromArgb(22, 22, 22);

        // modern flat, borderless icon button
        Button Icon(string glyph, string tip, int w, EventHandler onClick)
        {
            var b = new Button
            {
                Text = glyph, Width = w, Height = 24, FlatStyle = FlatStyle.Flat, TabStop = false,
                ForeColor = Color.Gainsboro, BackColor = Color.Transparent, Font = new Font("Segoe UI", 9.5f),
                Padding = new Padding(0), Margin = new Padding(0)
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += onClick;
            var tt = new ToolTip(); tt.SetToolTip(b, tip);
            _barBtns.Add(b);
            return b;
        }

        // ── nav row (below the tabs): ← → ↻  [ Enter a URL ]  ⋮ ──
        int x = 6;
        void Place(Button b) { b.Left = x; b.Top = 1; _toolbar.Controls.Add(b); x += b.Width + 1; }
        Place(Icon("\u2190", "Back", 26, (_, __) => Active()?.View.CoreWebView2?.GoBack()));
        Place(Icon("\u2192", "Forward", 26, (_, __) => Active()?.View.CoreWebView2?.GoForward()));
        Place(Icon("\u21BB", "Reload", 26, (_, __) => Active()?.View.CoreWebView2?.Reload()));

        // address — flat, borderless, centered placeholder (no box)
        _addr.Top = 5; _addr.Height = 18; _addr.Left = x;
        _addr.BorderStyle = BorderStyle.None;
        _addr.TextAlign = HorizontalAlignment.Center;
        _addr.PlaceholderText = "Enter a URL";
        _addr.Font = new Font("Segoe UI", 9f);
        _addr.KeyDown += (_, ke) => { if (ke.KeyCode == Keys.Enter) { ke.SuppressKeyPress = true; Navigate(_addr.Text); } };
        _toolbar.Controls.Add(_addr);

        // ⋮ overflow menu — styled to match the flat in-app browser menu.
        _menu = new ContextMenuStrip { ShowImageMargin = false, Font = new Font("Segoe UI", 9f), Padding = new Padding(7) };
        _menu.Renderer = new BrowserMenuRenderer(() => _pal);
        void Sep() { var s = new ToolStripSeparator { Margin = new Padding(0, 4, 0, 4) }; _menu.Items.Add(s); }
        ToolStripMenuItem Item(string text, EventHandler on)
        {
            var it = new ToolStripMenuItem(text) { AutoSize = false, Height = 30, Width = 206, Padding = new Padding(7, 0, 7, 0) };
            it.Click += on;
            _menu.Items.Add(it);
            return it;
        }
        Item("New tab", (_, __) => AddTab(_homeUrl, true, true));
        Item("Close current tab", (_, __) => CloseTab(_active));
        Item("Close other tabs", (_, __) => CloseOtherTabs());
        Sep();
        Item("Send page to AI", async (_, __) => await SendPageToAI(false));
        Item("Send selected text to message", async (_, __) => await SendSelectedText("message"));
        Item("Send selected text to notepad", async (_, __) => await SendSelectedText("note"));
        Item("Send screenshot to AI", async (_, __) => await SendPageToAI(true));
        Item("Send screenshot to notepad", async (_, __) => await SendScreenshotToNotepad());
        Sep();
        _menu.Items.Add(MakeZoomRow());
        Item("Auto fit to window", async (_, __) => await AutoFitZoom());
        Sep();
        Item("History", (_, __) => { });
        Item("Clear browsing data", async (_, __) => await ClearBrowserData());
        Sep();
        Item("Open in system browser", (_, __) => OpenActiveInSystemBrowser());
        Item("Hide chat (focus browser)", (_, __) => ToggleFull());

        _menuBtn = Icon("\u22EE", "Menu", 26, (_, __) =>
        {
            if (_menu.Visible) _menu.Close();
            else _menu.Show(_menuBtn, new Point(_menuBtn.Width - _menu.Width, _menuBtn.Height));
        });
        _menuBtn.Top = 1; _menuBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _toolbar.Controls.Add(_menuBtn);

        void LayoutBar()
        {
            _menuBtn.Left = _toolbar.Width - _menuBtn.Width - 3;
            _addr.Width = Math.Max(96, _menuBtn.Left - _addr.Left - 6);
        }
        LayoutBar();
        _toolbar.Resize += (_, __) => LayoutBar();

        // ── tab row (on top): [tabs] [+] ......... [⤢ full width] [⧉ close] ──
        _addTabBtn = new Button { Text = "+", Width = 30, Height = 30, FlatStyle = FlatStyle.Flat, TabStop = false, BackColor = Color.Transparent, Font = new Font("Segoe UI", 12f), Margin = new Padding(3, 7, 0, 0) };
        _addTabBtn.FlatAppearance.BorderSize = 0;
        _addTabBtn.Click += (_, __) => AddTab(_homeUrl, true, true);
        _barBtns.Add(_addTabBtn);

        var tabRight = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(0, 7, 6, 0), BackColor = Color.Transparent };
        _rightPanel = tabRight;
        Button TabIcon(string g, string tip, EventHandler on)
        {
            var b = new Button { Text = g, Width = 30, Height = 30, FlatStyle = FlatStyle.Flat, TabStop = false, BackColor = Color.Transparent, Font = new Font("Segoe UI", 10.5f), Margin = new Padding(1, 0, 1, 0) };
            b.FlatAppearance.BorderSize = 0; b.Click += on;
            var tt = new ToolTip(); tt.SetToolTip(b, tip);
            tabRight.Controls.Add(b); _barBtns.Add(b); return b;
        }
        TabIcon("\u2922", "Full width (hide chat)", (_, __) => ToggleFull());
        _browserCloseBtn = TabIcon("\u25CE", "Hide browser", (_, __) => ToggleBrowser(false));
        TabIcon("\u2014", "Minimize", (_, __) => WindowState = FormWindowState.Minimized);
        TabIcon("\u25A1", "Maximize", (_, __) => ToggleMaximize());
        var winClose = TabIcon("\u00D7", "Close", (_, __) => Close());
        winClose.FlatAppearance.MouseOverBackColor = Color.FromArgb(232, 17, 35);

        _tabStrip.Dock = DockStyle.Fill;
        _tabStrip.Resize += (_, __) => LayoutTabs();
        _tabBar.Controls.Add(_tabStrip);
        _tabBar.Controls.Add(tabRight);

        // assemble — add toolbar first, tab bar last so the tabs sit on TOP
        _browserPane.Controls.Add(_content);
        _browserPane.Controls.Add(_toolbar);
        _browserPane.Controls.Add(_tabBar);
        _browserPane.Controls.Add(_browserTitleBar);
        _toolbar.MouseDown += (_, __) => { if (_menu.Visible) _menu.Close(); };
        _tabBar.MouseDown += (_, me) =>
        {
            if (_menu.Visible) _menu.Close();
            if (me.Button == MouseButtons.Left)
            {
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            }
        };
        _browserTitleBar.MouseDown += (_, __) => { if (_menu.Visible) _menu.Close(); };
        _content.MouseDown += (_, __) => { if (_menu.Visible) _menu.Close(); };
        ApplyTheme(ResolveTheme()); // initial colors (UI resends the exact theme on load)
    }

    // ── theme-aware chrome ───────────────────────────────────────────
    static bool SystemDark()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return k?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch { return false; }
    }

    // read ui.theme from ~/.saz/config.json (system|light|dark); default system
    Palette ResolveTheme()
    {
        string theme = "system";
        try
        {
            var cfg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".saz", "config.json");
            if (File.Exists(cfg))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(cfg));
                if (doc.RootElement.TryGetProperty("ui", out var ui) && ui.TryGetProperty("theme", out var th))
                    theme = th.GetString() ?? "system";
            }
        }
        catch { }
        bool dark = theme == "dark" || (theme == "system" && SystemDark());
        return dark ? Palette.Dark : Palette.Light;
    }

    void ApplyTheme(Palette p)
    {
        _pal = p;
        BackColor = p.PaneBg;
        ApplyDwmChromeColor(p.PaneBg);
        _split.BackColor = p.Splitter;
        _split.Panel2.BackColor = p.PaneBg;
        _browserPane.BackColor = p.PaneBg;
        _content.BackColor = p.PaneBg;
        _browserTitleBar.BackColor = p.BarBg;
        _toolbar.BackColor = p.BarBg;
        _tabStrip.BackColor = p.BarBg;
        _tabBar.BackColor = p.BarBg;
        if (_rightPanel != null) _rightPanel.BackColor = p.BarBg;
        _addr.BackColor = p.BarBg; _addr.ForeColor = p.Text;
        if (_menu != null) { _menu.BackColor = p.BarBg; _menu.ForeColor = p.Text; }
        foreach (var b in _barBtns)
        {
            b.BackColor = Color.Transparent; b.ForeColor = p.Text; // flat, blends into the bar
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = p.BarBg;
            b.FlatAppearance.MouseDownBackColor = p.BarBg;
        }
        if (_browserCloseBtn != null)
        {
            _browserCloseBtn.BackColor = p.Hover;
            _browserCloseBtn.ForeColor = Color.FromArgb(34, 197, 94);
            _browserCloseBtn.FlatAppearance.MouseOverBackColor = p.Hover;
            _browserCloseBtn.FlatAppearance.MouseDownBackColor = p.Hover;
        }
        for (int i = 0; i < _tabs.Count; i++)
        {
            _tabs[i].Chip.ForeColor = p.Text;
            _tabs[i].Chip.FlatAppearance.BorderSize = 0;
            _tabs[i].Chip.BackColor = (i == _active) ? p.Hover : Color.Transparent;
        }
        foreach (var t in _tabs)
            if (t.View.CoreWebView2 != null)
                t.View.CoreWebView2.Profile.PreferredColorScheme =
                    (p.PaneBg.R < 128) ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;
    }

    TabItem? Active() => _active >= 0 && _active < _tabs.Count ? _tabs[_active] : null;

    void LayoutTabs()
    {
        if (_tabs.Count == 0 || _tabStrip.Width <= 0) return;
        var available = Math.Max(80, _tabStrip.ClientSize.Width - _addTabBtn.Width - 12);
        var chipW = Math.Clamp(available / Math.Max(1, _tabs.Count) - 4, 54, 142);
        foreach (var t in _tabs)
        {
            t.Chip.AutoSize = false;
            t.Chip.Width = chipW;
            t.Chip.Height = 30;
            t.Chip.Margin = new Padding(3, 7, 0, 0);
            t.Chip.TextAlign = ContentAlignment.MiddleLeft;
        }
    }

    string TabLabel(TabItem t)
    {
        var text = string.IsNullOrWhiteSpace(t.Title) ? (string.IsNullOrWhiteSpace(t.Url) ? "New tab" : t.Url) : t.Title;
        var max = _tabs.Count > 6 ? 12 : 20;
        return "\u25CE " + Trunc(text, max);
    }

    async void AddTab(string url, bool activate, bool navigate)
    {
        var t = new TabItem { Url = url };
        t.View.Dock = DockStyle.Fill;
        t.View.Visible = false;
        _content.Controls.Add(t.View);

        t.Chip.Height = 30; t.Chip.AutoSize = false; t.Chip.Width = 126; t.Chip.FlatStyle = FlatStyle.Flat;
        t.Chip.ForeColor = _pal.Text; t.Chip.BackColor = Color.Transparent;
        t.Chip.FlatAppearance.BorderSize = 0;
        t.Chip.FlatAppearance.MouseOverBackColor = _pal.Hover;
        t.Chip.Font = new Font("Segoe UI", 8.5f); t.Chip.Margin = new Padding(3, 7, 0, 0); t.Chip.Text = "\u25CE New tab";
        t.Chip.TextAlign = ContentAlignment.MiddleLeft;
        t.Chip.FlatAppearance.BorderColor = Color.FromArgb(60, 60, 60);
        t.Chip.Click += (_, __) => Activate(_tabs.IndexOf(t));
        // middle-click / right-click closes
        t.Chip.MouseUp += (_, me) => { if (me.Button != MouseButtons.Left) CloseTab(_tabs.IndexOf(t)); };
        _tabStrip.Controls.Add(t.Chip);
        if (!_tabStrip.Controls.Contains(_addTabBtn)) _tabStrip.Controls.Add(_addTabBtn);
        _tabStrip.Controls.SetChildIndex(_addTabBtn, _tabStrip.Controls.Count - 1); // keep "+" last
        LayoutTabs();

        try { t.View.DefaultBackgroundColor = _pal.PaneBg; } catch { } // no black flash before load
        _tabs.Add(t);
        await t.View.EnsureCoreWebView2Async(_env);
        try { t.View.CoreWebView2.Profile.PreferredColorScheme =
            (_pal.PaneBg.R < 128) ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light; } catch { }
        WireView(t);
        if (navigate) t.View.CoreWebView2.Navigate(url);
        if (activate) Activate(_tabs.IndexOf(t));
    }

    void WireView(TabItem t)
    {
        var c = t.View.CoreWebView2;
        t.View.Enter += (_, __) => { if (_menu.Visible) _menu.Close(); };
        t.View.GotFocus += (_, __) => { if (_menu.Visible) _menu.Close(); };
        t.View.MouseDown += (_, __) => { if (_menu.Visible) _menu.Close(); };
        c.SourceChanged += (_, __) => { t.Url = c.Source; if (t == Active()) _addr.Text = t.Url; t.Chip.Text = TabLabel(t); LayoutTabs(); SyncTabs(); };
        c.DocumentTitleChanged += (_, __) =>
        {
            t.Title = string.IsNullOrWhiteSpace(c.DocumentTitle) ? t.Url : c.DocumentTitle;
            t.Chip.Text = TabLabel(t);
            LayoutTabs();
        };
        c.NewWindowRequested += (_, ev) =>
        {
            ev.Handled = true;
            AddTab(ev.Uri, activate: true, navigate: true);
        };
        c.ContextMenuRequested += (_, ev) =>
        {
            var text = ev.ContextMenuTarget.SelectionText?.Trim();
            if (string.IsNullOrWhiteSpace(text)) return;
            var sendMessage = _env.CreateContextMenuItem("Send selection to message", null, CoreWebView2ContextMenuItemKind.Command);
            var sendNote = _env.CreateContextMenuItem("Send selection to notepad", null, CoreWebView2ContextMenuItemKind.Command);
            var separator = _env.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator);
            sendMessage.CustomItemSelected += (_, __) => SendBrowserSelection(t, text, "message");
            sendNote.CustomItemSelected += (_, __) => SendBrowserSelection(t, text, "note");
            ev.MenuItems.Insert(0, separator);
            ev.MenuItems.Insert(0, sendNote);
            ev.MenuItems.Insert(0, sendMessage);
        };
        t.View.ZoomFactorChanged += (_, __) => { if (t == Active()) UpdateZoomLabel(); }; // Ctrl+scroll etc.
        c.DownloadStarting += (_, ev) =>
        {
            if (!_permDownloads) ev.Cancel = true; // downloads disabled in Settings
        };
        c.PermissionRequested += (_, ev) =>
        {
            bool allow = ev.PermissionKind switch
            {
                CoreWebView2PermissionKind.Camera => _permCamera,
                CoreWebView2PermissionKind.Microphone => _permMic,
                CoreWebView2PermissionKind.Geolocation => _permGeo,
                _ => false
            };
            ev.State = allow ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        };
    }

    void Activate(int i)
    {
        if (i < 0 || i >= _tabs.Count) return;
        _active = i;
        for (int k = 0; k < _tabs.Count; k++)
        {
            _tabs[k].View.Visible = (k == i);
            _tabs[k].Chip.BackColor = (k == i) ? _pal.Hover : Color.Transparent;
        }
        _addr.Text = _tabs[i].Url;
        LayoutTabs();
        UpdateZoomLabel();
    }

    void CloseTab(int i)
    {
        if (i < 0 || i >= _tabs.Count) return;
        var t = _tabs[i];
        _tabStrip.Controls.Remove(t.Chip);
        _content.Controls.Remove(t.View);
        try { t.View.Dispose(); } catch { }
        _tabs.RemoveAt(i);
        if (_tabs.Count == 0) { AddTab(_homeUrl, true, true); return; }
        LayoutTabs();
        Activate(Math.Min(i, _tabs.Count - 1));
    }

    void CloseOtherTabs()
    {
        var keep = Active();
        if (keep == null) return;
        foreach (var t in _tabs.ToArray())
        {
            if (ReferenceEquals(t, keep)) continue;
            _tabStrip.Controls.Remove(t.Chip);
            _content.Controls.Remove(t.View);
            try { t.View.Dispose(); } catch { }
            _tabs.Remove(t);
        }
        if (!_tabStrip.Controls.Contains(_addTabBtn)) _tabStrip.Controls.Add(_addTabBtn);
        _tabStrip.Controls.SetChildIndex(_addTabBtn, _tabStrip.Controls.Count - 1);
        _active = 0;
        LayoutTabs();
        Activate(0);
    }

    void SyncTabs() { /* placeholder for future per-tab state push to chat UI */ }

    // ── zoom + full-width viewing ────────────────────────────────────
    void Zoom(double delta)
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        t.View.ZoomFactor = Math.Clamp(t.View.ZoomFactor + delta, 0.3, 3.0);
        UpdateZoomLabel();
    }
    ToolStripControlHost MakeZoomRow()
    {
        var row = new TableLayoutPanel
        {
            Width = 206,
            Height = 30,
            ColumnCount = 5,
            RowCount = 1,
            Margin = new Padding(0),
            Padding = new Padding(7, 0, 3, 0),
            BackColor = Color.Transparent
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 24));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 48));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 24));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 1));
        row.Controls.Add(new Label { Text = "Zoom", AutoSize = true, Anchor = AnchorStyles.Left, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
        Button Flat(string text, EventHandler onClick)
        {
            var b = new Button { Text = text, Width = 20, Height = 20, FlatStyle = FlatStyle.Flat, BackColor = Color.Transparent, TabStop = false, Margin = new Padding(0), Font = new Font("Segoe UI", 9f) };
            b.FlatAppearance.BorderSize = 0;
            b.Click += onClick;
            return b;
        }
        row.Controls.Add(Flat("-", (_, __) => Zoom(-0.1)), 1, 0);
        row.Controls.Add(new Label { Text = "100%", AutoSize = false, Width = 48, TextAlign = ContentAlignment.MiddleCenter, Anchor = AnchorStyles.None, Tag = "zoomLabel" }, 2, 0);
        row.Controls.Add(Flat("+", (_, __) => Zoom(0.1)), 3, 0);
        return new ToolStripControlHost(row) { AutoSize = false, Width = 206, Height = 30, Margin = new Padding(0), Padding = new Padding(0) };
    }
    void ResetZoom()
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        t.View.ZoomFactor = 1.0;
        UpdateZoomLabel();
    }
    async Task AutoFitZoom()
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        try
        {
            var json = await t.View.CoreWebView2.ExecuteScriptAsync(
                "(function(){var de=document.documentElement,b=document.body||de;" +
                "return Math.max(de.scrollWidth,b.scrollWidth,de.offsetWidth,b.offsetWidth,1);})()");
            var pageWidth = JsonSerializer.Deserialize<double>(json);
            var viewWidth = Math.Max(1, t.View.ClientSize.Width);
            var zoom = Math.Clamp(Math.Floor((viewWidth / Math.Max(1, pageWidth)) * 100) / 100, 0.3, 1.5);
            t.View.ZoomFactor = zoom;
            UpdateZoomLabel();
        }
        catch { }
    }
    void UpdateZoomLabel()
    {
        var t = Active();
        int pct = t?.View.CoreWebView2 != null ? (int)Math.Round(t.View.ZoomFactor * 100) : 100;
        if (_menu == null) return;
        foreach (ToolStripItem item in _menu.Items)
            if (item is ToolStripControlHost host && host.Control is TableLayoutPanel row)
                foreach (Control c in row.Controls)
                    if ((string?)c.Tag == "zoomLabel") c.Text = $"{pct}%";
    }
    void ToggleFull()
    {
        if (!_browserOpen) ToggleBrowser(true);
        _full = !_full;
        _split.Panel1Collapsed = _full; // hide the chat pane → browser full width
    }

    void Navigate(string input)
    {
        var url = Normalize(input);
        if (string.IsNullOrEmpty(url)) return;
        var t = Active();
        if (t == null) { AddTab(url, true, true); return; }
        t.View.CoreWebView2?.Navigate(url);
    }

    static string Normalize(string v)
    {
        v = (v ?? "").Trim();
        if (v.Length == 0) return "";
        if (v.StartsWith("http://") || v.StartsWith("https://")) return v;
        // localhost / ip:port stays http
        if (System.Text.RegularExpressions.Regex.IsMatch(v, @"^(localhost|127\.|\d{1,3}\.\d{1,3}\.)") ||
            System.Text.RegularExpressions.Regex.IsMatch(v, @"^[\w.-]+:\d{2,5}(/|$)")) return "http://" + v;
        // a bare domain vs a search query
        if (!v.Contains(' ') && v.Contains('.')) return "https://" + v;
        return "https://www.google.com/search?q=" + Uri.EscapeDataString(v);
    }

    static string Trunc(string s, int n) => s.Length <= n ? s : s.Substring(0, n) + "...";

    // ── show / hide the browser pane (driven by the chat UI toggle) ──
    bool _browserOpen = false;
    void FitBrowserSplit()
    {
        if (_split.Width <= 0) return;
        const int chatMin = 320;
        const int browserMin = 260;
        int panelWidth = Math.Max(0, _split.Width - _split.SplitterWidth);
        if (panelWidth <= chatMin + browserMin)
        {
            int compactMin = Math.Max(20, Math.Min(120, panelWidth / 3));
            _split.Panel1MinSize = compactMin;
            _split.Panel2MinSize = compactMin;
            int compactDistance = Math.Max(compactMin, panelWidth / 2);
            compactDistance = Math.Min(compactDistance, Math.Max(compactMin, _split.Width - compactMin));
            _split.SplitterDistance = compactDistance;
            return;
        }

        _split.Panel1MinSize = chatMin;
        _split.Panel2MinSize = browserMin;
        int available = panelWidth;
        const int preferredChatW = 760; // enough for sidebar + chat + notepad without clipping the composer/topbar
        int chatW = Math.Min(preferredChatW, available - browserMin);
        chatW = Math.Max(chatMin, chatW);
        _split.SplitterDistance = Math.Min(chatW, _split.Width - browserMin);
    }

    // When the browser opens in a small window, grow it so the chat side keeps room
    // instead of being squeezed (chat holds a ~185px sidebar + the conversation).
    void GrowForBrowser()
    {
        if (WindowState == FormWindowState.Maximized) return;
        var wa = Screen.FromHandle(Handle).WorkingArea;
        const int desiredMin = 1240; // sidebar + chat + notepad + a usable browser pane
        int target = Math.Min(wa.Width, Math.Max(Width, desiredMin));
        if (target <= Width) return;
        int newLeft = Left;
        if (newLeft + target > wa.Right) newLeft = Math.Max(wa.Left, wa.Right - target);
        Left = newLeft;
        Width = target;
    }

    void ToggleBrowser(bool? force = null)
    {
        _browserOpen = force ?? !_browserOpen;
        if (_browserOpen)
        {
            if (_split.Panel1Collapsed) { _split.Panel1Collapsed = false; _full = false; }
            _split.Panel2Collapsed = false;
            BeginInvoke(new Action(FitBrowserSplit)); // fit after the layout settles
        }
        else _split.Panel2Collapsed = true;
        PostToChat(new { type = "shellBrowser", open = _browserOpen });
    }

    // ── bridge: messages from the chat UI ────────────────────────────
    void OnChatMessage(object? s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var tp) ? tp.GetString() : null;
            if (type == "window") { HandleWindowCommand(root); return; }
            if (type == "clipboard")
            {
                var id = root.TryGetProperty("id", out var idp) ? idp.GetString() : null;
                try
                {
                    var text = Clipboard.ContainsText(TextDataFormat.UnicodeText)
                        ? Clipboard.GetText(TextDataFormat.UnicodeText)
                        : "";
                    PostToChat(new { type = "clipboard", id, ok = true, text });
                }
                catch (Exception ex)
                {
                    PostToChat(new { type = "clipboard", id, ok = false, error = ex.Message });
                }
                return;
            }
            if (type != "browser") return;
            var cmd = root.TryGetProperty("cmd", out var cp) ? cp.GetString() : null;
            switch (cmd)
            {
                case "toggle": ToggleBrowser(); break;
                case "show": ToggleBrowser(true); break;
                case "hide": ToggleBrowser(false); break;
                case "navigate":
                    if (root.TryGetProperty("url", out var up) && up.GetString() is { } u)
                    {
                        if (!_browserOpen) ToggleBrowser(true);
                        // AI-opened pages get their own tab
                        AddTab(u, activate: true, navigate: true);
                    }
                    break;
                case "control":
                    if (root.TryGetProperty("id", out var idp) && idp.GetString() is { } id &&
                        root.TryGetProperty("command", out var command))
                    {
                        _ = ExecuteBrowserControlAsync(id, command);
                    }
                    break;
                case "context":
                    if (root.TryGetProperty("id", out var cidp) && cidp.GetString() is { } cid)
                    {
                        _ = SendContextAsync(cid);
                    }
                    break;
                case "reloadPerms": ReadPerms(); break;
                case "snip":
                    var target = root.TryGetProperty("target", out var sp) ? sp.GetString() ?? "message" : "message";
                    _ = StartScreenSnipAsync(target);
                    break;
                case "theme":
                    var pal = root.TryGetProperty("dark", out var dk)
                        ? (dk.GetBoolean() ? Palette.Dark : Palette.Light)
                        : ResolveTheme();
                    ApplyTheme(pal);
                    break;
            }
        }
        catch { }
    }

    void PostToChat(object o)
    {
        try { _chat.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(o)); } catch { }
    }

    async Task StartScreenSnipAsync(string target)
    {
        uint startSeq = GetClipboardSequenceNumber();
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", "ms-screenclip:") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            PostToChat(new { type = "snip", ok = false, target, error = ex.Message });
            return;
        }

        for (int i = 0; i < 300; i++)
        {
            await Task.Delay(200);
            if (GetClipboardSequenceNumber() == startSeq) continue;
            try
            {
                if (!Clipboard.ContainsImage()) continue;
                using var img = Clipboard.GetImage();
                if (img == null) continue;
                using var bmp = new Bitmap(img);
                using var ms = new MemoryStream();
                bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                var b64 = Convert.ToBase64String(ms.ToArray());
                PostToChat(new { type = "snip", ok = true, target, dataURL = "data:image/png;base64," + b64 });
                return;
            }
            catch { }
        }

        PostToChat(new { type = "snip", ok = false, target, error = "screen snip was cancelled or timed out" });
    }

    async Task SendContextAsync(string id)
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null || !_browserOpen)
        {
            PostToChat(new { type = "context", id, browser = new { open = _browserOpen, url = "", title = "", text = "" } });
            return;
        }
        try
        {
            var json = await t.View.CoreWebView2.ExecuteScriptAsync(
                "(function(){return {url:location.href,title:document.title,text:(document.body?document.body.innerText:'')}})()");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var ocr = await ReadVisibleBrowserOcrAsync(t);
            PostToChat(new
            {
                type = "context",
                id,
                browser = new
                {
                    open = _browserOpen,
                    url = root.TryGetProperty("url", out var u) ? u.GetString() ?? t.Url : t.Url,
                    title = root.TryGetProperty("title", out var ti) ? ti.GetString() ?? t.Title : t.Title,
                    text = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "",
                    ocr
                }
            });
        }
        catch (Exception ex)
        {
            PostToChat(new { type = "context", id, browser = new { open = _browserOpen, url = t.Url, title = t.Title, text = "", error = ex.Message } });
        }
    }

    // ── send current page (text or screenshot) to the chat as an attachment ──
    async Task<string> ReadActivePageAsync(TabItem t)
    {
        var json = await t.View.CoreWebView2.ExecuteScriptAsync(
            "(function(){return {url:location.href,title:document.title,text:(document.body?document.body.innerText:'')}})()");
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var url = root.TryGetProperty("url", out var u) ? u.GetString() ?? t.Url : t.Url;
        var title = root.TryGetProperty("title", out var ti) ? ti.GetString() ?? t.Title : t.Title;
        var text = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
        var ocr = await ReadVisibleBrowserOcrAsync(t);
        var parts = new List<string> { "URL: " + url, "TITLE: " + title };
        if (!string.IsNullOrWhiteSpace(text)) parts.Add("PAGE TEXT:\n" + Trunc(text, 160000));
        if (!string.IsNullOrWhiteSpace(ocr)) parts.Add("SCREEN OCR (from visible browser pixels; use this for tables, dashboards, images, and canvas-rendered text):\n" + Trunc(ocr, 80000));
        if (parts.Count == 2) parts.Add("(no readable page text or OCR was found)");
        return string.Join("\n\n", parts);
    }

    async Task<byte[]?> CaptureBrowserPngAsync(TabItem t)
    {
        try
        {
            using var ms = new MemoryStream();
            await t.View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
            return ms.ToArray();
        }
        catch { return null; }
    }

    async Task<string> OcrPngAsync(byte[] png)
    {
        try
        {
            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null) return "";
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(png.AsBuffer());
            stream.Seek(0);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var result = await engine.RecognizeAsync(bitmap);
            return string.Join("\n", result.Lines.Select(l => l.Text)).Trim();
        }
        catch { return ""; }
    }

    async Task<string> ReadVisibleBrowserOcrAsync(TabItem t)
    {
        var png = await CaptureBrowserPngAsync(t);
        return png == null ? "" : await OcrPngAsync(png);
    }

    async Task WaitForNavOrDelayAsync(TabItem t, int ms = 900)
    {
        var done = new TaskCompletionSource();
        void Handler(object? s, CoreWebView2NavigationCompletedEventArgs e) => done.TrySetResult();
        try
        {
            t.View.CoreWebView2.NavigationCompleted += Handler;
            await Task.WhenAny(done.Task, Task.Delay(ms));
        }
        finally { try { t.View.CoreWebView2.NavigationCompleted -= Handler; } catch { } }
    }

    async Task ExecuteBrowserControlAsync(string id, JsonElement command)
    {
        if (!_browserOpen) ToggleBrowser(true);
        var t = Active();
        if (t?.View.CoreWebView2 == null)
        {
            PostToChat(new { type = "browserControlResult", id, ok = false, error = "no visible browser tab" });
            return;
        }
        try
        {
            var action = command.TryGetProperty("action", out var ap) ? ap.GetString() ?? "" : "";
            if (action == "open")
            {
                var input = command.TryGetProperty("url", out var up) ? up.GetString() ?? "" : "";
                Navigate(input);
                await WaitForNavOrDelayAsync(t, 2500);
                string openResult;
                try { openResult = await ReadActivePageAsync(t); }
                catch (Exception ex) { openResult = "opened visible browser to " + t.Url + "\n\nPage text is not readable yet: " + ex.Message; }
                PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, result = openResult });
                return;
            }
            if (action == "read")
            {
                PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, result = await ReadActivePageAsync(t) });
                return;
            }

            var text = command.TryGetProperty("text", out var xp) ? xp.GetString() ?? "" : "";
            var target = command.TryGetProperty("target", out var tp) ? tp.GetString() ?? "" : "";
            var value = command.TryGetProperty("value", out var vp) ? vp.GetString() ?? "" :
                command.TryGetProperty("text", out var tvp) ? tvp.GetString() ?? "" : "";
            var enter = command.TryGetProperty("enter", out var ep) && ep.ValueKind == JsonValueKind.True;
            var q = JsonSerializer.Serialize(action == "type" && !string.IsNullOrWhiteSpace(target) ? target : text);
            var v = JsonSerializer.Serialize(value);
            string script;
            if (action == "email_draft")
            {
                var draft = JsonSerializer.Serialize(value);
                script = "(async function(){var draft=" + draft + ";" +
                    "function delay(ms){return new Promise(function(r){setTimeout(r,ms)})}" +
                    "function roots(){var out=[document];function walk(r){try{[].slice.call(r.querySelectorAll('*')).forEach(function(e){if(e.shadowRoot){out.push(e.shadowRoot);walk(e.shadowRoot)}})}catch(_){}}walk(document);return out}" +
                    "function all(sel){var a=[];roots().forEach(function(r){try{a=a.concat([].slice.call(r.querySelectorAll(sel)))}catch(_){}});return a}" +
                    "function shown(e){if(!e||!e.getBoundingClientRect)return false;var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}" +
                    "function label(e){return [e.innerText,e.textContent,e.value,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('placeholder'),e.name,e.id,e.getAttribute('data-icon-name')].filter(Boolean).join(' ').replace(/\\s+/g,' ').toLowerCase()}" +
                    "function clickable(e){return e&&e.closest&&(e.closest('button,a,[role=button],[tabindex]')||e)}" +
                    "function findReply(){var allc=all('button,a,[role=button],[aria-label],[title],[data-icon-name]');var hits=allc.filter(function(e){var l=label(e);return shown(e)&&(/(^|\\s)reply(\\s|$| to| sender)/.test(l)||l==='reply'||l.indexOf('reply')===0||l.indexOf('respond')>=0||l.indexOf('mailreply')>=0)});hits=hits.filter(function(e){var l=label(e);return l.indexOf('reply all')<0&&l.indexOf('forward')<0});hits.sort(function(a,b){var la=label(a),lb=label(b),ea=(la==='reply'||la.indexOf('reply ')===0)?0:1,eb=(lb==='reply'||lb.indexOf('reply ')===0)?0:1;if(ea!==eb)return ea-eb;return b.getBoundingClientRect().top-a.getBoundingClientRect().top});return clickable(hits[0])}" +
                    "function findEditor(){var sels=['[role=textbox][contenteditable=true]','[contenteditable=true][aria-label*=\\\"Message\\\" i]','[contenteditable=true][aria-label*=\\\"body\\\" i]','[aria-label*=\\\"Message body\\\" i]','[aria-label*=\\\"Type a message\\\" i]','.elementToProof','div[contenteditable=true]','textarea'];for(var i=0;i<sels.length;i++){var hit=all(sels[i]).filter(shown).sort(function(a,b){return b.getBoundingClientRect().height-a.getBoundingClientRect().height})[0];if(hit)return hit}" +
                    "var active=document.activeElement;if(active&&shown(active)&&(active.isContentEditable||/^(TEXTAREA)$/i.test(active.tagName)))return active;return null}" +
                    "function mouseClick(e){var r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window}))})}" +
                    "async function openReply(){var r=findReply();if(!r)return false;r.scrollIntoView({block:'center',inline:'center'});await delay(120);r.focus();mouseClick(r);await delay(1700);return true}" +
                    "var editor=findEditor();if(!editor){await openReply();editor=findEditor()}if(!editor){await delay(900);editor=findEditor()}" +
                    "if(!editor)throw new Error('could not find a visible email reply editor');editor.scrollIntoView({block:'center',inline:'center'});editor.focus();" +
                    "if('value' in editor){editor.value=draft;editor.dispatchEvent(new Event('input',{bubbles:true}));editor.dispatchEvent(new Event('change',{bubbles:true}))}" +
                    "else{try{editor.innerHTML=''}catch(_){};if(document.execCommand){document.execCommand('insertText',false,draft)}else{editor.textContent=draft}editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:draft}));editor.dispatchEvent(new Event('change',{bubbles:true}))}" +
                    "return 'inserted '+draft.length+' chars into email draft (not sent)';})()";
            }
            else if (action == "click")
            {
                script = "(function(){var q=" + q + ".toLowerCase().trim();" +
                    "function shown(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}" +
                    "function label(e){return [e.innerText,e.value,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('placeholder'),e.name,e.id].filter(Boolean).join(' ').toLowerCase()}" +
                    "function find(sel){if(/^[.#\\[]/.test(sel)){try{var e=document.querySelector(sel);if(e&&shown(e))return e}catch(_){}}" +
                    "var all=[].slice.call(document.querySelectorAll('button,a,input,textarea,select,[role=button],[onclick],[tabindex]'));return all.find(function(e){return shown(e)&&label(e).indexOf(sel)>=0})}" +
                    "var el=find(q);if(!el)throw new Error('no visible element matching: '+q);el.scrollIntoView({block:'center',inline:'center'});el.click();return 'clicked '+q;})()";
            }
            else if (action == "type")
            {
                script = "(function(){var q=" + q + ".toLowerCase().trim(),val=" + v + ";" +
                    "function shown(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}" +
                    "function label(e){return [e.innerText,e.value,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('placeholder'),e.name,e.id].filter(Boolean).join(' ').toLowerCase()}" +
                    "function find(sel){if(!sel)return null;if(/^[.#\\[]/.test(sel)){try{var e=document.querySelector(sel);if(e&&shown(e))return e}catch(_){}}" +
                    "var all=[].slice.call(document.querySelectorAll('input,textarea,[contenteditable=true],select'));return all.find(function(e){return shown(e)&&label(e).indexOf(sel)>=0})}" +
                    "var el=find(q)||document.activeElement;if(!el)throw new Error('no matching or active input');el.focus();" +
                    "if('value' in el){el.value=val;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}else{document.execCommand('insertText',false,val)}" +
                    (enter ? "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));" : "") +
                    "return 'typed '+val.length+' chars';})()";
            }
            else
            {
                PostToChat(new { type = "browserControlResult", id, ok = false, error = "unknown visible browser action: " + action });
                return;
            }
            var resultJson = await t.View.CoreWebView2.ExecuteScriptAsync(script);
            var result = JsonSerializer.Deserialize<string>(resultJson) ?? action;
            await WaitForNavOrDelayAsync(t, 900);
            PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, result = result + "\n\nAfter " + action + ":\n" + await ReadActivePageAsync(t) });
        }
        catch (Exception ex)
        {
            PostToChat(new { type = "browserControlResult", id, ok = false, url = Active()?.Url ?? "", error = ex.Message });
        }
    }

    async Task SendPageToAI(bool screenshot)
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        try
        {
            if (screenshot)
            {
                using var ms = new MemoryStream();
                await t.View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                var b64 = Convert.ToBase64String(ms.ToArray());
                PostToChat(new { type = "attach", kind = "image", name = "screenshot.png", dataURL = "data:image/png;base64," + b64 });
            }
            else
            {
                var json = await t.View.CoreWebView2.ExecuteScriptAsync("document.body ? document.body.innerText : ''");
                var text = JsonSerializer.Deserialize<string>(json) ?? "";
                PostToChat(new { type = "attach", kind = "file", name = "page " + Trunc(t.Title, 40) + ".txt",
                    text = "Content of " + t.Url + ":\n\n" + text });
            }
        }
        catch { }
    }

    void SendBrowserSelection(TabItem tab, string text, string target)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        PostToChat(new { type = "browserSelection", target, text, url = tab.Url, title = tab.Title });
    }

    async Task SendSelectedText(string target)
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        try
        {
            var json = await t.View.CoreWebView2.ExecuteScriptAsync("String(window.getSelection ? window.getSelection() : '')");
            var text = JsonSerializer.Deserialize<string>(json) ?? "";
            if (string.IsNullOrWhiteSpace(text)) return;
            SendBrowserSelection(t, text, target);
        }
        catch { }
    }

    async Task SendScreenshotToNotepad()
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        try
        {
            using var ms = new MemoryStream();
            await t.View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
            var b64 = Convert.ToBase64String(ms.ToArray());
            PostToChat(new { type = "snip", target = "note", dataURL = "data:image/png;base64," + b64 });
        }
        catch { }
    }

    async Task ClearBrowserData()
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        try { await t.View.CoreWebView2.Profile.ClearBrowsingDataAsync(); }
        catch { }
    }

    void OpenActiveInSystemBrowser()
    {
        var url = Active()?.Url;
        if (string.IsNullOrWhiteSpace(url)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { }
    }

    sealed class BrowserMenuRenderer : ToolStripProfessionalRenderer
    {
        readonly Func<Palette> _palette;

        public BrowserMenuRenderer(Func<Palette> palette) => _palette = palette;

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var p = _palette();
            var rect = new Rectangle(Point.Empty, e.Item.Size);
            using var brush = new SolidBrush(e.Item.Selected ? p.Hover : p.BarBg);
            e.Graphics.FillRectangle(brush, rect);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            var p = _palette();
            var y = e.Item.Height / 2;
            using var pen = new Pen(p.BtnBorder);
            e.Graphics.DrawLine(pen, 8, y, e.Item.Width - 8, y);
        }
    }
}
