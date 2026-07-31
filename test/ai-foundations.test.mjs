import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui=fs.readFileSync(new URL("../src/ui.html",import.meta.url),"utf8");

test("Education includes a local AI Foundations learning path",()=>{
  assert.match(ui,/data-education-page="practice"/);
  assert.match(ui,/data-education-page="foundations"/);
  assert.match(ui,/const AI_FOUNDATIONS_SAVE_KEY="boollmAiFoundationsV1"/);
  assert.match(ui,/const aiFoundationModules=\[/);
  for(const title of ["What is AI?","Neural networks","Computer vision","Language and text","LLMs and prompting","Responsible AI"]){
    assert.match(ui,new RegExp(title.replace(/[?]/g,"\\?")));
  }
  assert.match(ui,/function renderAiFoundations\(\)/);
  assert.match(ui,/Answer all three quick-check questions first/);
});

test("AI Foundations preserves attribution and optional source lessons",()=>{
  assert.match(ui,/microsoft\/AI-For-Beginners/);
  assert.match(ui,/under the MIT license/);
  assert.match(ui,/Simplified Boolean lessons are not Microsoft-authored/);
  assert.match(ui,/id="aiLessonSource"/);
  assert.match(ui,/id="aiLessonAsk"/);
});
