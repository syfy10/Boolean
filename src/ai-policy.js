function textOnly(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  }
  return "";
}

export function stripAppContext(text) {
  return String(text || "").split(/\n\nCURRENT APP CONTEXT\b/)[0].trim();
}

export function normalizeUserText(text) {
  return stripAppContext(text)
    .replace(/\bwho\s+own\b/gi, "who won")
    .replace(/\bwho\s+one\b/gi, "who won")
    .replace(/\s+/g, " ")
    .trim();
}

function recentConversation(messages) {
  return (messages || [])
    .slice(-14, -1)
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => normalizeUserText(textOnly(message.content)))
    .filter(Boolean);
}

function sportsContext(lines) {
  const joined = lines.join("\n").toLowerCase();
  if (/\b(fifa|world cup)\b/.test(joined)) return "fifa";
  if (/\b(nba|basketball)\b/.test(joined)) return "nba";
  if (/\b(nfl|american football)\b/.test(joined)) return "nfl";
  if (/\b(mlb|baseball)\b/.test(joined)) return "mlb";
  if (/\b(nhl|hockey)\b/.test(joined)) return "nhl";
  if (/\b(soccer|football|match|game|score)\b/.test(joined)) return "sports";
  return "";
}

function previousSportsTimeframe(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].toLowerCase();
    if (/\byesterday\b/.test(line)) return "yesterday";
    if (/\b(next|upcoming)\b/.test(line)) return "next";
    if (/\b(last|latest|most recent)\b/.test(line)) return "latest-completed";
    if (/\b(today|tonight)\b/.test(line)) return "today";
    if (/\b(live|right now|currently)\b/.test(line)) return "live";
  }
  return "latest-completed";
}

function sportsTimeframe(lower, inherited = "latest-completed") {
  if (/\byesterday\b/.test(lower)) return "yesterday";
  if (/\b(next|upcoming)\b/.test(lower)) return "next";
  if (/\b(last|latest|most recent|previous)\b/.test(lower)) return "latest-completed";
  if (/\b(today|tonight)\b/.test(lower)) return "today";
  if (/\b(live|right now|currently)\b/.test(lower)) return "live";
  if (/\bwho won\b/.test(lower)) return inherited;
  return "today";
}

function makeQuery(text, domain, timeframe) {
  if (domain === "fifa") {
    if (timeframe === "yesterday") return "FIFA World Cup match result yesterday score";
    if (timeframe === "latest-completed") return "latest completed FIFA World Cup match result score";
    if (timeframe === "next") return "next FIFA World Cup match schedule date time";
    if (timeframe === "live") return "FIFA World Cup live score now";
    return "FIFA World Cup matches today scores schedule";
  }
  return text;
}

export function decideAiRoute(text, messages = []) {
  const normalized = normalizeUserText(text);
  const lower = normalized.toLowerCase();
  const prior = recentConversation(messages);
  const priorSport = sportsContext(prior);
  const explicitWeb = /\b(search(?: the)? (?:web|internet|online)|search for|google|browse|look up|lookup|find online|check online|on the web|from the internet)\b/.test(lower);
  const localReference = /\b(this|that|the|current|open|previous)\s+(report|dashboard|screenshot|image|chart|table|data|email|page)\b/.test(lower) ||
    /\b(from|based on)\s+(this|that|the)\b/.test(lower);
  const meta = /\b(are you okay|what(?:'s| is) getting (?:you )?(?:stuck|stock)|why did you (?:search|browse|open)|what went wrong)\b/.test(lower);
  const preference = /\b(going forward|from now on|next time|in the future)\b/.test(lower);

  if (!normalized || meta || preference || (localReference && !explicitWeb)) {
    return { needsWeb: false, mode: "none", domain: "conversation", timeframe: "none", query: "", normalized };
  }

  const weather = /\b(weather|forecast|temperature|rain|snow|humidity|air quality|aqi)\b/.test(lower);
  const news = /\b(news|headline|headlines|breaking news|top news|latest news)\b/.test(lower);
  const namedSport = /\b(fifa|world cup|soccer|football|nba|nfl|nhl|mlb|wnba|basketball|baseball|hockey)\b/.test(lower);
  const sportsQuestion = /\b(who won|winner|score|scores|result|results|match|matches|game|games|fixture|fixtures|standings|schedule|kickoff)\b/.test(lower);
  const shortSportsFollowup = /^(fifa|football|soccer|who won|who played|who plays|what(?:'s| is| was)? (?:the )?(?:score|result)|(?:the )?(?:score|result)|when(?:'s| is)? (?:the )?(?:next )?(?:game|match))\??$/.test(lower);
  const sports = namedSport || (Boolean(priorSport) && (sportsQuestion || shortSportsFollowup));
  const shopping = /\b(price|prices|sale|deal|deals|coupon|available|availability|in stock|shopping|shop|buy|purchase|retailer|cart|add to cart|where can i buy|under\s+\$?\d+|compare|reviews?)\b/.test(lower);
  const market = /\b(stock|stocks|market|ticker)\b/.test(lower) && /\b(today|now|current|latest|price|prices)\b/.test(lower);
  const datedEvent = /\b(next|upcoming|release|released|launch|premiere|coming out|airs|airing|starts|begins)\b/.test(lower) &&
    /\b(game|match|event|episode|series|show|movie|film|concert|election|update|version|phone|console)\b/.test(lower);

  let domain = "general";
  if (weather) domain = "weather";
  else if (news) domain = "news";
  else if (sports) domain = /\b(fifa|world cup)\b/.test(lower) || priorSport === "fifa" ? "fifa" : "sports";
  else if (shopping) domain = "shopping";
  else if (market) domain = "market";
  else if (datedEvent) domain = "event";

  const needsWeb = explicitWeb || domain !== "general";
  const timeframe = sports ? sportsTimeframe(lower, previousSportsTimeframe(prior)) : "current";
  return {
    needsWeb,
    mode: needsWeb ? (shopping ? "shortlist" : "quick") : "none",
    domain,
    timeframe,
    asksWinner: sports && /\b(who won|winner|result|score)\b/.test(lower),
    query: needsWeb ? makeQuery(normalized, domain, timeframe) : "",
    normalized
  };
}
