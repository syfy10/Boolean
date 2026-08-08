// Trading text parsers — the page IS the market data source.
//
// These read a broker page's rendered text and pull out the symbol, the quote,
// and the Legend position/order panels. They are pure: no DOM, no network, no
// shell. That is what lets the browser and `node --test` run the exact same
// code, instead of the tests slicing these functions out of ui.html by string
// offset and re-evaluating them with new Function().
//
// The browser gets this file through build/build-ui-logic.mjs, which bundles it
// to src/assets/ui-logic.js; the server inlines that into ui.html as it serves.

const normalizeSymbolInput=(value)=>{
  const raw=String(value||"").trim().toUpperCase();
  const future=raw.match(/^\/([A-Z0-9]{2,12})$/);
  return future?`/${future[1]}`:raw.replace(/[^A-Z0-9.^=-]/g,"").slice(0,24);
};

// Words that look like tickers on a broker page but never are. Without this,
// OCR of "Alphabet Class A $375.25" reads the symbol as "A".
const TICKER_STOPWORDS=new Set(["A","I","B","S","O","H","L","C","P","THE","BUY","SELL","SHORT","LONG",
  "HIGH","LOW","OPEN","CLOSE","VOL","VOLUME","USD","ETF","INC","CLASS","NEW","TAB","ADD","MKT","LMT",
  "DAY","AM","PM","ET","EST","EDT","AI","US","IPO","CEO","CFO","RANGE","TODAY","NEWS","CHART","MARKET",
  "HOURS","BID","ASK","AVG","MAX","MIN","OK","API","APP","PC","IT"]);
const tickerOk=(t)=>/^\/[A-Z0-9]{2,12}$/.test(String(t||""))||
  (!!t&&t.length>=2&&t.length<=5&&!TICKER_STOPWORDS.has(t));
function symbolFromPageText(text){
  const body=String(text||"");
  if(!body) return "";
  // Legend futures headers use a slash contract and often omit the dollar
  // sign: "/MYMU26 53,418 \u25B2 84 (0.16%)".
  // OCR may put toolbar labels or a line break between the contract and quote.
  const future=body.match(/(?:^|\s)(\/[A-Z]{2,8}\d{1,2})\b/);
  if(future) return normalizeSymbolInput(future[1]);
  // "GOOGL $375.25" — a ticker immediately before a price is the strongest signal.
  for(const m of body.matchAll(/\b([A-Z][A-Z.]{1,4})\b[\s ]*\$\s*[\d,]+\.\d\d/g)){
    const t=normalizeSymbolInput(m[1]);
    if(tickerOk(t)) return t;
  }
  const dollar=body.match(/\$([A-Z]{2,5})\b/);
  if(dollar){
    const t=normalizeSymbolInput(dollar[1]);
    if(tickerOk(t)) return t;
  }
  for(const m of body.matchAll(/\b([A-Z]{2,5})\b/g)){
    const t=normalizeSymbolInput(m[1]);
    if(tickerOk(t)) return t;
  }
  return "";
}

// "GOOGL $371.99 ▲ $15.86 (4.45%)" → { symbol, price, changePercent, changeAbs }
// Everything the page rendered in document order, without the shell's
// unordered React-state hint block appended to the end of it.
const beforeQuoteHints=(text)=>String(text||"").split("DOM quote hints:")[0];
function quoteFromPageText(text){
  const body=String(text||"").replace(/ /g," ");
  if(!body) return null;
  const symbol=symbolFromPageText(body);
  if(!symbol) return null;
  // The first price after the symbol is the quote; later prices are bid/ask/range.
  const at=body.indexOf(symbol);
  const after=at>=0?body.slice(at,at+400):body.slice(0,400);
  const futureTail=symbol.startsWith("/")?after.slice(symbol.length):"";
  // OCR often reads the headline before the contract line and turns the up
  // triangle into "A". Prefer the price/change/(percent) headline over the
  // chart's C value, which can be a historical candle under the mouse.
  const futuresHeadline=symbol.startsWith("/")
    ?body.match(/(?:^|\n)\s*(\d{2,3}(?:,\d{3})+(?:\.\d+)?)\s*[▲▼AV+-]?\s*[\d,]+(?:\.\d+)?\s*\(\s*[-+]?\d+(?:\.\d+)?\s*%\s*\)/m)
    :null;
  // The live quote is rendered as one string: symbol, price, absolute change,
  // percent change, in that order. Matching the whole shape is what tells it
  // apart from the OHLC strip ("O 40.05 H 40.05 L 40.01 C 40.01") and from a
  // Positions row, both of which sit near the ticker and both of which the
  // "first dollar amount after the symbol" rule happily mistook for a quote.
  const escapedSymbol=symbol.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const equityHeadline=symbol.startsWith("/")?null:body.match(new RegExp(
    `\\b${escapedSymbol}\\b[^\\d$]{0,40}\\$?\\s*([\\d,]+\\.\\d{2})\\s*[\\u25B2\\u25BCAV+\\-]?\\s*\\$?\\s*[\\d,]+\\.\\d{2}\\s*\\(\\s*[-+]?\\d+(?:\\.\\d+)?\\s*%\\s*\\)`
  ));
  // The current Legend layout can show only the day's absolute change beside
  // the ticker ("SPY ▲ $4.82 (0.63%)"). The actual quote lives in the chart's
  // C field and price marker. Treating the first dollar amount as the quote
  // turns $773.38 SPY into $4.82.
  const equityChangeOnly=symbol.startsWith("/")?null:after.match(/[▲▼AV+\-]\s*\$\s*([\d,]+\.\d{2})\s*\(\s*[-+]?\d+(?:\.\d+)?\s*%\s*\)/);
  const equityChartClose=equityChangeOnly?body.match(/\bC\s*\$?\s*([\d,]+\.\d{2,4})\b/i):null;
  const priceMatch=futuresHeadline||equityHeadline||equityChartClose||
    (!equityChangeOnly?after.match(/\$\s*([\d,]+\.\d{2})/):null)||
    (symbol.startsWith("/")?futureTail.match(/^(?![^\d]{0,80}\b(?:O|H|L|C|V|VOLUME)\b)[^\d]{0,80}(\d{2,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)/i):null)||
    (symbol.startsWith("/")?body.match(/\bC\s*([\d,]{4,}(?:\.\d+)?)\b/i):null);
  if(!priceMatch) return null;
  const price=Number(priceMatch[1].replace(/,/g,""));
  if(!Number.isFinite(price)) return null;
  // Which rule produced this number. The loose scan is the one that can pick
  // up a table cell or a candle value, so when a price looks wrong the bar
  // can say what it matched instead of leaving you to guess.
  const priceSource=futuresHeadline?"futures headline"
    :equityHeadline?"quote headline"
    :equityChartClose?"chart close"
    :"nearest dollar amount after the ticker";
  const pctMatch=(symbol.startsWith("/")?body.match(/\(\s*([-+]?\d+(?:\.\d+)?)\s*%\s*\)/):null)||after.match(/\(\s*([-+]?\d+(?:\.\d+)?)\s*%\s*\)/);
  const absMatch=after.match(/([-+]?)\$\s*([\d,]+\.\d{2})\s*\(/);
  const futuresAbs=symbol.startsWith("/")
    ?after.slice(symbol.length).match(/^\s*[\d,]+(?:\.\d+)?\s*([\u25B2\u25BC+-]?)\s*([\d,]+(?:\.\d+)?)\s*\(/)
    :null;
  let changePercent=pctMatch?Number(pctMatch[1]):null;
  let changeAbs=absMatch?Number(absMatch[2].replace(/,/g,"")):
    futuresAbs?Number(futuresAbs[2].replace(/,/g,"")):null;
  // Robinhood renders direction as ▲/▼ rather than a sign.
  const down=/\u25BC/.test(after)||futuresAbs?.[1]==="-"||/-\s*\$/.test(after);
  if(down){
    if(changePercent!=null&&changePercent>0) changePercent=-changePercent;
    if(changeAbs!=null&&changeAbs>0) changeAbs=-changeAbs;
  }
  return {symbol,price,changePercent,changeAbs,source:"page",priceSource};
}
const legendNumber=(value)=>{
  const number=Number(String(value||"").replace(/[$,%\s,]/g,""));
  return Number.isFinite(number)?number:null;
};
const legendSignedNumber=(marker,value)=>{
  const number=legendNumber(value);
  if(number==null) return null;
  return /[▼-]/.test(String(marker||""))?-Math.abs(number):Math.abs(number);
};
// Parse the compact Legend panels shown beside/below the chart. These values
// are display-only context for the bar; order execution remains behind the
// existing trading guard and never uses this parser to click or submit.
function legendTradingDetailsFromPageText(text,symbolHint=""){
  const body=String(text||"").replace(/ /g," ").replace(/\s+/g," ").trim();
  if(!body) return {};
  const symbol=normalizeSymbolInput(symbolHint)||symbolFromPageText(body);
  const details={};
  // Legend writes the top of book several ways depending on the widget and
  // its width: "B $39.43 x 100 / A $39.44 x 80" in the compact strip, and
  // "Bid 39.43 Ask 39.44" when there is room for words. Only the first was
  // recognised, so layouts using the second reported "spread --" forever.
  const bid=body.match(/\bB\s*\$?\s*([\d,]+\.\d{2,4})\s*x\s*([\d,]+)/i)
    ||body.match(/\bBid\b[^\d$]{0,12}\$?\s*([\d,]+\.\d{2,4})/i);
  const ask=body.match(/\bA\s*\$?\s*([\d,]+\.\d{2,4})\s*x\s*([\d,]+)/i)
    ||body.match(/\bAsk\b[^\d$]{0,12}\$?\s*([\d,]+\.\d{2,4})/i);
  if(bid) details.bid=legendNumber(bid[1]);
  if(ask) details.ask=legendNumber(ask[1]);
  if(bid?.[2]) details.bidSize=legendNumber(bid[2]);
  if(ask?.[2]) details.askSize=legendNumber(ask[2]);
  // "Bid Size: 80 / Ask Size: 80" is the other form brokers use.
  const bidSize=body.match(/\bBid\s*Size\b[^\d]{0,6}([\d,]+)/i);
  const askSize=body.match(/\bAsk\s*Size\b[^\d]{0,6}([\d,]+)/i);
  if(bidSize) details.bidSize=legendNumber(bidSize[1]);
  if(askSize) details.askSize=legendNumber(askSize[1]);
  // Day range, labelled either as a High/Low pair or a Hi/Lo strip.
  const dayHigh=body.match(/\bHigh\b[^\d$-]{0,10}\$?\s*([\d,]+\.\d{2,4})/i);
  const dayLow=body.match(/\bLow\b[^\d$-]{0,10}\$?\s*([\d,]+\.\d{2,4})/i);
  if(dayHigh) details.dayHigh=legendNumber(dayHigh[1]);
  if(dayLow) details.dayLow=legendNumber(dayLow[1]);
  if(details.bid!=null&&details.ask!=null&&details.ask>=details.bid){
    details.spread=Number((details.ask-details.bid).toFixed(4));
  }

  // Every position row, not just the one matching the visible symbol — the
  // bar's expandable panel shows the whole table, so the account can be read
  // without leaving the chat.
  if(/\bPositions\b/i.test(body)){
    const positionsAt=body.search(/\bPositions\b/i);
    const recentAfter=body.slice(positionsAt+1).search(/\bRecent orders\b/i);
    const table=body.slice(positionsAt,recentAfter>=0?positionsAt+1+recentAfter:body.length);
    const rowPattern=/(\/[A-Z0-9]{2,12}|\b[A-Z]{1,6}\b)\s+([+-]?[\d,]+)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+([▲▼+-]?)\s*\$([\d,]+\.\d{2})\s+([▲▼+-]?)\s*([\d.]+)%\s+([▲▼+-]?)\s*\$([\d,]+\.\d{2})\s+([▲▼+-]?)\s*([\d.]+)%/g;
    const positions=Array.from(table.matchAll(rowPattern)).map((row)=>({
      symbol:normalizeSymbolInput(row[1]),
      qty:legendNumber(row[2]),
      marketValue:legendNumber(row[3]),
      mark:legendNumber(row[4]),
      avgPrice:legendNumber(row[5]),
      last:legendNumber(row[6]),
      dayPnl:legendSignedNumber(row[7],row[8]),
      dayPnlPercent:legendSignedNumber(row[9],row[10]),
      openPnl:legendSignedNumber(row[11],row[12]),
      openPnlPercent:legendSignedNumber(row[13],row[14])
    })).filter((row)=>row.symbol);
    // Legend's current compact widget drops market value, last and the
    // percentage columns. Its rows are: Symbol, Mark, Quantity, Avg price,
    // 1D open P&L. Accept that shape too instead of interpreting a readable
    // but narrower table as an empty account.
    const compactPattern=/(\/[A-Z0-9]{2,12}|\b[A-Z]{1,6}\b)\s+\$([\d,]+\.\d{2,4})\s+([+-]?[\d,]+(?:\.\d+)?)\s+\$([\d,]+\.\d{2,4})(?:\s+([▲▼+-]?)\s*\$([\d,]+\.\d{2}))?/g;
    for(const row of table.matchAll(compactPattern)){
      const rowSymbol=normalizeSymbolInput(row[1]);
      if(!rowSymbol||positions.some((item)=>item.symbol===rowSymbol)) continue;
      const mark=legendNumber(row[2]), qty=legendNumber(row[3]);
      positions.push({
        symbol:rowSymbol, qty, mark, avgPrice:legendNumber(row[4]), last:mark,
        marketValue:Number.isFinite(mark)&&Number.isFinite(qty)?mark*qty:null,
        dayPnl:legendSignedNumber(row[5],row[6]),
        openPnl:legendSignedNumber(row[5],row[6])
      });
    }
    const explicitEmpty=/(?:you\s+don.t\s+have\s+any|no)\s+(?:[./A-Z0-9-]+\s+)?(?:open\s+)?positions/i.test(table);
    if(positions.length){ details.positions=positions; details.positionSyncOk=true; }
    else if(explicitEmpty){ details.positions=[]; details.positionSyncOk=true; }
    else details.positionSyncFailed=true;
    // The visible symbol's own row still drives the bar's summary line.
    const mine=symbol?positions.find((row)=>row.symbol===normalizeSymbolInput(symbol)):null;
    if(mine){
      details.positionQty=mine.qty;
      details.marketValue=mine.marketValue;
      details.mark=mine.mark;
      details.avgPrice=mine.avgPrice;
      details.last=mine.last;
      details.dayPnl=mine.dayPnl;
      details.dayPnlPercent=mine.dayPnlPercent;
      details.openPnl=mine.openPnl;
      details.openPnlPercent=mine.openPnlPercent;
    }
  }

  const ordersAt=body.search(/\bRecent orders\b/i);
  if(ordersAt>=0){
    const positionsOffset=body.slice(ordersAt+1).search(/\bPositions\b/i);
    const end=positionsOffset>=0?ordersAt+1+positionsOffset:body.length;
    const ordersText=body.slice(ordersAt,end);
    if(/(?:you\s+don.t\s+have\s+any|no)\s+(?:[./A-Z0-9-]+\s+)?(?:recent\s+|open\s+)?orders|orders\s+from\s+the\s+last/i.test(ordersText)){
      details.openOrders=0;
      details.orders=[];
    }else{
      // The rows themselves, so the panel can show what each order was
      // rather than only how many are still working.
      const rowPattern=/(\/[A-Z0-9]{2,12}|\b[A-Z]{1,6}\b)\s+(Filled|Canceled|Cancelled|Open|Pending|Queued|Submitted|Working|New|Partially\s+filled|Rejected|Expired)\s+(Buy|Sell|Short|Cover)\s+(Market|Limit|Stop\s+limit|Stop|Trail\s+stop\s+limit|Trail\s+stop|MOC|LOC)\s+([\d,]+)([\s\S]{0,70}?)(?=(?:\/[A-Z0-9]{2,12}|\b[A-Z]{1,6}\b)\s+(?:Filled|Canceled|Cancelled|Open|Pending|Queued|Submitted|Working|New|Partially\s+filled|Rejected|Expired)\s|$)/gi;
      const orders=Array.from(ordersText.matchAll(rowPattern)).map((row)=>{
        const tail=String(row[6]||"");
        const filled=tail.match(/\$([\d,]+\.\d{2})/);
        const when=tail.match(/([A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
        return {
          symbol:normalizeSymbolInput(row[1]),
          status:row[2].replace(/\s+/g," ").trim(),
          side:row[3].trim(),
          type:row[4].replace(/\s+/g," ").trim(),
          qty:legendNumber(row[5]),
          fill:filled?legendNumber(filled[1]):null,
          at:when?when[1].replace(/\s+/g," ").trim():""
        };
      }).filter((row)=>row.symbol);
      if(orders.length){
        details.orders=orders.slice(0,20);
        // Counted from the parsed rows. The previous loose scan looked for a
        // ticker-ish word followed by a live status, and the table's own
        // "Submitted" column header matched it — so a page showing nothing
        // but cancelled orders still reported one working, and offered to
        // cancel it. A status now has to belong to a row.
        details.openOrders=orders.filter((row)=>/^(open|pending|queued|submitted|working|new|partially filled)$/i.test(row.status)).length;
      }
    }
  }
  if(details.openOrders==null){
    const openOrders=body.match(/\b([\d,]+)\s+open\s+orders?\b/i);
    if(openOrders) details.openOrders=legendNumber(openOrders[1]);
  }
  if(symbol) details.symbol=symbol;
  return details;
}

export {
  normalizeSymbolInput,
  TICKER_STOPWORDS,
  tickerOk,
  symbolFromPageText,
  beforeQuoteHints,
  quoteFromPageText,
  legendNumber,
  legendSignedNumber,
  legendTradingDetailsFromPageText
};
