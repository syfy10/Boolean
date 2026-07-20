import fs from "fs";

let c = fs.readFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", "utf8");

// Find the old tabs block and replace with sidebar + content wrapper
const oldTabs = [
  '      <div class="settings-tabs" id="settingsTabs" aria-label="Settings sections">',
  '        <button class="settings-tab active" data-settings-tab="home">Home</button>',
  '        <button class="settings-tab" data-settings-tab="model">Models</button>',
  '        <button class="settings-tab" data-settings-tab="agent">Agent</button>',
  '        <button class="settings-tab" data-settings-tab="thirdparty">Connections</button>',
  '        <button class="settings-tab" data-settings-tab="browser">Browser</button>',
  '        <button class="settings-tab" data-settings-tab="memory">Notes</button>',
  '        <button class="settings-tab" data-settings-tab="scheduled">Tasks</button>',
  '        <button class="settings-tab" data-settings-tab="appearance">Look</button>',
  '        <button class="settings-tab" data-settings-tab="advanced">Advanced</button>',
  '      </div>'
].join("\n");

const newTabs = `      <div class="settings-tabs-row">
        <div class="settings-tabs" id="settingsTabs" aria-label="Settings sections">
          <button class="settings-tab active" data-settings-tab="home" title="Overview / Dashboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
            Overview
          </button>
          <button class="settings-tab" data-settings-tab="model" title="AI Models">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M6 10v1a6 6 0 0 0 12 0v-1"/><path d="M12 17v4"/><path d="M8 21h8"/></svg>
            AI Models
          </button>
          <button class="settings-tab" data-settings-tab="agent" title="Coding Agent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
            Agent
          </button>
          <button class="settings-tab" data-settings-tab="thirdparty" title="Connectors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Connectors
          </button>
          <button class="settings-tab" data-settings-tab="browser" title="Browser Research">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Browser
          </button>
          <button class="settings-tab" data-settings-tab="memory" title="Notepad Memory">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            Notes
          </button>
          <button class="settings-tab" data-settings-tab="scheduled" title="Tasks Automations">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>
            Tasks
          </button>
          <button class="settings-tab" data-settings-tab="legal" title="Privacy Security">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Privacy
          </button>
          <button class="settings-tab" data-settings-tab="appearance" title="Appearance UI">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            Appearance
          </button>
          <button class="settings-tab" data-settings-tab="advanced" title="Advanced Developer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
            Advanced
          </button>
        </div>
        <div class="settings-content">`;

// Also need to close the settings-tabs-row div before the save button
const saveBtn = '      <button class="minibtn" id="savesettings"';
const newSave = '        </div>\n      </div>\n      <button class="minibtn" id="savesettings"';

// Handle \r\n vs \n
let oldTabsFile = oldTabs;
let newTabsFile = newTabs;
if (c.includes(oldTabs.replace(/\n/g, "\r\n"))) {
  oldTabsFile = oldTabs.replace(/\n/g, "\r\n");
  newTabsFile = newTabs.replace(/\n/g, "\r\n");
}

if (!c.includes(oldTabsFile)) {
  console.log("ERROR: old tabs not found");
  process.exit(1);
}

c = c.replace(oldTabsFile, newTabsFile);
console.log("Tabs replaced OK");

// Close the wrapper div before save button
let saveBtnFile = saveBtn;
let newSaveFile = newSave;
if (c.includes(saveBtn.replace(/\n/g, "\r\n"))) {
  saveBtnFile = saveBtn.replace(/\n/g, "\r\n");
  newSaveFile = newSave.replace(/\n/g, "\r\n");
}
c = c.replace(saveBtnFile, newSaveFile);
console.log("Save button wrapper added OK");

fs.writeFileSync("C:/Users/S10/Documents/Boolean/src/ui.html", c);
console.log("Done!");
