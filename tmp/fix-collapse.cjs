const fs = require('fs');
const filePath = 'C:/Users/S10/Documents/Boolean/src/ui.html';
let text = fs.readFileSync(filePath, 'utf8');

const marker = 'saveChatMessageToNote(noteBtn); return; }';
const idx = text.lastIndexOf(marker);
console.log('Found at:', idx);

if (idx >= 0) {
    const afterPos = idx + marker.length;
    const collapseCode = `

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
    }`;

    text = text.substring(0, afterPos) + collapseCode + text.substring(afterPos);
    fs.writeFileSync(filePath, text, 'utf8');
    console.log('Done');
}
