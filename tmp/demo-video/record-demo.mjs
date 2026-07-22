import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/S10/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "recordings");
const pagePath = path.join(__dirname, "boolean-email-demo.html");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } }
});
const page = await context.newPage();
await page.goto(`file:///${pagePath.replaceAll("\\", "/")}`);
await page.waitForTimeout(36000);
const video = page.video();
await context.close();
await browser.close();
const videoPath = await video.path();
console.log(videoPath);
