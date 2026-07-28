import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const catalog = JSON.parse(fs.readFileSync(new URL("../src/education-official.json", import.meta.url), "utf8"));
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("official Education catalog contains released NYSED exams and scoring metadata", () => {
  assert.equal(catalog.generatedAt, "2026-07-28");
  assert.ok(catalog.exams.length >= 20);
  for (const subject of ["regentsAlgebra", "regentsGeometry", "regentsEla", "regentsScience", "regentsHistory"]) {
    assert.ok(catalog.exams.some(exam => exam.subject === subject), subject);
  }
  for (const exam of catalog.exams) {
    assert.match(exam.examUrl, /^https:\/\/www\.nysedregents\.org\//i);
    assert.match(exam.keyUrl, /^https:\/\/www\.nysedregents\.org\//i);
    assert.ok(exam.year >= 2021 && exam.year <= 2025);
    assert.ok(exam.questionCount >= exam.multipleChoiceCount);
    assert.equal(Object.keys(exam.answers).length, exam.multipleChoiceCount);
    assert.equal(Math.max(...Object.keys(exam.credits).map(Number)), exam.questionCount);
    assert.equal(Object.keys(exam.questionPages).length, exam.questionCount);
    assert.ok(Object.values(exam.questionPages).every(page => Number.isInteger(page) && page > 0));
    assert.match(exam.attribution, /From the New York State Education Department/);
  }
});

test("official Education documents are allowlisted, proxied, and graded in the workspace", () => {
  assert.match(server, /officialEducationCatalog from "\.\/education-official\.json"/);
  assert.match(server, /p === "\/api\/education\/official"/);
  assert.match(server, /p === "\/api\/education\/card"/);
  assert.match(server, /p === "\/api\/education\/pdf"/);
  assert.match(server, /nysedregents\\\.org/);
  assert.match(ui, /Official released test/);
  assert.match(ui, /Five-year official mix/);
  assert.match(ui, /function educationGradeOfficial\(\)/);
  assert.match(ui, /Official scale score/);
  assert.match(ui, /Multiple-choice answers are graded automatically/);
});

test("Education requires an account and filters exams by student grade", () => {
  assert.match(ui, /id="educationWorkspaceTab"[^>]*hidden aria-hidden="true"/);
  assert.match(ui, /id="educationGrade"/);
  assert.match(ui, /<option value="" selected>All grades<\/option>/);
  assert.match(ui, /sat:\[11,12\]/);
  assert.match(ui, /if\(!allGrades\)entries=entries\.filter/);
  assert.match(ui, /iq:\[6,7,8,9,10,11,12\]/);
  assert.match(ui, /\["education","markets"\]\.includes\(ws\)&&!marketsAccessAllowed\(\)/);
  assert.match(ui, /\["educationWorkspaceTab","marketsWorkspaceTab"\]/);
  assert.match(server, /Sign in to your Boollm account to use Education\./);
});

test("Education covers grades 6 through 12 and keeps test exit visible", () => {
  for (const grade of [6, 7, 8, 9, 10, 11, 12]) {
    assert.match(ui, new RegExp(`<option value="${grade}"`));
  }
  assert.match(ui, /grade6:\[6\],grade7:\[7\],iseeMiddle:\[6,7\],ssatMiddle:\[6,7\]/);
  assert.match(ui, /id="educationExitTop"[^>]*>Save &amp; exit test<\/button>/);
  assert.match(ui, /body\.education-testing #educationExitTop\{ display:inline-flex;/);
  assert.match(ui, /\$\("educationExitTop"\)\.onclick=educationExitOfficial/);
  assert.match(ui, /option\.disabled=!allGrades&&grade<8/);
});

test("official exams use a focused one-question reader with navigation and flags", () => {
  for (const id of ["educationOfficialPrevious", "educationOfficialNext", "educationOfficialFlag", "educationOfficialPage", "educationOfficialMap"]) {
    assert.match(ui, new RegExp(`id="${id}"`));
  }
  assert.match(ui, /function educationMoveOfficial\(number\)/);
  assert.match(ui, /currentQuestion:1/);
  assert.match(ui, /questionPages\?\.\[officialKey\]/);
  assert.match(ui, /#page=\$\{page\}&zoom=page-width/);
  assert.match(ui, /education-map-button\.answered/);
  assert.match(ui, /education-question-card\{ grid-row:1;/);
  assert.match(ui, /id="educationOfficialCard"/);
  assert.match(ui, /function educationOfficialCard\(\)/);
  assert.match(ui, /Read the official question card, then pick your answer below/);
});

test("every official question has a generated Boollm card", () => {
  const cardsRoot = new URL("../assets/education-cards/", import.meta.url);
  for (const exam of catalog.exams) {
    for (let number = 1; number <= exam.questionCount; number++) {
      assert.ok(fs.existsSync(new URL(`${exam.id}/${number}.webp`, cardsRoot)), `${exam.id} question ${number}`);
    }
  }
});
