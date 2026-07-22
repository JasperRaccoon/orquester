#!/usr/bin/env node
/**
 * Post-deploy browser smoke test for the web client.
 *
 *   node scripts/smoke-web.mjs https://your-orquester-host
 *
 * Loads the deployed URL once with clean storage and once per fixture set in
 * scripts/smoke-web-fixtures.json (real localStorage payloads written by OLD
 * bundles — persisted state outlives deploys, and a stale blob once crashed
 * the whole app on load). Each pass waits ~3s past first render and fails on:
 *   - any uncaught page error (window.onerror / unhandled rejection),
 *   - any console.error (expected auth 401s are allowlisted),
 *   - an empty #root (the "loads then goes gray" symptom).
 *
 * Uses puppeteer-core from the daemon's dependencies + a system Chrome/Chromium
 * (override the binary with SMOKE_CHROME=/path/to/chrome). Exit 0 = pass.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/smoke-web.mjs <deployed-url>");
  process.exit(2);
}

// Resolve puppeteer-core through the daemon package (it's a daemon dependency;
// pnpm does not hoist it to the repo root).
const require = createRequire(join(here, "..", "apps", "daemon", "package.json"));
let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core not installed — run `pnpm install` first.");
  process.exit(2);
}

function findChrome() {
  if (process.env.SMOKE_CHROME) return process.env.SMOKE_CHROME;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium"
  ];
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChrome();
if (!executablePath) {
  console.error("No Chrome/Chromium found. Set SMOKE_CHROME=/path/to/chrome.");
  process.exit(2);
}

const fixtures = JSON.parse(await readFile(join(here, "smoke-web-fixtures.json"), "utf8"));
const scenarios = [
  { name: "clean-storage", storage: {} },
  ...Object.entries(fixtures).map(([name, storage]) => ({ name, storage }))
];

// Console errors that are expected on a not-logged-in load: the browser logs
// the 401 responses of authenticated API calls as console errors.
const ALLOWED_CONSOLE = [/the server responded with a status of 401/i];

const SETTLE_MS = 3000;
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

let failed = false;
try {
  for (const scenario of scenarios) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const problems = [];

    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message ?? err}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (ALLOWED_CONSOLE.some((re) => re.test(text))) return;
      problems.push(`console.error: ${text}`);
    });

    // Seed localStorage before any app script runs.
    await page.evaluateOnNewDocument((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, scenario.storage);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("#root", { timeout: 15_000 });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const rootHtml = await page.$eval("#root", (el) => el.innerHTML.trim());
      if (!rootHtml) problems.push("empty #root after settle (blank page)");
    } catch (err) {
      problems.push(`navigation: ${err.message ?? err}`);
    }

    if (problems.length > 0) {
      failed = true;
      console.error(`✗ ${scenario.name}`);
      for (const p of problems) console.error(`    ${p}`);
    } else {
      console.log(`✓ ${scenario.name}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error(`SMOKE FAIL: ${url}`);
  process.exit(1);
}
console.log(`SMOKE OK: ${url}`);
