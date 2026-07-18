const fs = require("fs");
const html = fs.readFileSync("src/ui.html", "utf8");
const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
let i = 0;
let hasError = false;
for (const s of scripts) {
  i++;
  const code = s.replace(/<\/?script[^>]*>/gi, "");
  if (!code.trim()) continue;
  try {
    new Function(code);
    console.log("script block " + i + ": OK (" + code.length + " chars)");
  } catch (e) {
    console.error("script block " + i + " ERROR: " + e.message);
    hasError = true;
  }
}
console.log("Total script blocks: " + scripts.length);
process.exit(hasError ? 1 : 0);
