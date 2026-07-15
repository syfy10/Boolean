# Pushes Boolean's icon onto the Edge app-mode window so Alt+Tab / title bar /
# taskbar show our icon instead of the generic Edge one. Enumerates ALL
# top-level Chromium windows titled "Boolean" and sends WM_SETICON to each.
param([string]$Title = "Boolean", [string]$IconPath)

if (-not $IconPath) { $IconPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "saz.ico" }
if (-not (Test-Path $IconPath)) { return }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BooleanWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint fuLoad);
}
"@

# LR_LOADFROMFILE | LR_DEFAULTSIZE = 0x0010 | 0x0040 ; IMAGE_ICON = 1
$small = [BooleanWin]::LoadImage([IntPtr]::Zero, $IconPath, 1, 16, 16, 0x0010)
$big   = [BooleanWin]::LoadImage([IntPtr]::Zero, $IconPath, 1, 32, 32, 0x0010)
if ($small -eq [IntPtr]::Zero -and $big -eq [IntPtr]::Zero) { return }

$apply = {
  param($h)
  if ($small -ne [IntPtr]::Zero) { [BooleanWin]::SendMessage($h, 0x80, [IntPtr]0, $small) | Out-Null } # WM_SETICON small
  if ($big   -ne [IntPtr]::Zero) { [BooleanWin]::SendMessage($h, 0x80, [IntPtr]1, $big)   | Out-Null } # WM_SETICON big
}

# retry: the app window may not exist yet right after launch
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  $found = $false
  $cb = [BooleanWin+EnumProc]{
    param($h, $l)
    if (-not [BooleanWin]::IsWindowVisible($h)) { return $true }
    $t = New-Object System.Text.StringBuilder 256
    [BooleanWin]::GetWindowText($h, $t, 256) | Out-Null
    $title = $t.ToString()
    if ($title -eq $Title -or $title -like "$Title*") {
      $c = New-Object System.Text.StringBuilder 128
      [BooleanWin]::GetClassName($h, $c, 128) | Out-Null
      if ($c.ToString() -like "Chrome_WidgetWin*") { & $apply $h; $script:found = $true }
    }
    return $true
  }
  $script:found = $false
  [BooleanWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($script:found) { break }
  Start-Sleep -Milliseconds 500
}
