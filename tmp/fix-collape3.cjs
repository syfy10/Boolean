const fs = require('fs');
const filePath = 'C:/Users/S10/Documents/Boolean/src/ui.html';
let text = fs.readFileSync(filePath, 'utf8');

// 1. Add CSS for the thread summarize banner — after .ctxbar-fill
const cssMarker = '  .ctxbar-fill{ height:3px;';
const cssIdx = text.indexOf(cssMarker);
if (cssIdx < 0) { console.log('CSS marker not found'); process.exit(1); }

const bannerCss = `
  .thread-summarize-banner{ position:relative; padding:8px 14px; background:color-mix(in srgb, var(--accent) 8%, transparent); border:1px solid color-mix(in srgb, var(--accent) 20%, transparent); border-radius:10px; margin:6px 0; font-size:var(--fs-xs); display:flex; align-items:center; gap:8px; }
  .thread-summarize-banner.hidden{ display:none; }
  .thread-summarize-banner .tsb-text{ flex:1; color:var(--dim); }
  .thread-summarize-banner .tsb-text b{ color:var(--text); }
  .thread-summarize-banner button{ padding:4px 10px; border:none; border-radius:6px; background:var(--accent); color:var(--accent-text); font-size:var(--fs-xxs); cursor:pointer; }
  .thread-summarize-banner .tsb-dismiss{ background:var(--bubble); color:var(--dim); }
`;

text = text.substring(0, cssIdx) + bannerCss + text.substring(cssIdx);

// 2. Add the banner HTML — right after <div class="col" id="col"></div>
const colMarker = '<div class="col" id="col"></div>';
const colIdx = text.indexOf(colMarker);
if (colIdx < 0) { console.log('col marker not found'); process.exit(1); }

const bannerHtml = `
    <div class="thread-summarize-banner hidden" id="threadSummarizeBanner">
      <span class="tsb-text">Thread is getting long (<b id="tsbCount">0</b> messages). <b>Summarize</b> to free context.</span>
      <button id="tsbSummarize">Summarize</button>
      <button class="tsb-dismiss" id="tsbDismiss">Dismiss</button>
    </div>`;

text = text.substring(0, colIdx + colMarker.length) + bannerHtml + text.substring(colIdx + colMarker.length);

// 3. Add JS for the banner logic — after the estimateContext function's scheduleEstimate
const jsMarker = 'const scheduleEstimate=()=>{ clearTimeout(estTimer); estTimer=setTimeout(estimateContext,350); };';
const jsIdx = text.indexOf(jsMarker);
if (jsIdx < 0) { console.log('JS marker not found'); process.exit(1); }

const jsCode = `
  function detectLongThread(){
    const count=col.querySelectorAll(".msg-user").length;
    const banner=$("threadSummarizeBanner");
    if(!banner) return;
    if(count>15){
      banner.classList.remove("hidden");
      $("tsbCount").textContent=count;
    }else{
      banner.classList.add("hidden");
    }
  }
  if($("tsbSummarize")) $("tsbSummarize").onclick=()=>{
    $("input").value="Summarize the current chat conversation and save key points to the notepad.";
    setWorkspaceTab("chat");
    $("send")&&$("send").click();
    $("threadSummarizeBanner").classList.add("hidden");
  };
  if($("tsbDismiss")) $("tsbDismiss").onclick=()=>$("threadSummarizeBanner").classList.add("hidden");
`;

text = text.substring(0, jsIdx + jsMarker.length) + jsCode + text.substring(jsIdx + jsMarker.length);

fs.writeFileSync(filePath, text, 'utf8');
console.log('All 3 parts done');
