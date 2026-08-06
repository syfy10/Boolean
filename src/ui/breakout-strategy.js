// The breakout strategy's pure core: config normalisation, indicator maths,
// candidate selection, and the state machine step.
//
// Deliberately excluded and left in ui.html: buildBreakoutBarsFromHistory and
// seedBreakoutHistory (they mutate module-level caches and the live runtime),
// and loadBreakoutRuntime / saveBreakoutRuntime (localStorage). Everything here
// takes its state as an argument and returns a new value.
import { normalizeSymbolInput } from "./trading-logic.js";

const BREAKOUT_HISTORY_YEARS=2;
const BREAKOUT_HISTORY_MIN_BARS=30;
const BREAKOUT_HISTORY_MAX_BARS=120;

const BREAKOUT_DEFAULTS=Object.freeze({enabled:false,key:"multi",mode:"all",timeframeMinutes:5,lookbackBars:20,fastBars:9,slowBars:21,meanBars:20,meanSigma:2,riskReward:2,maxSignalsPerDay:4,cooldownBars:2,atrBars:14,atrStopMultiple:1,regimeFilter:true,trendMinEfficiency:.35,rangeMaxEfficiency:.25,breakoutBufferAtr:.25,outcomeHorizonBars:20});

function normalizeBreakoutConfig(value={}){
  const input=value&&typeof value==="object"?value:{};
  const timeframe=[1,5,15].includes(Number(input.timeframeMinutes))?Number(input.timeframeMinutes):5;
  const allowedModes=new Set(["breakout","ema","meanReversion","all"]);
  const requested=String(input.mode||(input.key==="breakout"?"breakout":""));
  const mode=allowedModes.has(requested)?requested:"all";
  const fastBars=Math.min(50,Math.max(3,Math.round(Number(input.fastBars)||9)));
  const slowBars=Math.min(100,Math.max(fastBars+2,Math.round(Number(input.slowBars)||21)));
  return {
    enabled:input.enabled===true,
    key:mode==="all"?"multi":mode,
    mode,
    timeframeMinutes:timeframe,
    lookbackBars:Math.min(100,Math.max(5,Math.round(Number(input.lookbackBars)||20))),
    fastBars,
    slowBars,
    meanBars:Math.min(100,Math.max(10,Math.round(Number(input.meanBars)||20))),
    meanSigma:Math.min(3,Math.max(1,Number(input.meanSigma)||2)),
    riskReward:Math.min(5,Math.max(1,Number(input.riskReward)||2)),
    maxSignalsPerDay:Math.min(10,Math.max(1,Math.round(Number(input.maxSignalsPerDay)||4))),
    cooldownBars:Math.min(12,Math.max(1,Math.round(Number(input.cooldownBars)||2))),
    // Kept in step with normalizeTradingStrategy() in server.js.
    atrBars:Math.min(50,Math.max(5,Math.round(Number(input.atrBars)||14))),
    atrStopMultiple:Math.min(3,Math.max(0,Number(input.atrStopMultiple??1))),
    regimeFilter:input.regimeFilter!==false,
    trendMinEfficiency:Math.min(1,Math.max(0,Number(input.trendMinEfficiency??.35))),
    rangeMaxEfficiency:Math.min(1,Math.max(0,Number(input.rangeMaxEfficiency??.25))),
    breakoutBufferAtr:Math.min(2,Math.max(0,Number(input.breakoutBufferAtr??.25))),
    outcomeHorizonBars:Math.min(100,Math.max(5,Math.round(Number(input.outcomeHorizonBars)||20)))
  };
}

function emptyBreakoutRuntime(){
  return {symbol:"",dayKey:"",bars:[],current:null,signalsToday:0,lastSignal:null,lastSignalId:"",lastMetrics:null,lastConflictAt:0,openSignals:[]};
}
function cleanBreakoutBar(value){
  if(!value||typeof value!=="object") return null;
  const bar={bucket:Number(value.bucket),open:Number(value.open),high:Number(value.high),low:Number(value.low),close:Number(value.close)};
  return Object.values(bar).every(Number.isFinite)&&bar.open>0&&bar.high>0&&bar.low>0&&bar.close>0?bar:null;
}

function strategySeedRequest(config={}){
  const cfg=normalizeBreakoutConfig(config);
  if(cfg.timeframeMinutes<=1) return {range:"5d",interval:"1m"};
  if(cfg.timeframeMinutes<=5) return {range:"1mo",interval:"5m"};
  return {range:"1mo",interval:"15m"};
}
// Median gap between points, in minutes. Median rather than mean so overnight
// and weekend gaps in an intraday series do not drag the estimate up.
function historySpacingMinutes(points){
  const times=(Array.isArray(points)?points:[]).map((point)=>Number(point?.time))
    .filter(Number.isFinite).sort((a,b)=>a-b);
  if(times.length<3) return 0;
  const gaps=times.slice(1).map((time,index)=>(time-times[index])/60_000).filter((gap)=>gap>0).sort((a,b)=>a-b);
  if(!gaps.length) return 0;
  return gaps[Math.floor(gaps.length/2)];
}

function breakoutDayKey(at){
  try{
    return new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(at));
  }catch{ return new Date(at).toISOString().slice(0,10); }
}
const averageNumbers=(values)=>values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length);
function emaForStrategy(values,period){
  if(!Array.isArray(values)||values.length<period) return null;
  const alpha=2/(period+1);
  let ema=averageNumbers(values.slice(0,period));
  for(let index=period;index<values.length;index+=1) ema=values[index]*alpha+ema*(1-alpha);
  return ema;
}
// Average true range over the last `period` completed bars. Plain mean of the
// true ranges rather than Wilder's smoothing — one fewer piece of state, and
// it is only used to set a floor, not to trigger anything.
function atrForBars(list,period){
  if(!Array.isArray(list)||list.length<period+1) return null;
  const ranges=[];
  for(let index=list.length-period;index<list.length;index+=1){
    const bar=list[index], previous=list[index-1];
    ranges.push(Math.max(bar.high-bar.low,Math.abs(bar.high-previous.close),Math.abs(bar.low-previous.close)));
  }
  const atr=averageNumbers(ranges);
  return Number.isFinite(atr)&&atr>0?atr:null;
}
// Kaufman efficiency ratio: net movement divided by the path walked to get
// there, over the last `period` bars. 1 is a straight line, 0 is chop. It
// needs no threshold of its own and no extra parameters, which is why it is
// the regime measure here rather than something like ADX.
function efficiencyRatioForCloses(closes,period){
  if(!Array.isArray(closes)||closes.length<period+1) return null;
  const window=closes.slice(-(period+1));
  const net=Math.abs(window.at(-1)-window[0]);
  let path=0;
  for(let index=1;index<window.length;index+=1) path+=Math.abs(window[index]-window[index-1]);
  if(!(path>0)) return null;
  return Math.min(1,net/path);
}
// Breakout is deliberately in neither list — it trades the transition, not a
// settled regime, so it is filtered by the ATR buffer instead.
const REGIME_STRATEGIES={trend:["ema"],range:["meanReversion"]};
function regimeForEfficiency(efficiency,cfg){
  if(efficiency==null) return "unknown";
  if(efficiency>=cfg.trendMinEfficiency) return "trend";
  if(efficiency<=cfg.rangeMaxEfficiency) return "range";
  return "mixed";
}
// Calculate all three candidates from one completed-candle history. The
// caller chooses the enabled strategy and rejects opposite simultaneous hits.
function strategyCandidatesForBars(bars,config={}){
  const cfg=normalizeBreakoutConfig(config);
  const list=(Array.isArray(bars)?bars:[]).map(cleanBreakoutBar).filter(Boolean);
  const closes=list.map(bar=>bar.close);
  const closed=list.at(-1)||null;
  const candidates=[];
  const metrics={};
  const atr=atrForBars(list,cfg.atrBars);
  // Measured on the bars BEFORE the signal candle. The regime is the context
  // a signal fires into; including the signal's own bar lets one violent
  // candle declare a trend and wave itself through.
  const efficiency=efficiencyRatioForCloses(closes.slice(0,-1),cfg.lookbackBars);
  const regimeBlocked=[];
  if(closed&&list.length>=cfg.lookbackBars+1){
    const prior=list.slice(-(cfg.lookbackBars+1),-1);
    const high=Math.max(...prior.map(bar=>bar.high));
    const low=Math.min(...prior.map(bar=>bar.low));
    // A breakout is a regime *change*, so gating it on the prior regime is
    // wrong in both directions: a quiet base breaking out is the setup this
    // model wants, and chop and quiet look identical to an efficiency ratio.
    // What separates a real break from a poke over the edge is size, so the
    // close has to clear the range by a fraction of recent range.
    const buffer=cfg.regimeFilter&&atr!=null?atr*cfg.breakoutBufferAtr:0;
    metrics.breakout={high,low,buffer};
    if(closed.close>high+buffer) candidates.push({strategy:"breakout",label:"Breakout",side:"long"});
    else if(closed.close<low-buffer) candidates.push({strategy:"breakout",label:"Breakout",side:"short"});
    else if(buffer>0&&(closed.close>high||closed.close<low)) regimeBlocked.push("breakout");
  }
  if(closed&&closes.length>=cfg.slowBars+1){
    const previous=closes.slice(0,-1);
    const fastBefore=emaForStrategy(previous,cfg.fastBars);
    const slowBefore=emaForStrategy(previous,cfg.slowBars);
    const fast=emaForStrategy(closes,cfg.fastBars);
    const slow=emaForStrategy(closes,cfg.slowBars);
    metrics.ema={fast,slow};
    if(fastBefore!=null&&slowBefore!=null&&fast!=null&&slow!=null){
      if(fastBefore<=slowBefore&&fast>slow) candidates.push({strategy:"ema",label:`EMA ${cfg.fastBars}/${cfg.slowBars}`,side:"long"});
      else if(fastBefore>=slowBefore&&fast<slow) candidates.push({strategy:"ema",label:`EMA ${cfg.fastBars}/${cfg.slowBars}`,side:"short"});
    }
  }
  if(closed&&closes.length>=cfg.meanBars+1){
    const prior=closes.slice(-(cfg.meanBars+1),-1);
    const mean=averageNumbers(prior);
    const variance=averageNumbers(prior.map(value=>(value-mean)**2));
    const deviation=Math.sqrt(variance);
    const upper=mean+deviation*cfg.meanSigma;
    const lower=mean-deviation*cfg.meanSigma;
    const half=Math.max(1,Math.floor(prior.length/2));
    const early=averageNumbers(prior.slice(0,half));
    const late=averageNumbers(prior.slice(half));
    const flatEnough=deviation>0&&Math.abs(late-early)<=deviation*.75;
    metrics.meanReversion={mean,upper,lower,deviation,flatEnough};
    const previousClose=prior.at(-1);
    if(flatEnough&&previousClose<lower&&closed.close>=lower&&closed.close<mean){
      candidates.push({strategy:"meanReversion",label:"Mean reversion",side:"long",target:mean});
    }else if(flatEnough&&previousClose>upper&&closed.close<=upper&&closed.close>mean){
      candidates.push({strategy:"meanReversion",label:"Mean reversion",side:"short",target:mean});
    }
  }
  metrics.atr=atr;
  metrics.efficiency=efficiency;
  metrics.regime=regimeForEfficiency(efficiency,cfg);
  metrics.regimeBlocked=regimeBlocked;
  // The other two models are gated on the regime itself, each on the failure
  // that actually costs them: an EMA cross in chop is the whipsaw, and mean
  // reversion in a trend is standing in front of it. Breakout is handled
  // above by its own buffer. When the tape cannot be measured the gate steps
  // aside — this filters signal quality, it is not a safety rail.
  if(cfg.regimeFilter&&efficiency!=null){
    const fits=(strategy)=>REGIME_STRATEGIES.trend.includes(strategy)
      ?efficiency>=cfg.trendMinEfficiency
      :REGIME_STRATEGIES.range.includes(strategy)
        ?efficiency<=cfg.rangeMaxEfficiency
        :true;
    const kept=[];
    for(const candidate of candidates){
      if(fits(candidate.strategy)) kept.push(candidate);
      else regimeBlocked.push(candidate.strategy);
    }
    return {candidates:kept,metrics};
  }
  return {candidates,metrics};
}
function strategyRequiredBars(config={}){
  const cfg=normalizeBreakoutConfig(config);
  const needs={breakout:cfg.lookbackBars,ema:cfg.slowBars+1,meanReversion:cfg.meanBars+1};
  return cfg.mode==="all"?Math.max(...Object.values(needs)):needs[cfg.mode]||cfg.lookbackBars;
}
// ── signal outcomes ────────────────────────────────────────────────────
// Every fired signal is followed forward so the strategies can be judged on
// what they actually did rather than on how they read. Two deliberate
// choices: the fill is the NEXT bar's open, because the signal bar's close
// is not a price anyone can get; and when a bar spans both the stop and the
// target, the stop wins, because assuming the good fill first is how a
// backtest flatters itself.
function advanceOpenSignals(runtime,closed,cfg,resolved){
  const still=[];
  for(const open of runtime.openSignals||[]){
    if(!open||typeof open!=="object") continue;
    // `fill` starts null and Number(null) is 0, not NaN — so this asks
    // whether a real price has been recorded, not whether it parses.
    if(!(Number(open.fill)>0)){
      open.fill=closed.open;
      open.risk=Math.abs(Number(open.fill)-Number(open.stop));
      open.mfe=0;
      open.mae=0;
      open.barsSeen=0;
      if(!(open.risk>0)){ continue; }
    }
    const long=open.side==="long";
    const favourable=long?closed.high-open.fill:open.fill-closed.low;
    const adverse=long?open.fill-closed.low:closed.high-open.fill;
    open.mfe=Math.max(Number(open.mfe)||0,favourable/open.risk);
    open.mae=Math.max(Number(open.mae)||0,adverse/open.risk);
    open.barsSeen=(Number(open.barsSeen)||0)+1;
    const stopHit=long?closed.low<=open.stop:closed.high>=open.stop;
    const targetHit=long?closed.high>=open.target:closed.low<=open.target;
    let outcome="";
    let exit=0;
    if(stopHit){ outcome="stop"; exit=open.stop; }
    else if(targetHit){ outcome="target"; exit=open.target; }
    else if(open.barsSeen>=cfg.outcomeHorizonBars){ outcome="timeout"; exit=closed.close; }
    if(!outcome){ still.push(open); continue; }
    const move=long?exit-open.fill:open.fill-exit;
    resolved.push({
      id:open.id,symbol:open.symbol,strategy:open.strategy,side:open.side,
      regime:open.regime||"unknown",efficiency:Number(open.efficiency)||null,
      timeframeMinutes:cfg.timeframeMinutes,
      signalPrice:Number(open.signalPrice)||null,
      fill:open.fill,stop:open.stop,target:open.target,
      // Slippage against the price the signal was calculated at, which is
      // the gap the entry-at-close assumption used to hide.
      slippage:Number.isFinite(Number(open.signalPrice))
        ?Math.round((long?open.fill-open.signalPrice:open.signalPrice-open.fill)*1e6)/1e6
        :null,
      outcome,
      r:Math.round((move/open.risk)*1000)/1000,
      mfe:Math.round(open.mfe*1000)/1000,
      mae:Math.round(open.mae*1000)/1000,
      bars:open.barsSeen,
      at:open.at,resolvedAt:closed.bucket
    });
  }
  runtime.openSignals=still.slice(-20);
}
// Build real completed candles from the quote visible in Boolean's browser.
// This engine emits display-only setups. It never clicks, stages, or submits.
function stepBreakoutStrategy(runtime,quote,config,at=Date.now()){
  const next=runtime&&typeof runtime==="object"?runtime:emptyBreakoutRuntime();
  const symbol=normalizeSymbolInput(quote?.symbol||"");
  const price=Number(quote?.price);
  const cfg=normalizeBreakoutConfig(config);
  if(!symbol||!Number.isFinite(price)||price<=0) return {runtime:next,ready:false,reason:"no-quote"};
  const dayKey=breakoutDayKey(at);
  if(next.symbol!==symbol||next.dayKey!==dayKey){
    Object.assign(next,emptyBreakoutRuntime(),{symbol,dayKey});
  }
  const span=cfg.timeframeMinutes*60_000;
  const bucket=Math.floor(Number(at)/span)*span;
  let signal=null;
  let conflict=false;
  let gapReset=false;
  const resolvedOutcomes=[];
  if(!next.current){
    next.current={bucket,open:price,high:price,low:price,close:price};
  }else if(bucket===next.current.bucket){
    next.current.high=Math.max(next.current.high,price);
    next.current.low=Math.min(next.current.low,price);
    next.current.close=price;
  }else if(bucket>next.current.bucket){
    if(bucket>next.current.bucket+span){
      Object.assign(next,emptyBreakoutRuntime(),{symbol,dayKey,current:{bucket,open:price,high:price,low:price,close:price}});
      gapReset=true;
    }else{
      const closed={...next.current};
      // Score the signals already in flight against this bar before looking
      // for a new one, so a signal never grades itself on the bar it fired on.
      advanceOpenSignals(next,closed,cfg,resolvedOutcomes);
      const history=[...next.bars,closed].slice(-120);
      const calculated=strategyCandidatesForBars(history,cfg);
      next.lastMetrics=calculated.metrics;
      const enabledOrder=cfg.mode==="all"?["breakout","ema","meanReversion"]:[cfg.mode];
      const candidates=enabledOrder.flatMap(strategy=>calculated.candidates.filter(item=>item.strategy===strategy));
      conflict=new Set(candidates.map(item=>item.side)).size>1;
      if(conflict) next.lastConflictAt=closed.bucket+span;
      const candidate=conflict?null:candidates[0]||null;
      const cooldownActive=next.lastSignal&&closed.bucket+span-Number(next.lastSignal.at||0)<cfg.cooldownBars*span;
      if(candidate&&!cooldownActive&&next.signalsToday<cfg.maxSignalsPerDay){
        const entry=closed.close;
        const meanMetric=calculated.metrics.meanReversion||{};
        const candleStop=candidate.strategy==="meanReversion"
          ?candidate.side==="long"
            ?Math.min(closed.low,Number(meanMetric.lower)-Number(meanMetric.deviation||0)*.25)
            :Math.max(closed.high,Number(meanMetric.upper)+Number(meanMetric.deviation||0)*.25)
          :candidate.side==="long"?closed.low:closed.high;
        // A signal candle can close a cent off its own low, which used to
        // produce a one-tick stop that noise removes before the idea has a
        // chance. Push the stop out to at least a fraction of recent range.
        const atrFloor=(Number(calculated.metrics.atr)||0)*cfg.atrStopMultiple;
        const stop=atrFloor>0
          ?(candidate.side==="long"?Math.min(candleStop,entry-atrFloor):Math.max(candleStop,entry+atrFloor))
          :candleStop;
        const risk=Math.abs(entry-stop);
        const target=Number.isFinite(Number(candidate.target))
          ?Number(candidate.target)
          :candidate.side==="long"?entry+risk*cfg.riskReward:entry-risk*cfg.riskReward;
        const targetValid=candidate.side==="long"?target>entry:target<entry;
        const id=`${symbol}:${closed.bucket}:${candidate.strategy}:${candidate.side}`;
        if(risk>0&&targetValid&&id!==next.lastSignalId){
          signal={id,side:candidate.side,strategy:candidate.strategy,strategyLabel:candidate.label,entry,stop,target,risk,at:closed.bucket+span,symbol,
            regime:calculated.metrics.regime,efficiency:calculated.metrics.efficiency,atr:calculated.metrics.atr};
          next.lastSignal=signal;
          next.lastSignalId=id;
          next.signalsToday+=1;
          // Follow it from the next bar. `fill` stays null until that bar
          // opens, which is the price this signal is actually graded on.
          next.openSignals=[...(next.openSignals||[]),{
            id,symbol,strategy:candidate.strategy,side:candidate.side,
            signalPrice:entry,stop,target,fill:null,at:signal.at,
            regime:calculated.metrics.regime,efficiency:calculated.metrics.efficiency
          }].slice(-20);
        }
      }
      next.bars=history;
      next.current={bucket,open:price,high:price,low:price,close:price};
    }
  }
  const recentSignal=signal||(
    next.lastSignal&&Number(at)-Number(next.lastSignal.at||0)<span
      ?next.lastSignal
      :null
  );
  const required=strategyRequiredBars(cfg);
  return {
    runtime:next,
    ready:next.bars.length>=required,
    barsReady:Math.min(next.bars.length,required),
    requiredBars:required,
    metrics:next.lastMetrics,
    signal:recentSignal,
    conflict:conflict||(next.lastConflictAt&&Number(at)-next.lastConflictAt<span),
    signalLimitReached:next.signalsToday>=cfg.maxSignalsPerDay,
    gapReset,
    resolvedOutcomes,
    openSignals:(next.openSignals||[]).length
  };
}

// Why the last history seed was refused, if it was. ui.html shows this in the
// strategy status line; it is set only by buildBreakoutBarsFromHistory below.
let lastSeedIssue = "";
const seedIssue = () => lastSeedIssue;

function buildBreakoutBarsFromHistory(points,config){
  const cfg=normalizeBreakoutConfig(config);
  const span=Math.max(1,cfg.timeframeMinutes*60_000);
  const now=Date.now();
  const cutoff=now-BREAKOUT_HISTORY_YEARS*365.25*24*60*60*1000;
  // Aggregating finer bars into coarser ones is sound; the reverse is not.
  // Weekly points bucketed into five-minute slots produce one "5m candle"
  // per week — a 20-bar breakout range that is really 20 weeks wide, and an
  // EMA crossover months out of date. Refuse the seed instead.
  const spacing=historySpacingMinutes(points);
  if(spacing>cfg.timeframeMinutes*1.5){
    lastSeedIssue=`history came back in ~${Math.round(spacing)}-minute bars, too coarse for ${cfg.timeframeMinutes}-minute candles`;
    return [];
  }
  lastSeedIssue="";
  const ordered=(Array.isArray(points)?points:[]).map((point)=>{
    const bucket=Math.floor(Number(point.time)/span)*span;
    const open=Number(point.open);
    const high=Number(point.high);
    const low=Number(point.low);
    const close=Number(point.close);
    if(!Number.isFinite(bucket)||!Number.isFinite(open)||!Number.isFinite(high)||!Number.isFinite(low)||!Number.isFinite(close)) return null;
    return {time:Number(point.time),bucket,open,high,low,close};
  }).filter(Boolean).filter((point)=>point.time>=cutoff&&point.time<=now).sort((a,b)=>a.time-b.time);
  const grouped=new Map();
  for(const point of ordered){
    const existing=grouped.get(point.bucket);
    if(existing){
      existing.high=Math.max(existing.high,point.high);
      existing.low=Math.min(existing.low,point.low);
      existing.close=point.close;
    }else{
      grouped.set(point.bucket,{bucket:point.bucket,open:point.open,high:point.high,low:point.low,close:point.close});
    }
  }
  return [...grouped.values()].sort((a,b)=>a.bucket-b.bucket).slice(-BREAKOUT_HISTORY_MAX_BARS);
}

export {
  BREAKOUT_HISTORY_YEARS,
  BREAKOUT_HISTORY_MIN_BARS,
  BREAKOUT_HISTORY_MAX_BARS,
  BREAKOUT_DEFAULTS,
  normalizeBreakoutConfig,
  emptyBreakoutRuntime,
  cleanBreakoutBar,
  strategySeedRequest,
  historySpacingMinutes,
  breakoutDayKey,
  averageNumbers,
  emaForStrategy,
  atrForBars,
  efficiencyRatioForCloses,
  REGIME_STRATEGIES,
  regimeForEfficiency,
  strategyCandidatesForBars,
  strategyRequiredBars,
  advanceOpenSignals,
  stepBreakoutStrategy,
  buildBreakoutBarsFromHistory,
  seedIssue
};
