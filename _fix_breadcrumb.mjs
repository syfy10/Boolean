import fs from "fs";

let c = fs.readFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", "utf8");

// In showSettingsHome, add breadcrumb reset
const oldHome = `    $("settingsBack").title="Close settings";
    $("settingsBack").setAttribute("aria-label","Close settings");
    syncSettingsTabs("home");`;
const newHome = `    $("settingsBack").title="Close settings";
    $("settingsBack").setAttribute("aria-label","Close settings");
    const bc=$("settingsBreadcrumb"); if(bc) bc.innerHTML='<span>Settings</span>';
    syncSettingsTabs("home");`;

function fixLE(s) {
  return c.includes(s.replace(/\n/g, "\r\n")) ? s.replace(/\n/g, "\r\n") : s;
}

let o = fixLE(oldHome), n = fixLE(newHome);
if (c.includes(o)) { c = c.replace(o, n); console.log("Breadcrumb added to showSettingsHome"); }
else { console.log("NOT found"); }

fs.writeFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", c);
console.log("Done");
