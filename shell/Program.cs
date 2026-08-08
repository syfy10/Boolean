// Boollm native shell: a WinForms window we own (so the taskbar shows OUR icon),
// hosting the existing web UI in a WebView2 on the left and a REAL Chromium
// browser (native WebView2, full internet — Outlook/Gmail included) on the
// right. The Node backend runs as a child ("core") process; the window just
// points a WebView2 at http://127.0.0.1:<port>.
using System.Diagnostics;
using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Linq;
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

sealed class RoundedPanel : Panel
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public int Radius { get; set; } = 12;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color BorderColor { get; set; } = Color.Transparent;

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var bg = new SolidBrush(Parent?.BackColor ?? SystemColors.Control))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        using var path = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Radius);
        using var brush = new SolidBrush(BackColor);
        e.Graphics.FillPath(brush, path);
        if (BorderColor.A > 0)
        {
            using var pen = new Pen(BorderColor);
            e.Graphics.DrawPath(pen, path);
        }
    }

    protected override void OnResize(EventArgs eventargs)
    {
        base.OnResize(eventargs);
        if (Width > 1 && Height > 1)
        {
            using var path = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Radius);
            var oldRegion = Region;
            Region = new Region(path);
            oldRegion?.Dispose();
        }
        Invalidate();
    }

    internal static GraphicsPath RoundedRect(Rectangle r, int radius)
    {
        var d = Math.Max(2, radius * 2);
        var p = new GraphicsPath();
        p.AddArc(r.Left, r.Top, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

sealed class RoundedButton : Button
{
    bool _hover;
    bool _down;

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public int Radius { get; set; } = 12;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color Fill { get; set; } = Color.Transparent;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color HoverFill { get; set; } = Color.FromArgb(242, 242, 242);
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color DownFill { get; set; } = Color.FromArgb(232, 232, 232);
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Color Border { get; set; } = Color.Transparent;

    public RoundedButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        TabStop = false;
        UseVisualStyleBackColor = false;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var fill = _down ? DownFill : (_hover ? HoverFill : Fill);
        using (var bg = new SolidBrush(Parent?.BackColor ?? SystemColors.Control))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        if (fill.A == 0)
        {
            TextRenderer.DrawText(e.Graphics, Text, Font, TextBounds(), ForeColor, TextFlags());
            return;
        }
        using var path = RoundedPanel.RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Radius);
        using var brush = new SolidBrush(fill);
        e.Graphics.FillPath(brush, path);
        if (Border.A > 0)
        {
            using var pen = new Pen(Border);
            e.Graphics.DrawPath(pen, path);
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, TextBounds(), ForeColor, TextFlags());
    }

    Rectangle TextBounds() => new(Padding.Left, Padding.Top,
        Math.Max(1, Width - Padding.Horizontal), Math.Max(1, Height - Padding.Vertical));

    TextFormatFlags TextFlags()
    {
        var flags = TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis;
        return flags | (TextAlign == ContentAlignment.MiddleLeft ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter);
    }
}

sealed class TabItem
{
    public int Id;
    public WebView2 View = new();
    public string Url = "";
    public string Title = "New tab";
    public string DarkModeScriptId = "";
}

enum BoollmPetDisplayState { Idle, Browsing, Coding }

sealed class BoollmPetForm : Form
{
    readonly System.Windows.Forms.Timer _animation = new() { Interval = 100 };
    readonly Stopwatch _clock = Stopwatch.StartNew();
    readonly Action _hideRequested;
    readonly Action<string> _replyRequested;
    readonly Action _stopRequested;
    readonly TextBox _replyInput = new();
    readonly Button _replyButton = new();
    readonly Button _stopButton = new();
    readonly ToolTip _shortcutTips = new();
    Point? _dragOrigin;
    Point _windowOrigin;
    BoollmPetDisplayState _displayState = BoollmPetDisplayState.Idle;
    string _chatName = "New chat";
    string _title = "Boollm is ready";
    string _detail = "";
    bool _active;
    bool _completed;
    bool _hoverReply;
    bool _reduceMotion;
    bool _darkMode;

    string LayoutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "saz3", "pet-layout.json");

    sealed class PetLayout
    {
        public int X { get; set; }
        public int Y { get; set; }
    }

    public BoollmPetForm(Action hideRequested, Action<string> replyRequested, Action stopRequested)
    {
        _hideRequested = hideRequested;
        _replyRequested = replyRequested;
        _stopRequested = stopRequested;
        Text = "Boollm Pet";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(390, 208);
        MinimumSize = MaximumSize = ClientSize;
        // A near-black transparency key prevents the magenta fringe produced
        // when anti-aliased pet edges were blended against Fuchsia.
        BackColor = Color.FromArgb(1, 2, 3);
        TransparencyKey = BackColor;
        Opacity = 0.96;
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Hide Boollm Pet", null, (_, __) => _hideRequested());
        ContextMenuStrip = menu;

        ConfigureReplyControls();

        _animation.Tick += (_, __) =>
        {
            var cursor = PointToClient(Cursor.Position);
            var hoverReply = _active && !_completed && new Rectangle(12, 10, Width - 24, 104).Contains(cursor);
            if (_hoverReply != hoverReply)
            {
                _hoverReply = hoverReply;
                SyncReplyControls();
            }
            Invalidate();
        };
        _animation.Start();
        MouseDown += BeginDrag;
        MouseMove += ContinueDrag;
        MouseUp += EndDrag;
        FormClosing += (_, __) => SaveLayout();
        RestoreLayout();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TOOLWINDOW = 0x00000080;
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    void ConfigureReplyControls()
    {
        _replyInput.BorderStyle = BorderStyle.None;
        _replyInput.Font = new Font("Segoe UI Variable Text", 9.5f);
        _replyInput.PlaceholderText = "Follow up";
        _replyInput.KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.Enter || e.Shift) return;
            e.SuppressKeyPress = true;
            SendReply();
        };

        ConfigureReplyButton(_replyButton, "↩", "Reply to this chat");
        ConfigureReplyButton(_stopButton, "■", "Stop Boollm");
        _replyButton.Click += (_, __) => SendReply();
        _stopButton.Click += (_, __) => _stopRequested();
        Controls.AddRange(new Control[] { _replyInput, _replyButton, _stopButton });
        ApplyReplyTheme();
        SyncReplyControls();
    }

    void ConfigureReplyButton(Button button, string text, string accessibleName)
    {
        button.Text = text;
        button.AccessibleName = accessibleName;
        button.Font = new Font("Segoe UI Symbol", text == "■" ? 9f : 13f, FontStyle.Bold);
        button.FlatStyle = FlatStyle.Flat;
        button.UseVisualStyleBackColor = false;
        button.FlatAppearance.BorderSize = 0;
        button.TabStop = true;
        _shortcutTips.SetToolTip(button, accessibleName);
    }

    void ApplyReplyTheme()
    {
        var input = _darkMode ? Color.FromArgb(30, 31, 31) : Color.FromArgb(246, 247, 245);
        var button = _darkMode ? Color.FromArgb(56, 57, 57) : Color.FromArgb(228, 229, 227);
        var foreground = _darkMode ? Color.FromArgb(222, 223, 221) : Color.FromArgb(104, 106, 105);
        _replyInput.BackColor = input;
        _replyInput.ForeColor = _darkMode ? Color.FromArgb(238, 239, 237) : Color.FromArgb(31, 32, 33);
        foreach (var shortcut in new[] { _replyButton, _stopButton })
        {
            shortcut.BackColor = button;
            shortcut.ForeColor = foreground;
            shortcut.FlatAppearance.MouseOverBackColor = _darkMode ? Color.FromArgb(72, 73, 73) : Color.FromArgb(211, 212, 210);
            shortcut.FlatAppearance.MouseDownBackColor = _darkMode ? Color.FromArgb(82, 83, 83) : Color.FromArgb(199, 201, 198);
        }
    }

    static void SetCircularButtonBounds(Button button, int x, int y, int size)
    {
        button.SetBounds(x, y, size, size);
        using var circle = new GraphicsPath();
        circle.AddEllipse(0, 0, size - 1, size - 1);
        button.Region?.Dispose();
        button.Region = new Region(circle);
    }

    void SyncReplyControls()
    {
        var visible = _hoverReply && _active && !_completed;
        _replyInput.Visible = visible;
        _replyButton.Visible = visible;
        _stopButton.Visible = visible;
        if (!visible) return;
        _replyInput.SetBounds(34, 72, 320, 22);
        SetCircularButtonBounds(_replyButton, 302, 20, 32);
        SetCircularButtonBounds(_stopButton, 340, 20, 32);
    }

    void SendReply()
    {
        var text = _replyInput.Text.Trim();
        if (text.Length == 0) return;
        _replyInput.Clear();
        _replyRequested(text);
    }

    public void Sync(BoollmPetDisplayState displayState, string chatName, string title, string detail, bool active, bool completed, bool reduceMotion, bool darkMode)
    {
        _displayState = displayState;
        _chatName = Trim(chatName, 50, "New chat");
        _title = Trim(title, 72, "Working on your project");
        _detail = Trim(detail, 120, "");
        _active = active;
        _completed = completed;
        _reduceMotion = reduceMotion;
        _darkMode = darkMode;
        if (!_active || _completed) _hoverReply = false;
        ApplyReplyTheme();
        SyncReplyControls();
        Invalidate();
    }

    static string Trim(string? value, int max, string fallback)
    {
        var text = string.Join(" ", (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (text.Length > max) text = text[..Math.Max(1, max - 1)] + "…";
        return string.IsNullOrWhiteSpace(text) ? fallback : text;
    }

    void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _dragOrigin = Cursor.Position;
        _windowOrigin = Location;
    }

    void ContinueDrag(object? sender, MouseEventArgs e)
    {
        if (_dragOrigin is not { } origin || e.Button != MouseButtons.Left) return;
        var now = Cursor.Position;
        Location = new Point(_windowOrigin.X + now.X - origin.X, _windowOrigin.Y + now.Y - origin.Y);
    }

    void EndDrag(object? sender, MouseEventArgs e)
    {
        if (_dragOrigin is null) return;
        _dragOrigin = null;
        KeepOnScreen();
        SaveLayout();
    }

    void RestoreLayout()
    {
        try
        {
            if (File.Exists(LayoutPath))
            {
                var saved = JsonSerializer.Deserialize<PetLayout>(File.ReadAllText(LayoutPath));
                if (saved is not null)
                {
                    Location = new Point(saved.X, saved.Y);
                    KeepOnScreen();
                    return;
                }
            }
        }
        catch { }
        var work = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Location = new Point(work.Right - Width - 18, work.Bottom - Height - 18);
    }

    void KeepOnScreen()
    {
        var screen = Screen.AllScreens.FirstOrDefault(item => item.WorkingArea.IntersectsWith(Bounds)) ?? Screen.PrimaryScreen;
        var work = screen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Left = Math.Clamp(Left, work.Left, Math.Max(work.Left, work.Right - Width));
        Top = Math.Clamp(Top, work.Top, Math.Max(work.Top, work.Bottom - Height));
    }

    void SaveLayout()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LayoutPath)!);
            File.WriteAllText(LayoutPath, JsonSerializer.Serialize(new PetLayout { X = Left, Y = Top }));
        }
        catch { }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        var tick = _reduceMotion ? 0d : _clock.Elapsed.TotalSeconds;
        var hover = _reduceMotion ? 0 : (int)Math.Round(Math.Sin(tick * 2.1) * 3);

        if (_active) DrawStatusBubble(g);
        DrawPetSymbol(g, hover, tick);
    }

    void DrawStatusBubble(Graphics g)
    {
        var rect = new Rectangle(12, 10, Width - 24, _hoverReply ? 100 : 76);
        using var shadowPath = RoundedPanel.RoundedRect(new Rectangle(rect.X + 2, rect.Y + 4, rect.Width, rect.Height), 18);
        using var shadow = new SolidBrush(Color.FromArgb(26, 0, 0, 0));
        g.FillPath(shadow, shadowPath);
        using var path = RoundedPanel.RoundedRect(rect, 18);
        using var fill = new SolidBrush(_darkMode ? Color.FromArgb(31, 32, 32) : Color.FromArgb(250, 250, 249));
        using var border = new Pen(_darkMode ? Color.FromArgb(76, 78, 76) : Color.FromArgb(211, 213, 207));
        g.FillPath(fill, path);
        g.DrawPath(border, path);

        DrawBoollmMark(g, new Point(rect.Left + 27, rect.Top + 30), 17, _darkMode ? Color.FromArgb(235, 236, 234) : Color.FromArgb(36, 37, 38));
        using var titleFont = new Font("Segoe UI Variable Text", 10.5f, FontStyle.Bold);
        using var detailFont = new Font("Segoe UI Variable Text", 9f, FontStyle.Regular);
        using var titleBrush = new SolidBrush(_darkMode ? Color.FromArgb(239, 240, 238) : Color.FromArgb(31, 32, 33));
        using var detailBrush = new SolidBrush(_darkMode ? Color.FromArgb(164, 166, 163) : Color.FromArgb(105, 107, 105));
        g.DrawString(_chatName, titleFont, titleBrush, new RectangleF(rect.Left + 57, rect.Top + 10, rect.Width - (_hoverReply ? 156 : 104), 22));
        if (!_hoverReply)
        {
            var activity = _completed ? "Finished" : (!string.IsNullOrWhiteSpace(_detail) ? _detail : _title);
            g.DrawString(activity, detailFont, detailBrush, new RectangleF(rect.Left + 57, rect.Top + 36, rect.Width - 91, 22));
        }
        if (_completed)
        {
            var green = Color.FromArgb(43, 184, 82);
            using var checkPen = new Pen(green, 2.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            var cx = rect.Right - 28;
            var cy = rect.Top + 31;
            g.DrawEllipse(checkPen, cx - 11, cy - 11, 22, 22);
            g.DrawLines(checkPen, new[] { new Point(cx - 5, cy), new Point(cx - 1, cy + 4), new Point(cx + 7, cy - 5) });
        }
        if (_hoverReply)
        {
            var inputRect = new Rectangle(rect.Left + 16, rect.Top + 56, rect.Width - 32, 32);
            using var inputPath = RoundedPanel.RoundedRect(inputRect, 14);
            using var inputFill = new SolidBrush(_darkMode ? Color.FromArgb(30, 31, 31) : Color.FromArgb(246, 247, 245));
            using var inputBorder = new Pen(_darkMode ? Color.FromArgb(86, 88, 85) : Color.FromArgb(207, 209, 205));
            g.FillPath(inputFill, inputPath);
            g.DrawPath(inputBorder, inputPath);
        }
        using var pinPen = new Pen(Color.FromArgb(96, 98, 97), 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawLine(pinPen, rect.Left + 45, rect.Top + 14, rect.Left + 45, rect.Top + 25);
        g.DrawLine(pinPen, rect.Left + 41, rect.Top + 18, rect.Left + 49, rect.Top + 18);
    }

    void DrawPetSymbol(Graphics g, int hover, double tick)
    {
        var tile = new Rectangle(Width - 86, (_hoverReply ? 119 : 93) + hover, 68, 68);
        using var rearShadow = new SolidBrush(Color.FromArgb(34, 0, 0, 0));
        g.FillEllipse(rearShadow, tile.Left + 5, tile.Bottom + 6, tile.Width - 10, 10);
        using var tilePath = RoundedPanel.RoundedRect(tile, 16);
        using var graphite = new LinearGradientBrush(tile, Color.FromArgb(35, 38, 38), Color.FromArgb(17, 20, 20), 90f);
        using var tileBorder = new Pen(Color.FromArgb(69, 74, 72), 1.1f);
        g.FillPath(graphite, tilePath);
        g.DrawPath(tileBorder, tilePath);

        var green = Color.FromArgb(53, 199, 89);
        var pulse = _reduceMotion ? 1f : .65f + (float)((Math.Sin(tick * 3) + 1) * .17);
        using var pulseLed = new SolidBrush(Color.FromArgb((int)(220 * pulse), green));
        g.FillEllipse(pulseLed, tile.Right - 12, tile.Bottom - 12, 5, 5);

        var center = new Point(tile.Left + tile.Width / 2, tile.Top + tile.Height / 2);
        if (_displayState == BoollmPetDisplayState.Browsing) DrawGlobe(g, center, 19, green, tick);
        else if (_displayState == BoollmPetDisplayState.Coding) DrawTerminal(g, tile, green);
        else DrawBoollmMark(g, center, 34, Color.White);
    }

    static void DrawBoollmMark(Graphics g, Point center, int size, Color color)
    {
        const int cells = 7;
        var spacing = size / 6f;
        using var brush = new SolidBrush(color);
        for (var y = 0; y < cells; y++)
        for (var x = 0; x < cells; x++)
        {
            var distance = Math.Max(Math.Abs(x - 3), Math.Abs(y - 3));
            var radius = Math.Max(.8f, size * (.078f - distance * .013f));
            var px = center.X + (x - 3) * spacing;
            var py = center.Y + (y - 3) * spacing;
            g.FillEllipse(brush, px - radius, py - radius, radius * 2, radius * 2);
        }
    }

    void DrawGlobe(Graphics g, Point center, int radius, Color color, double tick)
    {
        using var pen = new Pen(color, 2.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        var rect = new Rectangle(center.X - radius, center.Y - radius, radius * 2, radius * 2);
        g.DrawEllipse(pen, rect);
        g.DrawEllipse(pen, center.X - radius / 2, center.Y - radius, radius, radius * 2);
        g.DrawLine(pen, center.X - radius + 3, center.Y, center.X + radius - 3, center.Y);
        g.DrawArc(pen, center.X - radius + 3, center.Y - radius / 2, radius * 2 - 6, radius, 180, 180);
        g.DrawArc(pen, center.X - radius + 3, center.Y - radius / 2, radius * 2 - 6, radius, 0, 180);
        if (!_reduceMotion)
        {
            var angle = tick * Math.PI;
            var dotX = center.X + (float)Math.Cos(angle) * (radius + 5);
            var dotY = center.Y + (float)Math.Sin(angle) * 7;
            using var dot = new SolidBrush(color);
            g.FillEllipse(dot, dotX - 2.5f, dotY - 2.5f, 5, 5);
        }
    }

    void DrawTerminal(Graphics g, Rectangle display, Color color)
    {
        var cycle = _reduceMotion ? 1900L : _clock.ElapsedMilliseconds % 2000;
        var text = cycle < 350 ? ">_" : cycle < 700 ? ">" : cycle < 980 ? "" : cycle < 1280 ? ">" : ">_";
        using var font = new Font("Cascadia Mono", 27f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var brush = new SolidBrush(color);
        var measured = g.MeasureString(text, font);
        g.DrawString(text, font, brush, display.Left + (display.Width - measured.Width) / 2, display.Top + (display.Height - measured.Height) / 2 - 1);
    }
}

sealed class MainForm : Form
{
    // derived from AssemblyVersion (SazShell.csproj) so it can never drift from
    // the shipped version again — a stale hardcoded value here made 0.9.9
    // think it was 0.9.8 and re-download itself forever
    static readonly string AppVersion =
        typeof(MainForm).Assembly.GetName().Version is { } av ? $"{av.Major}.{av.Minor}.{av.Build}" : "0.0.0";
    // Keep the existing repository URL until the GitHub repository itself is renamed.
    const string UpdateManifestUrl = "https://github.com/syfy10/Boollm/releases/latest/download/update.json";

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
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    FormWindowState _lastWindowState = FormWindowState.Normal;
    bool _frameRefreshQueued;
    bool _restoreMaximized;
    bool _restoreBrowserOpen;
    int _restoreBrowserWidth;
    bool _windowLayoutRestored;
    string WindowLayoutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "saz3", "window-layout.json");

    sealed class SavedWindowLayout
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Maximized { get; set; }
        public bool BrowserOpen { get; set; }
        public int BrowserWidth { get; set; }
    }

    int ResizeHitTest(Point point, Size clientSize, int grip)
    {
        const int HTCLIENT = 1;
        const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        const int HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        bool left = point.X >= 0 && point.X < grip;
        bool right = point.X < clientSize.Width && point.X >= clientSize.Width - grip;
        bool top = point.Y >= 0 && point.Y < grip;
        bool bottom = point.Y < clientSize.Height && point.Y >= clientSize.Height - grip;
        if (top && left) return HTTOPLEFT;
        if (top && right) return HTTOPRIGHT;
        if (bottom && left) return HTBOTTOMLEFT;
        if (bottom && right) return HTBOTTOMRIGHT;
        if (left) return HTLEFT;
        if (right) return HTRIGHT;
        if (top) return HTTOP;
        if (bottom) return HTBOTTOM;
        return HTCLIENT;
    }

    void ApplyDpiMinimumSize()
    {
        var work = IsHandleCreated
            ? Screen.FromHandle(Handle).WorkingArea
            : (Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1200, 800));
        double scale = Math.Max(1d, DeviceDpi / 96d);
        int availableWidth = Math.Max(320, work.Width - 16);
        int availableHeight = Math.Max(320, work.Height - 16);
        MinimumSize = new Size(
            Math.Min((int)Math.Round(900 * scale), availableWidth),
            Math.Min((int)Math.Round(540 * scale), availableHeight));
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyDpiMinimumSize();
        if (_windowLayoutRestored) return;
        _windowLayoutRestored = true;
        // Screen and Bounds use the monitor's physical coordinates only after
        // the native handle has its DPI context. Restoring earlier mixed the
        // saved physical rectangle with logical startup coordinates.
        RestoreWindowLayout();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        ApplyDpiMinimumSize();
    }

    // Reclaim the top frame in a normal window. When maximized, MaximizedBounds already keeps
    // the window inside the work area, so reclaim the entire resize frame to avoid edge gaps.
    protected override void WndProc(ref Message m)
    {
        const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084, HTCLIENT = 1;
        if (m.Msg == WM_NCHITTEST && WindowState != FormWindowState.Maximized)
        {
            base.WndProc(ref m);
            if ((int)m.Result == HTCLIENT)
            {
                long packedPoint = m.LParam.ToInt64();
                var screenPoint = new Point(
                    unchecked((short)(packedPoint & 0xffff)),
                    unchecked((short)((packedPoint >> 16) & 0xffff)));
                int grip = Math.Max(8, (int)Math.Round(8 * DeviceDpi / 96d));
                int hit = ResizeHitTest(PointToClient(screenPoint), ClientSize, grip);
                if (hit != HTCLIENT) m.Result = (IntPtr)hit;
            }
            return;
        }
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

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (_lastWindowState == WindowState || !IsHandleCreated || _frameRefreshQueued) return;
        _lastWindowState = WindowState;
        _frameRefreshQueued = true;
        BeginInvoke(new Action(() =>
        {
            _frameRefreshQueued = false;
            if (IsDisposed || !IsHandleCreated) return;
            const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
            const uint SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            ApplyBorderlessDwm();
            if (WindowState != FormWindowState.Minimized && !_wasMinimized &&
                _browserOpen && !_full) BeginInvoke(new Action(FitBrowserSplit));
        }));
    }

    void ApplyBorderlessDwm()
    {
        try
        {
            // Keep the custom title bar, but retain a quiet one-pixel native
            // outline around the whole rounded window so it remains distinct
            // from similarly colored content behind it.
            int border = ColorTranslator.ToWin32(_pal.BtnBorder);
            DwmSetWindowAttribute(Handle, 34 /*DWMWA_BORDER_COLOR*/, ref border, 4);
            int round = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(Handle, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, ref round, 4);
        }
        catch { }
    }

    void RefreshTopOutline()
    {
        // Windows 11 honors the themed DWM border on every side, so complete
        // that border across the reclaimed custom title bar. Windows 10 can
        // omit the other three visible edges; drawing only this client-side
        // strip produces an unmatched white/accent line in dark mode.
        bool show = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000);
        _topOutline.Visible = show;
        if (!show) return;
        _topOutline.BackColor = _pal.BtnBorder;
        _topOutline.Invalidate();
    }

    void ApplyDwmChromeColor(Color color)
    {
        try
        {
            int caption = ColorTranslator.ToWin32(color);
            DwmSetWindowAttribute(Handle, 35 /*DWMWA_CAPTION_COLOR*/, ref caption, 4);
            int border = ColorTranslator.ToWin32(_pal.BtnBorder);
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
            case "growContext":
                if (_browserOpen && !_full) BeginInvoke(new Action(FitBrowserSplit));
                break;
            case "min": WindowState = FormWindowState.Minimized; break;
            case "max": MaximizeWindow(); break;
            case "snapleft": SnapWindow(false); break;
            case "snapright": SnapWindow(true); break;
            case "maxtoggle": ToggleMaximize(); break;
            case "appZoom":
                if (root.TryGetProperty("percent", out var zoomp) && zoomp.TryGetDouble(out var percent))
                    _chat.ZoomFactor = Math.Clamp(percent, 75d, 150d) / 100d;
                break;
            case "close": Close(); break;
        }
    }

    string? PickFolderNative(string? initialPath, string? title)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = string.IsNullOrWhiteSpace(title) ? "Choose folder" : title,
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            AutoUpgradeEnabled = true
        };
        try
        {
            if (!string.IsNullOrWhiteSpace(initialPath) && Directory.Exists(initialPath))
                dialog.SelectedPath = initialPath;
        }
        catch { }
        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
        var selected = dialog.SelectedPath;
        return string.IsNullOrWhiteSpace(selected) ? null : selected;
    }

    void ToggleMaximize()
    {
        if (WindowState != FormWindowState.Maximized)
        {
            MaximizeWindow();
            return;
        }
        WindowState = FormWindowState.Normal;
    }

    void MaximizeWindow()
    {
        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea; // don't cover the taskbar
        WindowState = FormWindowState.Maximized;
    }

    void SnapWindow(bool right)
    {
        var work = Screen.FromHandle(Handle).WorkingArea;
        WindowState = FormWindowState.Normal;
        var width = Math.Min(work.Width, Math.Max(MinimumSize.Width, work.Width / 2));
        Bounds = new Rectangle(right ? work.Right - width : work.Left, work.Top, width, work.Height);
        Activate();
    }

    bool IsSnappedToWorkingArea()
    {
        if (WindowState != FormWindowState.Normal) return false;
        var work = Screen.FromHandle(Handle).WorkingArea;
        // Wider tolerance: Windows 11 snap layouts leave small gaps and the DWM
        // frame extends a few px past the visible edge, so a strict 12px test
        // missed genuine snaps and the window grew anyway.
        const int tolerance = 24;
        // Cover "most of the height" rather than exact top+bottom — a snapped or
        // user-dragged edge window is tall even if it doesn't perfectly fill.
        bool tallEnough = Height >= work.Height - Math.Max(tolerance, work.Height / 6);
        bool touchesSide = Math.Abs(Left - work.Left) <= tolerance ||
            Math.Abs(Right - work.Right) <= tolerance;
        return tallEnough && touchesSide && Width < work.Width - tolerance;
    }

    // layout
    readonly SplitContainer _split = new() { Orientation = Orientation.Vertical, SplitterWidth = 5 };
    // Grab strip painted over the splitter. Both panes are WebView2 controls, which
    // host their own child HWNDs and swallow the mouse, so the SplitContainer's own
    // splitter can never be dragged. A real top-most control taking mouse capture is
    // the only way the divider tracks the cursor across both panes.
    readonly Panel _splitGrip = new() { TabStop = false, Visible = false, Cursor = Cursors.VSplit };
    // Right edge of the responsive preview: drag to any width, like a browser window.
    readonly Panel _previewGrip = new() { TabStop = false, Visible = false, Cursor = Cursors.SizeWE };
    readonly Panel _topOutline = new() { Dock = DockStyle.Top, Height = 1, TabStop = false, Visible = false };
    readonly WebView2 _chat = new() { Dock = DockStyle.Fill };
    // HTML browser chrome (tabs + nav + address + tasks + menu + window controls),
    // served from the core at /browser-chrome. Replaces the old WinForms chrome.
    readonly WebView2 _chromeView = new() { Dock = DockStyle.Top, Height = 116 };
    bool _chromeReady;
    bool _themeDark;
    string _themeSurface = "classic";
    bool _browserDarkMode;
    int _tabSeq;
    readonly RoundedPanel _browserPane = new() { Dock = DockStyle.Fill, Radius = 0 };
    readonly Panel _startup = new() { Dock = DockStyle.Fill, BackColor = Color.FromArgb(245, 245, 243) };
    readonly Label _startupTitle = new() { AutoSize = true, Font = new Font("Segoe UI", 18f, FontStyle.Bold), ForeColor = Color.FromArgb(18, 24, 20) };
    readonly Label _startupText = new() { AutoSize = false, Font = new Font("Segoe UI", 10f), ForeColor = Color.FromArgb(96, 100, 96) };
    readonly Button _startupClose = new() { Text = "Close", Width = 92, Height = 34, FlatStyle = FlatStyle.Flat, Visible = false };
    readonly Panel _content = new() { Dock = DockStyle.Fill };
    readonly List<TabItem> _tabs = new();
    int _active = -1;
    bool _full = false;
    bool _windowSizing;
    bool _fittingBrowserSplit;
    bool _gripDragging;
    bool _previewGripDragging;
    bool _wasMinimized;
    int _lastUsableBrowserWidth;
    // Width the user dragged the browser pane to. Window resizes keep it instead of
    // snapping the pane back to the automatic even split.
    int _browserManualWidth;
    int _deviceModeIdx = 0;
    // Preview width in CSS pixels for the responsive view (0 = fill the pane).
    int _deviceWidth;
    bool _deviceCustomWidth;
    const int PreviewGutter = 14;
    const int PreviewMinWidth = 240;
    static readonly (string id, string label, int w, int h, bool mobile, string glyph)[] DeviceModes =
    {
        ("desktop", "Desktop", 0, 0, false, "▣"),
        ("tablet",  "Tablet 834 × 1112", 834, 1112, false, "▭"),
        ("mobile",  "Mobile 390 × 844", 390, 844, true, "▯")
    };

    // themeable chrome (follows the app's light/dark theme)
    Palette _pal = Palette.Light;
    // Keep the native browser below Boollm's shared 38px title/tool band.
    // Without this inset the browser tab strip sits against the frameless
    // window edge, where its first row can be visually clipped.
    const int BrowserTopInset = 38;
    // Height of the HTML chrome bar: tab row (40) + nav/address row (42) + task row (34).
    const int ChromeHeight = 116;
    // The overflow menu is rendered inside the chrome WebView. WebView2 surfaces
    // are separate native HWNDs, so the page WebView would otherwise paint over
    // any menu pixels that extend past the chrome's normal 116px viewport.
    const int ChromeMenuHeight = 548;
    bool _chromeMenuOpen;
    CoreWebView2DevToolsProtocolEventReceiver? _studioScreencastReceiver;
    EventHandler<CoreWebView2DevToolsProtocolEventReceivedEventArgs>? _studioScreencastHandler;
    bool _studioRecording;
    long _studioRecordingStarted;
    int _studioRecordingFrames;

    readonly record struct Palette(Color CanvasBg, Color PaneBg, Color BarBg, Color BtnBg, Color BtnBorder,
        Color Text, Color AddrBg, Color Splitter, Color ActiveTab, Color Hover)
    {
        public static Palette Light => new(
            Color.FromArgb(245, 245, 243), Color.FromArgb(251, 251, 250), Color.FromArgb(245, 245, 243), Color.White, Color.FromArgb(233, 233, 230),
            Color.FromArgb(32, 33, 36), Color.White, Color.FromArgb(233, 233, 230), Color.FromArgb(251, 251, 250), Color.FromArgb(245, 245, 243));
        public static Palette Dark => new(
            Color.FromArgb(32, 32, 32), Color.FromArgb(28, 28, 28), Color.FromArgb(32, 32, 32), Color.FromArgb(34, 34, 34), Color.FromArgb(58, 58, 58),
            Color.Gainsboro, Color.FromArgb(44, 44, 44), Color.FromArgb(40, 40, 40), Color.FromArgb(46, 46, 46), Color.FromArgb(48, 48, 48));
    }

    CoreWebView2Environment _env = null!;
    Process? _core;
    int _port;
    volatile bool _corePrintedServing;
    string _homeUrl = "https://www.google.com";
    readonly List<(string url, string title)> _bookmarks = new(); // mirrored from Settings by the chat UI
    readonly HttpClient _http = new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };
    readonly string _logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "saz3", "logs");
    readonly string _updateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "saz3", "updates");
    string CoreLogPath => Path.Combine(_logDir, "boolean-core.log");
    string? _updateReadyPath;
    bool _updateCheckRunning;
    BoollmPetForm? _pet;

    // browser permissions read from the app config (~/.saz/config.json)
    bool _permDownloads = true, _permCamera = false, _permMic = false, _permGeo = false;

    public MainForm()
    {
        Text = "Boollm";                          // taskbar label only
        FormBorderStyle = FormBorderStyle.None;     // no native caption — the web top bar is the title bar
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1200, 800);
        // Establish a safe pre-handle minimum. Once Windows assigns the
        // monitor DPI, OnHandleCreated scales this 900x540 logical workspace
        // into physical pixels and clamps it to the real work area.
        MinimumSize = new Size(Math.Min(900, Math.Max(600, wa.Width - 16)), Math.Min(540, Math.Max(480, wa.Height - 16)));
        // Start large enough to present the complete workspace on first launch
        // and after an update: rail, project/chat sidebar, and main chat should
        // all be visible without the user having to resize the window.
        Width = Math.Min(wa.Width - 32, Math.Max(1100, (int)Math.Round(wa.Width * 0.90)));
        Height = Math.Min(wa.Height - 32, Math.Max(760, (int)Math.Round(wa.Height * 0.90)));
        StartPosition = FormStartPosition.Manual;
        Left = wa.Left + (wa.Width - Width) / 2;
        Top  = wa.Top + (wa.Height - Height) / 2;
        Opacity = 0;
        BackColor = Color.FromArgb(28, 28, 28);
        // Let the themed content reach the bottom edge. A reserved native
        // footer reads as a mismatched strip when switching light and dark.
        Padding = Padding.Empty;
        DoubleBuffered = true;
        try { _chat.DefaultBackgroundColor = BackColor; } catch { }
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
        // Side-by-side split: the chat REFLOWS to its pane when the browser opens,
        // so nothing is covered or cut off. The native splitter (thin, themed) is
        // the resize handle. An overlay approach was tried and reverted — the chat
        // underneath kept its full-width layout and half of it ended up hidden.
        // The HTML chrome renders its own window controls and drag region, so the
        // browser pane runs edge-to-edge (no reserved WinForms title band).
        _split.Panel2.Padding = new Padding(0, 0, 0, 0);
        _split.Panel2.Controls.Add(_browserPane);
        _split.Panel2Collapsed = true; // browser hidden until toggled
        Controls.Add(_split);
        BuildSplitGrip();
        // Windows 11 uses this to complete its themed DWM outline across the
        // custom title bar. RefreshTopOutline keeps it hidden on Windows 10,
        // where a lone client-side top line does not match the other edges.
        Controls.Add(_topOutline);
        _topOutline.BringToFront();
        BuildBrowserPill();
        Controls.Add(_startup);
        _startup.BringToFront();

        Load += OnLoad;
        // Docking already resizes both WebViews during a border drag. Recomputing
        // SplitterDistance for every WM_SIZE made the panes fight that layout,
        // producing visible shake and exposing an unpainted edge. Fit once when
        // resizing ends; non-interactive size changes still fit immediately.
        ResizeBegin += (_, __) => { _windowSizing = true; };
        Resize += (_, __) =>
        {
            if (WindowState == FormWindowState.Minimized)
            {
                _wasMinimized = true;
                return;
            }
            if (_wasMinimized)
            {
                _wasMinimized = false;
                if (_browserOpen && !_full) BeginInvoke(new Action(RestoreBrowserSplitAfterMinimize));
                PushChromeState();
                PushWindowState();
                PositionSplitGrip();
                return;
            }
            if (_browserOpen && !_full && !_windowSizing) FitBrowserSplit();
            PushChromeState(); // keep the chrome's maximize/restore glyph in sync
            PushWindowState(); // keep the main title bar's maximize/restore glyph in sync
            PositionSplitGrip();
        };
        ResizeEnd += (_, __) =>
        {
            _windowSizing = false;
            if (!_browserOpen || _full) return;
            _split.SuspendLayout();
            try { FitBrowserSplit(); }
            finally { _split.ResumeLayout(true); }
            _split.Invalidate(true);
        };
        FormClosing += (_, __) => SaveWindowLayout();
        FormClosed += (_, __) =>
        {
            try { _pet?.Close(); } catch { }
            CleanupCoreOnClose();
            LaunchPendingUpdate();
        };
        Shown += (_, __) =>
        {
            if (_restoreMaximized) BeginInvoke(new Action(MaximizeWindow));
        };
    }

    void RestoreWindowLayout()
    {
        try
        {
            if (!File.Exists(WindowLayoutPath)) return;
            var saved = JsonSerializer.Deserialize<SavedWindowLayout>(File.ReadAllText(WindowLayoutPath));
            if (saved == null || saved.Width < 600 || saved.Height < 480) return;
            var requested = new Rectangle(saved.X, saved.Y, saved.Width, saved.Height);
            var screen = Screen.AllScreens.FirstOrDefault(item =>
            {
                var overlap = Rectangle.Intersect(item.WorkingArea, requested);
                return overlap.Width >= 120 && overlap.Height >= 120;
            });
            if (screen == null) return;
            var work = screen.WorkingArea;
            int minWidth = Math.Min(MinimumSize.Width, work.Width);
            int minHeight = Math.Min(MinimumSize.Height, work.Height);
            // Older builds could save a normal/restored rectangle that filled
            // the work area (or physical-pixel bounds from a different DPI).
            // Restoring that rectangle looked identical to maximized and left
            // no visible edge to drag. Give it a clearly smaller centered
            // normal rectangle; a saved maximized state can still maximize
            // after first paint and will return to this useful restore size.
            bool savedFillsWorkArea =
                saved.Width >= work.Width - 24 &&
                saved.Height >= work.Height - 24;
            var width = savedFillsWorkArea
                ? Math.Clamp((int)Math.Round(work.Width * 0.90), minWidth, work.Width)
                : Math.Clamp(saved.Width, minWidth, work.Width);
            var height = savedFillsWorkArea
                ? Math.Clamp((int)Math.Round(work.Height * 0.90), minHeight, work.Height)
                : Math.Clamp(saved.Height, minHeight, work.Height);
            var x = savedFillsWorkArea
                ? work.Left + (work.Width - width) / 2
                : Math.Clamp(saved.X, work.Left, Math.Max(work.Left, work.Right - width));
            var y = savedFillsWorkArea
                ? work.Top + (work.Height - height) / 2
                : Math.Clamp(saved.Y, work.Top, Math.Max(work.Top, work.Bottom - height));
            Bounds = new Rectangle(x, y, width, height);
            _restoreMaximized = saved.Maximized;
            _restoreBrowserOpen = saved.BrowserOpen;
            _restoreBrowserWidth = Math.Max(0, saved.BrowserWidth);
            // A width carried over from the last session is the user's choice too.
            _browserManualWidth = _restoreBrowserWidth;
        }
        catch { }
    }

    void SaveWindowLayout()
    {
        try
        {
            var normal = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            if (normal.Width < 1 || normal.Height < 1) return;
            Directory.CreateDirectory(Path.GetDirectoryName(WindowLayoutPath)!);
            var saved = new SavedWindowLayout
            {
                X = normal.X,
                Y = normal.Y,
                Width = normal.Width,
                Height = normal.Height,
                Maximized = WindowState == FormWindowState.Maximized,
                BrowserOpen = _browserOpen,
                BrowserWidth = _browserOpen && !_split.Panel2Collapsed ? _split.Panel2.Width : 0
            };
            File.WriteAllText(WindowLayoutPath, JsonSerializer.Serialize(saved));
        }
        catch { }
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
        ShowStartup("Starting Boollm", "Loading the local app...");
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
        return Path.Combine(_updateDir, $"Boollm-setup-{safe}.exe");
    }

    async Task CheckForUpdatesAsync()
    {
        if (_updateCheckRunning) return;
        _updateCheckRunning = true;

        // Development builds do not update themselves. Packaged builds always
        // contain the core executable beside the shell.
        if (!File.Exists(Path.Combine(AppContext.BaseDirectory, "Boollm-core.exe"))) { _updateCheckRunning = false; return; }

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
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Boollm-Windows/" + AppVersion);

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
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
            Directory.CreateDirectory(backup);
            foreach (var name in new[] { "config.json", "config.json.bak", "threads.json", "usage.json", "preferences.json" })
            {
                var from = Path.Combine(source, name);
                // Skip empty/zero-byte files so a bad copy can't overwrite good user data on restore.
                if (File.Exists(from) && new FileInfo(from).Length > 0) File.Copy(from, Path.Combine(backup, name), true);
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
            var appExe = Path.Combine(AppContext.BaseDirectory, "Boollm.exe");
            var script = """
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$AppExe,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$PendingFile,
  [Parameter(Mandatory=$true)][string]$BackupDir,
  [Parameter(Mandatory=$true)][string]$UserDataDir
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
  if (Test-Path -LiteralPath $BackupDir) {
    New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
    Get-ChildItem -LiteralPath $BackupDir -File | ForEach-Object {
      # Never clobber user data with an empty or corrupt backup. For JSON files,
      # require the backup to parse before restoring it over the installed copy.
      if ($_.Length -le 0) { return }
      if ($_.Extension -ieq '.json') {
        try { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json -ErrorAction Stop | Out-Null }
        catch { Add-Content -LiteralPath $LogPath -Value ("Updater: skipped invalid backup " + $_.Name); return }
      }
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $UserDataDir $_.Name) -Force
    }
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
            psi.ArgumentList.Add("-BackupDir");
            psi.ArgumentList.Add(Path.Combine(_updateDir, "backup"));
            psi.ArgumentList.Add("-UserDataDir");
            psi.ArgumentList.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".saz"));
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
            // The browser opens on Boollm's own start page (running local servers
            // + quick links) instead of a search engine.
            _homeUrl = $"http://127.0.0.1:{_port}/browser-start";
            _env = await webViewTask;

            await _chat.EnsureCoreWebView2Async(_env);
            _chat.CoreWebView2.WebMessageReceived += OnChatMessage;
            _chat.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _chat.CoreWebView2.Settings.IsZoomControlEnabled = false;
            _chat.NavigationCompleted += (_, __) =>
            {
                try
                {
                    _startup.Visible = false;
                    Opacity = 1;
                    Activate();
                    PushWindowState();
                }
                catch { }
            };
            _chat.CoreWebView2.Navigate($"http://127.0.0.1:{_port}");

            await _chromeView.EnsureCoreWebView2Async(_env);
            _chromeView.CoreWebView2.WebMessageReceived += OnChromeMessage;
            _chromeView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _chromeView.CoreWebView2.Settings.IsZoomControlEnabled = false;
            // The chrome WebView temporarily overlaps the page while its menu
            // is open. A transparent controller background lets the page remain
            // visible everywhere outside the opaque menu and three chrome rows.
            try { _chromeView.DefaultBackgroundColor = Color.Transparent; } catch { }
            _chromeView.CoreWebView2.Navigate($"http://127.0.0.1:{_port}/browser-chrome");
            if (_restoreBrowserOpen)
                BeginInvoke(new Action(() => ToggleBrowser(true)));

            _ = CheckForUpdatesAsync();
            // long-lived windows re-check on the same cadence as the feed throttle
            var updateTimer = new System.Windows.Forms.Timer { Interval = (int)TimeSpan.FromHours(6).TotalMilliseconds };
            updateTimer.Tick += (_, __) => _ = CheckForUpdatesAsync();
            updateTimer.Start();
        }
        catch (Exception ex)
        {
            ShowStartup("Boollm could not start", ex.Message + "\n\nLog: " + CoreLogPath + ReadCoreLogTail(), true);
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
        // Node 24 can misclassify newer Windows Insider/build numbers as
        // unsupported even though the OS is Windows 10/11 compatible.
        psi.Environment["NODE_SKIP_PLATFORM_CHECK"] = "1";
        foreach (var a in args) psi.ArgumentList.Add(a);
        _core = Process.Start(psi) ?? throw new Exception("failed to launch: " + exe);
        _core.OutputDataReceived += (_, ev) => { if (ev.Data != null) OnCoreLogLine(ev.Data); };
        _core.ErrorDataReceived += (_, ev) => { if (ev.Data != null) OnCoreLogLine("[err] " + ev.Data); };
        try { _core.BeginOutputReadLine(); _core.BeginErrorReadLine(); } catch { }

        for (int i = 0; i < 60; i++)
        {
            if (_core.HasExited) throw new Exception("engine exited on startup (code " + _core.ExitCode + ")");
            if (i > 0 && i % 10 == 0)
                ShowStartup("Starting Boollm", "Still waiting for the local engine...\n" + ((i / 2) + 1) + " seconds elapsed\nLog: " + CoreLogPath);
            if (_corePrintedServing || await CoreReadyAsync(port)) return port;
            await Task.Delay(500);
        }
        throw new Exception("engine did not become ready in time. Boollm started the engine process, but it did not answer on localhost.");
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

    // packaged: Boollm-core.exe next to us. dev: node <repo>\src\index.js
    (string exe, string[] args) ResolveCore(int port)
    {
        var dir = AppContext.BaseDirectory;
        var core = Path.Combine(dir, "Boollm-core.exe");
        string[] tail = { "ui", "--no-open", "--port", port.ToString() };
        if (File.Exists(core)) return (core, tail);

        var index = FindUp(dir, Path.Combine("src", "index.js"));
        if (index != null)
        {
            var node = new[] { index }.Concat(tail).ToArray();
            return ("node", node);
        }
        throw new Exception("Boollm-core.exe not found and dev src\\index.js not located");
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
    // ── browser pane: HTML chrome bar on top + the page-content region below ──
    void BuildBrowserPane()
    {
        _browserPane.BackColor = Color.FromArgb(28, 28, 28);
        // The chrome WebView and the page-content host are laid out with EXPLICIT
        // bounds. Two WebView2 surfaces docked in the same pane overlap (the page
        // paints over the chrome lower rows), so manual bounds are used: the
        // chrome sits on top at a fixed height, the content fills the rest.
        _chromeView.Dock = DockStyle.None;
        _content.Dock = DockStyle.None;
        _browserPane.Controls.Add(_content);
        _browserPane.Controls.Add(_chromeView);
        _browserPane.Layout += (_, __) => LayoutBrowserPane();
        _browserPane.SizeChanged += (_, __) => LayoutBrowserPane();
        BuildPreviewGrip();
        // Clicking the page moves focus away from the chrome WebView. Collapse
        // any open chrome popup at the same time so stale menu state cannot
        // leave the page compressed or make the next menu click behave backward.
        _chromeView.Leave += (_, __) => CloseChromeMenu();
        LayoutBrowserPane();
        ApplyTheme(ResolveTheme()); // initial colors (UI resends the exact theme on load)
    }

    void CloseChromeMenu()
    {
        if (!_chromeMenuOpen) return;
        _chromeMenuOpen = false;
        LayoutBrowserPane();
        try
        {
            _chromeView.CoreWebView2?.PostWebMessageAsJson(
                JsonSerializer.Serialize(new { type = "dismissMenu" }));
        }
        catch { }
    }

    // ── HTML browser chrome bridge ───────────────────────────────────
    // Explicit two-region layout: fixed-height chrome bar on top, page content
    // filling the rest. Manual bounds so the two WebView2 surfaces never overlap.
    void LayoutBrowserPane()
    {
        var r = _browserPane.ClientRectangle;
        if (r.Width <= 0 || r.Height <= 0) return;
        // The chrome WebView renders its HTML in CSS (logical) pixels, but this
        // pane's bounds are in device pixels. Scale the fixed chrome height by the
        // DPI factor so all three HTML rows are shown (not clipped at ~66%).
        double dpi = _browserPane.DeviceDpi / 96.0;
        int normalHeight = (int)Math.Round(ChromeHeight * dpi);
        int desiredHeight = _chromeMenuOpen
            ? (int)Math.Round(ChromeMenuHeight * dpi)
            : normalHeight;
        // Keep a useful slice of the page visible in short windows. The menu
        // itself becomes scrollable inside the remaining chrome viewport.
        int pageReserve = (int)Math.Round(120 * dpi);
        int maxChromeHeight = Math.Max(normalHeight, r.Height - pageReserve);
        int h = Math.Min(desiredHeight, Math.Min(maxChromeHeight, r.Height));
        _chromeView.Bounds = new Rectangle(r.Left, r.Top, r.Width, h);
        // The page always starts below the normal chrome rows. Expanding the
        // chrome for a popup overlays the page instead of reflowing it downward.
        _content.Bounds = new Rectangle(
            r.Left,
            r.Top + normalHeight,
            r.Width,
            Math.Max(0, r.Height - normalHeight));
        LayoutContentViews();
        _chromeView.BringToFront();
    }

    // ── responsive preview ───────────────────────────────────────────
    // In a device/responsive view the page WebView is sized to the preview width
    // itself rather than stretched across the pane. The page then genuinely lays
    // out at that width, so the pane shows what the site looks like there.
    Rectangle PreviewViewport(Rectangle area)
    {
        if (_deviceWidth <= 0) return area;
        double dpi = _content.DeviceDpi / 96.0;
        int gutter = (int)Math.Round(PreviewGutter * dpi);
        int gripWidth = PreviewGripWidth();
        int maxWidth = Math.Max(120, area.Width - gutter - gripWidth);
        int width = Math.Min((int)Math.Round(_deviceWidth * dpi), maxWidth);
        return new Rectangle(area.Left + gutter, area.Top, width, area.Height);
    }

    int PreviewGripWidth() => Math.Max(8, (int)Math.Round(10 * (_content.DeviceDpi / 96.0)));

    void LayoutContentViews()
    {
        var area = _content.ClientRectangle;
        if (area.Width <= 0 || area.Height <= 0) return;
        var viewport = PreviewViewport(area);
        foreach (var t in _tabs)
            if (t.View.Bounds != viewport) t.View.Bounds = viewport;
        PositionPreviewGrip(area, viewport);
    }

    void PositionPreviewGrip(Rectangle area, Rectangle viewport)
    {
        if (_deviceWidth <= 0 || !_browserOpen)
        {
            if (_previewGrip.Visible) _previewGrip.Visible = false;
            return;
        }
        var bounds = new Rectangle(viewport.Right, area.Top, PreviewGripWidth(), area.Height);
        if (_previewGrip.Bounds != bounds) _previewGrip.Bounds = bounds;
        if (!_previewGrip.Visible) _previewGrip.Visible = true;
        _previewGrip.BringToFront();
    }

    void BuildPreviewGrip()
    {
        _previewGrip.BackColor = _pal.PaneBg;
        _previewGrip.Cursor = Cursors.SizeWE;
        _content.Controls.Add(_previewGrip);
        _previewGrip.MouseEnter += (_, __) => _previewGrip.Invalidate();
        _previewGrip.MouseLeave += (_, __) => _previewGrip.Invalidate();
        _previewGrip.Paint += (_, e) => PaintGrip(e, _previewGrip, _previewGripDragging, vertical: true);
        _previewGrip.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _previewGripDragging = true;
            _previewGrip.Capture = true;
            _previewGrip.Invalidate();
        };
        _previewGrip.MouseMove += (_, __) =>
        {
            if (!_previewGripDragging) return;
            var area = _content.ClientRectangle;
            double dpi = _content.DeviceDpi / 96.0;
            int gutter = (int)Math.Round(PreviewGutter * dpi);
            int device = (int)Math.Round((_content.PointToClient(Cursor.Position).X - area.Left - gutter) / dpi);
            int maxWidth = (int)Math.Round(Math.Max(120, area.Width - gutter - PreviewGripWidth()) / dpi);
            int next = Math.Clamp(device, PreviewMinWidth, Math.Max(PreviewMinWidth, maxWidth));
            if (next == _deviceWidth) return;
            _deviceWidth = next;
            _deviceCustomWidth = true;
            LayoutContentViews();
        };
        _previewGrip.MouseUp += (_, __) =>
        {
            if (!_previewGripDragging) return;
            _previewGripDragging = false;
            _previewGrip.Capture = false;
            _previewGrip.Invalidate();
            PushChromeState();
            _ = ApplyDeviceModeAsync();
        };
        // Double-click drops back to the full-width desktop view.
        _previewGrip.DoubleClick += (_, __) =>
        {
            _deviceModeIdx = 0;
            _deviceWidth = 0;
            _deviceCustomWidth = false;
            LayoutContentViews();
            PushChromeState();
            _ = ApplyDeviceModeAsync();
        };
    }

    // Compute the six context-aware AI quick actions for the task row.
    static (string text, string tip, string task)[] ChromeTaskSpecs(string? url) => IsEmailPage(url)
        ? new[] {
            ("Summarize", "Summarize this email conversation", "email_summary"),
            ("Draft reply", "Create a reply draft without sending", "email_reply"),
            ("Tasks", "Extract dates, decisions, and action items", "email_tasks"),
            ("Save", "Save useful email context to the project", "email_save"),
            ("Clean sender", "Preview older mail from this sender", "email_clean"),
            ("Email recipes", "Open all Email Recipes", "email_more")
        }
        : new[] {
            ("Use page", "Use the current page as context", "use"),
            ("Extract docs", "Extract documentation and code samples", "docs"),
            ("Turn into code", "Turn this page into working code", "code"),
            ("Summarize", "Summarize this page and save findings", "summarize"),
            ("Stack", "Detect CMS, framework, analytics, and hosting", "tech"),
            ("Monitor", "Watch this page for changes", "monitor")
        };

    static string ChromeTabTitle(TabItem t) =>
        !string.IsNullOrWhiteSpace(t.Title) && t.Title != t.Url ? t.Title
        : (!string.IsNullOrWhiteSpace(t.Url) ? t.Url : "New tab");

    // Push the full chrome state (tabs, address, nav availability, zoom, device,
    // window state, task specs, theme) to the HTML chrome.
    void PushChromeState()
    {
        if (!_chromeReady) return;
        var t = Active();
        var cw = t?.View.CoreWebView2;
        var tabs = _tabs.Select(x => new { id = x.Id, title = ChromeTabTitle(x), active = ReferenceEquals(x, t) }).ToArray();
        int zoom = cw != null ? (int)Math.Round(t!.View.ZoomFactor * 100) : 100;
        var specs = ChromeTaskSpecs(t?.Url).Select(s => new { text = s.text, tip = s.tip, task = s.task }).ToArray();
        var state = new
        {
            type = "state",
            tabs,
            url = t?.Url ?? "",
            canBack = cw?.CanGoBack ?? false,
            canFwd = cw?.CanGoForward ?? false,
            zoom,
            device = DeviceModes[_deviceModeIdx].id,
            deviceWidth = _deviceWidth,
            deviceLabel = _deviceWidth <= 0
                ? ""
                : _deviceCustomWidth
                    ? $"{_deviceWidth} px"
                    : DeviceModes[_deviceModeIdx].label,
            maxed = WindowState == FormWindowState.Maximized,
            full = _full,
            tasks = specs,
            bookmarks = _bookmarks.Select(b => new { url = b.url, title = b.title }).ToArray(),
            bookmarked = !string.IsNullOrEmpty(t?.Url) && _bookmarks.Any(b => b.url == t!.Url),
            dark = _themeDark,
            darkPage = _browserDarkMode,
            surface = _themeSurface
        };
        try { _chromeView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(state)); } catch { }
    }

    // The chat UI and the core both need to know which page the browser is on:
    // the UI for page-scoped actions (save page, detect stack, research cards) and
    // the core for URL-derived state such as the trading bar's symbol. The native
    // pane is the only browser, so it is the only thing that can report this.
    string _reportedBrowserUrl = "";
    void ReportBrowserUrl(TabItem? t)
    {
        var active = Active();
        if (t != null && !ReferenceEquals(t, active)) return;
        var paneOpen = BrowserPaneIsOpen();
        var url = paneOpen ? active?.Url ?? "" : "";
        var title = paneOpen ? active?.Title ?? "" : "";
        var key = url + " " + title;
        if (key == _reportedBrowserUrl) return;
        _reportedBrowserUrl = key;
        PostToChat(new { type = "shellBrowserUrl", url, title });
        _ = PostBrowserUrlToCore(url, title);
    }

    async System.Threading.Tasks.Task PostBrowserUrlToCore(string url, string title)
    {
        if (_port <= 0) return;
        try
        {
            var body = new StringContent(JsonSerializer.Serialize(new { url, title }),
                Encoding.UTF8, "application/json");
            using var _ = await _http.PostAsync($"http://127.0.0.1:{_port}/api/browser/url", body);
        }
        catch { /* the core may still be starting; the next navigation reports again */ }
    }

    void SelectTabById(int id) { var i = _tabs.FindIndex(x => x.Id == id); if (i >= 0) Activate(i); }
    void CloseTabById(int id) { var i = _tabs.FindIndex(x => x.Id == id); if (i >= 0) CloseTab(i); }

    // Messages from a page inside the browser pane. The only page allowed to send
    // any is Boollm's own start screen, whose Explore cards open Market,
    // Education or Sales in the app window next to the pane.
    void OnPageMessage(CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var source = e.Source ?? "";
            if (!source.StartsWith($"http://127.0.0.1:{_port}/", StringComparison.OrdinalIgnoreCase)) return;
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            if (!root.TryGetProperty("type", out var kind) || kind.GetString() != "exploreSurface") return;
            var surface = root.TryGetProperty("surface", out var s) ? s.GetString() ?? "" : "";
            if (surface != "markets" && surface != "education" && surface != "sales") return;
            PostToChat(new { type = "openExplore", surface });
        }
        catch { }
    }

    void OnChromeMessage(object? s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var r = doc.RootElement;
            var type = r.TryGetProperty("type", out var tp) ? tp.GetString() : null;
            if (type == "window") { HandleWindowCommand(r); BeginInvoke(new Action(PushChromeState)); return; }
            if (type != "chrome") return;
            var a = r.TryGetProperty("a", out var ap) ? ap.GetString() : null;
            int Id() => r.TryGetProperty("id", out var idp) && idp.TryGetInt32(out var v) ? v : -1;
            string Url() => r.TryGetProperty("url", out var up) ? up.GetString() ?? "" : "";
            string Task() => r.TryGetProperty("task", out var tkp) ? tkp.GetString() ?? "" : "";
            switch (a)
            {
                case "ready": _chromeReady = true; PushChromeState(); break;
                case "menuLayout":
                    _chromeMenuOpen = r.TryGetProperty("open", out var menuOpen) &&
                        menuOpen.ValueKind == JsonValueKind.True;
                    LayoutBrowserPane();
                    break;
                case "back": Active()?.View.CoreWebView2?.GoBack(); break;
                case "fwd": Active()?.View.CoreWebView2?.GoForward(); break;
                case "reload": Active()?.View.CoreWebView2?.Reload(); break;
                case "stop": Active()?.View.CoreWebView2?.Stop(); break;
                case "go": Navigate(Url()); break;
                case "newTab": AddTab(_homeUrl, true, true); break;
                case "selTab": SelectTabById(Id()); break;
                case "closeTab": CloseTabById(Id()); break;
                case "closeOthers": CloseOtherTabs(); break;
                case "device": CycleDeviceMode(); break;
                case "run": PostToChat(new { type = "runProject" }); break;
                case "darkPage":
                    _ = SetBrowserDarkModeAsync(!_browserDarkMode, notifyChat: true);
                    break;
                case "task": SendBrowserTask(Task()); break;
                // The star and the menu's bookmark list. Saving and deleting go
                // through the chat UI, which owns the stored list and pushes the
                // result back; opening one is pure navigation and stays here.
                case "bookmark":
                {
                    var bt = Active();
                    if (bt != null && !string.IsNullOrWhiteSpace(bt.Url))
                        PostToChat(new { type = "browserBookmarkToggle", url = bt.Url, title = ChromeTabTitle(bt) });
                    break;
                }
                case "bookmarkOpen":
                    if (r.TryGetProperty("url", out var bmOpen) && bmOpen.GetString() is { Length: > 0 } bmOpenUrl)
                        AddTab(bmOpenUrl, activate: true, navigate: true);
                    break;
                case "bookmarkRemove":
                    if (r.TryGetProperty("url", out var bmDel) && bmDel.GetString() is { Length: > 0 } bmDelUrl)
                        PostToChat(new { type = "browserBookmarkRemove", url = bmDelUrl });
                    break;
                case "zoomIn": Zoom(0.1); break;
                case "zoomOut": Zoom(-0.1); break;
                case "zoomReset": ResetZoom(); break;
                case "autofit": _ = AutoFitZoom(); break;
                case "sendPageAI": _ = SendPageToAI(false); break;
                case "sendShotAI": _ = SendPageToAI(true); break;
                case "sendSelMsg": _ = SendSelectedText("message"); break;
                case "sendSelNote": _ = SendSelectedText("note"); break;
                case "sendShotNote": _ = SendScreenshotToNotepad(); break;
                case "clear": _ = ClearBrowserData(); break;
                case "openSystem": OpenActiveInSystemBrowser(); break;
                case "hideChat": ToggleFull(); break;
                case "hideBrowser": ToggleBrowser(false); break;
            }
        }
        catch { }
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
        string surface = "classic";
        try
        {
            var cfg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".saz", "config.json");
            if (File.Exists(cfg))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(cfg));
                if (doc.RootElement.TryGetProperty("ui", out var ui))
                {
                    if (ui.TryGetProperty("theme", out var th)) theme = th.GetString() ?? "system";
                    if (ui.TryGetProperty("colorTheme", out var ct)) surface = ct.GetString() ?? "classic";
                }
            }
        }
        catch { }
        bool dark = theme == "dark" || (theme == "system" && SystemDark());
        _themeDark = dark;
        _themeSurface = "classic";
        if (dark) return Palette.Dark;
        return Palette.Light;
    }

    void ApplyTheme(Palette p)
    {
        _pal = p;
        // The WebView owns the complete bottom surface in both themes.
        Padding = Padding.Empty;
        _split.SplitterWidth = 5;
        _splitGrip.BackColor = p.Splitter;
        _splitGrip.Invalidate();
        _previewGrip.BackColor = p.PaneBg;
        _previewGrip.Invalidate();
        _browserPane.Radius = 0;
        BackColor = p.CanvasBg;
        try { _chat.DefaultBackgroundColor = p.PaneBg; } catch { }
        ApplyDwmChromeColor(p.CanvasBg);
        _split.BackColor = p.Splitter;
        RefreshTopOutline();
        _split.Panel1.BackColor = p.CanvasBg;
        // Panel2 paints the reserved browser top band; the browserPane below it
        // keeps its own PaneBg surface.
        _split.Panel2.BackColor = p.CanvasBg;
        _browserPane.BackColor = p.PaneBg;
        _browserPane.BorderColor = Color.Transparent;
        _browserPane.Invalidate();
        StyleBrowserPill();
        _content.BackColor = p.PaneBg;
        // The chrome bar is HTML (it themes itself from the pushed state); only its
        // pre-paint background needs to match so there is no flash.
        try { _chromeView.DefaultBackgroundColor = Color.Transparent; } catch { }
        foreach (var t in _tabs)
        {
            try { t.View.DefaultBackgroundColor = p.PaneBg; } catch { }
            if (t.View.CoreWebView2 != null)
                t.View.CoreWebView2.Profile.PreferredColorScheme =
                    (p.PaneBg.R < 128) ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;
        }
        PushChromeState();
    }

    // ── splitter grip ────────────────────────────────────────────────
    // Sits directly over the SplitContainer's splitter and owns the drag. Mouse
    // capture keeps every move coming here even while the cursor is over either
    // WebView, which is what makes the divider follow the pointer at all.
    void BuildSplitGrip()
    {
        _splitGrip.BackColor = _pal.Splitter;
        Controls.Add(_splitGrip);
        _splitGrip.MouseEnter += (_, __) => _splitGrip.Invalidate();
        _splitGrip.MouseLeave += (_, __) => _splitGrip.Invalidate();
        _splitGrip.Paint += (_, e) => PaintGrip(e, _splitGrip, _gripDragging, vertical: true);
        _splitGrip.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _gripDragging = true;
            _splitGrip.Capture = true;
            _splitGrip.Invalidate();
        };
        _splitGrip.MouseMove += (_, __) =>
        {
            if (_gripDragging) DragSplitTo(_split.PointToClient(Cursor.Position).X);
        };
        _splitGrip.MouseUp += (_, __) =>
        {
            if (!_gripDragging) return;
            _gripDragging = false;
            _splitGrip.Capture = false;
            _splitGrip.Invalidate();
            RememberBrowserSplit();
            AutoFitActiveBrowserIfNarrow();
        };
        // Double-click restores the automatic split, the same as never having dragged.
        _splitGrip.DoubleClick += (_, __) => { _browserManualWidth = 0; FitBrowserSplit(); PositionSplitGrip(); };
        _split.SplitterMoved += (_, __) => PositionSplitGrip();
        _split.SizeChanged += (_, __) => PositionSplitGrip();
    }

    static void PaintGrip(PaintEventArgs e, Control grip, bool dragging, bool vertical)
    {
        e.Graphics.Clear(grip.BackColor);
        bool hot = dragging || grip.ClientRectangle.Contains(grip.PointToClient(Cursor.Position));
        if (!hot) return;
        using var brush = new SolidBrush(Color.FromArgb(63, 185, 80));
        if (vertical)
        {
            int h = Math.Min(52, grip.Height);
            e.Graphics.FillRectangle(brush, (grip.Width - 2) / 2, (grip.Height - h) / 2, 2, h);
        }
        else
        {
            int w = Math.Min(52, grip.Width);
            e.Graphics.FillRectangle(brush, (grip.Width - w) / 2, (grip.Height - 2) / 2, w, 2);
        }
    }

    void DragSplitTo(int x)
    {
        int maximum = Math.Max(_split.Panel1MinSize,
            _split.Width - _split.SplitterWidth - _split.Panel2MinSize);
        int distance = Math.Clamp(x, _split.Panel1MinSize, maximum);
        if (distance == _split.SplitterDistance) return;
        _split.SplitterDistance = distance;
        // Remember the width so a later window resize does not undo the drag.
        _browserManualWidth = _split.Panel2.Width;
        PositionSplitGrip();
    }

    void PositionSplitGrip()
    {
        bool show = _browserOpen && !_full && !_split.Panel2Collapsed &&
            WindowState != FormWindowState.Minimized && _split.Width > 0 && _split.ClientSize.Height > 0;
        if (!show)
        {
            if (_splitGrip.Visible) _splitGrip.Visible = false;
            return;
        }
        var bounds = RectangleToClient(_split.RectangleToScreen(
            new Rectangle(_split.SplitterDistance, 0, _split.SplitterWidth, _split.ClientSize.Height)));
        // A couple of pixels of overhang per side make the divider easy to grab
        // without noticeably covering either pane.
        bounds.Inflate(2, 0);
        if (_splitGrip.Bounds != bounds) _splitGrip.Bounds = bounds;
        if (!_splitGrip.Visible) _splitGrip.Visible = true;
        _splitGrip.BringToFront();
    }

    TabItem? Active() => _active >= 0 && _active < _tabs.Count ? _tabs[_active] : null;

    async void AddTab(string url, bool activate, bool navigate)
    {
        var t = new TabItem { Url = url, Id = ++_tabSeq };
        // Explicit bounds, not Dock.Fill: a responsive preview sizes the page view to
        // the preview width so the page reflows for real (see LayoutContentViews).
        t.View.Dock = DockStyle.None;
        t.View.Bounds = PreviewViewport(_content.ClientRectangle);
        t.View.Visible = false;
        _content.Controls.Add(t.View);
        try { t.View.DefaultBackgroundColor = _pal.PaneBg; } catch { } // no black flash before load
        _tabs.Add(t);

                await t.View.EnsureCoreWebView2Async(_env);
        try { t.View.CoreWebView2.Profile.PreferredColorScheme =
            (_pal.PaneBg.R < 128) ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light; } catch { }
        await ConfigureBrowserDarkModeAsync(t);
        WireView(t);
        if (navigate) t.View.CoreWebView2.Navigate(url);
        if (activate) Activate(_tabs.IndexOf(t));
        PushChromeState();
    }

    void WireView(TabItem t)
    {
        var c = t.View.CoreWebView2;
        c.SourceChanged += (_, __) => { t.Url = c.Source; SyncTabs(); PushChromeState(); ReportBrowserUrl(t); };
        t.View.NavigationCompleted += (_, __) => { AutoFitActiveBrowserIfNarrow(); PushChromeState(); ReportBrowserUrl(t); };
        c.DocumentTitleChanged += (_, __) =>
        {
            t.Title = string.IsNullOrWhiteSpace(c.DocumentTitle) ? t.Url : c.DocumentTitle;
            PushChromeState();
            ReportBrowserUrl(t);
        };
        c.NewWindowRequested += (_, ev) =>
        {
            ev.Handled = true;
            AddTab(ev.Uri, activate: true, navigate: true);
        };
        // Only Boollm's own start page may talk to the shell from a browser tab.
        // Every other site's messages are dropped before they are even parsed.
        c.WebMessageReceived += (_, ev) => OnPageMessage(ev);
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

    const string BrowserDarkModeScript = """
(() => {
  const id = "boollm-browser-dark-mode";
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    style.textContent = `
      :root { color-scheme: dark !important; }
      html, body { background-color: #181a1b !important; color: #e8e6e3 !important; }
      body { background-image: none !important; }
      *, *::before, *::after { border-color: #45484a !important; }
      a { color: #76b7ff !important; }
      input, textarea, select, button {
        background-color: #25282a !important;
        color: #e8e6e3 !important;
        border-color: #4b4f52 !important;
      }
      table, th, td { border-color: #45484a !important; }
      [style*="background: white"], [style*="background:white"],
      [style*="background: #fff"], [style*="background:#fff"],
      [style*="background-color: white"], [style*="background-color:white"],
      [style*="background-color: #fff"], [style*="background-color:#fff"] {
        background-color: #181a1b !important;
      }
      [style*="color: black"], [style*="color:black"],
      [style*="color: #000"], [style*="color:#000"] {
        color: #e8e6e3 !important;
      }
      img, picture, video, canvas, svg { filter: none !important; opacity: 1 !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
})();
""";

    const string BrowserDarkModeRemoveScript = """
(() => { document.getElementById("boollm-browser-dark-mode")?.remove(); })();
""";

    async Task ConfigureBrowserDarkModeAsync(TabItem t)
    {
        var c = t.View.CoreWebView2;
        if (c == null) return;
        try
        {
            if (!string.IsNullOrWhiteSpace(t.DarkModeScriptId))
            {
                c.RemoveScriptToExecuteOnDocumentCreated(t.DarkModeScriptId);
                t.DarkModeScriptId = "";
            }
            if (_browserDarkMode)
            {
                t.DarkModeScriptId = await c.AddScriptToExecuteOnDocumentCreatedAsync(BrowserDarkModeScript);
                await c.ExecuteScriptAsync(BrowserDarkModeScript);
            }
            else
            {
                await c.ExecuteScriptAsync(BrowserDarkModeRemoveScript);
            }
        }
        catch { }
    }

    async Task SetBrowserDarkModeAsync(bool enabled, bool notifyChat = false)
    {
        _browserDarkMode = enabled;
        foreach (var tab in _tabs.ToArray())
            await ConfigureBrowserDarkModeAsync(tab);
        PushChromeState();
        if (notifyChat)
            PostToChat(new { type = "shellBrowserDarkMode", enabled });
    }

    void Activate(int i)
    {
        if (i < 0 || i >= _tabs.Count) return;
        _active = i;
        for (int k = 0; k < _tabs.Count; k++)
        {
            _tabs[k].View.Visible = (k == i);
        }
        LayoutContentViews();
        UpdateZoomLabel();
        PushChromeState();
        ReportBrowserUrl(null);
    }

    void CloseTab(int i)
    {
        if (i < 0 || i >= _tabs.Count) return;
        var t = _tabs[i];
        _content.Controls.Remove(t.View);
        try { t.View.Dispose(); } catch { }
        _tabs.RemoveAt(i);
        if (_tabs.Count == 0) { AddTab(_homeUrl, true, true); return; }
        Activate(Math.Min(i, _tabs.Count - 1));
    }

    void CloseOtherTabs()
    {
        var keep = Active();
        if (keep == null) return;
        foreach (var t in _tabs.ToArray())
        {
            if (ReferenceEquals(t, keep)) continue;
            _content.Controls.Remove(t.View);
            try { t.View.Dispose(); } catch { }
            _tabs.Remove(t);
        }
        _active = 0;
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
    void ResetZoom()
    {
        var t = Active();
        if (t?.View.CoreWebView2 == null) return;
        t.View.ZoomFactor = 1.0;
        UpdateZoomLabel();
    }
    async Task AutoFitZoom(bool allowZoomIn = true)
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
            var maxZoom = allowZoomIn ? 1.5 : 1.0;
            var zoom = Math.Clamp(Math.Floor((viewWidth / Math.Max(1, pageWidth)) * 100) / 100, 0.3, maxZoom);
            t.View.ZoomFactor = zoom;
            UpdateZoomLabel();
        }
        catch { }
    }
    async void AutoFitActiveBrowserIfNarrow()
    {
        var t = Active();
        if (!_browserOpen || t?.View.CoreWebView2 == null) return;
        // A responsive preview is narrow on purpose — zooming it out would stop it
        // showing the page as it actually looks at that width.
        if (_deviceWidth > 0) return;
        if (t.View.ClientSize.Width >= 560) return;
        await AutoFitZoom(allowZoomIn: false);
    }
    void UpdateZoomLabel() => PushChromeState();
    void ToggleFull()
    {
        if (!_browserOpen) ToggleBrowser(true);
        _full = !_full;
        _split.Panel1Collapsed = _full; // hide the chat pane → browser full width
        PositionSplitGrip();
        PushChromeState();
    }

    // Responsive/device emulation, mirroring the web browser's Desktop → Mobile
    // → Tablet presets. Uses the WebView2 DevTools protocol on the active tab.
    async void CycleDeviceMode()
    {
        _deviceModeIdx = (_deviceModeIdx + 1) % DeviceModes.Length;
        _deviceWidth = DeviceModes[_deviceModeIdx].w;
        _deviceCustomWidth = false;
        LayoutContentViews();
        await ApplyDeviceModeAsync();
    }
    async System.Threading.Tasks.Task ApplyDeviceModeAsync()
    {
        var m = DeviceModes[_deviceModeIdx];
        PushChromeState();
        var cw = Active()?.View.CoreWebView2;
        if (cw == null) return;
        try
        {
            // The view is already the preview's width, so only mobile emulation (touch,
            // mobile viewport meta) still needs an override. Forcing a metrics override
            // on a wider control is what made the preview show a scaled, misleading page.
            if (_deviceWidth <= 0 || !m.mobile)
            {
                await cw.CallDevToolsProtocolMethodAsync("Emulation.clearDeviceMetricsOverride", "{}");
                await cw.CallDevToolsProtocolMethodAsync("Emulation.setTouchEmulationEnabled", "{\"enabled\":false}");
            }
            else
            {
                double dpi = _content.DeviceDpi / 96.0;
                int width = Math.Max(PreviewMinWidth, (int)Math.Round(PreviewViewport(_content.ClientRectangle).Width / dpi));
                int height = Math.Max(320, (int)Math.Round(_content.ClientRectangle.Height / dpi));
                await cw.CallDevToolsProtocolMethodAsync("Emulation.setDeviceMetricsOverride",
                    $"{{\"width\":{width},\"height\":{height},\"deviceScaleFactor\":0,\"mobile\":true}}");
                await cw.CallDevToolsProtocolMethodAsync("Emulation.setTouchEmulationEnabled", "{\"enabled\":true}");
            }
        }
        catch { }
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
    bool _browserEmbedded = false;
    bool BrowserPaneIsOpen() => _browserEmbedded || (!_split.Panel2Collapsed && _browserPane.Visible);

    void RestoreBrowserPaneToSplit()
    {
        if (!_browserEmbedded) return;
        _browserEmbedded = false;
        _browserPane.Visible = false;
        _browserPane.Dock = DockStyle.Fill;
        _split.Panel2.Controls.Add(_browserPane);
        _browserPane.Visible = true;
    }

    void DockBrowserInExplore(JsonElement root)
    {
        if (!root.TryGetProperty("rect", out var rect) || rect.ValueKind != JsonValueKind.Object) return;
        static double Number(JsonElement value, string name) =>
            value.TryGetProperty(name, out var property) && property.TryGetDouble(out var number) ? number : 0;
        double viewportWidth = Number(rect, "viewportWidth"), viewportHeight = Number(rect, "viewportHeight");
        double x = Number(rect, "x"), y = Number(rect, "y");
        double width = Number(rect, "width"), height = Number(rect, "height");
        if (viewportWidth <= 0 || viewportHeight <= 0 || width < 2 || height < 2) return;

        _browserOpen = true;
        HideBrowserPill();
        _split.Panel2Collapsed = true;
        _split.Panel1Collapsed = false;
        if (_browserPane.Parent != this)
        {
            _browserPane.Visible = false;
            _browserPane.Dock = DockStyle.None;
            Controls.Add(_browserPane);
        }
        _browserEmbedded = true;
        var chatOrigin = PointToClient(_chat.PointToScreen(Point.Empty));
        double scaleX = _chat.ClientSize.Width / viewportWidth;
        double scaleY = _chat.ClientSize.Height / viewportHeight;
        _browserPane.Bounds = new Rectangle(
            chatOrigin.X + (int)Math.Round(x * scaleX),
            chatOrigin.Y + (int)Math.Round(y * scaleY),
            Math.Max(1, (int)Math.Round(width * scaleX)),
            Math.Max(1, (int)Math.Round(height * scaleY)));
        _browserPane.Visible = true;
        _browserPane.BringToFront();
        if (_tabs.Count == 0) AddTab(_homeUrl, activate: true, navigate: true);
        LayoutBrowserPane();
        PostToChat(new { type = "shellBrowser", open = true, embedded = true });
        PushChromeState();
        ReportBrowserUrl(null);
    }

    void UndockExploreBrowser()
    {
        if (!_browserEmbedded) return;
        RestoreBrowserPaneToSplit();
        _browserOpen = false;
        _split.Panel2Collapsed = true;
        _split.Panel1Collapsed = false;
        ShowBrowserPill();
        PostToChat(new { type = "shellBrowser", open = false, embedded = false });
        ReportBrowserUrl(null);
    }

    // Floating edge pill: when the full-window browser is closed it collapses to
    // a small tab peeking off the right edge that reopens it.
    readonly RoundedButton _browserPill = new();
    void BuildBrowserPill()
    {
        _browserPill.Text = "\u2039"; // slim edge chevron: reopen the right browser pane
        _browserPill.Size = new Size(20, 30);
        _browserPill.Font = new Font("Segoe UI Symbol", 14f);
        _browserPill.Radius = 7;
        _browserPill.FlatStyle = FlatStyle.Flat;
        _browserPill.FlatAppearance.BorderSize = 0;
        _browserPill.TabStop = false;
        _browserPill.Visible = false;
        _browserPill.Cursor = Cursors.Hand;
        _browserPill.Click += (_, __) => ToggleBrowser(true);
        var tt = new ToolTip(); tt.SetToolTip(_browserPill, "Open browser");
        Controls.Add(_browserPill);
        _browserPill.BringToFront();
        StyleBrowserPill();
        PositionBrowserPill();
        Resize += (_, __) => { if (_browserPill.Visible) PositionBrowserPill(); };
    }
    void StyleBrowserPill()
    {
        _browserPill.ForeColor = _pal.Text;
        _browserPill.Fill = Color.Transparent;
        _browserPill.HoverFill = Color.FromArgb(32, _pal.Text);
        _browserPill.DownFill = Color.FromArgb(48, _pal.Text);
        _browserPill.Border = Color.Transparent;
        _browserPill.BackColor = Color.Transparent;
    }
    void PositionBrowserPill()
    {
        _browserPill.Left = ClientSize.Width - 15; // only the chevron peeks in
        _browserPill.Top = Math.Max(0, (ClientSize.Height - _browserPill.Height) / 2);
    }
    void ShowBrowserPill()
    {
        // Browser remains available from the persistent top toolbar. Do not
        // place a second launcher over the right edge of the chat.
        _browserPill.Visible = false;
    }
    void HideBrowserPill() => _browserPill.Visible = false;

    void FitBrowserSplit()
    {
        if (_fittingBrowserSplit || _split.Width <= 0) return;
        _fittingBrowserSplit = true;
        try
        {
        // Below this width the trading ticket stops being a compact control
        // strip and turns into a tall stack of individually wrapped fields.
        // Make the splitter's drag limit agree with the UI's compact breakpoint.
        const int chatMin = 520;
        const int browserMin = 340;
        int panelWidth = Math.Max(0, _split.Width - _split.SplitterWidth);
        if (panelWidth <= chatMin + browserMin)
        {
            // Preserve the browser chrome first. The chat remains usable in its
            // compact responsive mode while browser tabs keep enough room.
            int compactChatMin = Math.Max(20, Math.Min(180, panelWidth / 3));
            int compactBrowserMin = Math.Max(20, Math.Min(browserMin, panelWidth - compactChatMin));
            _split.Panel1MinSize = compactChatMin;
            _split.Panel2MinSize = compactBrowserMin;
            int compactBrowserW = Math.Min(browserMin, Math.Max(compactBrowserMin, panelWidth - compactChatMin));
            _split.SplitterDistance = Math.Max(compactChatMin, panelWidth - compactBrowserW);
            BeginInvoke(new Action(AutoFitActiveBrowserIfNarrow));
            return;
        }

        _split.Panel1MinSize = chatMin;
        _split.Panel2MinSize = browserMin;
        int available = panelWidth;
        // A width the user dragged to wins over the automatic split. Without this the
        // pane snapped back to an even split on every window resize, which read as the
        // splitter not working at all.
        // Default to an even split — the chat stays fully usable while the browser
        // is open; the user drags the splitter for anything else.
        int preferredBrowserW = _browserManualWidth > 0
            ? _browserManualWidth
            : WindowState == FormWindowState.Maximized
                ? (int)Math.Round(available * 0.40)
                : available / 2;
        int browserW = Math.Clamp(preferredBrowserW, browserMin, Math.Max(browserMin, available - chatMin));
        int chatW = Math.Max(chatMin, available - browserW);
        _split.SplitterDistance = Math.Min(chatW, _split.Width - browserMin);
        BeginInvoke(new Action(AutoFitActiveBrowserIfNarrow));
        }
        finally
        {
            _fittingBrowserSplit = false;
            RememberBrowserSplit();
            PositionSplitGrip();
        }
    }

    void RememberBrowserSplit()
    {
        if (!_browserOpen || _full || _split.Panel2Collapsed ||
            WindowState == FormWindowState.Minimized || _split.Panel2.Width < 20) return;
        _lastUsableBrowserWidth = _split.Panel2.Width;
    }

    void RestoreBrowserSplitAfterMinimize()
    {
        if (!_browserOpen || _full || _split.Panel2Collapsed || _split.Width <= 0) return;
        int available = Math.Max(0, _split.Width - _split.SplitterWidth);
        if (available < 40) return;
        int browserWidth = Math.Clamp(
            _lastUsableBrowserWidth > 0 ? _lastUsableBrowserWidth : available / 2,
            Math.Min(20, available), Math.Max(20, available - 20));
        _split.Panel1MinSize = Math.Min(300, Math.Max(20, available - browserWidth));
        _split.Panel2MinSize = Math.Min(340, Math.Max(20, browserWidth));
        _split.SplitterDistance = Math.Max(_split.Panel1MinSize, available - browserWidth);
        BeginInvoke(new Action(AutoFitActiveBrowserIfNarrow));
    }

    // When the browser opens in a small window, grow it so the chat side keeps room
    // instead of being squeezed (chat holds a ~185px sidebar + the conversation).
    void GrowForBrowser()
    {
        if (WindowState == FormWindowState.Maximized || IsSnappedToWorkingArea()) return;
        var wa = Screen.FromHandle(Handle).WorkingArea;
        // Respect a window the user has docked against either screen edge: widening
        // it (opening the browser or notepad) looked like it ignored the snap.
        const int edgeTol = 24;
        bool touchesEdge = Math.Abs(Left - wa.Left) <= edgeTol || Math.Abs(Right - wa.Right) <= edgeTol;
        if (touchesEdge && Width < wa.Width - edgeTol) return;
        const int desiredMin = 1240; // sidebar + chat + notepad + a usable browser pane
        int target = Math.Min(wa.Width, Math.Max(Width, desiredMin));
        if (target <= Width) return;
        int newLeft = Left;
        if (newLeft + target > wa.Right) newLeft = Math.Max(wa.Left, wa.Right - target);
        Left = newLeft;
        Width = target;
    }

    void ToggleBrowser(bool? force = null, bool ensureTab = true)
    {
        if (_browserEmbedded) RestoreBrowserPaneToSplit();
        _browserOpen = force ?? !_browserOpen;
        if (_browserOpen)
        {
            HideBrowserPill();
            // Reveal and size both panes in one layout transaction. Painting the
            // open pane before assigning its split width caused a visible jump.
            _split.SuspendLayout();
            try
            {
                if (_split.Panel1Collapsed) { _split.Panel1Collapsed = false; _full = false; }
                _split.Panel2Collapsed = false;
                if (_restoreBrowserWidth > 0)
                {
                    const int chatMin = 300, browserMin = 340;
                    int available = Math.Max(0, _split.Width - _split.SplitterWidth);
                    int browserWidth = Math.Clamp(_restoreBrowserWidth, Math.Min(browserMin, available), Math.Max(browserMin, available - chatMin));
                    _split.Panel1MinSize = Math.Min(chatMin, Math.Max(20, available - browserWidth));
                    _split.Panel2MinSize = Math.Min(browserMin, Math.Max(20, browserWidth));
                    _split.SplitterDistance = Math.Max(_split.Panel1MinSize, available - browserWidth);
                    _browserManualWidth = browserWidth;
                    _restoreBrowserWidth = 0;
                }
                else FitBrowserSplit();
            }
            finally
            {
                _split.ResumeLayout(true);
            }
            RememberBrowserSplit();
            if (ensureTab && _tabs.Count == 0) AddTab(_homeUrl, activate: true, navigate: true);
            var t = Active();
            if (t != null && t.View.CoreWebView2 != null)
            {
                var src = t.View.CoreWebView2.Source?.ToString() ?? "";
                if (string.IsNullOrEmpty(src) || src == "about:blank")
                {
                    t.Url = _homeUrl;
                    t.View.CoreWebView2.Navigate(_homeUrl);
                }
            }
        }
        else
        {
            CloseChromeMenu();
            _split.Panel2Collapsed = true;
            _split.Panel1Collapsed = false; // restore the chat
            _full = false;
            ShowBrowserPill();
        }
        PositionSplitGrip();
        PostToChat(new { type = "shellBrowser", open = _browserOpen });
        PushChromeState();
        ReportBrowserUrl(null);
    }

    // ── bridge: messages from the chat UI ────────────────────────────
    void OnChatMessage(object? s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var tp) ? tp.GetString() : null;
            if (type == "window")
            {
                HandleWindowCommand(root);
                BeginInvoke(new Action(PushWindowState));
                return;
            }
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
            if (type == "folder")
            {
                var id = root.TryGetProperty("id", out var idp) ? idp.GetString() : null;
                var initial = root.TryGetProperty("initial", out var ip) ? ip.GetString() : null;
                var title = root.TryGetProperty("title", out var titlep) ? titlep.GetString() : null;
                try
                {
                    var picked = PickFolderNative(initial, title);
                    PostToChat(new { type = "folder", id, ok = !string.IsNullOrWhiteSpace(picked), path = picked });
                }
                catch (Exception ex)
                {
                    PostToChat(new { type = "folder", id, ok = false, error = ex.Message });
                }
                return;
            }
            if (type == "notify")
            {
                var title = root.TryGetProperty("title", out var tp2) ? tp2.GetString() ?? "Boollm" : "Boollm";
                var body = root.TryGetProperty("body", out var bp) ? bp.GetString() ?? "" : "";
                ShowToast(title, body);
                return;
            }
            if (type == "pet")
            {
                HandlePetMessage(root);
                return;
            }
            if (type != "browser") return;
            var cmd = root.TryGetProperty("cmd", out var cp) ? cp.GetString() : null;
            switch (cmd)
            {
                case "dock": DockBrowserInExplore(root); break;
                case "undock": UndockExploreBrowser(); break;
                case "toggle": ToggleBrowser(); break;
                case "show": ToggleBrowser(true); break;
                case "hide": ToggleBrowser(false); break;
                case "navigate":
                    if (root.TryGetProperty("url", out var up) && up.GetString() is { } u)
                    {
                        if (!_browserOpen) ToggleBrowser(true, ensureTab: false);
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
                case "studioRecordStart":
                    _ = StartStudioRecordingAsync(
                        root.TryGetProperty("url", out var recordUrl) ? recordUrl.GetString() ?? "" : "",
                        root.TryGetProperty("maxSeconds", out var maxSeconds) && maxSeconds.TryGetInt32(out var seconds) ? seconds : 30,
                        !root.TryGetProperty("privacy", out var privacy) || privacy.ValueKind != JsonValueKind.False,
                        !root.TryGetProperty("cursor", out var cursor) || cursor.ValueKind != JsonValueKind.False);
                    break;
                case "studioRecordStop":
                    _ = StopStudioRecordingAsync();
                    break;
                case "openDownloads":
                    try
                    {
                        var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                        Directory.CreateDirectory(downloads);
                        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{downloads}\"") { UseShellExecute = true });
                    }
                    catch (Exception ex)
                    {
                        PostToChat(new { type = "studioFolder", ok = false, error = ex.Message });
                    }
                    break;
                case "context":
                    if (root.TryGetProperty("id", out var cidp) && cidp.GetString() is { } cid)
                    {
                        _ = SendContextAsync(cid);
                    }
                    break;
                // Fast DOM text plus OCR of only the quote strip. Robinhood Legend
                // renders its live chart quote outside useful body.innerText, while
                // full-page OCR is too slow to poll every few seconds.
                case "pageText":
                    if (root.TryGetProperty("id", out var ptid) && ptid.GetString() is { } pageTextId)
                    {
                        _ = SendPageTextAsync(pageTextId);
                    }
                    break;
                // Bookmarks live in Boollm's settings, next to history and
                // permissions. The chat UI owns that store and pushes the list
                // here whenever it changes; the shell only mirrors it into the
                // browser chrome.
                case "bookmarks":
                    _bookmarks.Clear();
                    if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in items.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.Object) continue;
                            var bmUrl = item.TryGetProperty("url", out var bu) ? bu.GetString() ?? "" : "";
                            if (string.IsNullOrWhiteSpace(bmUrl)) continue;
                            var bmTitle = item.TryGetProperty("title", out var bt) ? bt.GetString() ?? "" : "";
                            _bookmarks.Add((bmUrl, string.IsNullOrWhiteSpace(bmTitle) ? bmUrl : bmTitle));
                        }
                    }
                    PushChromeState();
                    break;
                case "reloadPerms": ReadPerms(); break;
                case "snip":
                    var target = root.TryGetProperty("target", out var sp) ? sp.GetString() ?? "message" : "message";
                    _ = StartScreenSnipAsync(target);
                    break;
                case "theme":
                    var pal = ResolveTheme();
                    if (root.TryGetProperty("dark", out var dk))
                    {
                        _themeDark = dk.GetBoolean();
                        if (_themeDark) pal = Palette.Dark;
                        else
                        {
                            _themeSurface = "classic";
                            pal = Palette.Light;
                        }
                    }
                    if (root.TryGetProperty("browserDark", out var browserDark))
                        _ = SetBrowserDarkModeAsync(browserDark.GetBoolean());
                    ApplyTheme(pal);
                    break;
            }
        }
        catch { }
    }

    void HandlePetMessage(JsonElement root)
    {
        var enabled = root.TryGetProperty("enabled", out var enabledProperty) && enabledProperty.ValueKind == JsonValueKind.True;
        if (!enabled)
        {
            SetPetEnabled(false);
            return;
        }
        SetPetEnabled(true);
        if (_pet is null) return;
        var stateText = root.TryGetProperty("state", out var stateProperty) ? stateProperty.GetString() ?? "idle" : "idle";
        var state = stateText switch
        {
            "browsing" => BoollmPetDisplayState.Browsing,
            "coding" => BoollmPetDisplayState.Coding,
            _ => BoollmPetDisplayState.Idle
        };
        var title = root.TryGetProperty("title", out var titleProperty) ? titleProperty.GetString() ?? "" : "";
        var chatName = root.TryGetProperty("chat", out var chatProperty) ? chatProperty.GetString() ?? "" : "";
        var detail = root.TryGetProperty("detail", out var detailProperty) ? detailProperty.GetString() ?? "" : "";
        var active = root.TryGetProperty("active", out var activeProperty) && activeProperty.ValueKind == JsonValueKind.True;
        var completed = root.TryGetProperty("completed", out var completedProperty) && completedProperty.ValueKind == JsonValueKind.True;
        var reduceMotion = root.TryGetProperty("reduceMotion", out var motionProperty) && motionProperty.ValueKind == JsonValueKind.True;
        var darkMode = root.TryGetProperty("dark", out var darkProperty) && darkProperty.ValueKind == JsonValueKind.True;
        _pet.Sync(state, chatName, title, detail, active, completed, reduceMotion, darkMode);
    }

    void SetPetEnabled(bool enabled)
    {
        if (!enabled)
        {
            _pet?.Hide();
            return;
        }
        if (_pet is null || _pet.IsDisposed)
        {
            _pet = new BoollmPetForm(
                () =>
                {
                    SetPetEnabled(false);
                    PostToChat(new { type = "petPreference", enabled = false });
                },
                text => PostToChat(new { type = "petReply", text }),
                () => PostToChat(new { type = "petStop" }));
        }
        if (!_pet.Visible) _pet.Show();
    }

    void PostToChat(object o)
    {
        try { _chat.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(o)); } catch { }
    }

    void PushWindowState() =>
        PostToChat(new
        {
            type = "shellWindowState",
            maximized = WindowState == FormWindowState.Maximized
        });

    NotifyIcon? _notifyIcon;
    void ShowToast(string title, string body)
    {
        BeginInvoke(new Action(() =>
        {
            try
            {
                if (_notifyIcon == null)
                {
                    var iconPath = Path.Combine(AppContext.BaseDirectory, "saz.ico");
                    _notifyIcon = new NotifyIcon
                    {
                        Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
                        Visible = true,
                        Text = "Boollm",
                    };
                }
                _notifyIcon.ShowBalloonTip(4000, title, body, ToolTipIcon.Info);
                FlashTaskbar();
            }
            catch { }
        }));
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    void FlashTaskbar()
    {
        try
        {
            var fw = new FLASHWINFO
            {
                cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<FLASHWINFO>(),
                hwnd = Handle,
                dwFlags = 0x3,
                uCount = 3,
                dwTimeout = 0,
            };
            FlashWindowEx(ref fw);
        }
        catch { }
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

    // Fast page read: script only, no OCR, so it can be polled.
    async Task SendPageTextAsync(string id)
    {
        var t = Active();
        var paneOpen = BrowserPaneIsOpen();
        if (t?.View.CoreWebView2 == null || !paneOpen)
        {
            PostToChat(new { type = "pageText", id, open = paneOpen, url = "", title = "", text = "" });
            return;
        }
        try
        {
            var json = await t.View.CoreWebView2.ExecuteScriptAsync(
                "(function(){return {url:location.href,title:document.title,text:(document.body?document.body.innerText:'').slice(0,20000)}})()");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var domText = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
            var snapshotText = await ReadBrowserDomSnapshotTextAsync(t);
            var renderedText = await ReadBrowserAccessibilityTextAsync(t);
            var ocr = await ReadVisibleBrowserQuoteOcrAsync(t);
            PostToChat(new
            {
                type = "pageText",
                id,
                open = paneOpen,
                url = root.TryGetProperty("url", out var u) ? u.GetString() ?? t.Url : t.Url,
                title = root.TryGetProperty("title", out var ti) ? ti.GetString() ?? t.Title : t.Title,
                text = string.Join("\n", new[] { domText, snapshotText, renderedText }.Where(value => !string.IsNullOrWhiteSpace(value))),
                ocr
            });
        }
        catch (Exception ex)
        {
            PostToChat(new { type = "pageText", id, open = paneOpen, url = t.Url, title = t.Title, text = "", error = ex.Message });
        }
    }

    async Task SendContextAsync(string id)
    {
        var t = Active();
        var paneOpen = BrowserPaneIsOpen();
        if (t?.View.CoreWebView2 == null || !paneOpen)
        {
            PostToChat(new { type = "context", id, browser = new { open = paneOpen, url = "", title = "", text = "" } });
            return;
        }
        try
        {
            var json = await t.View.CoreWebView2.ExecuteScriptAsync(
                "(function(){return {url:location.href,title:document.title,text:(document.body?document.body.innerText:'')}})()");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var domText = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
            var snapshotText = await ReadBrowserDomSnapshotTextAsync(t);
            var renderedText = await ReadBrowserAccessibilityTextAsync(t);
            var ocr = await ReadVisibleBrowserOcrAsync(t);
            PostToChat(new
            {
                type = "context",
                id,
                browser = new
                {
                    open = paneOpen,
                    url = root.TryGetProperty("url", out var u) ? u.GetString() ?? t.Url : t.Url,
                    title = root.TryGetProperty("title", out var ti) ? ti.GetString() ?? t.Title : t.Title,
                    text = string.Join("\n", new[] { domText, snapshotText, renderedText }.Where(value => !string.IsNullOrWhiteSpace(value))),
                    ocr
                }
            });
        }
        catch (Exception ex)
        {
            PostToChat(new { type = "context", id, browser = new { open = paneOpen, url = t.Url, title = t.Title, text = "", error = ex.Message } });
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

    async Task<string> ReadBrowserAccessibilityTextAsync(TabItem t)
    {
        if (t.View.CoreWebView2 == null) return "";
        try
        {
            var json = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Accessibility.getFullAXTree", "{}");
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array) return "";
            var lines = new List<string>();
            var length = 0;
            foreach (var node in nodes.EnumerateArray())
            {
                if (!node.TryGetProperty("name", out var name) || !name.TryGetProperty("value", out var value)) continue;
                var text = value.GetString()?.Trim();
                // Repeated cell values are meaningful in trading tables (mark
                // and last are commonly identical). De-duplicating AX names
                // silently removed those cells and made a complete position
                // row fail the UI parser.
                if (string.IsNullOrWhiteSpace(text)) continue;
                lines.Add(text);
                length += text.Length + 1;
                if (length >= 40000) break;
            }
            return string.Join("\n", lines);
        }
        catch { return ""; }
    }

    // ── acting on controls the page does not expose to querySelectorAll ────
    // Reading Legend already goes through CDP because its UI lives in React
    // portals, shadow DOM and embedded frames (see the DOM snapshot reader
    // below). Clicking did not, so it searched the top document, found nothing,
    // and reported "no buy control on the page" while the button sat on screen.
    // The accessibility tree sees every one of those surfaces, and a backend
    // node id from it resolves to the real element regardless of where it lives.
    static readonly string[] ClickRoles = { "button", "link", "menuitem", "menuitemradio", "tab", "radio", "checkbox", "switch" };
    static readonly string[] TypeRoles = { "textbox", "searchbox", "spinbutton", "combobox" };
    static readonly string[] SelectRoles = { "combobox", "listbox", "menu", "popupbutton" };
    static readonly string[] AnyControlRoles = { "button", "link", "menuitem", "menuitemradio", "tab", "radio", "checkbox",
        "switch", "textbox", "searchbox", "spinbutton", "combobox", "listbox" };

    static string AxName(JsonElement node) =>
        node.TryGetProperty("name", out var n) && n.TryGetProperty("value", out var v) ? (v.GetString() ?? "").Trim() : "";
    static string AxRole(JsonElement node) =>
        node.TryGetProperty("role", out var r) && r.TryGetProperty("value", out var v) ? (v.GetString() ?? "") : "";

    async Task<JsonDocument?> AxTreeAsync(TabItem t)
    {
        if (t.View.CoreWebView2 == null) return null;
        try
        {
            var json = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Accessibility.getFullAXTree", "{}");
            return JsonDocument.Parse(json);
        }
        catch { return null; }
    }

    // The narrowest name that contains the query wins, exact matches first — so
    // "Buy" picks the Buy button, not a container whose name happens to include
    // the word.
    async Task<(string objectId, string name)> ResolveAxControlAsync(TabItem t, string query, string[] roles)
    {
        using var doc = await AxTreeAsync(t);
        if (doc == null || !doc.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            return ("", "");
        var want = query.Trim().ToLowerInvariant();
        long bestBackend = 0;
        var bestName = "";
        var bestScore = long.MaxValue;
        foreach (var node in nodes.EnumerateArray())
        {
            if (node.TryGetProperty("ignored", out var ignored) && ignored.ValueKind == JsonValueKind.True) continue;
            if (!node.TryGetProperty("backendDOMNodeId", out var backendProp) || !backendProp.TryGetInt64(out var backend)) continue;
            if (roles.Length > 0 && Array.IndexOf(roles, AxRole(node)) < 0) continue;
            var name = AxName(node);
            if (name.Length == 0) continue;
            var lower = name.ToLowerInvariant();
            if (!lower.Contains(want)) continue;
            var rank = lower == want ? 0 : lower.StartsWith(want) ? 1 : 2;
            var score = rank * 100000L + name.Length;
            if (score < bestScore) { bestScore = score; bestBackend = backend; bestName = name; }
        }
        if (bestBackend == 0) return ("", "");
        try
        {
            var resolved = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync(
                "DOM.resolveNode", "{\"backendNodeId\":" + bestBackend + "}");
            using var rdoc = JsonDocument.Parse(resolved);
            if (rdoc.RootElement.TryGetProperty("object", out var obj) && obj.TryGetProperty("objectId", out var oid))
                return (oid.GetString() ?? "", bestName);
        }
        catch { }
        return ("", bestName);
    }

    // Side selection must be exact. Legend's "Buy MKT" and "Short MKT"
    // buttons submit immediately, while plain "Buy"/"Short" only select a
    // side. A fuzzy Buy match can therefore place two orders in one send.
    async Task<(string objectId, string name)> ResolveAxExactControlAsync(TabItem t, string query, string[] roles)
    {
        using var doc = await AxTreeAsync(t);
        if (doc == null || !doc.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            return ("", "");
        long backend = 0;
        var matchedName = "";
        foreach (var node in nodes.EnumerateArray())
        {
            if (node.TryGetProperty("ignored", out var ignored) && ignored.ValueKind == JsonValueKind.True) continue;
            if (roles.Length > 0 && Array.IndexOf(roles, AxRole(node)) < 0) continue;
            var name = AxName(node);
            if (!string.Equals(name, query.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
            if (node.TryGetProperty("backendDOMNodeId", out var bp) && bp.TryGetInt64(out backend)) matchedName = name;
            if (backend != 0) break;
        }
        if (backend == 0) return ("", "");
        try
        {
            var resolved = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync(
                "DOM.resolveNode", "{\"backendNodeId\":" + backend + "}");
            using var rdoc = JsonDocument.Parse(resolved);
            if (rdoc.RootElement.TryGetProperty("object", out var obj) && obj.TryGetProperty("objectId", out var oid))
                return (oid.GetString() ?? "", matchedName);
        }
        catch { }
        return ("", matchedName);
    }

    async Task<string> CallOnAxNodeAsync(TabItem t, string objectId, string function, string? argJson = null)
    {
        if (t.View.CoreWebView2 == null || string.IsNullOrEmpty(objectId)) return "";
        var args = argJson == null ? "" : ",\"arguments\":[{\"value\":" + argJson + "}]";
        var payload = "{\"objectId\":" + JsonSerializer.Serialize(objectId) +
            ",\"functionDeclaration\":" + JsonSerializer.Serialize(function) + args +
            ",\"returnByValue\":true,\"awaitPromise\":true}";
        try
        {
            var json = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.callFunctionOn", payload);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("exceptionDetails", out _)) return "";
            if (doc.RootElement.TryGetProperty("result", out var result) && result.TryGetProperty("value", out var value))
                return value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ToString();
        }
        catch { }
        return "";
    }

    // React tracks its own copy of an input's value, so a plain el.value =
    // assignment is reverted on the next render. Going through the prototype's
    // native setter is what makes the framework notice.
    const string AxTypeFunction =
        "function(v){var el=this;try{el.scrollIntoView({block:'center'})}catch(_){}el.focus();" +
        "var proto=(typeof HTMLTextAreaElement!=='undefined'&&el instanceof HTMLTextAreaElement)?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
        "var d=Object.getOwnPropertyDescriptor(proto,'value');" +
        "if(d&&d.set){d.set.call(el,String(v))}else if('value' in el){el.value=String(v)}else{el.textContent=String(v)}" +
        "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
        "return 'typed '+String(v).length+' chars'}";

    const string AxClickFunction =
        "function(){var el=this;try{el.scrollIntoView({block:'center',inline:'center'})}catch(_){}" +
        "var r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;" +
        "['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(type){" +
        "try{el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window}))}catch(_){}});" +
        "try{if(typeof el.click==='function')el.click()}catch(_){}return 'clicked'}";

    const string AxSelectFunction =
        "function(v){var el=this,want=String(v).toLowerCase().trim();" +
        "if(el.tagName!=='SELECT')return '';" +
        "var opts=[].slice.call(el.options||[]);" +
        "var hit=opts.filter(function(o){return String(o.text||'').toLowerCase().trim()===want||String(o.value||'').toLowerCase().trim()===want})[0]" +
        "||opts.filter(function(o){return String(o.text||'').toLowerCase().indexOf(want)>=0})[0];" +
        "if(!hit)return '';" +
        "var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');" +
        "if(d&&d.set){d.set.call(el,hit.value)}else{el.value=hit.value}" +
        "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
        "return 'selected '+(hit.text||hit.value)}";

    // Legend does not render its Cancel button until a working-order row is
    // opened. Find the symbol next to a live status in AX reading order, open
    // that row, then resolve the newly rendered Cancel control. This is kept
    // symbol-scoped so a page with several working orders cannot cancel an
    // arbitrary row.
    async Task<string> TryCancelOrderAccessibilityAsync(TabItem t, string symbol)
    {
        symbol = (symbol ?? "").Trim().ToUpperInvariant();
        if (t.View.CoreWebView2 == null || symbol.Length == 0) return "";
        using var doc = await AxTreeAsync(t);
        if (doc == null || !doc.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            return "";
        var list = nodes.EnumerateArray().ToList();
        long backend = 0;
        // Prefer the selectable data-grid row itself. Clicking a symbol cell
        // bubbles in ordinary HTML, but Legend attaches its expansion handler
        // to the ARIA row and ignores synthetic events dispatched on the cell.
        for (var i = 0; i < list.Count; i++)
        {
            var name = AxName(list[i]);
            if (!string.Equals(AxRole(list[i]), "row", StringComparison.OrdinalIgnoreCase) ||
                !name.Contains(symbol, StringComparison.OrdinalIgnoreCase) ||
                !System.Text.RegularExpressions.Regex.IsMatch(name,
                    @"\b(Working|Pending|Open|Submitted|Queued|New|Partially filled)\b",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
            if (list[i].TryGetProperty("backendDOMNodeId", out var rowBackend) && rowBackend.TryGetInt64(out backend)) break;
        }
        // Older broker tables expose only selectable cells. Keep that fallback,
        // but current Legend is expected to take the row path above.
        for (var i = 0; backend == 0 && i < list.Count; i++)
        {
            if (!string.Equals(AxName(list[i]), symbol, StringComparison.OrdinalIgnoreCase)) continue;
            var from = Math.Max(0, i - 8);
            var to = Math.Min(list.Count - 1, i + 12);
            var nearby = string.Join(" ", list.Skip(from).Take(to - from + 1).Select(AxName));
            if (!System.Text.RegularExpressions.Regex.IsMatch(nearby,
                @"\b(Working|Pending|Open|Submitted|Queued|New|Partially filled)\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
            if (list[i].TryGetProperty("backendDOMNodeId", out var bp) && bp.TryGetInt64(out backend)) break;
        }
        if (backend == 0) return "";
        string rowObject = "";
        try
        {
            var resolved = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync(
                "DOM.resolveNode", "{\"backendNodeId\":" + backend + "}");
            using var rdoc = JsonDocument.Parse(resolved);
            if (rdoc.RootElement.TryGetProperty("object", out var obj) && obj.TryGetProperty("objectId", out var oid))
                rowObject = oid.GetString() ?? "";
        }
        catch { }
        if (string.IsNullOrEmpty(rowObject) || string.IsNullOrEmpty(await CallOnAxNodeAsync(t, rowObject, AxClickFunction))) return "";
        await Task.Delay(700);
        var (cancelObject, cancelName) = await ResolveAxControlAsync(t, "Cancel order", ClickRoles);
        if (string.IsNullOrEmpty(cancelObject)) (cancelObject, cancelName) = await ResolveAxControlAsync(t, "Cancel", ClickRoles);
        if (string.IsNullOrEmpty(cancelObject)) return "";
        return string.IsNullOrEmpty(await CallOnAxNodeAsync(t, cancelObject, AxClickFunction))
            ? "" : "clicked " + cancelName + " in " + symbol + " order row";
    }

    // Returns the step's success string, or "" to mean "the accessibility tree
    // could not do this" — in which case the caller falls back to the DOM scan,
    // which is still the better path on ordinary pages.
    async Task<string> TryAccessibilityActionAsync(TabItem t, string action, JsonElement command)
    {
        if (t.View.CoreWebView2 == null) return "";
        var text = command.TryGetProperty("text", out var xp) ? xp.GetString() ?? "" : "";
        var target = command.TryGetProperty("target", out var tp) ? tp.GetString() ?? "" : "";
        var value = command.TryGetProperty("value", out var vp) ? vp.GetString() ?? "" : text;

        if (action == "controls")
        {
            using var doc = await AxTreeAsync(t);
            if (doc == null || !doc.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
                return "";
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var lines = new List<string>();
            foreach (var node in nodes.EnumerateArray())
            {
                if (node.TryGetProperty("ignored", out var ignored) && ignored.ValueKind == JsonValueKind.True) continue;
                var role = AxRole(node);
                if (Array.IndexOf(AnyControlRoles, role) < 0) continue;
                var name = AxName(node);
                if (name.Length == 0 || name.Length > 60 || !seen.Add(role + ":" + name)) continue;
                lines.Add(role + ": " + name);
                if (lines.Count >= 80) break;
            }
            return lines.Count > 0 ? string.Join("\n", lines) : "";
        }

        var query = action == "click" ? text : (!string.IsNullOrWhiteSpace(target) ? target : text);
        if (string.IsNullOrWhiteSpace(query)) return "";

        if (action == "click")
        {
            var (objectId, name) = await ResolveAxControlAsync(t, query, ClickRoles);
            if (string.IsNullOrEmpty(objectId)) return "";
            var done = await CallOnAxNodeAsync(t, objectId, AxClickFunction);
            return string.IsNullOrEmpty(done) ? "" : "clicked " + name;
        }
        if (action == "type")
        {
            var (objectId, name) = await ResolveAxControlAsync(t, query, TypeRoles);
            if (string.IsNullOrEmpty(objectId)) return "";
            var done = await CallOnAxNodeAsync(t, objectId, AxTypeFunction, JsonSerializer.Serialize(value));
            return string.IsNullOrEmpty(done) ? "" : done + " into " + name;
        }
        if (action == "select")
        {
            var (objectId, name) = await ResolveAxControlAsync(t, query, SelectRoles);
            if (string.IsNullOrEmpty(objectId)) return "";
            var done = await CallOnAxNodeAsync(t, objectId, AxSelectFunction, JsonSerializer.Serialize(value));
            if (!string.IsNullOrEmpty(done)) return done;
            // Not a native <select>. Custom dropdowns open a list of options, so
            // open it and click the option by the name it shows.
            if (string.IsNullOrEmpty(await CallOnAxNodeAsync(t, objectId, AxClickFunction))) return "";
            await Task.Delay(500);
            var (optionId, optionName) = await ResolveAxControlAsync(t, value,
                new[] { "option", "menuitem", "menuitemradio", "listitem", "button" });
            if (string.IsNullOrEmpty(optionId)) return "";
            return string.IsNullOrEmpty(await CallOnAxNodeAsync(t, optionId, AxClickFunction))
                ? "" : "selected " + optionName;
        }
        return "";
    }

    // Chromium's DOM snapshot includes text stored in React portals, shadow DOM,
    // and embedded frame documents that body.innerText and the AX tree can omit.
    // Robinhood Legend uses those surfaces for its live contract and quote strip.
    async Task<string> ReadBrowserDomSnapshotTextAsync(TabItem t)
    {
        if (t.View.CoreWebView2 == null) return "";
        try
        {
            var json = await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync(
                "DOMSnapshot.captureSnapshot",
                "{\"computedStyles\":[],\"includePaintOrder\":false,\"includeDOMRects\":false}");
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("strings", out var strings) || strings.ValueKind != JsonValueKind.Array) return "";
            if (!doc.RootElement.TryGetProperty("documents", out var documents) || documents.ValueKind != JsonValueKind.Array) return "";
            var lines = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var length = 0;
            void AddStringIndex(JsonElement value)
            {
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var index) || index < 0 || index >= strings.GetArrayLength()) return;
                var item = strings[index];
                if (item.ValueKind != JsonValueKind.String) return;
                var text = item.GetString()?.Trim();
                if (string.IsNullOrWhiteSpace(text) || text.Length > 500 || !seen.Add(text)) return;
                lines.Add(text);
                length += text.Length + 1;
            }
            foreach (var document in documents.EnumerateArray())
            {
                // Layout.text is emitted in rendered document order and avoids
                // pairing a ticker with an unrelated number from CDP's global,
                // unordered string dictionary.
                if (document.TryGetProperty("layout", out var layout) &&
                    layout.TryGetProperty("text", out var layoutText) && layoutText.ValueKind == JsonValueKind.Array)
                    foreach (var value in layoutText.EnumerateArray())
                    {
                        AddStringIndex(value);
                        if (length >= 60000) break;
                    }
                if (length >= 60000) break;
                // Keep DOM text-node values as a fallback for rendered portals
                // that Chromium omits from the layout text array.
                if (document.TryGetProperty("nodes", out var nodes) &&
                    nodes.TryGetProperty("nodeValue", out var nodeValues) && nodeValues.ValueKind == JsonValueKind.Array)
                    foreach (var value in nodeValues.EnumerateArray())
                    {
                        AddStringIndex(value);
                        if (length >= 60000) break;
                    }
                if (length >= 60000) break;
            }
            // Canvas-heavy broker UIs may keep their live quote strings in
            // React state/attributes rather than rendered text nodes. Expose
            // the bounded string table as an explicitly unordered hint block;
            // the UI uses it only for quote detection, never table-row parsing.
            lines.Add("DOM quote hints:");
            foreach (var value in strings.EnumerateArray())
            {
                if (value.ValueKind != JsonValueKind.String) continue;
                var text = value.GetString()?.Trim();
                if (string.IsNullOrWhiteSpace(text) || text.Length > 500 || seen.Contains(text)) continue;
                seen.Add(text);
                lines.Add(text);
                length += text.Length + 1;
                if (length >= 70000) break;
            }
            return string.Join("\n", lines);
        }
        catch { return ""; }
    }

    async Task<string> ReadVisibleBrowserQuoteOcrAsync(TabItem t)
    {
        var png = await CaptureBrowserPngAsync(t);
        if (png == null) return "";
        try
        {
            using var input = new MemoryStream(png);
            using var source = new Bitmap(input);
            var quoteHeight = Math.Min(source.Height, Math.Max(180, source.Height / 3));
            const int scale = 3;
            using var quote = new Bitmap(source.Width * scale, quoteHeight * scale, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(quote))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(source, new Rectangle(0, 0, quote.Width, quote.Height), new Rectangle(0, 0, source.Width, quoteHeight), GraphicsUnit.Pixel);
            }
            using var original = new MemoryStream();
            quote.Save(original, System.Drawing.Imaging.ImageFormat.Png);
            var originalText = await OcrPngAsync(original.ToArray());

            // Legend uses small light/green text on a dark canvas. Inverting an
            // enlarged copy gives Windows OCR a conventional dark-on-light
            // pass without changing what the user sees in the browser.
            using var inverted = new Bitmap(quote.Width, quote.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(inverted))
            using (var attributes = new System.Drawing.Imaging.ImageAttributes())
            {
                attributes.SetColorMatrix(new System.Drawing.Imaging.ColorMatrix(new[]
                {
                    new float[] { -1, 0, 0, 0, 0 },
                    new float[] { 0, -1, 0, 0, 0 },
                    new float[] { 0, 0, -1, 0, 0 },
                    new float[] { 0, 0, 0, 1, 0 },
                    new float[] { 1, 1, 1, 0, 1 }
                }));
                graphics.DrawImage(quote, new Rectangle(0, 0, inverted.Width, inverted.Height), 0, 0, quote.Width, quote.Height, GraphicsUnit.Pixel, attributes);
            }
            using var invertedOutput = new MemoryStream();
            inverted.Save(invertedOutput, System.Drawing.Imaging.ImageFormat.Png);
            var invertedText = await OcrPngAsync(invertedOutput.ToArray());
            return string.Join("\n", new[] { originalText, invertedText }.Where(value => !string.IsNullOrWhiteSpace(value)).Distinct());
        }
        catch { return ""; }
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

    async Task StartStudioRecordingAsync(string url, int maxSeconds, bool privacy, bool showCursor)
    {
        if (_studioRecording) await StopStudioRecordingAsync();
        if (!_browserOpen) ToggleBrowser(true);
        var t = Active();
        if (t?.View.CoreWebView2 == null)
        {
            PostToChat(new { type = "studioRecording", action = "error", error = "Open a browser tab before recording." });
            return;
        }
        try
        {
            if (!string.IsNullOrWhiteSpace(url))
            {
                Navigate(url);
                await WaitForNavOrDelayAsync(t, 3000);
            }
            var recordingOverlay = $@"(function(){{
              var style=document.getElementById('boolean-studio-recording-style')||document.createElement('style');
              style.id='boolean-studio-recording-style';
              style.textContent='{(privacy ? "input[type=password],[data-private],[data-sensitive],[autocomplete=\\\"one-time-code\\\"]{filter:blur(8px)!important}" : "")}' +
                '{(showCursor ? "#boolean-studio-cursor{position:fixed;z-index:2147483647;width:18px;height:18px;border:3px solid white;border-radius:50%;box-shadow:0 1px 8px rgba(0,0,0,.55);pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s}#boolean-studio-cursor.click{width:30px;height:30px}" : "")}';
              (document.head||document.documentElement).appendChild(style);
              if({showCursor.ToString().ToLowerInvariant()}){{
                var dot=document.getElementById('boolean-studio-cursor')||document.createElement('div');dot.id='boolean-studio-cursor';document.documentElement.appendChild(dot);
                window.__booleanStudioMove=function(e){{dot.style.left=e.clientX+'px';dot.style.top=e.clientY+'px';}};
                window.__booleanStudioClick=function(){{dot.classList.add('click');setTimeout(function(){{dot.classList.remove('click');}},160);}};
                document.addEventListener('pointermove',window.__booleanStudioMove,true);document.addEventListener('click',window.__booleanStudioClick,true);
              }}
              return true;
            }})()";
            await t.View.CoreWebView2.ExecuteScriptAsync(recordingOverlay);
            _studioRecordingFrames = 0;
            _studioRecordingStarted = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _studioRecording = true;
            _studioScreencastReceiver = t.View.CoreWebView2.GetDevToolsProtocolEventReceiver("Page.screencastFrame");
            _studioScreencastHandler = async (_, ev) =>
            {
                if (!_studioRecording) return;
                try
                {
                    using var frame = JsonDocument.Parse(ev.ParameterObjectAsJson);
                    var root = frame.RootElement;
                    var data = root.TryGetProperty("data", out var dp) ? dp.GetString() ?? "" : "";
                    var sessionId = root.TryGetProperty("sessionId", out var sp) && sp.TryGetInt32(out var sid) ? sid : 0;
                    if (sessionId > 0)
                        await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.screencastFrameAck", $"{{\"sessionId\":{sessionId}}}");
                    if (string.IsNullOrWhiteSpace(data)) return;
                    _studioRecordingFrames++;
                    PostToChat(new
                    {
                        type = "studioRecording",
                        action = "frame",
                        dataURL = "data:image/jpeg;base64," + data,
                        at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _studioRecordingStarted,
                        url = t.Url,
                        frame = _studioRecordingFrames
                    });
                }
                catch { }
            };
            _studioScreencastReceiver.DevToolsProtocolEventReceived += _studioScreencastHandler;
            var limit = Math.Clamp(maxSeconds, 6, 60);
            await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.startScreencast", "{\"format\":\"jpeg\",\"quality\":72,\"maxWidth\":960,\"maxHeight\":720,\"everyNthFrame\":2}");
            PostToChat(new { type = "studioRecording", action = "started", url = t.Url, maxSeconds = limit });
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromSeconds(limit));
                if (_studioRecording) BeginInvoke(new Action(() => _ = StopStudioRecordingAsync()));
            });
        }
        catch (Exception ex)
        {
            _studioRecording = false;
            PostToChat(new { type = "studioRecording", action = "error", error = ex.Message });
        }
    }

    async Task StopStudioRecordingAsync()
    {
        if (!_studioRecording) return;
        _studioRecording = false;
        var t = Active();
        try { if (t?.View.CoreWebView2 != null) await t.View.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.stopScreencast", "{}"); } catch { }
        try
        {
            if (_studioScreencastReceiver != null && _studioScreencastHandler != null)
                _studioScreencastReceiver.DevToolsProtocolEventReceived -= _studioScreencastHandler;
        }
        catch { }
        _studioScreencastReceiver = null;
        _studioScreencastHandler = null;
        try { if (t?.View.CoreWebView2 != null) await t.View.CoreWebView2.ExecuteScriptAsync("(function(){document.removeEventListener('pointermove',window.__booleanStudioMove,true);document.removeEventListener('click',window.__booleanStudioClick,true);document.getElementById('boolean-studio-recording-style')?.remove();document.getElementById('boolean-studio-cursor')?.remove();delete window.__booleanStudioMove;delete window.__booleanStudioClick;return true})()"); } catch { }
        PostToChat(new
        {
            type = "studioRecording",
            action = "complete",
            frames = _studioRecordingFrames,
            duration = Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _studioRecordingStarted),
            url = t?.Url ?? ""
        });
    }

    // Shared by the click, type and controls scripts. Searches shadow roots and
    // same-origin frames as well as the top document — a broker order ticket is
    // routinely inside one of those, and a control that cannot be seen reads
    // exactly like a control that does not exist.
    const string DomProbeHelpers =
        "function roots(){var out=[document];function walk(r){try{[].slice.call(r.querySelectorAll('*')).forEach(function(e){if(e.shadowRoot){out.push(e.shadowRoot);walk(e.shadowRoot)}})}catch(_){}}walk(document);" +
        "try{[].slice.call(document.querySelectorAll('iframe,frame')).forEach(function(f){try{if(f.contentDocument){out.push(f.contentDocument)}}catch(_){}})}catch(_){}return out}" +
        "function all(sel){var a=[];roots().forEach(function(r){try{a=a.concat([].slice.call(r.querySelectorAll(sel)))}catch(_){}});return a}" +
        "function queryDeep(sel){var hit=null;roots().some(function(r){try{var e=r.querySelector(sel);if(e&&shown(e)){hit=e;return true}}catch(_){}return false});return hit}" +
        "function shown(e){try{var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}catch(_){return false}}" +
        "function tight(e){var parts=[e.getAttribute&&e.getAttribute('aria-label'),e.value,e.getAttribute&&e.getAttribute('placeholder'),e.innerText,e.getAttribute&&e.getAttribute('title'),e.name,e.id];" +
        "for(var i=0;i<parts.length;i++){var p=String(parts[i]||'').replace(/\\s+/g,' ').trim();if(p)return p}return ''}" +
        "function label(e){return [e.innerText,e.value,e.getAttribute&&e.getAttribute('aria-label'),e.getAttribute&&e.getAttribute('title'),e.getAttribute&&e.getAttribute('placeholder'),e.name,e.id].filter(Boolean).join(' ').toLowerCase()}" +
        // The narrowest label that contains the query wins, exact matches first,
        // so a wrapper whose innerText happens to include the word never beats
        // the button itself.
        "function best(list,sel){var hits=list.filter(function(e){return shown(e)&&label(e).indexOf(sel)>=0});" +
        "hits.sort(function(a,b){var la=tight(a).toLowerCase(),lb=tight(b).toLowerCase();" +
        "var ea=la===sel?0:1,eb=lb===sel?0:1;if(ea!==eb)return ea-eb;" +
        "var sa=la.indexOf(sel)===0?0:1,sb=lb.indexOf(sel)===0?0:1;if(sa!==sb)return sa-sb;" +
        "return la.length-lb.length});return hits[0]||null}";

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
            if (action == "capture")
            {
                // optional navigate first (e.g. to a freshly started localhost dev server)
                var capUrl = command.TryGetProperty("url", out var cup) ? cup.GetString() ?? "" : "";
                if (!string.IsNullOrWhiteSpace(capUrl))
                {
                    Navigate(capUrl);
                    await WaitForNavOrDelayAsync(t, 3000);
                }
                var png = await CaptureBrowserPngAsync(t);
                if (png == null || png.Length == 0)
                {
                    PostToChat(new { type = "browserControlResult", id, ok = false, error = "could not capture the page" });
                    return;
                }
                string pageInfo;
                try { pageInfo = await ReadActivePageAsync(t); }
                catch (Exception ex) { pageInfo = "URL: " + t.Url + "\n(page text unavailable: " + ex.Message + ")"; }
                PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, image = Convert.ToBase64String(png), result = pageInfo });
                return;
            }

            var text = command.TryGetProperty("text", out var xp) ? xp.GetString() ?? "" : "";
            var target = command.TryGetProperty("target", out var tp) ? tp.GetString() ?? "" : "";
            if (action == "select_order_side")
            {
                var side = command.TryGetProperty("side", out var sidep) ? sidep.GetString() ?? "" : "";
                var choices = string.Equals(side, "buy", StringComparison.OrdinalIgnoreCase)
                    ? new[] { "Buy" } : new[] { "Short", "Sell" };
                foreach (var choice in choices)
                {
                    var (objectId, name) = await ResolveAxExactControlAsync(t, choice, ClickRoles);
                    if (string.IsNullOrEmpty(objectId)) continue;
                    if (string.IsNullOrEmpty(await CallOnAxNodeAsync(t, objectId, AxClickFunction))) continue;
                    await WaitForNavOrDelayAsync(t, 500);
                    PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url,
                        result = "selected order side " + name });
                    return;
                }
            }
            if (action == "cancel_order")
            {
                var orderSymbol = command.TryGetProperty("symbol", out var symp) ? symp.GetString() ?? "" : "";
                var axCancel = await TryCancelOrderAccessibilityAsync(t, orderSymbol);
                if (!string.IsNullOrEmpty(axCancel))
                {
                    await WaitForNavOrDelayAsync(t, 900);
                    PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url,
                        result = axCancel + "\n\nAfter cancel:\n" + await ReadActivePageAsync(t) });
                    return;
                }
            }
            // Try the accessibility tree before the DOM scan for anything that
            // acts on a control. On pages that keep their UI in portals, shadow
            // roots or frames the scan sees nothing at all, and the AX tree is
            // the same surface the page reader already relies on.
            if (action == "click" || action == "type" || action == "select" || action == "controls")
            {
                var axResult = await TryAccessibilityActionAsync(t, action, command);
                if (!string.IsNullOrEmpty(axResult))
                {
                    if (action == "controls")
                    {
                        PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, result = axResult });
                        return;
                    }
                    await WaitForNavOrDelayAsync(t, 900);
                    PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url,
                        result = axResult + "\n\nAfter " + action + ":\n" + await ReadActivePageAsync(t) });
                    return;
                }
            }
            var value = command.TryGetProperty("value", out var vp) ? vp.GetString() ?? "" :
                command.TryGetProperty("text", out var tvp) ? tvp.GetString() ?? "" : "";
            var enter = command.TryGetProperty("enter", out var ep) && ep.ValueKind == JsonValueKind.True;
            var q = JsonSerializer.Serialize(action == "type" && !string.IsNullOrWhiteSpace(target) ? target : text);
            var v = JsonSerializer.Serialize(value);
            string script;
            if (action == "inspect_layout")
            {
                var selector = JsonSerializer.Serialize(command.TryGetProperty("selector", out var sp) ? sp.GetString() ?? "" : "");
                var scroll = command.TryGetProperty("scroll", out var scp) && scp.TryGetDouble(out var scrollValue)
                    ? scrollValue.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : "null";
                script = "(async function(){var selector=" + selector + ",requested=" + scroll + ";" +
                    "var el;try{el=document.querySelector(selector)}catch(e){throw new Error('invalid CSS selector: '+selector)}" +
                    "if(!el)throw new Error('no element matches: '+selector);" +
                    "function css(e){var s=getComputedStyle(e);return{position:s.position,top:s.top,bottom:s.bottom,left:s.left,right:s.right,display:s.display,alignSelf:s.alignSelf,overflowX:s.overflowX,overflowY:s.overflowY}}" +
                    "function rect(e){var r=e.getBoundingClientRect();return{x:+r.x.toFixed(1),y:+r.y.toFixed(1),top:+r.top.toFixed(1),bottom:+r.bottom.toFixed(1),width:+r.width.toFixed(1),height:+r.height.toFixed(1)}}" +
                    "function name(e){if(e===document.documentElement)return'html';if(e===document.body)return'body';return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(e.classList&&e.classList.length?'.'+[].slice.call(e.classList).slice(0,3).join('.'):'')}" +
                    "var ancestors=[],p=el.parentElement,scroller=null;while(p){var s=css(p),scrollable=p.scrollHeight>p.clientHeight+1&&/(auto|scroll|overlay)/.test(s.overflowY);ancestors.push({element:name(p),overflowY:s.overflowY,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,scrollable:scrollable});if(!scroller&&scrollable)scroller=p;p=p.parentElement}" +
                    "var root=document.scrollingElement||document.documentElement;if(!scroller)scroller=root;var before=rect(el),style=css(el),old=scroller.scrollTop,amount=Number.isFinite(requested)?requested:Math.max(240,Math.round(innerHeight*.6));scroller.scrollTop=old+amount;await new Promise(function(r){setTimeout(r,140)});var after=rect(el),actual=scroller.scrollTop-old;scroller.scrollTop=old;" +
                    "return JSON.stringify({selector:selector,viewport:{width:innerWidth,height:innerHeight,pageScrollY:scrollY},element:{name:name(el),style:style,before:before,after:after,movementY:+(after.top-before.top).toFixed(1),stickyHeld:style.position==='sticky'&&Math.abs(after.top-before.top)<=2},scrollTest:{container:name(scroller),requested:amount,actual:actual},ancestors:ancestors.slice(0,8)});})()";
            }
            else if (action == "email_draft")
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
                // Two changes over the original document.querySelectorAll scan.
                // Shadow roots and same-origin frames are searched, because a
                // broker's order ticket is frequently in one of them and the
                // control simply "did not exist" otherwise. And among matches
                // the TIGHTEST label wins: innerText matching means a wrapper
                // holding half the page also contains "buy", and clicking that
                // does nothing useful.
                script = "(function(){var q=" + q + ".toLowerCase().trim();" + DomProbeHelpers +
                    "function find(sel){if(/^[.#\\[]/.test(sel)){var direct=queryDeep(sel);if(direct)return direct}" +
                    "return best(all('button,a,input,textarea,select,[role=button],[onclick],[tabindex]'),sel)}" +
                    "var el=find(q);if(!el)throw new Error('no visible element matching: '+q);el.scrollIntoView({block:'center',inline:'center'});el.click();return 'clicked '+q;})()";
            }
            else if (action == "cancel_order")
            {
                // A Legend row button is normally named only "Cancel". The
                // generic accessibility-name lookup cannot associate that
                // button with its SPY row, and refusing a bare match is the
                // correct safety behavior when several orders are live. Find
                // the smallest visible row-like ancestor containing both the
                // requested symbol and a Cancel control, then click inside it.
                var symbol = JsonSerializer.Serialize(command.TryGetProperty("symbol", out var domSymp) ? domSymp.GetString() ?? "" : "");
                script = "(async function(){var sym=" + symbol + ".toUpperCase().trim();" + DomProbeHelpers +
                    "if(!sym)throw new Error('no order symbol supplied');" +
                    "function delay(ms){return new Promise(function(r){setTimeout(r,ms)})}" +
                    "var controls=all('button,a,[role=button],[onclick],[tabindex]').filter(function(e){return shown(e)&&/^cancel(?:\\s+(?:this\\s+)?order)?$/i.test(tight(e))});" +
                    "var hits=[];controls.forEach(function(c){var p=c;for(var depth=0;p&&depth<10;depth++,p=p.parentElement){var txt=String(p.innerText||p.textContent||'').replace(/\\s+/g,' ').toUpperCase();if(txt.indexOf(sym)>=0){hits.push({c:c,p:p,len:txt.length,depth:depth});break}}});" +
                    "hits.sort(function(a,b){return a.len-b.len||a.depth-b.depth});var hit=hits[0];" +
                    "if(!hit){var live=/\\b(WORKING|PENDING|OPEN|SUBMITTED|QUEUED|NEW|PARTIALLY FILLED)\\b/;var nodes=all('[role=row],tr,[role=gridcell],button,a,[tabindex],div').filter(function(e){if(!shown(e))return false;var x=String(e.innerText||e.textContent||'').replace(/\\s+/g,' ').toUpperCase();return x.indexOf(sym)>=0&&live.test(x)});nodes.sort(function(a,b){return String(a.innerText||'').length-String(b.innerText||'').length});var row=nodes[0];if(row){row.scrollIntoView({block:'center',inline:'center'});row.click();await delay(900);controls=all('button,a,[role=button],[onclick],[tabindex]').filter(function(e){return shown(e)&&/^cancel(?:\\s+(?:this\\s+)?order)?$/i.test(tight(e))});if(controls.length===1)hit={c:controls[0]}}}" +
                    "if(!hit)throw new Error('no visible Cancel control in the '+sym+' order row');" +
                    "hit.c.scrollIntoView({block:'center',inline:'center'});hit.c.click();return 'clicked Cancel in '+sym+' order row';})()";
            }
            else if (action == "select_order_side")
            {
                var side = JsonSerializer.Serialize(command.TryGetProperty("side", out var domSidep) ? domSidep.GetString() ?? "" : "");
                script = "(function(){var side=" + side + ".toLowerCase();" + DomProbeHelpers +
                    "var names=side==='buy'?['buy']:['short','sell'];var controls=all('button,a,[role=button],[role=tab],[role=radio],[onclick],[tabindex]').filter(shown),hit=null;" +
                    "for(var i=0;i<names.length&&!hit;i++){hit=controls.filter(function(e){return tight(e).toLowerCase()===names[i]})[0]||null}" +
                    "if(!hit)throw new Error('no safe non-executing '+side+' side control');hit.scrollIntoView({block:'center',inline:'center'});hit.click();return 'selected order side '+tight(hit);})()";
            }
            else if (action == "type")
            {
                script = "(function(){var q=" + q + ".toLowerCase().trim(),val=" + v + ";" + DomProbeHelpers +
                    "function find(sel){if(!sel)return null;if(/^[.#\\[]/.test(sel)){var direct=queryDeep(sel);if(direct)return direct}" +
                    "return best(all('input,textarea,[contenteditable=true],select'),sel)}" +
                    "var el=find(q)||document.activeElement;if(!el)throw new Error('no matching or active input');el.focus();" +
                    "if('value' in el){el.value=val;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}else{document.execCommand('insertText',false,val)}" +
                    (enter ? "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));" : "") +
                    "return 'typed '+val.length+' chars';})()";
            }
            // Dropdowns need their option chosen by what it says, not by
            // assigning a value that may not be the option's value. Order type
            // on a broker ticket is one of these, which is why a limit order
            // could not be set up from the trading bar at all.
            else if (action == "select")
            {
                script = "(function(){var q=" + q + ".toLowerCase().trim(),val=" + v + ";" + DomProbeHelpers +
                    "var el=best(all('select'),q);" +
                    "if(!el){var near=best(all('label,div,span'),q);if(near){var scope=near.closest?near.closest('div,form,section'):null;" +
                    "if(scope){el=[].slice.call(scope.querySelectorAll('select')).filter(shown)[0]}}}" +
                    "if(!el)throw new Error('no dropdown matching: '+q);" +
                    "var opts=[].slice.call(el.options||[]),want=String(val).toLowerCase().trim();" +
                    "var hit=opts.filter(function(o){return String(o.text||'').toLowerCase().trim()===want||String(o.value||'').toLowerCase().trim()===want})[0]" +
                    "||opts.filter(function(o){return String(o.text||'').toLowerCase().indexOf(want)>=0})[0];" +
                    "if(!hit)throw new Error('no option \\''+val+'\\' in that dropdown (has: '+opts.map(function(o){return o.text}).join(', ')+')');" +
                    "el.value=hit.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
                    "return 'selected '+(hit.text||hit.value);})()";
            }
            // What the page actually offers. "No buy control on the page" is a
            // dead end on its own; the list of controls that ARE there turns it
            // into a label you can configure.
            else if (action == "controls")
            {
                script = "(function(){" + DomProbeHelpers +
                    "var seen={},out=[];" +
                    "all('button,a,input,textarea,select,[role=button],[onclick],[tabindex]').forEach(function(e){" +
                    "if(!shown(e))return;var text=tight(e);if(!text||text.length>60)return;" +
                    "if(seen[text])return;seen[text]=1;out.push(e.tagName.toLowerCase()+': '+text)});" +
                    "return out.slice(0,80).join('\\n');})()";
            }
            else
            {
                PostToChat(new { type = "browserControlResult", id, ok = false, error = "unknown visible browser action: " + action });
                return;
            }
            // The click and type scripts signal "no element matched" by throwing.
            // ExecuteScriptAsync swallows that into the string "null", which the
            // old ?? fallback turned into the action name and reported as ok:true
            // — so a click that found nothing looked exactly like a click that
            // worked. Wrap the script so a failure comes back as a failure.
            var wrapped = "(async function(){try{var r=await (" + script + ");" +
                "return JSON.stringify({ok:true,result:r===undefined||r===null?'':String(r)});}" +
                "catch(e){return JSON.stringify({ok:false,error:String((e&&e.message)||e)});}})()";
            var resultJson = await t.View.CoreWebView2.ExecuteScriptAsync(wrapped);
            var raw = JsonSerializer.Deserialize<string>(resultJson);
            var ok = true;
            var result = action;
            var scriptError = "";
            if (string.IsNullOrEmpty(raw))
            {
                ok = false;
                scriptError = "the page did not answer the " + action + " request";
            }
            else
            {
                try
                {
                    using var envelope = JsonDocument.Parse(raw);
                    ok = !envelope.RootElement.TryGetProperty("ok", out var okProp) || okProp.ValueKind != JsonValueKind.False;
                    if (ok)
                    {
                        result = envelope.RootElement.TryGetProperty("result", out var resProp) ? resProp.GetString() ?? action : action;
                        if (string.IsNullOrEmpty(result)) result = action;
                    }
                    else
                    {
                        scriptError = envelope.RootElement.TryGetProperty("error", out var errProp) ? errProp.GetString() ?? "" : "";
                        if (string.IsNullOrEmpty(scriptError)) scriptError = action + " failed on the page";
                    }
                }
                catch { result = raw; }
            }
            if (!ok)
            {
                PostToChat(new { type = "browserControlResult", id, ok = false, url = t.Url, error = scriptError });
                return;
            }
            // Both of these are read-only probes; appending a full page read
            // would bury the answer and cost a second of OCR for nothing.
            if (action == "inspect_layout" || action == "controls")
            {
                PostToChat(new { type = "browserControlResult", id, ok = true, url = t.Url, result });
                return;
            }
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

    void SendBrowserTask(string task)
    {
        var t = Active();
        PostToChat(new { type = "browserTask", task, url = t?.Url ?? "", title = t?.Title ?? "" });
    }

    static bool IsEmailPage(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host.ToLowerInvariant();
        return host == "mail.google.com" || host.EndsWith(".mail.google.com", StringComparison.Ordinal) ||
               host == "outlook.live.com" || host.EndsWith(".outlook.live.com", StringComparison.Ordinal) ||
               host == "outlook.office.com" || host.EndsWith(".outlook.office.com", StringComparison.Ordinal) ||
               host == "outlook.office365.com" || host.EndsWith(".outlook.office365.com", StringComparison.Ordinal);
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

}
