/**
 * The agent pages' headless Chromium, driven for real. Skipped where the host
 * has no Chromium-family browser on PATH (the "browser missing" path itself
 * runs everywhere).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { on } from "node:events";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { HTML_RENDER_COLUMN_WIDTH, htmlRenderStockTheme } from "@orquester/api/agent-chat";

import {
  Gate,
  HtmlPreviewBrowser,
  HtmlPreviewError,
  killWindowsTree,
  MAX_CONSOLE_MESSAGES,
  MAX_CONSOLE_TEXT_CHARS,
  MAX_SCREENSHOT_BASE64_CHARS,
  MAX_WAITING_CALLS,
  PREVIEW_PROFILE_PREFIX,
  PREVIEWS_BUSY_MESSAGE,
  STALE_PROFILE_AGE_MS,
  TASKKILL_TIMEOUT_MS,
  type StartTimer
} from "./browser.ts";
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
  // Real Chromium on a loaded test machine can take longer than the production
  // budgets: those must not turn the rendering tests into budget tests (the
  // budgets have their own tests).
  browser = new HtmlPreviewBrowser({
    resolveChromium: () => CHROMIUM,
    tmpDir: scratch,
    captureTimeoutMs: 60_000,
    measureTimeoutMs: 60_000
  });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Each test's bound: generous for real Chromium on a loaded machine, but a hung
 * launch or wait fails its test instead of stalling the whole suite.
 */
const TEST_TIMEOUT_MS = 120_000;

const FIXED = (height: number): string =>
  `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><div style="height:${height}px"></div></body></html>`;

interface ManualTimer {
  readonly ms: number;
  cancelled: boolean;
  fired: boolean;
  fire(): void;
}

/** Timers the test runs out by hand: none ever fires by itself. `started` lists every one, in order. */
function manualTimers(): { startTimer: StartTimer; started: ManualTimer[] } {
  const started: ManualTimer[] = [];
  return {
    started,
    startTimer: (onTimeout, ms) => {
      const timer: ManualTimer = {
        ms,
        cancelled: false,
        fired: false,
        fire: () => {
          assert.ok(!timer.cancelled && !timer.fired, "a live timer");
          timer.fired = true;
          onTimeout();
        }
      };
      started.push(timer);
      return () => {
        timer.cancelled = true;
      };
    }
  };
}

describe("html preview browser", { skip }, () => {
  it("screenshots the page at the width asked, measuring its content height", { timeout: TEST_TIMEOUT_MS }, async () => {
    const capture = await browser.capture({ html: FIXED(300), width: 400, urlFragment: "" });
    assert.equal(capture.contentHeight, 300);
    assert.equal(capture.capturedHeight, 300);
    assert.deepEqual(pngSize(capture.screenshot.data), { width: 400, height: 300 });
    assert.deepEqual(capture.screenshot, { data: capture.screenshot.data, mimeType: "image/png", width: 400, height: 300 });
    assert.deepEqual(capture.consoleMessages, []);
  });

  it("caps the capture at 4000px while reporting the whole height", { timeout: TEST_TIMEOUT_MS }, async () => {
    const capture = await browser.capture({ html: FIXED(5000), width: 320, urlFragment: "" });
    assert.equal(capture.contentHeight, 5000);
    assert.equal(capture.capturedHeight, 4000);
    assert.equal(pngSize(capture.screenshot.data).height, 4000);
  });

  it("captures the console — levels, uncaught exceptions with page.html stacks — bounded", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("never reaches this machine: every attempt at loopback, v4 or v6, is refused before any server sees it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const requests: string[] = [];
    const servers: http.Server[] = [];
    const listen = async (host: string): Promise<number | undefined> => {
      const server = http.createServer((request, response) => {
        requests.push(`${host} ${request.url ?? ""}`);
        response.end("ok");
      });
      // A WebSocket upgrade is a request too.
      server.on("upgrade", (request, socket) => {
        requests.push(`${host} upgrade ${request.url ?? ""}`);
        socket.destroy();
      });
      const port = await new Promise<number | undefined>((resolve) => {
        server.once("error", () => resolve(undefined));
        server.listen(0, host, () => resolve((server.address() as { port: number }).port));
      });
      if (port !== undefined) servers.push(server);
      return port;
    };
    const v4 = await listen("127.0.0.1");
    const v6 = await listen("::1");
    assert.ok(v4 !== undefined);
    try {
      const targets: Array<[string, string]> = [
        ["v4", `127.0.0.1:${v4}`],
        ["localhost", `localhost:${v4}`],
        ...(v6 !== undefined ? ([["v6", `[::1]:${v6}`]] as Array<[string, string]>) : [])
      ];
      // Every attempt is awaited to its end and logged, and the capture waits
      // for all of them (the settle step awaits document.fonts.ready).
      const attempts = targets
        .map(
          ([name, target]) => `
          fetch("http://${target}/fetch").then(() => "${name} fetch reached", () => "${name} fetch refused"),
          fetch("http://${target}/keepalive", { method: "POST", body: "x", keepalive: true }).then(() => "${name} keepalive reached", () => "${name} keepalive refused"),
          new Promise((resolve) => { const img = new Image(); img.onload = () => resolve("${name} img reached"); img.onerror = () => resolve("${name} img refused"); img.src = "http://${target}/img.png"; }),
          new Promise((resolve) => { const ws = new WebSocket("ws://${target}/socket"); ws.onopen = () => resolve("${name} ws reached"); ws.onclose = () => resolve("${name} ws refused"); }),
          new Promise((resolve) => { const frame = document.createElement("iframe"); frame.onload = () => resolve("${name} frame settled"); frame.src = "http://${target}/frame"; document.body.append(frame); })`
        )
        .join(",");
      const html = `<!doctype html><body><script>
        const done = Promise.all([${attempts}]).then((results) => console.log(JSON.stringify(results)));
        Object.defineProperty(document.fonts, "ready", { get: () => done.then(() => document.fonts) });
      </script></body>`;
      const capture = await browser.capture({ html, width: 320, urlFragment: "" });
      const logged = capture.consoleMessages.find((message) => message.level === "log" && message.text.startsWith("["));
      assert.ok(logged, JSON.stringify(capture.consoleMessages));
      assert.deepEqual(
        JSON.parse(logged.text),
        targets.flatMap(([name]) => [
          `${name} fetch refused`,
          `${name} keepalive refused`,
          `${name} img refused`,
          `${name} ws refused`,
          `${name} frame settled`
        ])
      );
      assert.deepEqual(requests, []);
      if (v6 === undefined) t.diagnostic("no IPv6 loopback on this host: the [::1] case was not run");
    } finally {
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the main frame on the page", { timeout: TEST_TIMEOUT_MS }, async () => {
    for (const target of ["http://example.invalid/elsewhere", "http://127.0.0.1:9/elsewhere"]) {
      const html = `${FIXED(120)}<script>location.replace(${JSON.stringify(target)})</script>`;
      const capture = await browser.capture({ html, width: 320, urlFragment: "" });
      assert.equal(capture.contentHeight, 120, target);
    }
  });

  it("gives every preview a fresh profile: nothing one page stores is seen by the next", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("gives up at the deadline, killing the browser and removing its profile", { timeout: TEST_TIMEOUT_MS }, async () => {
    const timers = manualTimers();
    let loading!: () => void;
    const pageLoading = new Promise<void>((resolve) => (loading = resolve));
    const hurried = new HtmlPreviewBrowser({
      resolveChromium: () => CHROMIUM,
      tmpDir: scratch,
      captureTimeoutMs: 2000,
      startTimer: timers.startTimer,
      // The page's image never answers, so the page never finishes loading.
      proxy: {
        resolve: () => {
          loading();
          return new Promise(() => undefined);
        }
      }
    });
    const pending = hurried.capture({
      html: `<img src="http://stalls.example/never.png"><script>setTimeout(() => { while (true) {} })</script>`,
      width: 320,
      urlFragment: ""
    });
    pending.catch(() => undefined);
    // The page is loading (its image went out): its deadline runs out now.
    await pageLoading;
    const deadline = timers.started.find((timer) => timer.ms === 2000 && !timer.cancelled);
    assert.ok(deadline);
    deadline.fire();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HtmlPreviewError && error.code === "timeout" && /within 2 seconds/.test(error.message)
    );
    // Only the deadline ran out: it alone ended the call, its browser killed and gone.
    assert.deepEqual(
      timers.started.filter((timer) => timer.fired),
      [deadline]
    );
    assert.deepEqual(await readdir(scratch), []);
  });

  it("stops when the call is cancelled", { timeout: TEST_TIMEOUT_MS }, async () => {
    const controller = new AbortController();
    const html = `<script>console.log("started"); while (true) {}</script>`;
    const pending = browser.capture({ html, width: 320, urlFragment: "", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled");
    assert.deepEqual(await readdir(scratch), []);
  });

  it("measures a page at each width, ascending, each from a fresh load", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("answers no heights when measuring outlives its budget", { timeout: TEST_TIMEOUT_MS }, async () => {
    const hurried = new HtmlPreviewBrowser({ resolveChromium: () => CHROMIUM, tmpDir: scratch, measureTimeoutMs: 1500 });
    assert.equal(await hurried.measure({ html: "<script>while (true) {}</script>", widths: [320], urlFragment: "" }), undefined);
    assert.deepEqual(await readdir(scratch), []);
  });

  it("keeps a screenshot under the size cap: a PNG too large comes back as JPEG, scaled down as needed", { timeout: TEST_TIMEOUT_MS }, async () => {
    // Noise does not compress: 1600×4000 of it is far over the cap as PNG.
    const html = `<!doctype html><style>html,body{margin:0}</style><canvas id="c" width="1600" height="4000" style="display:block"></canvas><script>
      const context = c.getContext("2d");
      const image = context.createImageData(1600, 4000);
      for (let i = 0; i < image.data.length; i++) image.data[i] = (Math.random() * 256) | 0;
      context.putImageData(image, 0, 0);
    </script>`;
    const capture = await browser.capture({ html, width: 1600, urlFragment: "" });
    assert.equal(capture.capturedHeight, 4000);
    const { screenshot } = capture;
    assert.equal(screenshot.mimeType, "image/jpeg");
    assert.ok(screenshot.data.length <= MAX_SCREENSHOT_BASE64_CHARS, `${screenshot.data.length}`);
    const bytes = Buffer.from(screenshot.data, "base64");
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(screenshot.width <= 1600 && screenshot.height <= 4000);
    assert.equal(screenshot.width / screenshot.height, 1600 / 4000);
  });

  it("runs the page source only once it has a slot, and passes its refusal through as it is", { timeout: TEST_TIMEOUT_MS }, async () => {
    let made = 0;
    const capture = await browser.capture({
      html: async () => {
        made += 1;
        return FIXED(50);
      },
      width: 320,
      urlFragment: ""
    });
    assert.equal(made, 1);
    assert.equal(capture.contentHeight, 50);
    class Refusal extends Error {}
    await assert.rejects(
      browser.capture({
        html: async () => {
          throw new Refusal("too large");
        },
        width: 320,
        urlFragment: ""
      }),
      (error: unknown) => error instanceof Refusal
    );
  });
});

describe("html preview: as a reader sees it", { skip }, () => {
  const backgroundProbe = `<!doctype html><body><script>console.log(getComputedStyle(document.documentElement).getPropertyValue("--background").trim())</script></body>`;

  it("themes the page with the stock palette of the appearance asked, dark by default", { timeout: TEST_TIMEOUT_MS }, async () => {
    const dark = await previewHtmlPage(browser, { html: backgroundProbe, sandboxRoot: null });
    assert.equal(dark.consoleMessages[0]?.text, htmlRenderStockTheme("dark").variables["--background"]);
    const light = await previewHtmlPage(browser, { html: backgroundProbe, appearance: "light", sandboxRoot: null });
    assert.equal(light.consoleMessages[0]?.text, htmlRenderStockTheme("light").variables["--background"]);
    assert.notEqual(dark.consoleMessages[0]?.text, light.consoleMessages[0]?.text);
  });

  it("previews at the reply column's width by default, the width clamped to 240..1600", { timeout: TEST_TIMEOUT_MS }, async () => {
    const html = FIXED(100);
    assert.equal((await previewHtmlPage(browser, { html, sandboxRoot: null })).width, HTML_RENDER_COLUMN_WIDTH);
    const narrow = await previewHtmlPage(browser, { html, width: 100, sandboxRoot: null });
    assert.equal(narrow.width, 240);
    assert.equal(pngSize(narrow.screenshot.data).width, 240);
    assert.equal((await previewHtmlPage(browser, { html, width: 4000, sandboxRoot: null })).width, 1600);
  });

  it("inlines the project's images and reports the ones it cannot show", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("measures a prepared page at every client width", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("says no browser is available yet, and that html_render still works", { timeout: TEST_TIMEOUT_MS }, async () => {
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

  it("measures nothing, so a page publishes without heights", { timeout: TEST_TIMEOUT_MS }, async () => {
    assert.equal(await measureHtmlPage(none, FIXED(10)), undefined);
  });
});

describe("the browser gate", () => {
  it("lets two in, hands a freed slot to the next waiter, and drops a waiter whose call was cancelled", { timeout: TEST_TIMEOUT_MS }, async () => {
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

interface FakeChromium {
  executable: string;
  /** The pids of the first `count` to reach their mark, once they have. */
  started(count: number): Promise<number[]>;
  cleanup(): Promise<void>;
}

/**
 * A "Chromium" from `script`, which marks a moment of its own by creating a
 * file named after its pid in the directory it is given.
 */
async function fakeChromium(script: (marks: string) => string): Promise<FakeChromium> {
  const dir = await mkdtemp(join(tmpdir(), "orq-fake-chromium-"));
  const marks = join(dir, "marks");
  await mkdir(marks);
  const executable = join(dir, "chromium");
  await writeFile(executable, script(marks), { mode: 0o755 });
  const watcher = watch(marks);
  const pids = async (): Promise<number[]> => (await readdir(marks)).map(Number);
  return {
    executable,
    started: async (count) => {
      // Wait on the directory's own events; the signal only bounds a launch
      // that never comes, so it fails here rather than hanging the suite.
      const changed = on(watcher, "change", { signal: AbortSignal.timeout(TEST_TIMEOUT_MS / 2) });
      while ((await pids()).length < count) await changed.next();
      return pids();
    },
    cleanup: async () => {
      watcher.close();
      for (const pid of await pids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * A "Chromium" that starts and then never answers: it marks its start, then
 * sleeps. What a hung or slow launch looks like.
 */
function hangingChromium(): Promise<FakeChromium> {
  return fakeChromium((marks) => `#!/bin/sh\ntouch "${marks}/$$"\nexec sleep 300\n`);
}

/**
 * A "Chromium" that answers puppeteer over the pipe until puppeteer sets up
 * its first tab, then never attaches the tab's page: puppeteer's wait for it
 * has no end of its own, not even once the pipe closes. It marks the moment
 * puppeteer has taken the tab and is waiting.
 */
function chromiumStuckAtFirstTab(): Promise<FakeChromium> {
  return fakeChromium(
    (marks) => `#!${process.execPath}
const { createReadStream, writeFileSync, writeSync } = require("node:fs");
const send = (...messages) => writeSync(4, messages.map((message) => JSON.stringify(message) + "\\0").join(""));
let buffered = "";
createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\0"); end !== -1; end = buffered.indexOf("\\0")) {
    const { id, method, sessionId } = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (method === "Target.getBrowserContexts") send({ id, result: { browserContextIds: [] } });
    else if (method === "Target.setAutoAttach" && sessionId === undefined) {
      // The first tab, attached during the initial auto-attach, and in the same read its answer.
      const targetInfo = { targetId: "tab", type: "tab", title: "", url: "about:blank", attached: true, canAccessOpener: false };
      send({ method: "Target.attachedToTarget", params: { sessionId: "tab", targetInfo, waitingForDebugger: false } }, { id, result: {} });
    } else {
      send({ id, sessionId, result: {} });
      // Puppeteer resumes the tab as it takes it, and takes the answer sent with the tab on that same turn.
      if (method === "Runtime.runIfWaitingForDebugger" && sessionId === "tab") writeFileSync(${JSON.stringify(marks)} + "/" + process.pid, "");
    }
  }
});
`
  );
}

/** Gone, or a zombie awaiting its reap: either way no longer running. */
function notRunning(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z";
  } catch {
    return true;
  }
}

describe("html preview browser: slots, queue and cancellation", () => {
  it("a cancel kills a launch that hangs at once, and frees its slot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const fake = await hangingChromium();
    t.after(() => fake.cleanup());
    // No timer runs out here: the cancels alone end both calls.
    const timers = manualTimers();
    const browser = new HtmlPreviewBrowser({ resolveChromium: () => fake.executable, tmpDir: scratch, startTimer: timers.startTimer });
    const first = new AbortController();
    const second = new AbortController();
    const one = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: first.signal });
    const two = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: second.signal });
    const [pidOne, pidTwo] = await fake.started(2);
    // Both outcomes are taken at once: neither rejection may go unhandled while the other is awaited.
    const outcomes = Promise.allSettled([one, two]);
    first.abort();
    second.abort();
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, "rejected");
      const error = (outcome as PromiseRejectedResult).reason;
      assert.ok(error instanceof HtmlPreviewError && error.code === "cancelled", String(error));
    }
    // Each call took down its own bounds as it ended: its queue bound once in a slot, its deadline after.
    assert.equal(timers.started.length, 4);
    assert.ok(timers.started.every((timer) => timer.cancelled && !timer.fired));
    // Each call ended only once its Chromium had exited.
    assert.ok(notRunning(pidOne!) && notRunning(pidTwo!));
    // Both slots are free again: a third launch starts at once.
    const third = new AbortController();
    const three = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: third.signal });
    three.catch(() => undefined);
    assert.equal((await fake.started(3)).length, 3);
    third.abort();
    await assert.rejects(three);
    assert.deepEqual(await readdir(scratch), []);
  });

  it("launches Chromium with every connection through the proxy, loopback and QUIC included (S-M3)", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "orq-args-chromium-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const argsFile = join(dir, "args");
    const executable = join(dir, "chromium");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}.tmp"\nmv "${argsFile}.tmp" "${argsFile}"\nexec sleep 300\n`, { mode: 0o755 });
    const own = await mkdtemp(join(tmpdir(), "orq-html-preview-args-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const browser = new HtmlPreviewBrowser({ resolveChromium: () => executable, tmpDir: own, captureTimeoutMs: 60_000 });
    const cancel = new AbortController();
    const running = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: cancel.signal });
    running.catch(() => undefined);
    const watcher = watch(dir);
    t.after(() => watcher.close());
    const changed = on(watcher, "change");
    while (!existsSync(argsFile)) await changed.next();
    const args = readFileSync(argsFile, "utf8").split("\n");
    cancel.abort();
    await assert.rejects(running);
    assert.ok(args.includes("--disable-quic"), args.join(" "));
    assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
    assert.ok(args.some((arg) => arg.startsWith("--proxy-server=socks5://127.0.0.1:")));
    assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
    // Driven over the pipe only, never a debugging port, from a fresh profile of its own.
    assert.ok(args.includes("--remote-debugging-pipe"));
    assert.ok(!args.some((arg) => arg.startsWith("--remote-debugging-port")));
    const profiles = args.filter((arg) => arg.startsWith("--user-data-dir="));
    assert.equal(profiles.length, 1);
    assert.ok(profiles[0]!.startsWith(`--user-data-dir=${join(own, PREVIEW_PROFILE_PREFIX)}`), profiles[0]);
  });

  it("names a browser binary that cannot be started, and never takes it for a sandbox failure", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const own = await mkdtemp(join(tmpdir(), "orq-html-preview-missing-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    // The registry's cached path, after the browser was removed or upgraded away.
    let executable = join(own, "gone", "chromium");
    const logged: string[] = [];
    const browser = new HtmlPreviewBrowser({
      resolveChromium: () => executable,
      tmpDir: own,
      log: (message, error) => logged.push(`${message}: ${String(error)}`)
    });
    await assert.rejects(
      browser.capture({ html: FIXED(1), width: 320, urlFragment: "" }),
      (error: unknown) =>
        error instanceof HtmlPreviewError &&
        error.code === "browser-unavailable" &&
        error.message.includes(executable) &&
        error.message.includes("ENOENT") &&
        /html_render still works/.test(error.message)
    );
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.ok(logged[0]!.includes(executable) && logged[0]!.includes("ENOENT"), logged[0]);
    assert.deepEqual(await readdir(own), [], "no profile left");
    // Once a browser is back, previews still run sandboxed: nothing was learnt from the missing one.
    const fake = await fakeChromium((marks) => `#!/bin/sh\nprintf '%s\\n' "$@" > "${marks}/../args"\ntouch "${marks}/$$"\nexec sleep 300\n`);
    t.after(() => fake.cleanup());
    executable = fake.executable;
    const cancel = new AbortController();
    const running = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: cancel.signal });
    running.catch(() => undefined);
    await fake.started(1);
    const args = readFileSync(join(fake.executable, "..", "args"), "utf8").split("\n");
    cancel.abort();
    await assert.rejects(running, (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled");
    assert.ok(args.includes("--remote-debugging-pipe"), args.join(" "));
    assert.ok(!args.includes("--no-sandbox"), args.join(" "));
  });

  it("the daemon's stop kills a preview in flight, removes its profile, and refuses any after it (D-M4)", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const fake = await hangingChromium();
    t.after(() => fake.cleanup());
    const own = await mkdtemp(join(tmpdir(), "orq-html-preview-stop-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const browser = new HtmlPreviewBrowser({ resolveChromium: () => fake.executable, tmpDir: own, captureTimeoutMs: 60_000 });
    const running = browser.capture({ html: FIXED(1), width: 320, urlFragment: "" });
    running.catch(() => undefined);
    const [pid] = await fake.started(1);
    await browser.stop();
    await assert.rejects(running, (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled");
    assert.ok(notRunning(pid!));
    assert.deepEqual(await readdir(own), [], "no profile left");
    await assert.rejects(
      browser.capture({ html: FIXED(1), width: 320, urlFragment: "" }),
      (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled"
    );
  });

  it("at boot, sweeps the stale preview profiles a dead daemon left, never a young one or another name (D-M4)", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const own = await mkdtemp(join(tmpdir(), "orq-html-preview-sweep-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    await mkdir(join(own, `${PREVIEW_PROFILE_PREFIX}old`));
    await mkdir(join(own, `${PREVIEW_PROFILE_PREFIX}young`));
    await mkdir(join(own, "someone-elses"));
    const browser = new HtmlPreviewBrowser({ resolveChromium: () => undefined, tmpDir: own });
    // Seen from now, nothing is stale yet.
    assert.deepEqual(await browser.sweepStaleProfiles(Date.now()), []);
    // Seen from later, the untouched one is; the one touched "later" is still young.
    const later = Date.now() + STALE_PROFILE_AGE_MS + 1_000;
    await utimes(join(own, `${PREVIEW_PROFILE_PREFIX}young`), new Date(later), new Date(later));
    assert.deepEqual(await browser.sweepStaleProfiles(later), [`${PREVIEW_PROFILE_PREFIX}old`]);
    assert.deepEqual((await readdir(own)).sort(), [`${PREVIEW_PROFILE_PREFIX}young`, "someone-elses"]);
  });

  it("a call waiting for a slot is told previews are busy — at its own bound, or at once past the waiting cap", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const fake = await hangingChromium();
    t.after(() => fake.cleanup());
    const browser = new HtmlPreviewBrowser({
      resolveChromium: () => fake.executable,
      tmpDir: scratch,
      captureTimeoutMs: 60_000,
      queueTimeoutMs: 500
    });
    const holders = [new AbortController(), new AbortController()];
    const held = holders.map((holder) => browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: holder.signal }));
    for (const pending of held) pending.catch(() => undefined);
    await fake.started(2);
    let made = 0;
    const source = async (): Promise<string> => {
      made += 1;
      return FIXED(1);
    };
    // Waits its bound, never starts its source, and says why.
    await assert.rejects(
      browser.capture({ html: source, width: 320, urlFragment: "" }),
      (error: unknown) => error instanceof HtmlPreviewError && error.code === "busy" && error.message === PREVIEWS_BUSY_MESSAGE
    );
    assert.equal(made, 0, "a waiting call made no page");
    // A measurement behind them publishes without heights.
    assert.equal(await browser.measure({ html: FIXED(1), widths: [320], urlFragment: "" }), undefined);
    // Past the waiting cap: refused at once.
    const patient = new HtmlPreviewBrowser({ resolveChromium: () => fake.executable, tmpDir: scratch, captureTimeoutMs: 60_000 });
    const patientHolders = Array.from({ length: 2 + MAX_WAITING_CALLS }, () => new AbortController());
    const queued = patientHolders.map((holder) => patient.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: holder.signal }));
    for (const pending of queued) pending.catch(() => undefined);
    await assert.rejects(
      patient.capture({ html: FIXED(1), width: 320, urlFragment: "" }),
      (error: unknown) => error instanceof HtmlPreviewError && error.code === "busy"
    );
    for (const holder of [...holders, ...patientHolders]) holder.abort();
    await Promise.allSettled([...held, ...queued]);
    assert.deepEqual(await readdir(scratch), []);
  });

  it("the deadline runs from the slot's start, not from the queue", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const fake = await hangingChromium();
    t.after(() => fake.cleanup());
    const deadline = 1_500;
    const queueBound = 30_000;
    const timers = manualTimers();
    const browser = new HtmlPreviewBrowser({
      resolveChromium: () => fake.executable,
      tmpDir: scratch,
      captureTimeoutMs: deadline,
      queueTimeoutMs: queueBound,
      startTimer: timers.startTimer
    });
    const deadlines = (): ManualTimer[] => timers.started.filter((timer) => timer.ms === deadline);
    const calls = [0, 1, 2].map(() => browser.capture({ html: FIXED(1), width: 320, urlFragment: "" }));
    for (const call of calls) call.catch(() => undefined);
    await fake.started(2);
    // Two hold the slots, each with its deadline; the third waits, on its queue bound only.
    assert.equal(deadlines().length, 2);
    assert.equal(timers.started.filter((timer) => timer.ms === queueBound).length, 3);
    deadlines()[0]!.fire();
    await assert.rejects(calls[0]!, (error: unknown) => error instanceof HtmlPreviewError && error.code === "timeout");
    // The freed slot went to the third, whose whole deadline starts only now.
    await fake.started(3);
    assert.equal(deadlines().length, 3);
    assert.ok(!deadlines()[2]!.fired && !deadlines()[2]!.cancelled);
    for (const timer of deadlines().slice(1)) timer.fire();
    for (const call of calls.slice(1)) {
      await assert.rejects(call, (error: unknown) => error instanceof HtmlPreviewError && error.code === "timeout");
    }
    assert.deepEqual(await readdir(scratch), []);
  });

  it("the deadline ends a call even where puppeteer would wait forever: Chromium killed while puppeteer sets up its first tab", { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const fake = await chromiumStuckAtFirstTab();
    t.after(() => fake.cleanup());
    const own = await mkdtemp(join(tmpdir(), "orq-html-preview-stuck-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const timers = manualTimers();
    const browser = new HtmlPreviewBrowser({
      resolveChromium: () => fake.executable,
      tmpDir: own,
      captureTimeoutMs: 20_000,
      startTimer: timers.startTimer
    });
    const pending = browser.capture({ html: FIXED(1), width: 320, urlFragment: "" });
    pending.catch(() => undefined);
    const [pid] = await fake.started(1);
    timers.started.find((timer) => timer.ms === 20_000)!.fire();
    await assert.rejects(pending, (error: unknown) => error instanceof HtmlPreviewError && error.code === "timeout");
    // It ended only once its Chromium had exited, and left nothing behind.
    assert.ok(notRunning(pid!));
    assert.deepEqual(await readdir(own), []);
    // And its slot is free: the next call starts at once (and is cancelled the same way).
    const next = new AbortController();
    const after = browser.capture({ html: FIXED(1), width: 320, urlFragment: "", signal: next.signal });
    after.catch(() => undefined);
    await fake.started(2);
    next.abort();
    await assert.rejects(after, (error: unknown) => error instanceof HtmlPreviewError && error.code === "cancelled");
    assert.deepEqual(await readdir(own), []);
  });
});

describe("the Windows tree kill", () => {
  it("runs taskkill /T /F on the pid, bounded by a timeout, and says whether it worked", () => {
    const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { status: calls.length === 1 ? 0 : 1, signal: null, output: [], pid: 1, stdout: null, stderr: null };
    }) as unknown as typeof spawnSync;
    assert.equal(killWindowsTree(4242, { run }), true);
    assert.deepEqual(calls[0]!.args, ["/pid", "4242", "/T", "/F"]);
    assert.equal(calls[0]!.command, "taskkill");
    assert.equal(calls[0]!.options.timeout, TASKKILL_TIMEOUT_MS);
    assert.equal(killWindowsTree(4242, { run }), false, "a failed taskkill: the caller kills the process itself");
  });

  it("a taskkill that hangs is killed at its bound: the call returns false instead of hanging", { timeout: TEST_TIMEOUT_MS }, () => {
    // A stand-in that never exits, run through the real spawnSync with the options the kill passes.
    const run = ((_command: string, _args: readonly string[], options: Parameters<typeof spawnSync>[2]) =>
      spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)) as unknown as typeof spawnSync;
    const started = Date.now();
    assert.equal(killWindowsTree(4242, { run, timeoutMs: 300 }), false);
    assert.ok(Date.now() - started < TEST_TIMEOUT_MS, "bounded");
  });
});
