import fs from "fs";

let c = fs.readFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", "utf8");

// 1. Add About tab after Advanced in sidebar
const advancedTabEnd = `            Advanced
          </button>
        </div>
        <div class="settings-content">`;

const aboutTab = `            Advanced
          </button>
          <button class="settings-tab" data-settings-tab="about" title="About Updates">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            About
          </button>
        </div>
        <div class="settings-content">`;

function fixLE(s) {
  return c.includes(s.replace(/\n/g, "\r\n")) ? s.replace(/\n/g, "\r\n") : s;
}

let o = fixLE(advancedTabEnd), n = fixLE(aboutTab);
if (c.includes(o)) { c = c.replace(o, n); console.log("About tab added to sidebar"); }
else { console.log("Advanced tab end not found"); }

// 2. Add about section before the save button (before closing divs)
const saveBtnArea = `        </div>
      </div>
      <button class="minibtn" id="savesettings"`;

const aboutSection = `      <div class="sec" data-sec="about" data-search="about version changelog updates feedback documentation license">
        <div class="sechead">About &amp; Updates <span class="caret">▶</span></div>
        <div class="secbody">
          <div class="setrow"><div>Version<div class="hint">Current Boolean build</div></div><b id="aboutVersion">—</b></div>
          <div class="setrow" style="display:block"><div>Changelog<div class="hint">Recent improvements and fixes</div></div><div class="about-line" id="aboutChangelog">Loading…</div></div>
          <div class="setrow"><div>Documentation<div class="hint">Official Boolean help and guides</div></div><button class="minibtn" id="aboutDocs">Open docs</button></div>
          <div class="setrow"><div>Feedback<div class="hint">Report a bug or suggest a feature</div></div><button class="minibtn" id="aboutFeedback">Send feedback</button></div>
        </div>
      </div>
        </div>
      </div>
      <button class="minibtn" id="savesettings"`;

let o2 = fixLE(saveBtnArea), n2 = fixLE(aboutSection);
if (c.includes(o2)) { c = c.replace(o2, n2); console.log("About section added"); }
else { console.log("Save button area not found"); }

fs.writeFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", c);
console.log("Done");
