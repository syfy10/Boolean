// Everything ui.html's inline script pulls off window.BoollmTradingLogic.
//
// build/build-ui-logic.mjs bundles this into src/assets/ui-logic.js and the
// server inlines it as it serves the page. Tests import the individual modules
// directly — they never go through this barrel or the bundle.
export * from "./trading-logic.js";
export * from "./ticket.js";
export * from "./breakout-strategy.js";
