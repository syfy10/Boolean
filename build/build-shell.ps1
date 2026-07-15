# Builds the native WebView2 shell distribution into dist\saz-app\:
#   saz.exe          - the .NET WebView2 window we own (taskbar icon, real browser)
#   saz-core.exe     - the Node backend (engine + server + web UI), launched by the shell
#   engine\, templates\, saz.ico, docs
# Run:  powershell -ExecutionPolicy Bypass -File build\build-shell.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$out = "$root\dist\saz-app"

Write-Host "[1/5] building Node core (saz-core.exe)..."
& powershell -ExecutionPolicy Bypass -File "$root\build\build-exe.ps1"
if ($LASTEXITCODE -ne 0) { throw "core build failed" }

Write-Host "[2/5] publishing .NET shell (self-contained saz.exe)..."
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
& dotnet publish "$root\shell\SazShell.csproj" -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=none -o $out --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw "shell publish failed" }

Write-Host "[3/5] placing the Node core next to the shell..."
Copy-Item "$root\dist\saz.exe" "$out\saz-core.exe" -Force

Write-Host "[4/5] bundling engine, templates and icon..."
Copy-Item "$root\build\engine" "$out\engine" -Recurse -Force
# drop llama.cpp tool payloads we never ship an exe for (only llama-server.exe is used)
$deadEngineDlls = @(
  "llama-cli-impl.dll", "llama-bench-impl.dll", "llama-perplexity-impl.dll",
  "llama-completion-impl.dll", "llama-quantize-impl.dll",
  "llama-batched-bench-impl.dll", "llama-fit-params-impl.dll", "ggml-rpc.dll",
  # server/HEDT CPU variants consumer PCs never match; ggml falls back to the
  # next-best variant (haswell/alderlake/zen4 cover consumer AVX2/AVX512)
  "ggml-cpu-sapphirerapids.dll", "ggml-cpu-skylakex.dll", "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll", "ggml-cpu-cannonlake.dll", "ggml-cpu-icelake.dll"
)
Get-ChildItem "$out\engine" -Recurse -File | Where-Object { $deadEngineDlls -contains $_.Name } | Remove-Item -Force
Copy-Item "$root\templates" "$out\templates" -Recurse -Force
Copy-Item "$root\assets\saz.ico" "$out\saz.ico" -Force

Write-Host "[5/5] copying docs..."
foreach ($f in "LICENSE.txt", "PRIVACY.txt") { Copy-Item "$root\assets\$f" "$out\$f" -Force }
Copy-Item "$root\README.md" "$out\README.md" -Force

# drop the pdb / extra junk publish may leave
Get-ChildItem $out -Filter *.pdb -ErrorAction SilentlyContinue | Remove-Item -Force

$size = [math]::Round((Get-ChildItem $out -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "done: dist\saz-app\ ($size MB installer staging only)"
