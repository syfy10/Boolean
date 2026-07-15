# Generates the Boolean app icon while keeping the existing asset filenames
# used by the build pipeline: assets\saz.ico, assets\saz-256.png, assets\saz-32.png.
# Mark: a bold binary tile designed to stay legible at Windows' 16px taskbar size.
# The white bar is 1 and the green ring is 0. Both use simple geometry rather
# than text so antialiasing cannot make the small icon disappear.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = "$root\assets"
$store = "$assets\store"
New-Item -ItemType Directory -Force $assets | Out-Null
New-Item -ItemType Directory -Force $store | Out-Null

$tile = [System.Drawing.Color]::FromArgb(0xFA, 0xFB, 0xFA)
$knob = [System.Drawing.Color]::FromArgb(0xFF, 0xFF, 0xFF)
$ink = [System.Drawing.Color]::FromArgb(0x14, 0x19, 0x17)
$inkSoft = [System.Drawing.Color]::FromArgb(0x1C, 0x22, 0x1F)
$green = [System.Drawing.Color]::FromArgb(0x12, 0x96, 0x4E)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-CenteredText($g, [string]$text, $font, $brush, [float]$x, [float]$y, [float]$w, [float]$h) {
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap
  $rect = [System.Drawing.RectangleF]::new($x, $y, $w, $h)
  $g.DrawString($text, $font, $brush, $rect, $fmt)
  $fmt.Dispose()
}

function Render-Square([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [float]$size
  $tileInset = [Math]::Max(1, $s * 0.035)
  $tileSize = $s - ($tileInset * 2)
  $tilePath = New-RoundedPath $tileInset $tileInset $tileSize $tileSize ($s * 0.22)
  $inkBrush = New-Object System.Drawing.SolidBrush($ink)
  $g.FillPath($inkBrush, $tilePath)

  # The binary marks occupy most of the tile. Keep strokes on whole-ish pixels
  # at tiny sizes so Explorer and the taskbar do not reduce them to gray specks.
  $oneW = [Math]::Max(2, [Math]::Round($s * 0.10))
  $oneH = $s * 0.47
  $oneX = $s * 0.30
  $oneY = ($s - $oneH) / 2
  $onePath = New-RoundedPath $oneX $oneY $oneW $oneH ($oneW * 0.48)
  $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.FillPath($whiteBrush, $onePath)

  $zeroStroke = [Math]::Max(2, [Math]::Round($s * 0.09))
  $zeroSize = $s * 0.39
  $zeroX = $s * 0.57
  $zeroY = ($s - $zeroSize) / 2
  $greenPen = New-Object System.Drawing.Pen($green, $zeroStroke)
  $g.DrawEllipse($greenPen, $zeroX, $zeroY, $zeroSize, $zeroSize)

  $g.Dispose()
  $inkBrush.Dispose(); $whiteBrush.Dispose(); $greenPen.Dispose()
  return $bmp
}

function Render-Wide([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgPath = New-RoundedPath 2 2 ($w - 4) ($h - 4) ([Math]::Min($w, $h) * 0.13)
  $tileBrush = New-Object System.Drawing.SolidBrush($tile)
  $g.FillPath($tileBrush, $bgPath)

  $mark = Render-Square ([int]($h * 0.72))
  $markSize = [int]($h * 0.62)
  $markX = [int]($w * 0.12)
  $markY = [int](($h - $markSize) / 2)
  $g.DrawImage($mark, $markX, $markY, $markSize, $markSize)
  $mark.Dispose()

  $fontFamily = New-Object System.Drawing.FontFamily("Segoe UI")
  $wordFont = New-Object System.Drawing.Font($fontFamily, ($h * 0.25), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $subFont = New-Object System.Drawing.Font($fontFamily, ($h * 0.09), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $inkBrush = New-Object System.Drawing.SolidBrush($ink)
  $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x6B, 0x73, 0x6D))
  $greenBrush = New-Object System.Drawing.SolidBrush($green)
  $textX = $markX + $markSize + ($w * 0.05)
  $g.DrawString("boolean", $wordFont, $inkBrush, [System.Drawing.PointF]::new($textX, $h * 0.31))
  $textWidth = $g.MeasureString("boolean", $wordFont).Width
  $g.DrawString("_", $wordFont, $greenBrush, [System.Drawing.PointF]::new($textX + $textWidth - ($h * 0.035), $h * 0.31))
  $g.DrawString("LOCAL AI", $subFont, $mutedBrush, [System.Drawing.PointF]::new($textX + ($h * 0.02), $h * 0.61))

  $g.Dispose()
  $tileBrush.Dispose(); $fontFamily.Dispose(); $wordFont.Dispose(); $subFont.Dispose()
  $inkBrush.Dispose(); $mutedBrush.Dispose(); $greenBrush.Dispose()
  return $bmp
}

$sizes = 256, 128, 64, 48, 32, 24, 16
$pngs = @()
foreach ($sz in $sizes) {
  $bmp = Render-Square $sz
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,@($sz, $ms.ToArray())
  if ($sz -eq 256) { $bmp.Save("$assets\saz-256.png", [System.Drawing.Imaging.ImageFormat]::Png) }
  if ($sz -eq 32) { $bmp.Save("$assets\saz-32.png", [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose(); $ms.Dispose()
}

$storeSizes = @{
  "Boolean-AppIcon1024.png" = @(1024, 1024)
  "Boolean-Square310x310Logo.png" = @(310, 310)
  "Boolean-Square150x150Logo.png" = @(150, 150)
  "Boolean-Square71x71Logo.png" = @(71, 71)
  "Boolean-Square44x44Logo.png" = @(44, 44)
  "Boolean-StoreLogo50x50.png" = @(50, 50)
}
foreach ($name in $storeSizes.Keys) {
  $dims = $storeSizes[$name]
  $bmp = Render-Square $dims[0]
  $bmp.Save("$store\$name", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$wide = Render-Wide 310 150
$wide.Save("$store\Boolean-Wide310x150Logo.png", [System.Drawing.Imaging.ImageFormat]::Png)
$wide.Dispose()

$fs = [System.IO.File]::Create("$assets\saz.ico")
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($entry in $pngs) {
  $sz = $entry[0]; $data = $entry[1]
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($entry in $pngs) { $bw.Write($entry[1]) }
$bw.Close(); $fs.Close()

Write-Host "done: assets\saz.ico ($([math]::Round((Get-Item "$assets\saz.ico").Length / 1KB)) KB, $($pngs.Count) sizes)"
Write-Host "done: assets\store Microsoft Store logo PNGs"
