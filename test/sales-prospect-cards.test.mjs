import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const ui=await readFile(new URL("../src/ui.html",import.meta.url),"utf8");

test("Sales exposes a compact verified prospect card area",()=>{
  assert.match(ui,/id="salesProspects"/);
  assert.match(ui,/id="salesProspectList"/);
  assert.match(ui,/class="sales-prospect-card/);
  assert.match(ui,/Verified buying signal:/);
});

test("prospect cards are derived only from verified dated evidence rows",()=>{
  assert.match(ui,/function salesProspectsFromResearch\(section,existing=\[\]\)/);
  assert.match(ui,/indexes\.verification<0\|\|indexes\.evidence<0\|\|indexes\.checked<0/);
  assert.match(ui,/!\/\\bverified\\b\/i\.test\(verification\)/);
  assert.match(ui,/\\bunverified\|not verified\|suggested\\b/);
  assert.match(ui,/!evidenceLinks\.length\|\|!checkedPattern\.test\(checked\)/);
});

test("prospect cards contain the editable sales workflow fields",()=>{
  for(const field of ["company","website","fit","stage","sequence","reminder","why","nextAction"]){
    assert.match(ui,new RegExp(`data-sales-prospect-field="${field}"`));
  }
  assert.match(ui,/Value-first 3-touch/);
  assert.match(ui,/Awaiting approval/);
  assert.match(ui,/data-sales-evidence/);
});

test("prospect edits and approval state persist with saved plans",()=>{
  assert.match(ui,/function persistSalesProspectChanges\(\)/);
  assert.match(ui,/plan\.prospects=\(salesWorkflow\.prospects\|\|\[\]\)/);
  assert.match(ui,/prospects:Array\.isArray\(plan\.prospects\)\?plan\.prospects:\[\]/);
  assert.match(ui,/if\(!salesWorkflow\.prospects\.length\)syncSalesProspects\(\)/);
});

test("approval is drafting-only and never implies sending",()=>{
  assert.match(ui,/Approve prospect for drafting\?/);
  assert.match(ui,/Nothing will be sent\./);
  assert.match(ui,/Approve for drafting/);
  assert.match(ui,/Drafting approval revoked/);
});
