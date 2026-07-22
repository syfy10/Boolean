$filePath = "C:\Users\S10\Documents\Boolean\src\ui.html"
$text = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# Find the exact marker
$marker = "live-usage""></span>'+chatActionButtons"
$idx = $text.IndexOf($marker)
Write-Output "Marker found at: $idx"

if ($idx -ge 0) {
    # We need to insert the collapse button between </span> and the '+chatActionButtons
    # The </span> is at idx + 20 (after "live-usage""></span>)
    $insertPos = $idx + "live-usage".Length + "".Length
    # Actually: marker starts at idx. The </span> ends right before the '
    # "live-usage""></span>'+chatActionButtons
    #                     ^-- insert point is right after </span>
    
    $before = $idx + "live-usage".Length + [char]34 + [char]62 + [char]60 + [char]47 + [char]115 + [char]112 + [char]97 + [char]110 + [char]62
    # "live-usage"></span>
    #            ^ insert here
    
    # Simpler: just split on the marker
    $beforeText = $text.Substring(0, $idx)
    $afterMarker = $text.Substring($idx)
    
    $insertBtn = '<button class="msg-collapse-btn" type="button" title="Collapse" aria-label="Collapse exchange">' + [char]39 + [char]9662 + [char]39 + '</button>'
    
    $newText = $beforeText + "live-usage" + [char]34 + [char]62 + [char]60 + [char]47 + [char]115 + [char]112 + [char]97 + [char]110 + [char]62 + $insertBtn + [char]39 + '+chatActionButtons' + $afterMarker.Substring($afterMarker.IndexOf('+chatActionButtons') + '+chatActionButtons'.Length)
    
    [System.IO.File]::WriteAllText($filePath, $newText, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Success"
}
