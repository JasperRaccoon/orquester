/**
 * The agent pages' headless Chromium, driven for real. Skipped where the host
 * has no Chromium-family browser on PATH (the "browser missing" path itself
 * runs everywhere).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { HTML_RENDER_COLUMN_WIDTH, htmlRenderStockTheme } from "@orquester/api/agent-chat";

import { Gate, HtmlPreviewBrowser, HtmlPreviewError, MAX_CONSOLE_MESSAGES, MAX_CONSOLE_TEXT_CHARS } from "./browser.ts";
import { measureHtmlPage, previewHtmlPage } from "./index.ts";

function findChromium(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const CHROMIUM = findChromium();
const skip = CHROMIUM === undefined ? "no Chromium-family browser on PATH" : false;

/** Width and height from a PNG's IHDR. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let scratch: string;
let browser: HtmlPreviewBrowser;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "orq-html-preview-test-"));
  browser = new HtmlPreviewBrowser({ resolveChromium: () => CHROMIUM, tmpDir: scratch });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const FIXED = (height: number): string =>
  `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><div style="height:${height}px"></div></body></html>`;

describe("html preview browser", { skip }, () => {
  it("screenshots the page at the width asked, measuring its content height", async () => {
    const capture = await browser.capture({ html: FIXED(300), width: 400, urlFragment: "" });
    assert.equal(capture.contentHeight, 300);
    assert.equal(capture.capturedHeight, 300);
    assert.deepEqual(pngSize(capture.png), { width: 400, height: 300 });
    assert.deepEqual(capture.consoleMessages, []);
  });

  it("caps the capture at 4000px while reporting the whole height", async () => {
    const capture = await browser.capture({ html: FIXED(5000), width: 320, urlFragment: "" });
    assert.equal(capture.contentHeight, 5000);
    assert.equal(capture.capturedHeight, 4000);
    assert.equal(pngSize(capture.png).height, 4000);
  });

  it("captures the console — levels, uncaught exceptions with page.html stacks — bounded", async () => {
    const html = `<!doctype html><body><script>
      console.log("checked", 3);
      console.info("info");
      console.warn("careful");
      console.error("bad");
      function explode() { throw new Error("boom"); }
      setTimeout(explode);
    </script><script>setTimeout(() => console.log("after"), 10)</script></body>`;
    const capture = await browser.capture({ html, width: 320, urlFragment: "#orq-theme=%7B%7D" });
    const levels = capture.consoleMessages.map((message) => [message.level, message.text.split("\n")[0]]);
    assert.deepEqual(levels.slice(0, 4), [
      ["log", "checked 3"],
      ["info", "info"],
      ["warning", "careful"],
      ["error", "bad"]
    ]);
    const exception = capture.consoleMessages.find((message) => message.text.startsWith("Error: boom"));
    assert.ok(exception, JSON.stringify(capture.consoleMessages));
    assert.equal(exception.level, "error");
    assert.match(exception.text, /page\.html:\d+:\d+/);
    for (const message of capture.consoleMessages) {
      assert.doesNotMatch(message.text, /orquester-page\.localhost|orq-theme/);
    }

    const noisy = await browser.capture({
      html: `<script>for (let i = 0; i < 30; i++) console.log(i === 0 ? "x".repeat(2000) : "line " + i)</script>`,
      width: 320,
      urlFragment: ""
    });
    assert.equal(noisy.consoleMessages.length, MAX_CONSOLE_MESSAGES + 1);
    assert.equal(noisy.consoleMessages[0]!.text.length, MAX_CONSOLE_TEXT_CHARS + 1);
    assert.ok(noisy.consoleMessages[0]!.text.endsWith("…"));
    assert.deepEqual(noisy.consoleMessages.at(-1), { level: "warning", text: "10 more console messages were omitted." });
  });

  it("never reaches this machine: fetch, images, frames, sockets, beacons and navigation to loopback are refused", async () => {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? "");
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const html = `<!doctype html><body><p id="mine">mine</p>
        <img src="http://127.0.0.1:${port}/img.png">
        <img src="http://localhost:${port}/img2.png">
        <iframe src="http://127.0.0.1:${port}/frame"></iframe>
        <link rel="stylesheet" href="http://[::1]:${port}/style.css">
        <script>
          fetch("http://127.0.0.1:${port}/fetch").catch(() => console.log("fetch refused"));
          try { new WebSocket("ws://127.0.0.1:${port}/socket"); } catch {}
          navigator.sendBeacon("http://127.0.0.1:${port}/beacon", "x");
          setTimeout(() => { location.href = "http://127.0.0.1:${port}/navigate"; });
        </script></body>`;
      const capture = await browser.capture({ html, width: 320, urlFragment: "" });
      assert.ok(capture.contentHeight > 0);
      assert.deepEqual(requests, []);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the main frame on the page", async () => {
    const html = `${FIXED(120)}<script>location.replace("http://example.invalid/elsewhere")</script>`;
    const capture = await browser.capture({ html, width: 320, urlFragment: "" });
    assert.equal(capture.contentHeight, 120);
  });

  it("gives every preview a fresh profile: nothing one page stores is seen by the next", async () => {
    await browser.capture({
      html: `<script>localStorage.setItem("seen", "1"); document.cookie = "seen=1; max-age=999"; indexedDB.open("seen");</script>`,
      width: 320,
      urlFragment: ""
    });
    const second = await browser.capture({
      html: `<script>console.log(JSON.stringify([localStorage.getItem("seen"), document.cookie]))</script>`,
      width: 320,
      urlFragment: ""
    });
    assert.deepEqual(second.consoleMessages, [{ level: "log", text: '[null,""]' }]);
    // And the profile itself is gone.
    assert.deepEqual(await readdir(scratch), []);
  });

  it("gives up at the deadline, killing the browser and removing its profile", async () => {
    const hurried = new HtmlPreviewBrowser({ resolveChromium: () => CHROMIUM, tmpDir: scratch, captureTimeoutMs: 2000 });
    const started = Date.now();
    await assert.rejects(
      hurried.capture({ html: "<script>while (true) {}</script>", width: 320, urlFragment: "" }),
      (error: unknown) => error instanceof HtmlPreviewError && error.code === "timeout" && /within 2 seconds/.test(error.message)
    );
    assert.ok(Date.now() - started < 10_000);
    assert.deepEqual(await readdir(scratch), []);
  });

  it("stops when the call is cancelled", async () => {
    const controller = new AbortController();
    const html = `<script>console.log("started"); while (true) {}</script>`;
    const pending = browser.capture({ html, width: 320, urlFragment: "", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled");
    assert.deepEqual(await readdir(scratch), []);
  });

  it("measures a page at each width, ascending, each from a fresh load", async () => {
    const text = `<!doctype html><style>html,body{margin:0}</style><p style="margin:0">${"word ".repeat(400)}</p>`;
    const heights = await browser.measure({ html: text, widths: [1144, 320, 728], urlFragment: "" });
    assert.ok(heights);
    assert.deepEqual(heights.map(([width]) => width), [320, 728, 1144]);
    assert.ok(heights[0]![1] > heights[1]![1] && heights[1]![1] > heights[2]![1], JSON.stringify(heights));
    // A page that lays itself out once, from the width at load.
    const once = `<!doctype html><style>html,body{margin:0}</style><div id="d"></div><script>d.style.height = innerWidth < 500 ? "400px" : "100px"</script>`;
    assert.deepEqual(await browser.measure({ html: once, widths: [320, 728], urlFragment: "" }), [
      [320, 400],
      [728, 100]
    ]);
  });

  it("answers no heights when measuring outlives its budget", async () => {
    const hurried = new HtmlPreviewBrowser({ resolveChromium: () => CHROMIUM, tmpDir: scratch, measureTimeoutMs: 1500 });
    assert.equal(await hurried.measure({ html: "<script>while (true) {}</script>", widths: [320], urlFragment: "" }), undefined);
    assert.deepEqual(await readdir(scratch), []);
  });
});

describe("html preview: as a reader sees it", { skip }, () => {
  const backgroundProbe = `<!doctype html><body><script>console.log(getComputedStyle(document.documentElement).getPropertyValue("--background").trim())</script></body>`;

  it("themes the page with the stock palette of the appearance asked, dark by default", async () => {
    const dark = await previewHtmlPage(browser, { html: backgroundProbe, sandboxRoot: null });
    assert.equal(dark.consoleMessages[0]?.text, htmlRenderStockTheme("dark").variables["--background"]);
    const light = await previewHtmlPage(browser, { html: backgroundProbe, appearance: "light", sandboxRoot: null });
    assert.equal(light.consoleMessages[0]?.text, htmlRenderStockTheme("light").variables["--background"]);
    assert.notEqual(dark.consoleMessages[0]?.text, light.consoleMessages[0]?.text);
  });

  it("previews at the reply column's width by default, the width clamped to 240..1600", async () => {
    const html = FIXED(100);
    assert.equal((await previewHtmlPage(browser, { html, sandboxRoot: null })).width, HTML_RENDER_COLUMN_WIDTH);
    const narrow = await previewHtmlPage(browser, { html, width: 100, sandboxRoot: null });
    assert.equal(narrow.width, 240);
    assert.equal(pngSize(narrow.png).width, 240);
    assert.equal((await previewHtmlPage(browser, { html, width: 4000, sandboxRoot: null })).width, 1600);
  });

  it("inlines the project's images and reports the ones it cannot show", async () => {
    const project = await mkdtemp(join(tmpdir(), "orq-html-preview-project-"));
    const outside = await mkdtemp(join(tmpdir(), "orq-html-preview-outside-"));
    try {
      // A 1×1 PNG.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64"
      );
      await mkdir(join(project, "shots"));
      await writeFile(join(project, "shots", "in.png"), png);
      await writeFile(join(outside, "secret.png"), png);
      await symlink(join(outside, "secret.png"), join(project, "shots", "link.png"));
      const html = `<!doctype html><body>
        <img id="a" src="${join(project, "shots", "in.png")}">
        <img id="b" src="${join(project, "shots", "gone.png")}">
        <img id="c" src="${join(project, "shots", "link.png")}">
        <script>addEventListener("load", () => console.log([a, b, c].map((img) => img.naturalWidth).join(",")))</script></body>`;
      const preview = await previewHtmlPage(browser, { html, sandboxRoot: project });
      assert.deepEqual(preview.missingImages, [join(project, "shots", "gone.png")]);
      assert.deepEqual(preview.imagesOutsideProject, [join(project, "shots", "link.png")]);
      assert.ok(
        preview.consoleMessages.some((message) => message.text === "1,0,0"),
        JSON.stringify(preview.consoleMessages)
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("measures a prepared page at every client width", async () => {
    const heights = await measureHtmlPage(browser, FIXED(240));
    assert.ok(heights);
    assert.deepEqual(
      heights.map(([width]) => width),
      [320, 375, 430, 520, 640, 728, 860, 1000, 1144]
    );
    assert.ok(heights.every(([, height]) => height === 240), JSON.stringify(heights));
  });
});

describe("html preview without a browser", () => {
  const none = new HtmlPreviewBrowser({ resolveChromium: () => undefined });

  it("says no browser is available yet, and that html_render still works", async () => {
    assert.equal(none.available(), false);
    await assert.rejects(
      previewHtmlPage(none, { html: FIXED(10), sandboxRoot: null }),
      (error: unknown) =>
        error instanceof HtmlPreviewError &&
        error.code === "browser-unavailable" &&
        /no Chromium-family browser/.test(error.message) &&
        /html_render still works/.test(error.message)
    );
  });

  it("measures nothing, so a page publishes without heights", async () => {
    assert.equal(await measureHtmlPage(none, FIXED(10)), undefined);
  });
});

describe("the browser gate", () => {
  it("lets two in, hands a freed slot to the next waiter, and drops a waiter whose call was cancelled", async () => {
    const gate = new Gate(2);
    const live = new AbortController().signal;
    const first = await gate.enter(live);
    const second = await gate.enter(live);
    const order: string[] = [];
    const cancelled = new AbortController();
    const third = gate.enter(cancelled.signal).then(
      () => order.push("third"),
      () => order.push("third cancelled")
    );
    const fourth = gate.enter(live).then((release) => {
      order.push("fourth");
      return release;
    });
    cancelled.abort();
    await third;
    first();
    first(); // a second release is a no-op
    const releaseFourth = await fourth;
    assert.deepEqual(order, ["third cancelled", "fourth"]);
    // Still full: second and fourth hold the two slots.
    let fifthIn = false;
    const fifth = gate.enter(live).then((release) => {
      fifthIn = true;
      return release;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fifthIn, false);
    second();
    (await fifth)();
    releaseFourth();
    // Both slots free again.
    (await gate.enter(live))();
  });
});
