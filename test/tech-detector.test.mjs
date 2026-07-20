import assert from "node:assert/strict";
import test from "node:test";

import { detectWebsiteTech } from "../src/tech-detector.js";

test("detects common CMS, framework, analytics, and CDN signals", () => {
  const report = detectWebsiteTech({
    url: "https://example.com",
    headers: { server: "cloudflare", "cf-ray": "abc" },
    html: `
      <meta name="generator" content="WordPress 6.5">
      <link rel="stylesheet" href="/wp-content/themes/site/style.css">
      <script id="__NEXT_DATA__" type="application/json">{}</script>
      <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script>
    `
  });
  const names = report.detected.map((item) => item.name);
  assert.ok(names.includes("WordPress"));
  assert.ok(names.includes("Next.js"));
  assert.ok(names.includes("Google Tag Manager"));
  assert.ok(names.includes("Cloudflare"));
  assert.equal(report.privacy.includes("No third-party"), true);
});

test("returns sorted confidence scores with signal explanations", () => {
  const report = detectWebsiteTech({
    html: `<script>window.Shopify={}</script><img src="https://cdn.shopify.com/s/files/1/asset.js">`
  });
  assert.equal(report.detected[0].name, "Shopify");
  assert.equal(report.detected[0].confidence > 50, true);
  assert.equal(report.detected[0].signals.length > 0, true);
});

