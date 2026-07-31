import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("Explore includes a local Research Library", () => {
  assert.match(ui, /data-workspace-page="library"[\s\S]*?>Library<span class="workspace-beta">Beta<\/span>/);
  assert.match(ui, /id="libraryPanel" aria-label="Research Library"/);
  assert.match(ui, /Save current page/);
  assert.match(ui, /Save current note/);
  assert.match(ui, /Add PDF or image/);
  assert.match(ui, /const EXPLORE_WORKSPACES=\["markets","education","recipes","sales","library","studio"\]/);
  assert.match(ui, /document\.body\.classList\.toggle\("library-open", activeWsTab === "library"\)/);
});

test("Library persists metadata locally and file bodies in IndexedDB", () => {
  assert.match(ui, /const LIBRARY_KEY="booleanResearchLibraryV1"/);
  assert.match(ui, /const LIBRARY_DB="boolean-library-files"/);
  assert.match(ui, /indexedDB\.open\(LIBRARY_DB,1\)/);
  assert.match(ui, /request\.result\.createObjectStore\("files"\)/);
  assert.match(ui, /localStorage\.setItem\(LIBRARY_KEY/);
  assert.match(ui, /libraryFilePut\(id,file\)/);
});

test("Library cards can open, summarize, use in chat, and be removed", () => {
  assert.match(ui, /data-library-action="open"/);
  assert.match(ui, /data-library-action="summarize"/);
  assert.match(ui, /data-library-action="chat"/);
  assert.match(ui, /data-library-action="delete"/);
  assert.match(ui, /function useLibraryInChat\(item,summarize=false\)/);
  assert.match(ui, /function openLibraryItem\(item\)/);
  assert.match(ui, /libraryItems=libraryItems\.filter\(row=>row\.id!==item\.id\)/);
});
