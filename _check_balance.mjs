import fs from "fs";

const c = fs.readFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", "utf8");
const lines = c.split(/\r?\n/);

// Find settings-tabs-row opening
let startLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('class="settings-tabs-row"')) { startLine = i; break; }
}

// Track to find where depth returns to 0 (the closing div for settings-tabs-row)
let depth = 0;
let closeLine = -1;
for (let i = startLine; i < lines.length; i++) {
  const opens = (lines[i].match(/<div[\s>]/g) || []).length;
  const closes = (lines[i].match(/<\/div>/g) || []).length;
  const prevDepth = depth;
  depth += opens - closes;
  
  if (depth === 0 && i > startLine) {
    closeLine = i;
    console.log(`settings-tabs-row closes at line ${i + 1}`);
    break;
  }
  
  // Show lines where depth changes to near 0
  if (depth <= 1 && prevDepth >= 2 && i > startLine + 100) {
    console.log(`  depth ${prevDepth}→${depth} at line ${i + 1}: ${lines[i].trimEnd().substring(0, 100)}`);
  }
}

if (closeLine < 0) {
  console.log("Never reached depth 0. Last lines:");
  for (let i = lines.length - 10; i < lines.length; i++) {
    console.log(`  ${i + 1}: ${lines[i].trimEnd()}`);
  }
}
