import assert from "node:assert/strict";
import test from "node:test";

import { formatResearchEvidence, rankResearchCandidates, researchAuthority } from "../src/browse.js";

test("authoritative research ranks primary sources above community pages", () => {
  const results = [
    { n: 1, text: "Community answer", url: "https://reddit.com/r/example/post" },
    { n: 2, text: "Official guidance", url: "https://www.cdc.gov/example" },
    { n: 3, text: "Academic paper", url: "https://example.edu/paper" }
  ];
  const ranked = rankResearchCandidates(results, ["community", "official", "paper"], "authoritative");
  assert.equal(ranked[0].text, "Official guidance");
  assert.equal(ranked.at(-1).text, "Community answer");
  assert.equal(researchAuthority("https://www.cdc.gov/example").label, "government primary source");
});

test("research relevance breaks ties between equally authoritative sources", () => {
  const results = [
    { n: 1, text: "All Node.js documentation", url: "https://nodejs.org/api/all.html" },
    { n: 2, text: "Node.js fetch documentation", url: "https://nodejs.org/api/globals.html#fetch" }
  ];
  const ranked = rankResearchCandidates(results, ["Every Node.js API", "How fetch works in Node.js"], "authoritative", "Node.js fetch");
  assert.equal(ranked[0].url, "https://nodejs.org/api/globals.html#fetch");
});

test("research evidence is citation-ready and includes direct URLs", () => {
  const report = formatResearchEvidence("current guidance", [{
    title: "Official guidance", host: "cdc.gov", authority: "government primary source",
    url: "https://www.cdc.gov/example", evidence: "The official evidence text."
  }]);
  assert.match(report, /Cite factual claims with \[1\]/);
  assert.match(report, /\[1\] Official guidance/);
  assert.match(report, /https:\/\/www\.cdc\.gov\/example/);
});
