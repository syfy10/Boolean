const fs = require('fs');
const filePath = 'C:/Users/S10/Documents/Boolean/src/ui.html';
let text = fs.readFileSync(filePath, 'utf8');

// Add detectLongThread() call after updateCopyButton in addUser
const marker = 'if(!quiet){ updateCopyButton(); updateComposerConsoleInfo(); scrollDown(true); }';
const idx = text.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

const newCode = 'if(!quiet){ updateCopyButton(); updateComposerConsoleInfo(); detectLongThread(); scrollDown(true); }';

text = text.substring(0, idx) + newCode + text.substring(idx + marker.length);

fs.writeFileSync(filePath, text, 'utf8');
console.log('Done');
