const FIFA_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FIFA_SOURCE = "https://www.espn.com/soccer/scoreboard/_/league/fifa.world";

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function eventState(event) {
  return event?.status?.type?.state || "pre";
}

export function selectFifaEvents(events, timeframe, now = new Date()) {
  const sorted = [...(events || [])].filter((event) => event?.date).sort((a, b) => new Date(a.date) - new Date(b.date));
  const today = localDateKey(now);
  const yesterday = localDateKey(addDays(now, -1));
  if (timeframe === "latest-completed") {
    return sorted.filter((event) => eventState(event) === "post" && new Date(event.date) <= now).slice(-1);
  }
  if (timeframe === "next") {
    return sorted.filter((event) => eventState(event) === "pre" && new Date(event.date) >= now).slice(0, 1);
  }
  if (timeframe === "final") {
    const upcomingOrRecent = sorted.filter((event) => new Date(event.date) >= addDays(now, -21));
    return upcomingOrRecent.length ? upcomingOrRecent.slice(-1) : sorted.slice(-1);
  }
  if (timeframe === "yesterday") return sorted.filter((event) => localDateKey(new Date(event.date)) === yesterday);
  if (timeframe === "live") {
    const live = sorted.filter((event) => eventState(event) === "in");
    return live.length ? live : sorted.filter((event) => localDateKey(new Date(event.date)) === today);
  }
  return sorted.filter((event) => localDateKey(new Date(event.date)) === today);
}

function teamName(competitor) {
  return competitor?.team?.shortDisplayName || competitor?.team?.displayName || competitor?.team?.name || "Unknown team";
}

function eventLine(event) {
  const competition = event?.competitions?.[0] || {};
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.find((item) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item.homeAway === "away") || competitors[1];
  const state = eventState(event);
  const detail = event?.status?.type?.shortDetail || event?.status?.type?.detail || event?.status?.type?.description || "";
  const date = event?.date ? new Date(event.date) : null;
  const dateText = date ? new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date) : "";
  const homeName = teamName(home);
  const awayName = teamName(away);
  if (state === "post") {
    const winner = competitors.find((item) => item.winner === true);
    const loser = winner === home ? away : home;
    if (winner && loser) return `${teamName(winner)} beat ${teamName(loser)} ${winner.score}-${loser.score} on ${dateText} (${detail || "final"}).`;
    return `${awayName} and ${homeName} finished ${away?.score ?? 0}-${home?.score ?? 0} on ${dateText} (${detail || "final"}).`;
  }
  if (state === "in") return `${awayName} ${away?.score ?? 0}, ${homeName} ${home?.score ?? 0} (${detail || "live"}).`;
  const start = date ? new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date) : "time not listed";
  return `${awayName} plays ${homeName} on ${start}.`;
}

function fetchRange(timeframe, now) {
  if (timeframe === "latest-completed") return `${localDateKey(addDays(now, -14))}-${localDateKey(now)}`;
  if (timeframe === "next") return `${localDateKey(now)}-${localDateKey(addDays(now, 14))}`;
  if (timeframe === "final") return `${localDateKey(addDays(now, -21))}-${localDateKey(addDays(now, 60))}`;
  if (timeframe === "yesterday") return localDateKey(addDays(now, -1));
  return localDateKey(now);
}

export async function answerFifaQuestion(route, ctx, options = {}) {
  if (route?.domain !== "fifa") return "";
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl || fetch;
  try {
    ctx?.onStatus?.("checking FIFA results...");
    const response = await fetchImpl(`${FIFA_SCOREBOARD}?dates=${fetchRange(route.timeframe, now)}`, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "Boolean/0.9 sports answer" }
    });
    if (!response.ok) return "";
    const data = await response.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const league = data.leagues?.[0]?.name || "FIFA World Cup";
    const selected = selectFifaEvents(events, route.timeframe, now);
    if (selected.length) {
      const completed = selected.filter((event) => eventState(event) === "post");
      if (route.timeframe === "final") {
        const finalLine = selected.map(eventLine).join(" ");
        const alreadyPlayed = selected.every((event) => eventState(event) === "post");
        return `${league} final: ${finalLine}${alreadyPlayed ? "" : " That is the last scheduled game in the tournament window."} Source: ${FIFA_SOURCE}`;
      }
      if (route.timeframe === "today" && route.asksWinner && !completed.length) {
        return `No ${league} match has finished today. ${selected.map(eventLine).join(" ")} Source: ${FIFA_SOURCE}`;
      }
      const answerEvents = route.asksWinner && completed.length ? completed : selected;
      return `${league}: ${answerEvents.map(eventLine).join(" ")} Source: ${FIFA_SOURCE}`;
    }
    if (route.timeframe === "latest-completed") return `I could not find a completed ${league} match in the last 14 days. Source: ${FIFA_SOURCE}`;
    if (route.timeframe === "yesterday") return `No ${league} match was listed yesterday. Source: ${FIFA_SOURCE}`;
    if (route.timeframe === "next") return `No upcoming ${league} match was listed in the next 14 days. Source: ${FIFA_SOURCE}`;
    if (route.timeframe === "final") return `I could not find the ${league} final in the tournament schedule. Source: ${FIFA_SOURCE}`;
    return `No ${league} match is listed today. Source: ${FIFA_SOURCE}`;
  } catch {
    return "";
  }
}
