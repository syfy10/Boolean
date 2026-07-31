import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const ui=await readFile(new URL("../src/ui.html",import.meta.url),"utf8");

test("the reusable task library is visibly named Workflows",()=>{
  assert.match(ui,/id="recipesWorkspaceTab"[^>]*>[\s\S]*?Workflows<\/button>/);
  assert.match(ui,/id="recipesPanel" aria-label="Workflows"/);
  assert.match(ui,/aria-label="Workflow categories"/);
  assert.match(ui,/placeholder="Search workflows\.\.\."/);
});

test("Workflows supports favorites recent and user-saved filters",()=>{
  assert.match(ui,/data-workflow-filter="favorites"/);
  assert.match(ui,/data-workflow-filter="recent"/);
  assert.match(ui,/data-workflow-filter="mine"/);
  assert.match(ui,/const WORKFLOW_PREFS_KEY="boolean\.workflowPrefs\.v1"/);
  assert.match(ui,/function toggleWorkflowFavorite\(id\)/);
  assert.match(ui,/function markWorkflowRecent\(id\)/);
});

test("Workflows uses one full-page catalog and detail workspace",()=>{
  assert.match(ui,/recipes-shell workflow-guided/);
  assert.match(ui,/grid-template-columns:minmax\(230px,38%\) minmax\(0,62%\)/);
  assert.match(ui,/id="recipeGrid"/);
  assert.match(ui,/id="recipeDetail" aria-label="Workflow details"/);
  assert.match(ui,/workflow-runner-body\{[^}]*overflow-x:hidden; overflow-y:auto;/);
  assert.match(ui,/workflow-runner-main \.workflow-step-preview\{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(ui,/workflow-quick-picker\{ display:none; \}/);
});

test("small Workflows uses a catalog drawer and stacked detail sections",()=>{
  assert.match(ui,/id="workflowCatalogToggle" aria-expanded="false">Browse workflows/);
  assert.match(ui,/workflow-guided\.catalog-open \.recipes-main\{ display:flex; \}/);
  assert.match(ui,/width:min\(238px,72%\); padding:6px 7px; gap:4px;/);
  assert.match(ui,/\.workflow-guided \.recipe-card\{ min-height:40px; padding:5px 4px; \}/);
  assert.match(ui,/\.workflow-guided \.recipe-card small\{ margin-top:1px; font-size:8\.5px; white-space:nowrap; display:block; \}/);
  assert.match(ui,/workflow-runner-body\{ grid-template-columns:1fr; padding-inline:12px; \}/);
  assert.match(ui,/workflowCatalogToggle"\)\.setAttribute\("aria-expanded",String\(open\)\)/);
});

test("generic workflows expose structured inputs and five visible stages",()=>{
  assert.match(ui,/id="recipeOutput"/);
  assert.match(ui,/Goal or instructions/);
  assert.match(ui,/function workflowSteps\(recipe\)/);
  assert.match(ui,/\["Inspect","Reproduce","Patch","Test","Report"\]/);
  assert.match(ui,/class="workflow-step-preview"/);
});

test("run preview shows model context tools and approval",()=>{
  for(const label of ["Model","Context","Tools","Approval"]){
    assert.match(ui,new RegExp(`workflow-preview-row[^>]*><span>${label}<`));
  }
  assert.match(ui,/Required before risky actions/);
  assert.match(ui,/Start workflow/);
});

test("configured workflows can be saved as reusable user copies",()=>{
  assert.match(ui,/function saveConfiguredWorkflowCopy\(\)/);
  assert.match(ui,/id="workflow-copy-"\+Date\.now\(\)/);
  assert.match(ui,/workflowFilter="mine"/);
  assert.match(ui,/\$\("recipeFill"\)\.onclick=saveConfiguredWorkflowCopy/);
});

test("starting a workflow creates a fresh chat and keeps Workflows open",()=>{
  assert.match(ui,/async function startWorkflowTask\(recipe,prompt,ai=bestAvailableAiForRun\(\)\)/);
  assert.match(ui,/function revealWorkflowRunProgress\(\)[\s\S]*?detail\.scrollTo\(\{top:0,behavior:"smooth"\}\)[\s\S]*?scrollIntoView\(\{behavior:"smooth",block:"start",inline:"nearest"\}\)/);
  assert.match(ui,/renderWorkflowRunProgress\(\);\s*revealWorkflowRunProgress\(\);\s*startRun\(threadId,/);
  assert.match(ui,/await newChat\(\{preserveWorkspace:true\}\)/);
  assert.match(ui,/workflowRun:true,workflowRecipeId:recipe\.id/);
  assert.match(ui,/if\(activeWsTab!=="recipes"\)markWorkspaceTab\("recipes"\)/);
  assert.match(ui,/!opts\.salesWorkflow&&!opts\.workflowRun/);
  assert.match(ui,/if\(opts\.workflowRun\)\{[\s\S]*?body\.workflowRun=true;/);
  assert.match(ui,/pendingWorkflowDraft&&!busy\(\)/);
  assert.match(ui,/function loadWorkflowDraft\(recipe,prompt\)/);
  assert.doesNotMatch(ui,/setComposerDraft\(prompt\);\s*setWorkspaceTab\("chat"\);\s*tempToast\("Email workflow loaded into chat\."\)/);
});

test("live workflow stages consume checkpoints and show completion states",()=>{
  assert.match(ui,/WORKFLOW_STAGE_\(\[1-5\]\)/);
  assert.match(ui,/function workflowLiveCheckpoint\(note\)/);
  assert.match(ui,/finishedRun\?\.request\?\.workflowRun&&finishedRun\.answered&&workflowRun\.running[\s\S]*?workflowRun\.states=workflowRun\.steps\.map\(\(\)=>"done"\)/);
  assert.match(ui,/workflowRun\.detail="Finishing the chat response and final checks\."/);
  assert.match(ui,/class="workflow-live-status/);
  assert.match(ui,/workflowRunEvent\(ev\)/);
  assert.match(ui,/function advanceWorkflowStage\(nextStage\)/);
  assert.match(ui,/for\(let index=0;index<next;index\+\+\)if\(!workflowRun\.states\[index\]\)workflowRun\.states\[index\]="done"/);
  assert.match(ui,/Waiting for approval/);
  assert.match(ui,/workflowRun\.threadId===threadId&&!!workflowRun\.recipeId[\s\S]*?workflowRun\.waiting\|\|\(activeWsTab==="recipes"&&workspaceContextSharing\)/);
  assert.match(ui,/needsApproval=.*waiting for[\s\S]*move \..* to trash/);
  assert.match(ui,/workflowRun\.states\[workflowRun\.stage\]="waiting"/);
  assert.match(ui,/workflowFollowup\?\{workflowRun:true,workflowRecipeId:workflowRun\.recipeId\}/);
  assert.match(ui,/queuedWorkflowContinuation=\(queues\[tid\]\|\|\[\]\)\.some[\s\S]*?!queuedWorkflowContinuation/);
  assert.match(ui,/queuedWorkflow=!comparing&&!!run\?\.request\?\.workflowRun[\s\S]*?queuedWorkflow\?\{workflowRun:true,workflowRecipeId:workflowRun\.recipeId\}/);
  assert.match(ui,/linkedChatActive=ownsRun&&!!run&&run\.threadId===workflowRun\.threadId/);
  assert.match(ui,/!linkedChatActive&&!workflowRun\.running&&workflowRun\.completedAt\?"Workflow complete"/);
});

test("workflow builder customizes versioned steps and keeps local run history",()=>{
  assert.match(ui,/data-workflow-mode="guided"[\s\S]*data-workflow-mode="builder"/);
  assert.match(ui,/const WORKFLOW_BLUEPRINTS_KEY="boolean\.workflowBlueprints\.v1"/);
  assert.match(ui,/function renderWorkflowBuilder\(recipe\)/);
  assert.match(ui,/data-builder-name[\s\S]*data-builder-tool[\s\S]*data-builder-approval[\s\S]*data-builder-failure/);
  assert.match(ui,/persistWorkflowBlueprint\(recipe,saveDraft\(\),\{version:true\}\)/);
  assert.match(ui,/const WORKFLOW_RUN_HISTORY_KEY="boolean\.workflowRunHistory\.v1"/);
  assert.match(ui,/recordWorkflowRun\("complete"\)/);
  assert.match(ui,/Execution rules:\\n/);
});
