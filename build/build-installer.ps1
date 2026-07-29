# Builds dist\Boolean-setup.exe (requires dist\saz.exe from build-exe.ps1
# and Inno Setup: winget install JRSoftware.InnoSetup)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) { throw "Inno Setup not found. Install with: winget install JRSoftware.InnoSetup" }
if (-not (Test-Path "$root\dist\saz-app\Boolean.exe")) { throw "dist\saz-app missing. Run build\build-shell.ps1 first." }

$prereqDir = Join-Path $root "dist\prerequisites"
$webViewBootstrapper = Join-Path $prereqDir "MicrosoftEdgeWebview2Setup.exe"
$webViewBootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
New-Item -ItemType Directory -Force -Path $prereqDir | Out-Null

Write-Host "fetching Microsoft WebView2 Evergreen bootstrapper..."
Invoke-WebRequest -UseBasicParsing -Uri $webViewBootstrapperUrl -OutFile $webViewBootstrapper
if ((Get-Item $webViewBootstrapper).Length -lt 100KB) {
  throw "WebView2 bootstrapper download is unexpectedly small"
}
$signature = Get-AuthenticodeSignature $webViewBootstrapper
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft") {
  throw "WebView2 bootstrapper does not have a valid Microsoft signature"
}

& $iscc "$root\build\installer.iss"
if ($LASTEXITCODE -ne 0) { throw "installer build failed" }

$size = [math]::Round((Get-Item "$root\dist\Boolean-setup.exe").Length / 1MB, 1)
Write-Host "done: dist\Boolean-setup.exe ($size MB)"

& powershell -ExecutionPolicy Bypass -File "$root\build\make-update-manifest.ps1"
if ($LASTEXITCODE -ne 0) { throw "update manifest generation failed" }
