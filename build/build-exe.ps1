# Builds dist\saz.exe — a standalone executable (no Node.js needed on target PCs).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File build\build-exe.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

New-Item -ItemType Directory -Force "$root\dist" | Out-Null

Write-Host "[1/5] bundling source into one file..."
& npx esbuild src/index.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

Write-Host "[2/5] generating SEA blob..."
& node --experimental-sea-config build/sea-config.json
if ($LASTEXITCODE -ne 0) { throw "sea blob generation failed" }

Write-Host "[3/5] copying node runtime..."
Copy-Item (Get-Command node).Source "$root\dist\saz.exe" -Force

Write-Host "[4/5] setting icon & version info..."
& node build/set-icon.cjs dist/saz.exe assets/saz.ico
if ($LASTEXITCODE -ne 0) { throw "icon embedding failed" }

Write-Host "[5/5] injecting app into executable..."
& npx postject dist/saz.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject failed" }

$size = [math]::Round((Get-Item "$root\dist\saz.exe").Length / 1MB, 1)
Write-Host "done: dist\saz.exe ($size MB)"
