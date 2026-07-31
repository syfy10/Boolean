import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui=fs.readFileSync(new URL("../src/ui.html",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../src/server.js",import.meta.url),"utf8");

test("Explore Studio contains Ad, Draft, Document, and Workflow tools",()=>{
  assert.match(ui,/id="studioWorkspaceTab"/);
  assert.match(ui,/data-studio-view="draft">Draft Studio/);
  assert.match(ui,/data-studio-view="documents">Document Tools/);
  assert.match(ui,/data-studio-view="builder">Workflow Builder/);
  assert.match(ui,/data-studio-view="ads">Ad Creator/);
  assert.match(ui,/id="adAnalyze"/);
  assert.match(ui,/id="adStage"/);
  assert.match(ui,/id="adExport"/);
  assert.match(ui,/id="adAssetQty"/);
  assert.match(ui,/id="adAssetTray"/);
  assert.match(ui,/id="adAssetUpload"/);
  assert.match(ui,/data-studio-view="video-ads">Video Ads/);
  assert.match(ui,/id="videoAdCanvas"/);
  assert.match(ui,/id="videoAdScenes"/);
  assert.match(ui,/id="videoAdPlay"/);
  assert.match(ui,/id="videoAdExport"/);
  assert.match(ui,/id="videoAdGoal"/);
  assert.match(ui,/data-video-length="6"/);
  assert.match(ui,/data-video-length="15"/);
  assert.match(ui,/data-video-length="30"/);
  assert.match(ui,/id="videoAdScore"/);
  assert.match(ui,/id="videoAdImprove"/);
  assert.match(ui,/id="videoAdVeo"/);
  assert.match(ui,/YouTube creative score/);
  assert.match(ui,/new MediaRecorder/);
  assert.match(ui,/captureStream\(30\)/);
  assert.match(ui,/id="studioCreateDraft"/);
  assert.match(ui,/id="studioDocumentFiles"/);
  assert.match(ui,/id="studioWorkflowSteps"/);
});

test("Video Ads keeps local export and offers optional saved-key Veo motion",()=>{
  assert.match(server,/\/api\/studio\/veo\/start/);
  assert.match(server,/\/api\/studio\/veo\/capability/);
  assert.match(server,/models\?pageSize=1000/);
  assert.match(server,/veo-3\.1-fast-generate-preview:predictLongRunning/);
  assert.match(server,/config\.google\?\.apiKey/);
  assert.match(server,/\/api\/studio\/veo\/status/);
  assert.match(server,/\/api\/studio\/veo\/file/);
  assert.match(ui,/Preview and local export stay free/);
  assert.match(ui,/may use paid API credits/);
  assert.match(ui,/id="videoAdVeoState"/);
  assert.match(ui,/id="videoAdVeoCheck"/);
  assert.match(ui,/id="videoAdVeoConfirmRun"/);
  assert.match(ui,/id="videoAdVeoCancel"/);
  assert.match(ui,/id="videoAdVeoRun"/);
  assert.match(ui,/Estimated Google charge: up to \$0\.80/);
  assert.match(ui,/You do not need a second key/);
  assert.match(ui,/Open Google AI Studio/);
  assert.doesNotMatch(ui,/if\(!confirm\("Generate one 8-second Veo/);
  assert.match(ui,/Download MP4/);
  assert.match(ui,/id="videoAdAssetQty"/);
  assert.match(ui,/id="videoAdAssetTray"/);
  assert.match(ui,/id="videoAdAssetUpload"/);
  assert.match(ui,/scene\.assetIndex/);
  assert.match(ui,/image:sourceImage/);
  assert.match(server,/assetLimit/);
  assert.match(server,/data-srcset/);
  assert.match(server,/background\(\?:-image\)\?/);
  assert.match(server,/instance\.image = \{ inlineData/);
  assert.doesNotMatch(server,/numberOfVideos/);
});

test("Studio actions reuse fresh workflow chats and local storage",()=>{
  assert.match(ui,/await startWorkflowTask\(recipe,studioDraftPrompt\(\)\)/);
  assert.match(ui,/await startWorkflowTask\(recipe,\[action/);
  assert.match(ui,/await startWorkflowTask\(studioWorkflowRecipe\(\),studioWorkflowPrompt\(\)\)/);
  assert.match(ui,/booleanStudioBriefsV1/);
  assert.match(ui,/booleanStudioWorkflowsV1/);
});
