$filePath = "C:\Users\S10\Documents\Boolean\src\ui.html"
$text = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

$marker = 'saveChatMessageToNote(noteBtn); return; }'
$idx = $text.LastIndexOf($marker)
Write-Output "Found at: $idx"

if ($idx -ge 0) {
    $afterPos = $idx + $marker.Length
    $nl = [char]10
    $sp4 = "    "
    
    $lines = @(
        "",
        $sp4 + "const collapseBtn=e.target.closest(" + [char]34 + ".msg-collapse-btn" + [char]34 + ");",
        $sp4 + "if(collapseBtn){",
        $sp4 + $sp4 + "e.preventDefault();",
        $sp4 + $sp4 + "const aiMsg=collapseBtn.closest(" + [char]34 + ".msg-ai" + [char]34 + ");",
        $sp4 + $sp4 + "if(!aiMsg) return;",
        $sp4 + $sp4 + "const isCollapsed=aiMsg.classList.toggle(" + [char]34 + "msg-collapsed" + [char]34 + ");",
        $sp4 + $sp4 + "collapseBtn.innerHTML=isCollapsed?" + [char]39 + "&#9652;" + [char]39 + ":" + [char]39 + "&#9662;" + [char]39 + ";",
        $sp4 + $sp4 + "collapseBtn.title=isCollapsed?" + [char]34 + "Expand this exchange" + [char]34 + ":" + [char]34 + "Collapse this exchange" + [char]34 + ";",
        $sp4 + $sp4 + "let prev=aiMsg.previousElementSibling;",
        $sp4 + $sp4 + "while(prev && !prev.classList.contains(" + [char]34 + "msg-user" + [char]34 + ")) prev=prev.previousElementSibling;",
        $sp4 + $sp4 + "if(prev) prev.classList.toggle(" + [char]34 + "msg-collapsed" + [char]34 + ",isCollapsed);",
        $sp4 + $sp4 + "return;",
        $sp4 + "}",
    )
    $collapseCode = $nl + ($lines -join $nl)
    
    $newText = $text.Substring(0, $afterPos) + $collapseCode + $text.Substring($afterPos)
    [System.IO.File]::WriteAllText($filePath, $newText, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Done"
}
