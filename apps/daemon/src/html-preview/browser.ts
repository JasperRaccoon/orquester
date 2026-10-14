/**
 * Headless Chromium for agent pages (design 2026-10-14 §2.1, §2.2): the
 * `html_preview` screenshot and the heights `html_render` publishes with.
 *
 * Ported from T3 Code (MIT): `apps/server/src/htmlRender/headlessChrome.ts`,
 * on puppeteer-core and the Chromium the daemon's browser tabs already use
 * (`resolveChromium`, the registry's probed Chromium-family entry; the same
 * sandbox-then-`--no-sandbox` launch as `../browsers.ts`). Never the user's
 * browser tabs' process or profile:
 *
 * - **Isolated.** Each preview or measurement launches its own browser over a
 *   pipe (no debugging port) with a fresh temporary profile, removed after,
 *   downloads denied and popups blocked — no cookie, storage or cache is
 *   shared with anything.
 * - **No local network.** Every connection, loopback included, goes through
 *   `public-proxy.ts`, which resolves the target itself and connects only to
 *   public addresses; WebRTC is removed (its UDP bypasses any proxy).
 * - **The page is served, never a file.** It loads from a made-up web origin
 *   answered by request interception, so it cannot read local files; local
 *   images reach it already inlined. The main frame stays on the page.
 * - **Bounded.** A hard deadline kills the browser's process group; console
 *   output is capped; at most two browsers run at once.
 */

import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type ConsoleMessage as PuppeteerConsoleMessage, type HTTPRequest, type Page } from "puppeteer-core";

import { isRetryableSandboxFailure } from "../browsers.ts";
import { startPublicProxy, type PublicProxyOptions } from "./public-proxy.ts";

export type HtmlPreviewErrorCode = "browser-unavailable" | "browser-failed" | "busy" | "timeout" | "cancelled";

/** A failure whose message is written for the agent. */
export class HtmlPreviewError extends Error {
  constructor(
    readonly code: HtmlPreviewErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HtmlPreviewError";
  }
}

export interface HtmlConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

/** The screenshot: base64, at most {@link MAX_SCREENSHOT_BASE64_CHARS}. */
export interface HtmlScreenshot {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
  /** Its pixel size: the captured area, or less when it had to be scaled down to fit. */
  readonly width: number;
  readonly height: number;
}

export interface HtmlCapture {
  /** The top `capturedHeight` pixels of the page. */
  readonly screenshot: HtmlScreenshot;
  /** The height the page needs to show without scrolling. */
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: HtmlConsoleMessage[];
}

export const MAX_CONSOLE_MESSAGES = 20;
export const MAX_CONSOLE_TEXT_CHARS = 500;
const VIEWPORT_HEIGHT = 800;
export const MAX_CAPTURE_HEIGHT = 4000;
/**
 * A screenshot stays under this much base64 (3 MiB of image): within what
 * every provider takes inline (Anthropic's API refuses an image over 5 MB).
 * A PNG over it is retaken as JPEG, then scaled down until it fits.
 */
export const MAX_SCREENSHOT_BASE64_CHARS = 4 * 1024 * 1024;
/** From a slot's start: loading, settling and the screenshot. */
export const CAPTURE_TIMEOUT_MS = 20_000;
/** Publishing measures for this long at most, then publishes without heights. */
export const MEASURE_TIMEOUT_MS = 6_000;
/** How long a preview waits for a free browser slot before it is told previews are busy. */
export const CAPTURE_QUEUE_TIMEOUT_MS = 30_000;
/** How long a publish waits for a slot to measure before it publishes without heights. */
export const MEASURE_QUEUE_TIMEOUT_MS = 10_000;
// Each preview or measurement runs its own browser; more at once mostly costs memory.
const MAX_CONCURRENT_BROWSERS = 2;
/** Calls waiting for a slot; past it a call is refused as busy at once. */
export const MAX_WAITING_CALLS = 8;
// Each measuring load is its own page in the one browser.
const MEASURE_CONCURRENCY = 3;
const CLOSE_GRACE_MS = 2_000;

// A made-up web origin, answered by interception: never a file, so the page
// can read no local file. `.localhost` keeps it a secure context that may
// still load plain-http resources, and the request never leaves the browser.
const PAGE_ORIGIN = "http://orquester-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
// Stack traces and load errors name the page this way instead of its URL (and its theme fragment).
const PAGE_NAME = "page.html";
const PAGE_URL_PATTERN = new RegExp(`${PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:#[^\\s:]*)?`, "g");

// Previews have no use for WebRTC, whose ICE servers would send UDP no proxy carries.
const NO_WEBRTC = "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;";
// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// The root's scroll height never drops below the viewport, so a short page
// reports its own box height instead.
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

const CONSOLE_LEVELS: Readonly<Record<string, HtmlConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warn: "warning",
  warning: "warning",
  error: "error",
  assert: "error"
};

export interface HtmlPreviewBrowserOptions {
  /** The Chromium-family binary, or undefined when the host has none (yet). */
  resolveChromium(): string | undefined;
  /** For tests: the proxy's resolver and block rule. */
  proxy?: PublicProxyOptions;
  /** For tests. */
  captureTimeoutMs?: number;
  measureTimeoutMs?: number;
  queueTimeoutMs?: number;
  /** Where temporary profiles go; the OS temp dir by default. */
  tmpDir?: string;
  log?: (message: string, error?: unknown) => void;
}

/** A bounded console log, as the agent reads it. */
class ConsoleLog {
  readonly messages: HtmlConsoleMessage[] = [];
  private omitted = 0;

  add(level: HtmlConsoleMessage["level"], raw: string): void {
    if (this.messages.length >= MAX_CONSOLE_MESSAGES) {
      this.omitted += 1;
      return;
    }
    const text = raw.replace(PAGE_URL_PATTERN, PAGE_NAME);
    this.messages.push({
      level,
      text: text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text
    });
  }

  list(): HtmlConsoleMessage[] {
    return this.omitted === 0
      ? [...this.messages]
      : [...this.messages, { level: "warning", text: `${this.omitted} more console messages were omitted.` }];
  }
}

function consoleText(message: PuppeteerConsoleMessage): string {
  const text = message.text();
  // A browser log entry (a failed load) has no arguments: name what failed.
  const url = message.args().length === 0 ? message.location().url : undefined;
  return url && !text.includes(url) ? `${text} ${url}` : text;
}

/** Kills a launched browser's whole process group, now. */
function killBrowser(browser: Browser): void {
  const child = browser.process();
  if (!child?.pid) return;
  try {
    // puppeteer spawns Chromium detached, so its pid leads its group.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export const PREVIEWS_BUSY_MESSAGE = "Previews are busy right now; try again in a few seconds.";

/**
 * A counting semaphore: a freed slot passes straight to the next waiter,
 * waits honour an abort signal, and at most `maxWaiting` wait — past that a
 * call is refused as busy at once.
 */
export class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting = Number.POSITIVE_INFINITY
  ) {}

  async enter(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      if (this.waiters.length >= this.maxWaiting) throw new HtmlPreviewError("busy", PREVIEWS_BUSY_MESSAGE);
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(handOver);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        const handOver = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiters.push(handOver);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/** What previewing and measuring need of a browser (tests pass a fake). */
export type HtmlPageRenderer = Pick<HtmlPreviewBrowser, "available" | "capture" | "measure">;

/** A page, or what makes it — run only once the call has its browser slot, so a queue holds no inlined pages. */
export type HtmlSource = string | (() => Promise<string>);

/** Thrown by an {@link HtmlSource}: rethrown as it is, never as a browser failure. */
class SourceFailure {
  constructor(readonly cause: unknown) {}
}

/** The prefix of every preview's temporary profile directory. */
export const PREVIEW_PROFILE_PREFIX = "orq-html-preview-";
/** A profile older than this at boot belongs to no running preview (every one ends within a minute). */
export const STALE_PROFILE_AGE_MS = 10 * 60_000;

export class HtmlPreviewBrowser {
  private readonly gate = new Gate(MAX_CONCURRENT_BROWSERS, MAX_WAITING_CALLS);
  /** Learnt once per daemon: false after the sandbox failed to start here. */
  private sandboxWorks = true;
  /** The calls in flight: `stop()` cancels each and waits for it to clean up. */
  private readonly inFlight = new Map<AbortController, Promise<unknown>>();
  private closed = false;

  constructor(private readonly opts: HtmlPreviewBrowserOptions) {}

  /**
   * The daemon is stopping (D-M4): every preview or measurement in flight is cancelled — its
   * Chromium process group killed, its profile and proxy removed — and none starts after this.
   */
  async stop(): Promise<void> {
    this.closed = true;
    for (const controller of this.inFlight.keys()) {
      if (!controller.signal.aborted) controller.abort(new HtmlPreviewError("cancelled", "Orquester is shutting down."));
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * At boot (D-M4): remove the temporary profiles a daemon that died mid-preview left behind —
   * this process's own `PREVIEW_PROFILE_PREFIX` directories older than `STALE_PROFILE_AGE_MS`
   * (younger ones may be another daemon's running preview sharing the temp dir). Never throws.
   */
  async sweepStaleProfiles(now = Date.now()): Promise<string[]> {
    const dir = this.opts.tmpDir ?? tmpdir();
    const removed: string[] = [];
    const entries = await readdir(dir).catch((): string[] => []);
    for (const entry of entries) {
      if (!entry.startsWith(PREVIEW_PROFILE_PREFIX)) continue;
      const path = join(dir, entry);
      const info = await lstat(path).catch(() => null);
      if (info === null || !info.isDirectory() || now - info.mtimeMs < STALE_PROFILE_AGE_MS) continue;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed.push(entry);
    }
    return removed;
  }

  /** Whether a Chromium-family browser is there to launch. */
  available(): boolean {
    return this.opts.resolveChromium() !== undefined;
  }

  /** Loads the page at `width` and screenshots the top of it. */
  capture(input: { html: HtmlSource; width: number; urlFragment: string; signal?: AbortSignal }): Promise<HtmlCapture> {
    return this.withBrowser(
      input.signal,
      {
        timeoutMs: this.opts.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS,
        queueTimeoutMs: this.opts.queueTimeoutMs ?? CAPTURE_QUEUE_TIMEOUT_MS
      },
      input.html,
      async (browser, html) => {
        const log = new ConsoleLog();
        const page = await openPage(browser, input.width, html, log);
        const contentHeight = await load(page, input.urlFragment);
        const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
        const screenshot = await screenshotWithinCap(page, input.width, capturedHeight);
        return { screenshot, contentHeight, capturedHeight, consoleMessages: log.list() };
      }
    );
  }

  /**
   * The page's content height at each width, each from a fresh load (pages
   * often lay themselves out from the width once, at load), ascending by
   * width. Never installs or waits long for a browser: undefined when there
   * is none, no slot frees up in time, it fails, or it outlives its budget.
   */
  async measure(input: {
    html: string;
    widths: readonly number[];
    urlFragment: string;
    signal?: AbortSignal;
  }): Promise<Array<[number, number]> | undefined> {
    if (!this.available()) return undefined;
    try {
      const heights = await this.withBrowser(
        input.signal,
        {
          timeoutMs: this.opts.measureTimeoutMs ?? MEASURE_TIMEOUT_MS,
          queueTimeoutMs: this.opts.queueTimeoutMs ?? MEASURE_QUEUE_TIMEOUT_MS
        },
        input.html,
        async (browser, html) => {
          const queue = [...input.widths];
          const measured: Array<[number, number]> = [];
          const worker = async (): Promise<void> => {
            for (let width = queue.shift(); width !== undefined; width = queue.shift()) {
              const page = await openPage(browser, width, html);
              try {
                measured.push([width, await load(page, input.urlFragment)]);
              } finally {
                await page.close().catch(() => undefined);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, worker));
          return measured;
        }
      );
      return heights.sort(([left], [right]) => left - right);
    } catch (error) {
      this.opts.log?.("[html-preview] could not measure a page; publishing it without heights", error);
      return undefined;
    }
  }

  /**
   * Runs `work` against a browser of its own. First a browser slot (at most
   * `queueTimeoutMs` of waiting, else "busy"); then, from the slot's start, a
   * hard deadline of `timeoutMs`. On the deadline or a cancellation the
   * browser — even one still starting — is killed at once and the slot is
   * freed; the profile and the proxy go with it either way.
   */
  private async withBrowser<T>(
    signal: AbortSignal | undefined,
    bounds: { timeoutMs: number; queueTimeoutMs: number },
    source: HtmlSource,
    work: (browser: Browser, html: string) => Promise<T>
  ): Promise<T> {
    const executable = this.opts.resolveChromium();
    if (executable === undefined) {
      throw new HtmlPreviewError(
        "browser-unavailable",
        "Orquester has no Chromium-family browser on this machine yet, so it cannot render pages. Ask the user to install Chromium or Google Chrome (or enable one under Settings › Tools), then call again; html_render still works without it."
      );
    }
    if (this.closed) {
      throw new HtmlPreviewError("cancelled", "Orquester is shutting down.");
    }
    const controller = new AbortController();
    let finished!: () => void;
    this.inFlight.set(controller, new Promise<void>((resolve) => (finished = resolve)));
    const stop = (reason: HtmlPreviewError): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onAbort = (): void => stop(new HtmlPreviewError("cancelled", "The preview was cancelled."));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timers: NodeJS.Timeout[] = [];
    const stopped = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    stopped.catch(() => undefined);
    let browser: Browser | undefined;
    let profile: string | undefined;
    let proxy: Awaited<ReturnType<typeof startPublicProxy>> | undefined;
    let release: (() => void) | undefined;
    const run = (async (): Promise<T> => {
      timers.push(setTimeout(() => stop(new HtmlPreviewError("busy", PREVIEWS_BUSY_MESSAGE)), bounds.queueTimeoutMs));
      release = await this.gate.enter(controller.signal);
      clearTimeout(timers.pop());
      // The deadline runs from the slot's start, not from the queue.
      timers.push(
        setTimeout(
          () =>
            stop(
              new HtmlPreviewError(
                "timeout",
                `The page did not finish loading within ${Math.round(bounds.timeoutMs / 1000)} seconds.`
              )
            ),
          bounds.timeoutMs
        )
      );
      let html: string;
      try {
        html = typeof source === "string" ? source : await source();
      } catch (error) {
        throw new SourceFailure(error);
      }
      controller.signal.throwIfAborted();
      proxy = await startPublicProxy(this.opts.proxy);
      profile = await mkdtemp(join(this.opts.tmpDir ?? tmpdir(), PREVIEW_PROFILE_PREFIX));
      controller.signal.throwIfAborted();
      browser = await this.launch(executable, profile, proxy.port, controller.signal, bounds.timeoutMs);
      // Killed at once if the deadline passed while it was starting.
      if (controller.signal.aborted) killBrowser(browser);
      return await work(browser, html);
    })();
    run.catch(() => undefined);
    let done = false;
    try {
      const result = await Promise.race([run, stopped]);
      done = true;
      return result;
    } catch (error) {
      if (error instanceof SourceFailure) throw error.cause;
      if (error instanceof HtmlPreviewError) throw error;
      this.opts.log?.("[html-preview] the browser failed", error);
      throw new HtmlPreviewError("browser-failed", "Headless Chromium could not render the page.");
    } finally {
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!done) {
        // Stop whatever still runs: a launch in progress is killed by
        // puppeteer on this abort (its `signal`), a launched browser here.
        stop(new HtmlPreviewError("cancelled", "The preview was cancelled."));
        if (browser) killBrowser(browser);
      }
      // Wait for the work to settle, so nothing below races it: a killed
      // browser fails it promptly.
      await run.catch(() => undefined);
      if (browser) await closeBrowser(browser);
      await proxy?.close();
      if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      release?.();
      this.inFlight.delete(controller);
      finished();
    }
  }

  /** Launches with the sandbox, and once more without it where it cannot start (as `../browsers.ts`). */
  private async launch(
    executable: string,
    profile: string,
    proxyPort: number,
    signal: AbortSignal,
    launchTimeoutMs: number
  ): Promise<Browser> {
    const attempt = async (sandboxed: boolean): Promise<Browser> => {
      const browser = await puppeteer.launch({
        executablePath: executable,
        userDataDir: profile,
        // The deadline or a cancellation kills the launching process at once.
        timeout: launchTimeoutMs,
        signal,
        headless: true,
        pipe: true,
        defaultViewport: null,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        downloadBehavior: { policy: "deny" },
        args: [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--block-new-web-contents",
          `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
          // Loopback would otherwise skip the proxy.
          "--proxy-bypass-list=<-loopback>",
          // WebRTC would otherwise send UDP, which no proxy carries.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          // QUIC is UDP, which no SOCKS proxy here carries: TCP only, as every
          // other connection (S-M3 hardening; HTTP/3 falls back to HTTP/2).
          "--disable-quic",
          ...(sandboxed ? [] : ["--no-sandbox"])
        ]
      });
      if (signal.aborted) return browser;
      try {
        // A present-but-broken sandbox lets the pipe connect, then aborts the
        // first renderer: start one now so that fails here.
        const probe = await browser.newPage();
        await probe.close();
        return browser;
      } catch (error) {
        killBrowser(browser);
        throw error;
      }
    };
    if (!this.sandboxWorks) return attempt(false);
    try {
      return await attempt(true);
    } catch (error) {
      if (signal.aborted || !isRetryableSandboxFailure(error)) throw error;
      this.sandboxWorks = false;
      this.opts.log?.("[html-preview] Chromium's sandbox is unavailable here; previews run without it", error);
      return attempt(false);
    }
  }
}

/** Closes politely, and kills what has not gone after a short grace. */
async function closeBrowser(browser: Browser): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    browser.close().catch(() => killBrowser(browser)),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        killBrowser(browser);
        resolve();
      }, CLOSE_GRACE_MS);
    })
  ]);
  clearTimeout(timer);
}

/** A page at `width` that serves `html` at {@link PAGE_URL} and nothing else of its own. */
async function openPage(browser: Browser, width: number, html: string, log?: ConsoleLog): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(NO_WEBRTC);
  await page.setRequestInterception(true);
  page.on("request", (request) => void route(page, request, html));
  if (log) {
    page.on("console", (message) => {
      const level = CONSOLE_LEVELS[message.type()];
      if (level) log.add(level, consoleText(message));
    });
    page.on("pageerror", (error) => {
      log.add("error", error instanceof Error ? (error.stack ?? error.message) : String(error));
    });
  }
  return page;
}

/**
 * Serves the page, keeps the main frame on it, refuses anything else of the
 * page's own origin, and lets the rest out — through the public-only proxy.
 */
async function route(page: Page, request: HTTPRequest, html: string): Promise<void> {
  try {
    const url = request.url().split("#", 1)[0]!;
    const mainFrameNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (url === PAGE_URL && mainFrameNavigation) {
      await request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      return;
    }
    // Chromium asks for a favicon on its own; answering it keeps that out of the page's console.
    if (url === `${PAGE_ORIGIN}/favicon.ico` && !request.isNavigationRequest()) {
      await request.respond({ status: 204, body: "" });
      return;
    }
    // "aborted" cancels a navigation outright; any other error would commit
    // Chromium's error page in place of the page.
    if (mainFrameNavigation) {
      await request.abort("aborted");
      return;
    }
    if (url.startsWith(`${PAGE_ORIGIN}/`)) {
      await request.abort("accessdenied");
      return;
    }
    await request.continue();
  } catch {
    // The page or browser went away mid-request.
  }
}

/**
 * The top `height` pixels at `width`, as PNG when that fits
 * {@link MAX_SCREENSHOT_BASE64_CHARS}, else as JPEG, scaled down by halves
 * until it does.
 */
async function screenshotWithinCap(page: Page, width: number, height: number): Promise<HtmlScreenshot> {
  const shoot = (type: "png" | "jpeg", scale: number) =>
    page.screenshot({
      type,
      encoding: "base64",
      captureBeyondViewport: true,
      ...(type === "jpeg" ? { quality: 80 } : {}),
      clip: { x: 0, y: 0, width, height, scale }
    });
  const png = await shoot("png", 1);
  if (png.length <= MAX_SCREENSHOT_BASE64_CHARS) return { data: png, mimeType: "image/png", width, height };
  for (let scale = 1; scale >= 1 / 16; scale /= 2) {
    const jpeg = await shoot("jpeg", scale);
    if (jpeg.length <= MAX_SCREENSHOT_BASE64_CHARS || scale <= 1 / 16) {
      return {
        data: jpeg,
        mimeType: "image/jpeg",
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
      };
    }
  }
  throw new Error("unreachable");
}

/** Navigates to the page with `urlFragment` (its theme) and answers its settled content height. */
async function load(page: Page, urlFragment: string): Promise<number> {
  // The caller's deadline bounds every step; puppeteer's own timeouts stay off.
  await page.goto(`${PAGE_URL}${urlFragment}`, { waitUntil: "load", timeout: 0 });
  await page.evaluate(SETTLE_EXPRESSION);
  const height = await page.evaluate(MEASURE_EXPRESSION);
  return Math.max(0, Math.ceil(typeof height === "number" && Number.isFinite(height) ? height : 0));
}
