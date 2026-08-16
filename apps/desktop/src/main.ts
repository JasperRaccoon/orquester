import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, type IpcMainEvent } from "electron";
import { startDaemon as startOrquesterDaemon, type RunningDaemon } from "@orquester/daemon";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

interface DaemonRequest {
  method?: string;
  path?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
  // Present when the renderer wants the request to be cancellable (see unaryRequests).
  requestId?: string;
}

interface DaemonResponse {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let daemon: RunningDaemon | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let daemonSocketPath: string | undefined;
let isDaemonOwner = false;
let quitting = false;

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

/** HTTP request to the daemon over its unix socket (the renderer's transport). */
function requestOverSocket({ method, path: requestPath, headers, body, requestId }: DaemonRequest, senderId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    if (!daemonSocketPath) {
      reject(new Error("Orquester daemon is not running."));
      return;
    }

    const req = http.request(
      { socketPath: daemonSocketPath, path: requestPath || "/", method: method || "GET", headers: headers || {} },
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
    if (body) {
      req.write(body);
    }
    req.end();
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
      { socketPath: daemonSocketPath, path: requestPath || "/", method: method || "GET", headers: headers || {} },
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
    if (body) req.write(body);
    req.end();
  });
}

const streams = new Map<string, http.ClientRequest>();

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
  streams.set(streamId, req);
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
  body?: string;
  // See DaemonRequest.requestId.
  requestId?: string;
}

function httpModuleFor(target: URL): typeof http | typeof https {
  return target.protocol === "https:" ? https : http;
}

/** One unary request/response round trip to a remote daemon over TCP. */
function requestOverHttp({ url, method, headers, body, requestId }: RemoteHttpRequest, senderId?: number): Promise<DaemonResponse> {
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
      { method: method || "GET", headers: headers || {} },
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
    if (body) {
      req.write(body);
    }
    req.end();
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
    const req = httpModuleFor(target).request(target, { method: method || "GET", headers: headers || {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: toArrayBuffer(Buffer.concat(chunks)) });
      });
    });
    trackUnaryRequest(req, requestId, senderId);
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
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
  streams.set(streamId, req);
}

function closeStream(streamId: string): void {
  const req = streams.get(streamId);
  if (req) {
    req.destroy();
    streams.delete(streamId);
  }
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
  ipcMain.on("orquester:window", (_event, action: string) => {
    if (!mainWindow) {
      return;
    }
    if (action === "minimize") mainWindow.minimize();
    else if (action === "toggleMaximize") mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === "close") mainWindow.close();
  });
}

function showWindow(): void {
  if (mainWindow) {
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: "Orquester",
    icon: nativeImage.createFromPath(logoPath("logo-512.png")),
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    show: false,
    // Read synchronously here (not from the renderer) so the window's first
    // paint is already in the user's colour scheme instead of flashing dark.
    backgroundColor: readWindowTheme().background,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(desktopRoot, "dist-electron", "preload.cjs")
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Run-in-background: closing hides the window (daemon + tray keep running).
  mainWindow.on("close", (event) => {
    if (!quitting && runInBackground() && isDaemonOwner) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  const devUrl = process.env.ORQUESTER_DESKTOP_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(desktopRoot, "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  ensureAppFiles();
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
  if (isDaemonOwner) {
    createTray();
  }
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
