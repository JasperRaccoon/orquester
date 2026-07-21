import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import {
  type BrowserPickPayload,
  type BrowserStateMessage,
  type BrowserStatus,
  type BrowserSummary,
  type BrowserViewportMode
} from "@orquester/api";
import { type BrowserRecord, createDefaultBrowsersFile, parseBrowsersFile } from "@orquester/config";
import {
  PICKER_SCRIPT,
  SCREENSHOT_MAX_BYTES,
  armPickerExpression,
  clampBrowserPickPayload
} from "./browser-pick.js";

export class BrowserError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

// A Chromium launch failure that a `--no-sandbox` retry can plausibly recover:
// either an explicit sandbox error, or an immediate post-connect crash (the
// setuid sandbox aborting the zygote surfaces as "Target closed" / "Protocol
// error" / "Connection closed"). The retry is bounded (one attempt) and flags
// the browser as unsandboxed, so a false match at worst costs one extra launch.
function isRetryableSandboxFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /sandbox|target closed|protocol error|connection closed/i.test(msg);
}

export interface BrowserSink {
  onFrame(jpeg: Buffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}

const VIEWPORTS: Record<BrowserViewportMode, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
};

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

interface Tab {
  record: BrowserRecord;
  status: BrowserStatus;
  sandboxed: boolean;
  errorMessage?: string;
  page: Page | null;
  cdp: CDPSession | null;
  sinks: Set<BrowserSink>;
  streaming: boolean;
  picking: boolean;
  loading: boolean;
}

interface Chrome {
  browser: Browser;
  sandboxed: boolean;
}

export class BrowserManager {
  readonly lifecycle = new EventEmitter();
  private readonly tabs = new Map<string, Tab>();
  private readonly chromes = new Map<string, Promise<Chrome>>();
  // Serialize on-disk writes: concurrent persist() calls (framenavigated + load
  // fire close together) would otherwise race the same tmp file and corrupt it.
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      indexFile: string;
      profilesDir: string;
      resolveChromium: () => string | undefined;
    }
  ) {}

  async load(): Promise<void> {
    let file = createDefaultBrowsersFile();
    try {
      file = parseBrowsersFile(JSON.parse(await readFile(this.opts.indexFile, "utf8")));
    } catch {
      /* first boot or unreadable — start empty; a corrupt file must not block boot */
    }
    for (const record of file.browsers) {
      this.tabs.set(record.id, {
        record, status: "stopped", sandboxed: true, page: null, cdp: null,
        sinks: new Set(), streaming: false, picking: false, loading: false
      });
    }
  }

  list(projectPath?: string): BrowserSummary[] {
    return [...this.tabs.values()]
      .filter((t) => !projectPath || t.record.projectPath === projectPath)
      .sort((a, b) => a.record.order - b.record.order || a.record.createdAt.localeCompare(b.record.createdAt))
      .map((t) => this.summary(t));
  }

  get(id: string): BrowserSummary | undefined {
    const tab = this.tabs.get(id);
    return tab ? this.summary(tab) : undefined;
  }

  async create(projectPath: string, url = "about:blank"): Promise<BrowserSummary> {
    if (!this.opts.resolveChromium()) {
      throw new BrowserError("No chromium/chrome binary found on the daemon host", 409);
    }
    const orders = this.list(projectPath).map((b) => b.order);
    const record: BrowserRecord = {
      id: randomUUID(), projectPath, url, title: "",
      viewportMode: "desktop", order: (orders.length ? Math.max(...orders) : 0) + 1,
      createdAt: new Date().toISOString()
    };
    const tab: Tab = {
      record, status: "stopped", sandboxed: true, page: null, cdp: null,
      sinks: new Set(), streaming: false, picking: false, loading: false
    };
    this.tabs.set(record.id, tab);
    await this.persist();
    this.lifecycle.emit("created", this.summary(tab));
    return this.summary(tab);
  }

  async close(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    for (const sink of tab.sinks) sink.onEnd();
    tab.sinks.clear();
    await tab.page?.close().catch(() => undefined);
    // Last tab of the project → kill its Chromium (the "no open browser tab →
    // no Chromium running" rule from the spec).
    const project = tab.record.projectPath;
    if (![...this.tabs.values()].some((t) => t.record.projectPath === project)) {
      const pending = this.chromes.get(project);
      this.chromes.delete(project);
      if (pending) (await pending.catch(() => null))?.browser.close().catch(() => undefined);
    }
    await this.persist();
    this.lifecycle.emit("closed", { id });
  }

  async closeForProject(projectPath: string): Promise<void> {
    for (const tab of [...this.tabs.values()]) {
      if (tab.record.projectPath === projectPath) await this.close(tab.record.id);
    }
  }

  async subscribe(id: string, sink: BrowserSink): Promise<() => void> {
    const tab = this.mustGet(id);
    tab.sinks.add(sink);
    try {
      await this.ensurePage(tab);
      await this.startScreencast(tab);
      sink.onState(this.state(tab));
      // Prime the canvas immediately — screencast only emits on change.
      const shot = await tab.cdp!.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
      sink.onFrame(Buffer.from(shot.data, "base64"));
    } catch (error) {
      tab.status = "error";
      tab.errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error);
      this.emitUpdated(tab);
      sink.onState(this.state(tab));
    }
    return () => {
      tab.sinks.delete(sink);
      if (tab.sinks.size === 0) void this.stopScreencast(tab);
    };
  }

  async navigate(id: string, action: "goto" | "back" | "forward" | "reload", url?: string): Promise<void> {
    const tab = this.mustGet(id);
    await this.ensurePage(tab);
    const page = tab.page!;
    try {
      if (action === "goto" && url) {
        const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (action === "reload") await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      /* navigation errors render Chromium's own error page — streamed like anything */
    }
    await this.syncRecord(tab);
  }

  async setViewport(id: string, mode: BrowserViewportMode): Promise<void> {
    const tab = this.mustGet(id);
    tab.record.viewportMode = mode;
    if (tab.cdp) await this.applyViewport(tab);
    await this.persist();
    this.emitUpdated(tab);
    this.pushState(tab);
  }

  async setPick(id: string, on: boolean): Promise<void> {
    const tab = this.mustGet(id);
    await this.ensurePage(tab);
    tab.picking = on;
    await tab.cdp!.send("Runtime.evaluate", { expression: on ? PICKER_SCRIPT : "0" });
    await tab.cdp!.send("Runtime.evaluate", { expression: armPickerExpression(on) });
  }

  dispatchPointer(id: string, kind: "move" | "down" | "up", x: number, y: number,
    button: "none" | "left" | "middle" | "right", modifiers: number, clickCount: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "move" ? "mouseMoved" : kind === "down" ? "mousePressed" : "mouseReleased";
    void cdp.send("Input.dispatchMouseEvent", { type, x, y, button, modifiers, clickCount }).catch(() => undefined);
  }

  dispatchWheel(id: string, x: number, y: number, dx: number, dy: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    void cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, button: "none", deltaX: dx, deltaY: dy
    }).catch(() => undefined);
  }

  dispatchKey(id: string, kind: "down" | "up" | "char", key: string, code: string,
    text: string | undefined, modifiers: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "down" ? "keyDown" : kind === "up" ? "keyUp" : "char";
    void cdp.send("Input.dispatchKeyEvent", { type, key, code, text, modifiers }).catch(() => undefined);
  }

  dispatchTouch(id: string, kind: "start" | "move" | "end", points: Array<{ x: number; y: number }>): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "start" ? "touchStart" : kind === "move" ? "touchMove" : "touchEnd";
    void cdp.send("Input.dispatchTouchEvent", {
      type, touchPoints: kind === "end" ? [] : points.map((p) => ({ x: p.x, y: p.y }))
    }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const tab of this.tabs.values()) {
      for (const sink of tab.sinks) sink.onEnd();
      tab.sinks.clear();
    }
    for (const pending of this.chromes.values()) {
      (await pending.catch(() => null))?.browser.close().catch(() => undefined);
    }
    this.chromes.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private mustGet(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserError("Unknown browser tab", 404);
    return tab;
  }

  private summary(tab: Tab): BrowserSummary {
    return {
      ...tab.record,
      status: tab.status,
      sandboxed: tab.sandboxed,
      ...(tab.errorMessage ? { errorMessage: tab.errorMessage } : {})
    };
  }

  private state(tab: Tab): BrowserStateMessage {
    return {
      t: "state", id: tab.record.id, url: tab.record.url, title: tab.record.title,
      loading: tab.loading, canGoBack: false, canGoForward: false,
      viewportMode: tab.record.viewportMode, status: tab.status, sandboxed: tab.sandboxed
    };
  }

  private pushState(tab: Tab): void {
    const state = this.state(tab);
    for (const sink of tab.sinks) sink.onState(state);
  }

  private emitUpdated(tab: Tab): void {
    this.lifecycle.emit("updated", this.summary(tab));
  }

  private chromeFor(projectPath: string): Promise<Chrome> {
    let pending = this.chromes.get(projectPath);
    if (!pending) {
      pending = this.launch(projectPath);
      this.chromes.set(projectPath, pending);
      pending.catch(() => this.chromes.delete(projectPath));
    }
    return pending;
  }

  private async launch(projectPath: string): Promise<Chrome> {
    const executablePath = this.opts.resolveChromium();
    if (!executablePath) throw new BrowserError("No chromium/chrome binary found on the daemon host", 409);
    const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
    const userDataDir = join(this.opts.profilesDir, hash);
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    const base = {
      executablePath, userDataDir, pipe: true, headless: true as const,
      defaultViewport: null,
      args: ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--mute-audio"]
    };
    try {
      return { browser: await this.tryLaunch(base), sandboxed: true };
    } catch (error) {
      // Sandbox unavailable (no userns / setuid helper) is the one retryable
      // launch failure — retry unsandboxed and FLAG it; never silently. It can
      // surface two ways: puppeteer.launch() throws with a "sandbox" message, or
      // (on hosts where the setuid sandbox aborts *after* the pipe connects) the
      // browser connects and then crashes when the first renderer target starts,
      // reported as "Target closed" / "Protocol error". Probing in tryLaunch()
      // turns the latter into a throw here so both take the unsandboxed path.
      if (!isRetryableSandboxFailure(error)) throw error;
      const browser = await this.tryLaunch({ ...base, args: [...base.args, "--no-sandbox"] });
      return { browser, sandboxed: false };
    }
  }

  // Launch Chromium and force a renderer target to start, so a present-but-broken
  // sandbox (which lets the browser pipe connect, then aborts the zygote) fails
  // here instead of silently later in ensurePage(). On failure the browser is
  // torn down so no orphan process leaks before the caller's retry.
  private async tryLaunch(options: Parameters<typeof puppeteer.launch>[0]): Promise<Browser> {
    const browser = await puppeteer.launch(options);
    try {
      const probe = await browser.newPage();
      await probe.close();
      return browser;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensurePage(tab: Tab): Promise<void> {
    if (tab.page && !tab.page.isClosed()) return;
    tab.status = "starting";
    this.emitUpdated(tab);
    const chrome = await this.chromeFor(tab.record.projectPath);
    tab.sandboxed = chrome.sandboxed;
    const page = await chrome.browser.newPage();
    tab.page = page;
    tab.cdp = await page.createCDPSession();
    tab.streaming = false;
    await this.applyViewport(tab);
    await tab.cdp.send("Runtime.enable");
    await tab.cdp.send("Runtime.addBinding", { name: "__orquesterPick" });
    tab.cdp.on("Runtime.bindingCalled", (event) => {
      if (event.name === "__orquesterPick") void this.onPickReport(tab, event.payload);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.syncRecord(tab).catch(() => undefined);
    });
    page.on("load", () => { tab.loading = false; void this.syncRecord(tab).catch(() => undefined); });
    page.on("close", () => {
      if (this.tabs.get(tab.record.id) !== tab) return; // our own close()
      tab.page = null; tab.cdp = null; tab.streaming = false;
      tab.status = "crashed";
      this.emitUpdated(tab);
      this.pushState(tab);
    });
    tab.status = "running";
    tab.errorMessage = undefined;
    if (tab.record.url && tab.record.url !== "about:blank") {
      tab.loading = true;
      void page.goto(tab.record.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => undefined)
        .finally(() => { tab.loading = false; void this.syncRecord(tab).catch(() => undefined); });
    }
    this.emitUpdated(tab);
  }

  private async applyViewport(tab: Tab): Promise<void> {
    const vp = VIEWPORTS[tab.record.viewportMode];
    await tab.cdp!.send("Emulation.setDeviceMetricsOverride", vp);
    await tab.cdp!.send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
    await tab.cdp!.send("Emulation.setUserAgentOverride", vp.mobile ? { userAgent: MOBILE_UA } : { userAgent: "" });
  }

  private async startScreencast(tab: Tab): Promise<void> {
    if (tab.streaming || !tab.cdp) return;
    tab.streaming = true;
    const vp = VIEWPORTS[tab.record.viewportMode];
    tab.cdp.on("Page.screencastFrame", (frame) => {
      // ALWAYS ack (CDP stalls otherwise); per-socket send-skips happen in the
      // ws handler via bufferedAmount, not here.
      void tab.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      const jpeg = Buffer.from(frame.data, "base64");
      for (const sink of tab.sinks) sink.onFrame(jpeg);
    });
    await tab.cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1
    });
  }

  private async stopScreencast(tab: Tab): Promise<void> {
    if (!tab.streaming || !tab.cdp) return;
    tab.streaming = false;
    await tab.cdp.send("Page.stopScreencast").catch(() => undefined);
    tab.cdp.removeAllListeners("Page.screencastFrame");
  }

  private async onPickReport(tab: Tab, raw: string): Promise<void> {
    // Ignore unsolicited/forged binding calls: a hostile page can invoke
    // window.__orquesterPick(...) at any time, but only an armed pick is real.
    if (!tab.picking) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = clampBrowserPickPayload(parsed);
    if (!payload) return;
    payload.page.viewportMode = tab.record.viewportMode;
    tab.picking = false;
    try {
      const r = payload.target.rectViewport;
      if (r.width > 0 && r.height > 0 && tab.cdp) {
        // Clamp the clip to the emulated viewport so a fabricated 1e9-px rect
        // can't drive captureScreenshot into a renderer OOM.
        const vp = VIEWPORTS[tab.record.viewportMode];
        const x = Math.min(Math.max(0, r.x - 8), vp.width);
        const y = Math.min(Math.max(0, r.y - 8), vp.height);
        const width = Math.min(r.width + 16, vp.width - x);
        const height = Math.min(r.height + 16, vp.height - y);
        if (width > 0 && height > 0) {
          const shot = await tab.cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { x, y, width, height, scale: 1 }
          });
          if (Buffer.byteLength(shot.data, "base64") <= SCREENSHOT_MAX_BYTES) {
            payload.screenshotBase64 = shot.data;
          }
        }
      }
    } catch {
      /* screenshot is best-effort; the payload ships without it */
    }
    for (const sink of tab.sinks) sink.onPicked(payload);
  }

  private async syncRecord(tab: Tab): Promise<void> {
    if (!tab.page || tab.page.isClosed()) return;
    const url = tab.page.url();
    const title = await tab.page.title().catch(() => tab.record.title);
    if (url !== tab.record.url || title !== tab.record.title) {
      tab.record.url = url;
      tab.record.title = title;
      await this.persist();
      this.emitUpdated(tab);
    }
    // canGoBack/Forward need real history state; fetch per push.
    const state = this.state(tab);
    if (tab.cdp) {
      try {
        const h = await tab.cdp.send("Page.getNavigationHistory");
        state.canGoBack = h.currentIndex > 0;
        state.canGoForward = h.currentIndex < h.entries.length - 1;
      } catch { /* page gone */ }
    }
    for (const sink of tab.sinks) sink.onState(state);
  }

  private persist(): Promise<void> {
    // Chain every write so only one is in flight; a unique tmp name per write
    // means even a bug in the chain can't make two writers share a tmp file.
    const next = this.persistChain.then(
      () => this.writeIndex(),
      () => this.writeIndex()
    );
    this.persistChain = next.catch(() => undefined);
    return next;
  }

  private async writeIndex(): Promise<void> {
    const file = {
      version: 1 as const,
      browsers: [...this.tabs.values()].map((t) => t.record)
    };
    const tmp = `${this.opts.indexFile}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.opts.indexFile), { recursive: true });
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await rename(tmp, this.opts.indexFile);
  }
}
