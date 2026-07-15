# Creates the release manifest consumed by Boolean's built-in updater.
# Run after build-installer.ps1. Keep this file ASCII for Windows PowerShell 5.1.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$installer = Join-Path $root "dist\Boolean-setup.exe"
$iss = Join-Path $root "build\installer.iss"

if (-not (Test-Path $installer)) { throw "installer not found: $installer" }

$match = [regex]::Match((Get-Content $iss -Raw), '#define AppVersion "([^"]+)"')
if (-not $match.Success) { throw "AppVersion not found in build\installer.iss" }
$version = $match.Groups[1].Value
$sha256 = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()

$manifest = [ordered]@{
  version = $version
  url = "https://github.com/syfy10/Boolean/releases/download/v$version/Boolean-setup.exe"
  sha256 = $sha256
} | ConvertTo-Json

$target = Join-Path $root "dist\update.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($target, $manifest + "`n", $utf8)
Write-Host "done: dist\update.json (v$version, sha256 $sha256)"
