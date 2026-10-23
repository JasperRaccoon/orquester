import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  screen,
  shell,
  Tray,
  type IpcMainEvent
} from "electron";
import { startDaemon as startOrquesterDaemon, type RunningDaemon } from "@orquester/daemon";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import {
  navigationAction,
  remoteBaseOf,
  visualTarget,
  windowOpenAction,
  VISUAL_SCHEME,
  type NavigationAction
} from "./navigation";
import { applicationMenuTemplate, contextMenuTemplate } from "./menus";
import {
  badgeDescription,
  badgeOverlayBitmap,
  parseBadgeCount,
  parseNotificationRequest,
  type NotificationTarget
} from "./native-notifications";
import {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_SIZE,
  NO_NATIVE_CONTROLS_ARGUMENT,
  frameKey,
  hasNativeWindowControls,
  parseWindowState,
  resolveInitialWindowBounds,
  sameWindowState,
  windowFrameOptions,
  type WindowState
} from "./window-state";

/**
 * A bridged request body: JSON as a string, or an upload's raw bytes as the
 * ArrayBuffer the renderer cloned over IPC (Electron may deliver it as a
 * Uint8Array on the main side — both are accepted).
 */
type BridgeBody = string | ArrayBuffer | Uint8Array;

interface DaemonRequest {
  method?: string;
  path?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: BridgeBody;
  // Present when the renderer wants the request to be cancellable (see unaryRequests).
  requestId?: string;
}

interface DaemonResponse {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// --- Agent visuals: the page scheme (spec 2026-10-14 §2.2) ---
//
// An agent-published page renders in a sandboxed iframe from a short-lived
// signed URL. The renderer is a file:// document talking to the daemon over
// its unix socket (or, for a remote, through this process), so an http URL
// for the frame may not be reachable at all — and a remote's Caddy would
// refuse a file:// parent anyway (`frame-ancestors 'self'`). The frame loads
// `orq-visual://local/api/agent-visuals/…` (the local daemon) or
// `orq-visual://remote/<base64url endpoint>/api/agent-visuals/…` (a remote this
// process already talks to, `navigation.ts`) instead, and this process fetches the page and
// answers it with the same sandbox CSP the daemon sends: the page gets an
// opaque origin, and the preload bridge never runs in a subframe. The URL
// layout is `packages/ui/src/lib/agent-chat/visual-frame.ts`'s.
const VISUAL_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer"
} as const;

// Before `ready`: a privileged standard scheme resolves relative URLs and
// counts as a secure context, like the https a web client frames from.
protocol.registerSchemesAsPrivileged([
  { scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true, stream: true } }
]);

/**
 * Bases (origin plus configured sub-path, `remoteBaseOf`) of the remote
 * daemons the renderer reached through this process — the only remotes a
 * page URL or a download may name, so a page cannot turn the scheme into a
 * fetch of an arbitrary host or path.
 */
const remoteBases = new Set<string>();

function rememberRemoteBase(url: string): void {
  const base = remoteBaseOf(url);
  if (base !== null) remoteBases.add(base);
}

function visualRefusal(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...VISUAL_PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
  });
}

function registerVisualProtocol(): void {
  protocol.handle(VISUAL_SCHEME, async (request) => {
    if (request.method !== "GET") return visualRefusal(405, "Not allowed.");
    const target = visualTarget(request.url, remoteBases);
    if (target === null) return visualRefusal(404, "Not found.");
    try {
      const response =
        target.kind === "local"
          ? await requestBytesOverSocket({ method: "GET", path: target.path })
          : await requestBytesOverHttp({ url: target.url, method: "GET" });
      if (!response.ok) {
        return visualRefusal(response.status || 502, Buffer.from(response.body).toString("utf8").slice(0, 500));
      }
      // The daemon's own headers are not passed on: this process answers with
      // the sandbox it knows, never a remote's framing rules.
      return new Response(response.body, { status: 200, headers: VISUAL_PAGE_HEADERS });
    } catch {
      return visualRefusal(502, "Orquester could not reach the daemon for this page.");
    }
  });
}

let daemon: RunningDaemon | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let daemonSocketPath: string | undefined;
let isDaemonOwner = false;
let quitting = false;
/** Startup reached window creation: from here a second launch may open a window. */
let windowsReady = false;

// One Orquester per user: a second launch focuses the running window instead
// of starting another shell that would race this one for the daemon. A dev
// appdir (ORQUESTER_APPDIR) takes no lock, so a staging instance can run
// beside the installed app or another checkout.
const hasInstanceLock = process.env.ORQUESTER_APPDIR ? true : app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (windowsReady) showWindow();
  });
}

function checkExistingDaemon(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "win32" && !fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const req = http.request(
      { socketPath, path: "/api/config/daemon", method: "GET" },
      (res) => {
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

function listenForDaemonShutdown(): void {
  if (!daemonSocketPath) return;
  const req = http.request({ socketPath: daemonSocketPath, path: "/events", method: "GET" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (chunk.includes('"daemon.shutdown"')) {
        quitting = true;
        app.quit();
      }
    });
    res.on("end", () => {
      if (!quitting && !isDaemonOwner) app.quit();
    });
  });
  req.on("error", () => {
    if (!quitting && !isDaemonOwner) app.quit();
  });
  req.end();
}

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");

// Base config dir: ORQUESTER_APPDIR (relative paths resolved against the repo
// root so `.stage` is stable regardless of Electron's cwd), else ~/.orquester.
function baseDir(): string {
  const appdir = process.env.ORQUESTER_APPDIR;
  if (appdir && appdir.length > 0) {
    return path.isAbsolute(appdir) ? appdir : path.resolve(repoRoot, appdir);
  }
  return path.join(app.getPath("home"), ".orquester");
}

const appDir = () => path.join(baseDir(), "app");
const daemonDir = () => path.join(baseDir(), "daemon");

function socketPathFor(): string {
  return process.platform === "win32" ? "\\\\.\\pipe\\orquester-daemon" : path.join(daemonDir(), "daemon.sock");
}

function dailyLogFile(logsDir: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return path.join(logsDir, `${stamp}.log`);
}

/** Read app.json (best effort) for desktop-side flags like runInBackground. */
function readAppConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir(), "app.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
const runInBackground = () => readAppConfig().runInBackground === true;
// "Custom titlebar" (Settings → General); the schema's default is on.
const useTitlebar = () => readAppConfig().useTitlebar !== false;

// --- Window background (follows the renderer's colour scheme) ---
//
// A BrowserWindow's native backgroundColor is fixed in THIS process, before any
// renderer code runs (public/theme-boot.js included), so the only way the window
// can launch in the user's colour scheme is for the renderer to have persisted
// the resolved colour on a previous paint. Sole owner of window-theme.json is
// the main process — app.json is deliberately not extended for this: the daemon
// read-modify-writes it (PUT /api/config/app) and it is daemon-shared config,
// while this is a device-local bit of window chrome.

interface WindowTheme {
  /** `#rrggbb` — the scheme's base surface (`--n-950`, what the app paints). */
  background: string;
  /** Which palette the colour came from. Informational: it makes the file
   *  self-describing and lets native chrome couple to it later without
   *  re-deriving the mode from the colour. */
  resolvedMode: "light" | "dark";
}

// The stock dark scheme's `--n-950`. (Was #111111, which matched no palette:
// the app root paints bg-neutral-950 = #0a0a0a in the default scheme.)
const DEFAULT_WINDOW_THEME: WindowTheme = { background: "#0a0a0a", resolvedMode: "dark" };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const windowThemePath = () => path.join(appDir(), "window-theme.json");

/** Read the persisted window background. Field-validated: a blob written by an
 *  older/newer bundle must degrade to the stock look, never reach setBackgroundColor. */
function readWindowTheme(): WindowTheme {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(windowThemePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_WINDOW_THEME;
    }
    const record = parsed as Record<string, unknown>;
    return {
      background:
        typeof record.background === "string" && HEX_COLOR.test(record.background)
          ? record.background.toLowerCase()
          : DEFAULT_WINDOW_THEME.background,
      resolvedMode:
        record.resolvedMode === "light" || record.resolvedMode === "dark"
          ? record.resolvedMode
          : DEFAULT_WINDOW_THEME.resolvedMode
    };
  } catch {
    return DEFAULT_WINDOW_THEME;
  }
}

/** Renderer -> main (preload `setWindowBackground`). The payload crosses the
 *  context bridge, so it is untrusted: validate before persisting or painting. */
function applyWindowBackground(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.background !== "string" || !HEX_COLOR.test(record.background)) {
    return;
  }
  // A mode we don't recognise means the sender is not the shape we expect, so
  // reject the whole payload rather than persisting a colour under a guessed
  // "dark" — a light hex filed as dark would mislead any later native-chrome
  // coupling that trusts this field.
  if (record.resolvedMode !== "light" && record.resolvedMode !== "dark") {
    return;
  }
  const next: WindowTheme = {
    background: record.background.toLowerCase(),
    resolvedMode: record.resolvedMode
  };

  const current = readWindowTheme();
  if (current.background !== next.background || current.resolvedMode !== next.resolvedMode) {
    try {
      fs.mkdirSync(appDir(), { recursive: true });
      fs.writeFileSync(windowThemePath(), `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      console.error("Failed to persist window theme", error);
    }
  }

  // Also repaint the live window(s): the native colour shows through during a
  // resize and around a frameless window's corners, so a mid-session scheme
  // switch would otherwise leave the old one behind until the next launch.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.setBackgroundColor(next.background);
    }
  }
}

// --- Window geometry (window-state.json) ---
//
// Device-local like window-theme.json and owned by this process; the pure
// rules (validation, display fit) are `window-state.ts`'s.

const windowStatePath = () => path.join(appDir(), "window-state.json");

function readWindowState(): WindowState {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(windowStatePath(), "utf8")));
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

/** The connected displays' work areas, primary first; empty when the screen module cannot say. */
function displayAreas(): Electron.Rectangle[] {
  try {
    const primary = screen.getPrimaryDisplay();
    return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)].map(
      (display) => display.workArea
    );
  } catch {
    return [];
  }
}

/** Save a window's normal bounds and maximized flag (a maximized window keeps its restore size). */
function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const useNormal = win.isMaximized() || win.isMinimized() || win.isFullScreen();
  const raw = useNormal ? win.getNormalBounds() : win.getBounds();
  const next = parseWindowState({
    bounds: {
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.round(raw.width),
      height: Math.round(raw.height)
    },
    maximized: win.isMaximized()
  });
  if (sameWindowState(next, readWindowState())) return;
  try {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(windowStatePath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.error("Failed to persist window state", error);
  }
}

const WINDOW_STATE_SAVE_DELAY_MS = 500;

/** Save the window's geometry as it moves and resizes (debounced), and once more as it closes. */
function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(win), WINDOW_STATE_SAVE_DELAY_MS);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", () => {
    clearTimeout(timer);
    saveWindowState(win);
  });
  win.on("closed", () => clearTimeout(timer));
}

function ensureAppFiles(): void {
  const dir = appDir();
  const logsDir = path.join(dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const appConfigPath = path.join(dir, "app.json");
  if (!fs.existsSync(appConfigPath)) {
    const defaults = { version: 1, activeConnectionId: "local", useTitlebar: true, runInBackground: false };
    fs.writeFileSync(appConfigPath, `${JSON.stringify(defaults, null, 2)}\n`);
  }
  const remotesPath = path.join(dir, "remotes.json");
  if (!fs.existsSync(remotesPath)) {
    // Seed the VPS as a selectable remote (kept alongside the bundled local
    // daemon). The URL is build/env-provided so we never bake a placeholder in.
    const remoteUrl = process.env.ORQUESTER_REMOTE_URL;
    const remotes = remoteUrl
      ? [{ id: "vps", name: "Orquester VPS", kind: "remote", baseUrl: remoteUrl }]
      : [];
    fs.writeFileSync(remotesPath, `${JSON.stringify({ version: 1, remotes }, null, 2)}\n`);
  }
  fs.appendFileSync(dailyLogFile(logsDir), `${new Date().toISOString()} app: started\n`);
}

async function startIntegratedDaemon(): Promise<void> {
  const socketPath = socketPathFor();
  const webDir = path.join(repoRoot, "apps", "web", "dist");
  const env = {
    ...process.env,
    ORQUESTER_UNIX_SOCKET: socketPath,
    ORQUESTER_WEB_DIR: webDir,
    ...(process.env.ORQUESTER_HTTP_ENABLED ? {} : { ORQUESTER_HTTP_ENABLED: "false" })
  };

  daemon = await startOrquesterDaemon({
    cwd: repoRoot,
    env,
    appdir: process.env.ORQUESTER_APPDIR ? baseDir() : undefined,
    webDir
  });

  process.env.ORQUESTER_UNIX_SOCKET = daemon.socketPath;
  daemonSocketPath = daemon.socketPath;
}

async function stopIntegratedDaemon(): Promise<void> {
  if (!daemon) {
    return;
  }
  const current = daemon;
  daemon = undefined;
  await current.stop().catch((error) => {
    console.error("Failed to stop Orquester daemon", error);
  });
}

// In-flight cancellable unary requests, keyed by the renderer-supplied requestId.
// Mirrors `streams` for the stream-close channel: abortUnaryRequest destroys the
// ClientRequest (which drops the daemon connection so its reply.raw "close" abort
// fires). senderId gates aborts to the window that owns the request.
const unaryRequests = new Map<string, { req: http.ClientRequest; senderId: number }>();

/** Register a cancellable request; no-op unless the renderer supplied a requestId. */
function trackUnaryRequest(req: http.ClientRequest, requestId: string | undefined, senderId: number | undefined): void {
  if (requestId === undefined || senderId === undefined) return;
  unaryRequests.set(requestId, { req, senderId });
  const cleanup = () => unaryRequests.delete(requestId);
  req.on("close", cleanup);
  req.on("error", cleanup);
}

/** Destroy an in-flight request on renderer abort, but only for its owning window. */
function abortUnaryRequest(event: IpcMainEvent, requestId: string): void {
  const entry = unaryRequests.get(requestId);
  if (entry && entry.senderId === event.sender.id) {
    entry.req.destroy();
    unaryRequests.delete(requestId);
  }
}

/** Wire form of a bridged body — a binary body is wrapped without copying. */
function bodyToWire(body: BridgeBody): string | Buffer {
  if (typeof body === "string") return body;
  return ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body);
}

/**
 * A binary body is sent with an explicit Content-Length (JSON keeps chunked
 * encoding as before): the daemon refuses an over-cap upload from the header
 * alone, before reading a single byte of it.
 */
function headersForBody(headers: http.OutgoingHttpHeaders | undefined, body: BridgeBody | undefined): http.OutgoingHttpHeaders {
  const base = headers || {};
  if (body === undefined || typeof body === "string") return base;
  return { ...base, "content-length": String(body.byteLength) };
}

/** Write a bridged body (if any) and finish the request. */
function endWithBody(req: http.ClientRequest, body: BridgeBody | undefined): void {
  if (body !== undefined) {
    const wire = bodyToWire(body);
    if (wire.length > 0) req.write(wire);
  }
  req.end();
}

/** HTTP request to the daemon over its unix socket (the renderer's transport). */
function requestOverSocket({ method, path: requestPath, headers, body, requestId }: DaemonRequest, senderId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    if (!daemonSocketPath) {
      reject(new Error("Orquester daemon is not running."));
      return;
    }

    const req = http.request(
      { socketPath: daemonSocketPath, path: requestPath || "/", method: method || "GET", headers: headersForBody(headers, body) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    trackUnaryRequest(req, requestId, senderId);
    req.on("error", reject);
    endWithBody(req, body);
  });
}

interface DaemonBytesResponse {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: ArrayBuffer;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Like requestOverSocket but preserves raw bytes (file preview). */
function requestBytesOverSocket({ method, path: requestPath, headers, body, requestId }: DaemonRequest, senderId?: number): Promise<DaemonBytesResponse> {
  return new Promise((resolve, reject) => {
    if (!daemonSocketPath) {
      reject(new Error("Orquester daemon is not running."));
      return;
    }
    const req = http.request(
      { socketPath: daemonSocketPath, path: requestPath || "/", method: method || "GET", headers: headersForBody(headers, body) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: toArrayBuffer(Buffer.concat(chunks)) });
        });
      }
    );
    trackUnaryRequest(req, requestId, senderId);
    req.on("error", reject);
    endWithBody(req, body);
  });
}

// Open streams, with the webContents that opened them: a window that is
// rebuilt (the titlebar setting) or closed takes its streams with it.
const streams = new Map<string, { req: http.ClientRequest; senderId: number }>();

function closeStreamsOf(senderId: number): void {
  for (const [streamId, stream] of streams) {
    if (stream.senderId === senderId) {
      stream.req.destroy();
      streams.delete(streamId);
    }
  }
}

function openStreamOverSocket(event: IpcMainEvent, { streamId, path: streamPath }: { streamId: string; path: string }): void {
  if (!daemonSocketPath) {
    if (!event.sender.isDestroyed()) {
      event.sender.send("orquester:stream:end", { streamId });
    }
    return;
  }

  const req = http.request({ socketPath: daemonSocketPath, path: streamPath, method: "GET" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("orquester:stream:data", { streamId, chunk });
      }
    });
    res.on("end", () => {
      streams.delete(streamId);
      if (!event.sender.isDestroyed()) {
        event.sender.send("orquester:stream:end", { streamId });
      }
    });
  });
  req.on("error", () => {
    streams.delete(streamId);
    if (!event.sender.isDestroyed()) {
      event.sender.send("orquester:stream:end", { streamId });
    }
  });
  req.end();
  streams.set(streamId, { req, senderId: event.sender.id });
}

// --- Remote HTTP transport (desktop → VPS over TCP, in the main process) ---
//
// The renderer is loaded from file:// (or the dev-server origin), so a browser
// `fetch` to a remote daemon (https://…) is cross-origin. The daemon serves no
// CORS headers (it is same-origin only for the web SPA behind Caddy), so those
// browser requests would be blocked. Running the request/stream here in Node
// has no CORS gate, so the desktop's remote REST calls and event stream work.
// The bearer token still authenticates each call (sent as Authorization).

interface RemoteHttpRequest {
  url: string;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: BridgeBody;
  // See DaemonRequest.requestId.
  requestId?: string;
}

function httpModuleFor(target: URL): typeof http | typeof https {
  return target.protocol === "https:" ? https : http;
}

/** One unary request/response round trip to a remote daemon over TCP. */
function requestOverHttp({ url, method, headers, body, requestId }: RemoteHttpRequest, senderId?: number): Promise<DaemonResponse> {
  rememberRemoteBase(url);
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const req = httpModuleFor(target).request(
      target,
      { method: method || "GET", headers: headersForBody(headers, body) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    trackUnaryRequest(req, requestId, senderId);
    req.on("error", reject);
    endWithBody(req, body);
  });
}

/** Like requestOverHttp but preserves raw bytes (file preview over TCP). */
function requestBytesOverHttp({ url, method, headers, body, requestId }: RemoteHttpRequest, senderId?: number): Promise<DaemonBytesResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const req = httpModuleFor(target).request(target, { method: method || "GET", headers: headersForBody(headers, body) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: toArrayBuffer(Buffer.concat(chunks)) });
      });
    });
    trackUnaryRequest(req, requestId, senderId);
    req.on("error", reject);
    endWithBody(req, body);
  });
}

/** Open a chunked GET stream (event bus / session output) to a remote daemon. */
function openHttpStream(
  event: IpcMainEvent,
  { streamId, url, headers }: { streamId: string; url: string; headers?: http.OutgoingHttpHeaders }
): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    if (!event.sender.isDestroyed()) {
      event.sender.send("orquester:http-stream:end", { streamId });
    }
    return;
  }

  const req = httpModuleFor(target).request(target, { method: "GET", headers: headers || {} }, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      // An error answer is not stream content: drop its body and report the status instead.
      res.resume();
      res.on("end", () => {
        streams.delete(streamId);
        if (!event.sender.isDestroyed()) {
          event.sender.send("orquester:http-stream:end", { streamId, status });
        }
      });
      return;
    }
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("orquester:http-stream:data", { streamId, chunk });
      }
    });
    res.on("end", () => {
      streams.delete(streamId);
      if (!event.sender.isDestroyed()) {
        event.sender.send("orquester:http-stream:end", { streamId });
      }
    });
  });
  req.on("error", () => {
    streams.delete(streamId);
    if (!event.sender.isDestroyed()) {
      event.sender.send("orquester:http-stream:end", { streamId });
    }
  });
  req.end();
  streams.set(streamId, { req, senderId: event.sender.id });
}

function closeStream(streamId: string): void {
  const stream = streams.get(streamId);
  if (stream) {
    stream.req.destroy();
    streams.delete(streamId);
  }
}

// --- Notifications, badge and menu actions (the renderer's desktop host) ---

/** Only the main window's own page may drive notifications, the badge and the frame. */
function fromMainWindow(event: IpcMainEvent): boolean {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

/** Send to the main window's page, once it has loaded (a click may have just created the window). */
function sendToRenderer(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (!contents || contents.isDestroyed()) return;
  if (contents.isLoading()) {
    contents.once("did-finish-load", () => {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    });
  } else {
    contents.send(channel, payload);
  }
}

// Shown notifications by tag: a newer one with the same tag replaces the old,
// and holding them keeps their click handlers from being collected.
const notifications = new Map<string, Notification>();

function showNotification(payload: unknown): void {
  const request = parseNotificationRequest(payload);
  if (!request || !Notification.isSupported()) return;
  notifications.get(request.tag)?.close();
  const notification = new Notification({ title: request.title, body: request.body });
  notifications.set(request.tag, notification);
  const forget = () => {
    if (notifications.get(request.tag) === notification) notifications.delete(request.tag);
  };
  notification.on("click", () => {
    forget();
    showWindow();
    if (request.target) sendToRenderer("orquester:notification-open", request.target satisfies NotificationTarget);
  });
  notification.on("close", forget);
  notification.show();
}

let badgeCount = 0;
let badgeOverlay: Electron.NativeImage | undefined;

/** Dock badge on macOS, launcher badge on Linux (Unity-style launchers only), taskbar overlay dot on Windows. */
function applyBadge(count: number): void {
  badgeCount = count;
  if (process.platform === "win32") {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    badgeOverlay ??= nativeImage.createFromBitmap(badgeOverlayBitmap(16), { width: 16, height: 16 });
    mainWindow.setOverlayIcon(count > 0 ? badgeOverlay : null, badgeDescription(count));
  } else {
    app.setBadgeCount(count);
  }
}

function setBadge(payload: unknown): void {
  const count = parseBadgeCount(payload);
  if (count !== null && count !== badgeCount) applyBadge(count);
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate(process.platform, app.getName(), {
        openSettings: () => {
          showWindow();
          sendToRenderer("orquester:menu-action", "open-settings");
        },
        openLogs: () => void shell.openPath(path.join(appDir(), "logs"))
      })
    )
  );
}

/** Right-click menu for editable fields and selections, with spelling suggestions. */
function installContextMenu(win: BrowserWindow): void {
  const contents = win.webContents;
  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => {
        if (!contents.isDestroyed()) contents.replaceMisspelling(word);
      },
      addToDictionary: (word) => {
        if (!contents.isDestroyed()) contents.session.addWordToSpellCheckerDictionary(word);
      }
    });
    if (template.length > 0 && !win.isDestroyed()) {
      Menu.buildFromTemplate(template).popup({ window: win });
    }
  });
}

function registerIpc(): void {
  ipcMain.handle("orquester:request", (event, request: DaemonRequest) => requestOverSocket(request, event.sender.id));
  ipcMain.handle("orquester:request-bytes", (event, request: DaemonRequest) => requestBytesOverSocket(request, event.sender.id));
  ipcMain.on("orquester:request:abort", (event, requestId: string) => abortUnaryRequest(event, requestId));
  ipcMain.on("orquester:stream:open", (event, payload: { streamId: string; path: string }) => openStreamOverSocket(event, payload));
  ipcMain.on("orquester:stream:close", (_event, streamId: string) => closeStream(streamId));

  // Remote HTTP transport (the renderer's HttpTransporter for remote servers).
  ipcMain.handle("orquester:http:request", (event, request: RemoteHttpRequest) => requestOverHttp(request, event.sender.id));
  ipcMain.handle("orquester:http:request-bytes", (event, request: RemoteHttpRequest) => requestBytesOverHttp(request, event.sender.id));
  ipcMain.on("orquester:http:request:abort", (event, requestId: string) => abortUnaryRequest(event, requestId));
  ipcMain.on(
    "orquester:http-stream:open",
    (event, payload: { streamId: string; url: string; headers?: http.OutgoingHttpHeaders }) => openHttpStream(event, payload)
  );
  ipcMain.on("orquester:http-stream:close", (_event, streamId: string) => closeStream(streamId));
  ipcMain.on("orquester:window-background", (_event, payload: unknown) => applyWindowBackground(payload));
  ipcMain.on("orquester:window", (event, action: string) => {
    // The sender's own window: while a rebuilt window loads, the old one is still on screen.
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return;
    }
    if (action === "minimize") win.minimize();
    else if (action === "toggleMaximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
  });
  ipcMain.on("orquester:titlebar-changed", (event) => {
    if (fromMainWindow(event)) rebuildWindowIfFrameChanged();
  });
  ipcMain.on("orquester:notify", (event, payload: unknown) => {
    if (fromMainWindow(event)) showNotification(payload);
  });
  ipcMain.on("orquester:badge", (event, payload: unknown) => {
    if (fromMainWindow(event)) setBadge(payload);
  });
}

function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// --- Tray (always present; controls daemon independently of the window) ---

// Resolves an app-logo asset copied into dist-electron by the build step (see
// scripts/build-main.ts). Works in dev and inside the packaged app.asar alike.
function logoPath(name: string): string {
  return path.join(desktopRoot, "dist-electron", name);
}

function makeTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(logoPath("logo-32.png"));
  // Fit the menu-bar / system-tray footprint; keep the source's alpha.
  return icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16, quality: "best" });
}

async function httpEnabled(): Promise<boolean> {
  try {
    const res = await requestOverSocket({ method: "GET", path: "/api/config/daemon" });
    return Boolean(JSON.parse(res.body)?.transports?.http?.enabled);
  } catch {
    return false;
  }
}

async function toggleHttp(): Promise<void> {
  const enabled = await httpEnabled();
  try {
    await requestOverSocket({
      method: "PUT",
      path: "/api/config/daemon",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transports: { http: { enabled: !enabled } } })
    });
  } catch (error) {
    console.error("Tray: toggle HTTP failed", error);
  }
  await rebuildTrayMenu();
}

async function rebuildTrayMenu(): Promise<void> {
  if (!tray) {
    return;
  }
  const enabled = await httpEnabled();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Orquester", click: showWindow },
      { type: "separator" },
      { label: `HTTP transport: ${enabled ? "On" : "Off"}`, click: () => void toggleHttp() },
      { type: "separator" },
      {
        label: "Quit",
        click: async () => {
          quitting = true;
          await requestOverSocket({ method: "POST", path: "/api/daemon/shutdown" }).catch(() => {});
          void stopIntegratedDaemon().finally(() => app.quit());
        }
      }
    ])
  );
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("Orquester");
  tray.on("click", showWindow);
  void rebuildTrayMenu();
}

/** The main window's frame identity (`frameKey`); a titlebar change that alters it rebuilds the window. */
let mainWindowFrame: string | undefined;
/** A rebuilt window still loading behind the one on screen. */
let replacementWindow: BrowserWindow | undefined;

/**
 * Create the main window, or — with `replacing` — its replacement: the new
 * window loads hidden and takes over (geometry, badge, focus) once it can
 * paint, then the old one is destroyed, so there is never a moment with no
 * window and no `window-all-closed`.
 */
function createWindow(replacing?: BrowserWindow): void {
  const titlebar = useTitlebar();
  const frame = windowFrameOptions(process.platform, titlebar);
  const state = readWindowState();
  const win = new BrowserWindow({
    ...resolveInitialWindowBounds(state.bounds, displayAreas()),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: "Orquester",
    icon: nativeImage.createFromPath(logoPath("logo-512.png")),
    ...frame,
    // A framed window on Windows/Linux keeps its menu bar behind Alt.
    autoHideMenuBar: true,
    show: false,
    // Read synchronously here (not from the renderer) so the window's first
    // paint is already in the user's colour scheme instead of flashing dark.
    backgroundColor: readWindowTheme().background,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(desktopRoot, "dist-electron", "preload.cjs"),
      // Tells the preload the window has no OS caption buttons, so the UI
      // shows its own whatever the setting says.
      additionalArguments: hasNativeWindowControls(process.platform, titlebar) ? [] : [NO_NATIVE_CONTROLS_ARGUMENT]
    }
  });
  if (replacing) {
    replacementWindow = win;
  } else {
    mainWindow = win;
    mainWindowFrame = frameKey(frame);
  }

  // No window of this app opens another one, and no frame may navigate it
  // away from itself: a link (a chat link's target=_blank, an agent page's
  // `ui/open-link`, which the renderer opens with window.open) goes to the
  // system browser, as on the web it goes to a new tab. A remote's file
  // download is downloaded here, and a URL carrying the connection's
  // password never reaches the system browser. Anything else is refused
  // (spec 2026-10-14 §2.2; the decisions are `navigation.ts`'s).
  const contents = win.webContents;
  const perform = (action: NavigationAction): void => {
    if (action.kind === "download") contents.downloadURL(action.url);
    else if (action.kind === "external") void shell.openExternal(action.url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    perform(windowOpenAction(url, { remoteBases }));
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    const action = navigationAction(url, { currentUrl: contents.getURL(), remoteBases });
    if (action.kind === "allow") return;
    event.preventDefault();
    perform(action);
  });
  installContextMenu(win);
  const contentsId = contents.id;
  contents.once("destroyed", () => closeStreamsOf(contentsId));

  win.once("ready-to-show", () => {
    if (state.maximized) win.maximize();
    if (replacing) {
      replacementWindow = undefined;
      mainWindow = win;
      mainWindowFrame = frameKey(frame);
      if (!replacing.isDestroyed()) replacing.destroy();
      applyBadge(badgeCount);
    }
    win.show();
    win.focus();
    // The setting may have changed again while this window loaded.
    if (replacing) rebuildWindowIfFrameChanged();
  });
  trackWindowState(win);

  // Run-in-background: closing hides the window (daemon + tray keep running).
  win.on("close", (event) => {
    if (!quitting && runInBackground() && isDaemonOwner) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = undefined;
      mainWindowFrame = undefined;
      // No page is left to keep the count current.
      applyBadge(0);
    }
    if (replacementWindow === win) replacementWindow = undefined;
  });

  const devUrl = process.env.ORQUESTER_DESKTOP_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(desktopRoot, "dist", "index.html"));
  }
}

/**
 * The renderer saved the "Custom titlebar" setting: rebuild the main window
 * when the frame it needs differs from the one it has (never on macOS, whose
 * frame does not change). The setting is read back from app.json rather than
 * taken from the message, so a save that failed changes nothing.
 */
function rebuildWindowIfFrameChanged(): void {
  const current = mainWindow;
  if (!current || current.isDestroyed() || replacementWindow) return;
  if (frameKey(windowFrameOptions(process.platform, useTitlebar())) === mainWindowFrame) return;
  saveWindowState(current);
  createWindow(current);
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) {
    return;
  }
  ensureAppFiles();
  // Windows shows a notification only for an app with an AppUserModelID
  // (the installer's appId; set here so a dev run notifies too).
  if (process.platform === "win32") {
    app.setAppUserModelId("com.orquester.desktop");
  }
  const socketPath = socketPathFor();

  if (await checkExistingDaemon(socketPath)) {
    daemonSocketPath = socketPath;
    process.env.ORQUESTER_UNIX_SOCKET = socketPath;
    isDaemonOwner = false;
  } else {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
    await startIntegratedDaemon();
    isDaemonOwner = true;
  }

  listenForDaemonShutdown();
  registerIpc();
  registerVisualProtocol();
  if (isDaemonOwner) {
    createTray();
  }
  installApplicationMenu();
  windowsReady = true;
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showWindow();
    }
  });
}).catch((error) => {
  console.error("Failed to start Orquester desktop", error);
  app.quit();
});

app.on("window-all-closed", () => {
  // In background mode the tray keeps the app (and daemon) alive.
  if ((!runInBackground() || !isDaemonOwner) && process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  quitting = true;
  if (daemon) {
    event.preventDefault();
    void stopIntegratedDaemon().finally(() => app.quit());
  }
});
