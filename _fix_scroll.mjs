import fs from "fs";

let c = fs.readFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", "utf8");

// Fix second scrollTop
const old1 = `    if(section.dataset.sec==="github") loadGithubStatus();\n    if(section.dataset.sec==="skills") loadSkillList();\n    panel.scrollTop=0;`;
const new1 = `    if(section.dataset.sec==="github") loadGithubStatus();\n    if(section.dataset.sec==="skills") loadSkillList();\n    const ca = panel.querySelector(".settings-content");\n    if (ca) ca.scrollTop = 0; else panel.scrollTop = 0;`;

// Handle line endings
function fixLineEndings(str) {
  if (c.includes(str.replace(/\n/g, "\r\n"))) return str.replace(/\n/g, "\r\n");
  return str;
}

let o1 = fixLineEndings(old1), n1 = fixLineEndings(new1);
if (c.includes(o1)) {
  c = c.replace(o1, n1);
  console.log("Second scrollTop fixed");
} else {
  console.log("Second scrollTop NOT found");
}

fs.writeFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", c);
console.log("Done");
