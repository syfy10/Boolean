# Generates the Boolean app icon while keeping the existing asset filenames
# used by the build pipeline: assets\saz.ico, assets\saz-256.png, assets\saz-32.png.
# Mark: a bold terminal tile designed to stay legible at Windows' 16px taskbar size.
# The >_ shape uses simple geometry rather than text so antialiasing cannot make
# the small icon disappear.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = "$root\assets"
$store = "$assets\store"
New-Item -ItemType Directory -Force $assets | Out-Null
New-Item -ItemType Directory -Force $store | Out-Null

$ink = [System.Drawing.Color]::FromArgb(0x14, 0x19, 0x17)
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
  $tileInset = [Math]::Max(1, $s * 0.02)
  $tileSize = $s - ($tileInset * 2)
  $tilePath = New-RoundedPath $tileInset $tileInset $tileSize $tileSize ($s * 0.20)
  $inkBrush = New-Object System.Drawing.SolidBrush($ink)
  $g.FillPath($inkBrush, $tilePath)

  $stroke = [Math]::Max(2, [Math]::Round($s * 0.085))
  $greenPen = New-Object System.Drawing.Pen($green, $stroke)
  $greenPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $greenPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $greenPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $x1 = $s * 0.32
  $x2 = $s * 0.52
  $x3 = $s * 0.32
  $y1 = $s * 0.34
  $y2 = $s * 0.50
  $y3 = $s * 0.66
  $g.DrawLine($greenPen, $x1, $y1, $x2, $y2)
  $g.DrawLine($greenPen, $x2, $y2, $x3, $y3)

  $cursorH = [Math]::Max(2, [Math]::Round($s * 0.07))
  $cursorW = $s * 0.20
  $cursorX = $s * 0.58
  $cursorY = $s * 0.64
  $cursorPath = New-RoundedPath $cursorX $cursorY $cursorW $cursorH ($cursorH * 0.5)
  $greenBrush = New-Object System.Drawing.SolidBrush($green)
  $g.FillPath($greenBrush, $cursorPath)

  $g.Dispose()
  $inkBrush.Dispose(); $greenPen.Dispose(); $greenBrush.Dispose()
  return $bmp
}

function Render-Wide([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

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
  $fontFamily.Dispose(); $wordFont.Dispose(); $subFont.Dispose()
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
