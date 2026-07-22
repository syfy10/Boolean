$filePath = "C:\Users\S10\Documents\Boolean\src\ui.html"
$content = [System.IO.File]::ReadAllText($filePath)

$old = 'live-usage"></span>' + [char]39 + '+chatActionButtons("ai")' + [char]39 + '</div>'
$new = 'live-usage"></span><button class="msg-collapse-btn" type="button" title="Collapse" aria-label="Collapse exchange">' + [char]39 + [char]9662 + [char]39 + '</button>' + [char]39 + '+chatActionButtons("ai")' + [char]39 + '</div>'

$idx = $content.LastIndexOf($old)
Write-Output "Found last occurrence at: $idx"

if ($idx -ge 0) {
    $content = $content.Substring(0, $idx) + $new + $content.Substring($idx + $old.Length)
    [System.IO.File]::WriteAllText($filePath, $content)
    Write-Output "Done - replaced makeAI usage-inline line"
} else {
    Write-Output "NOT FOUND"
}
