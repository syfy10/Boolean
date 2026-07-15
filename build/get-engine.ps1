# Downloads the latest llama.cpp Windows CPU build into build\engine\
# (bundled into the installer; Saz runs llama-server.exe as its local engine)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$engineDir = "$root\build\engine"

$rel = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent" = "saz-build" }
$asset = $rel.assets | Where-Object { $_.name -match "bin-win-cpu-x64\.zip$" } | Select-Object -First 1
if (-not $asset) { throw "no win-cpu-x64 asset in latest llama.cpp release" }

Write-Host "downloading $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)..."
$zip = "$env:TEMP\llama-engine.zip"
Invoke-WebRequest $asset.browser_download_url -OutFile $zip

if (Test-Path $engineDir) { Remove-Item -Recurse -Force $engineDir }
New-Item -ItemType Directory -Force $engineDir | Out-Null
Expand-Archive -Path $zip -DestinationPath $engineDir -Force
Remove-Item $zip -Force

# flatten if the zip has a nested folder
$exe = Get-ChildItem $engineDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $exe) { throw "llama-server.exe not found in the zip" }
if ($exe.DirectoryName -ne $engineDir) {
  Get-ChildItem $exe.DirectoryName | Move-Item -Destination $engineDir -Force
}

# keep only what the server needs (the zip ships many example binaries)
Get-ChildItem $engineDir -File | Where-Object { $_.Extension -eq ".exe" -and $_.Name -ne "llama-server.exe" } | Remove-Item -Force

# app-local VC++ runtime so target PCs don't need the redistributable installed
foreach ($dll in "vcruntime140.dll","vcruntime140_1.dll","msvcp140.dll","msvcp140_1.dll","msvcp140_2.dll") {
  if (Test-Path "C:\Windows\System32\$dll") { Copy-Item "C:\Windows\System32\$dll" $engineDir -Force }
}

$size = [math]::Round((Get-ChildItem $engineDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "done: build\engine ($size MB)"
