$filePath = "C:\Users\S10\Documents\Boolean\src\ui.html"
$text = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# The exact old string from the makeAI function
$old = 'class="usage-inline live-usage"></span>' + [char]39 + '+chatActionButtons("ai")' + [char]39 + '</div>'
$idx = $text.IndexOf($old)
Write-Output "Found at: $idx"

if ($idx -ge 0) {
    $new = 'class="usage-inline live-usage"></span><button class="msg-collapse-btn" type="button" title="Collapse" aria-label="Collapse exchange">' + [char]39 + [char]9662 + [char]39 + '</button>' + [char]39 + '+chatActionButtons("ai")' + [char]39 + '</div>'
    $text = $text.Substring(0, $idx) + $new + $text.Substring($idx + $old.Length)
    [System.IO.File]::WriteAllText($filePath, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Success"
} else {
    Write-Output "NOT FOUND - trying different encoding"
    # try with \r\n
    $old2 = $old.Replace([char]39, "`'" )
    $idx2 = $text.IndexOf($old2)
    Write-Output "Alt search at: $idx2"
}
