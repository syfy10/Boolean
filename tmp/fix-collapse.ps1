$filePath = "C:\Users\S10\Documents\Boolean\src\ui.html"
$text = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# Find the second occurrence (the one inside the main col click handler)
$marker = 'const noteBtn=e.target.closest(".note-save");'
$firstIdx = $text.IndexOf($marker)
$secondIdx = $text.IndexOf($marker, $firstIdx + $marker.Length)
Write-Output "First at: $firstIdx, Second at: $secondIdx"

if ($secondIdx -ge 0) {
    $afterMarker = $text.Substring($secondIdx)
    # Find the end of the line (the next occurrence of note-save)
    $endOfLine = $afterMarker.IndexOf("saveChatMessageToNote(noteBtn); return; }")
    Write-Output "End of block at offset: $endOfLine"
    
    $blockEnd = $secondIdx + "const noteBtn=e.target.closest(" + [char]34 + ".note-save" + [char]34 + ");" + "`n    if(noteBtn){ e.preventDefault(); saveChatMessageToNote(noteBtn); return; }".Length
    
    $collapseCode = @"

    const collapseBtn=e.target.closest(".msg-collapse-btn");
    if(collapseBtn){
      e.preventDefault();
      const aiMsg=collapseBtn.closest(".msg-ai");
      if(!aiMsg) return;
      const isCollapsed=aiMsg.classList.toggle("msg-collapsed");
      collapseBtn.innerHTML=isCollapsed?'&#9652;':'&#9662;';
      collapseBtn.title=isCollapsed?"Expand this exchange":"Collapse this exchange";
      let prev=aiMsg.previousElementSibling;
      while(prev && !prev.classList.contains("msg-user")) prev=prev.previousElementSibling;
      if(prev) prev.classList.toggle("msg-collapsed",isCollapsed);
      return;
    }
"@ 
    $newText = $text.Substring(0, $secondIdx) + $collapseCode + "`n    " + $afterMarker
    [System.IO.File]::WriteAllText($filePath, $newText, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Done"
}
