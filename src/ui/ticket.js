// Order-ticket definitions and the share-price correction.
//
// TICKET_ORDER_TYPES / TICKET_TIF mirror ORDER_TYPES and TIME_IN_FORCE in
// src/trade-guard.js, which stays the authority — the guard rejects anything
// these disagree with. Pure data and pure functions, so the tests import them
// rather than slicing them out of ui.html.

// Ticket state. `touched` records which fields the user has edited so the
// 5-second page refresh can keep prefilling the rest without ever
// overwriting something typed by hand mid-ticket.
// Mirrors ORDER_TYPES / TIME_IN_FORCE in trade-guard.js, which stays the
// authority — the guard rejects anything these two disagree with.
// `short` is what the bar shows; `label` is what gets matched against the
// broker's own option text when the order type is selected on the page. They
// differ because the widest label decides the dropdown's width, and a
// shortened one would no longer match "Trail Stop Limit" on the form.
const TICKET_ORDER_TYPES=Object.freeze({
  "market":{short:"MKT",label:"Market",needs:[]},
  "limit":{short:"LMT",label:"Limit",needs:["limit"]},
  "stop":{short:"Stop",label:"Stop",needs:["trigger"]},
  "stop-limit":{short:"Stop lmt",label:"Stop limit",needs:["trigger","limit"]},
  "trail-stop":{short:"Trail",label:"Trail stop",needs:["trail"]},
  "trail-stop-limit":{short:"Trail lmt",label:"Trail stop limit",needs:["trail","limit"]},
  "moc":{short:"MOC",label:"MOC",needs:[]},
  "loc":{short:"LOC",label:"LOC",needs:["limit"]}
});
const TICKET_TIF=Object.freeze({
  "day":"Day","gtc":"GTC","ext":"EXT","gtc-ext":"GTC+EXT","am":"AM","pm":"PM"
});
// Broker tickets use different visible option names for the same canonical
// choice. Keep the compact bar labels above, but try the broker's common
// full names as well. The first value remains the preferred display label.
const TICKET_ORDER_TYPE_OPTIONS=Object.freeze({
  "market":["Market","Market order"],
  "limit":["Limit","Limit order"],
  "stop":["Stop","Stop order","Stop market"],
  "stop-limit":["Stop limit","Stop-limit","Stop limit order"],
  "trail-stop":["Trail stop","Trailing stop","Trailing stop order"],
  "trail-stop-limit":["Trail stop limit","Trailing stop limit","Trailing stop-limit"],
  "moc":["MOC","Market on close","Market-on-close"],
  "loc":["LOC","Limit on close","Limit-on-close"]
});
const TICKET_TIF_OPTIONS=Object.freeze({
  "day":["Day","Good for day","Good for the day"],
  "gtc":["GTC","Good till canceled","Good til canceled","Good until canceled"],
  "ext":["EXT","Extended hours","Day + extended hours"],
  "gtc-ext":["GTC+EXT","GTC + extended hours","Good till canceled + extended hours"],
  "am":["AM","Morning","Market open"],
  "pm":["PM","Evening","Market close"]
});
const emptyTicketState=()=>({
  side:"",qty:"",type:"market",tif:"day",limit:"",trigger:"",trail:"",
  stop:"",target:"",symbol:"",touched:{},
  // Set once per account rather than per order, so they live behind More.
  positionEffect:"auto",instruction:"",exchange:"",taxLot:"",accountName:"",
  submitAt:"",submitOn:"",cancelAt:"",cancelOn:""
});

function correctSharePrice(quote,details={}){
  if(!quote) return quote;
  const mark=Number(details.mark), price=Number(quote.price);
  if(!Number.isFinite(mark)||mark<=0||!Number.isFinite(price)||price<=0) return quote;
  const value=Number(details.marketValue);
  const isMarketValue=Number.isFinite(value)&&Math.abs(price-value)<0.01&&Math.abs(value-mark)>=0.01;
  const impossibleScale=price>mark*3||price<mark/3;
  if(!isMarketValue&&!impossibleScale) return quote;
  quote.price=mark;
  quote.priceSource="Positions mark column";
  return quote;
}

export {
  TICKET_ORDER_TYPES,
  TICKET_TIF,
  TICKET_ORDER_TYPE_OPTIONS,
  TICKET_TIF_OPTIONS,
  emptyTicketState,
  correctSharePrice
};
