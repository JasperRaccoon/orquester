// Desktop tabs: a virtual X display (Xvnc + Openbox + PulseAudio + D-Bus) that
// one or more GUI apps run in, streamed to the tab over RFB (or voxl H.264) and an
// Opus audio socket, and driven by agents through the daemon's X11 automation.
// See docs/superpowers/specs/2026-09-30-desktop-tab-design.md and
// docs/superpowers/specs/2026-11-10-desktop-agents-touch-voxl-design.md.

export type DesktopStatus = "starting" | "running" | "stopped" | "error";
export type DesktopAppStatus = "starting" | "running" | "exited";
export type DesktopAudioAvailability = "available" | "unavailable";
export type DesktopWindowAction = "activate" | "maximize" | "close";

export interface DesktopSize {
  width: number;
  height: number;
}

export interface DesktopAppSummary {
  id: string;
  desktopId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  status: DesktopAppStatus;
  /** `null` while running, or when the exit status could not be recovered. */
  exitCode: number | null;
  startedAt: string;
  exitedAt: string | null;
}

export interface DesktopWindow {
  /** X window id as a `0x…` hex string. */
  id: string;
  title: string;
  /** The app that owns the window, or `null` ("Other"). */
  appId: string | null;
  wmClass: string | null;
  maximized: boolean;
  /** The window's frame on the root window (display pixels); absent while unknown. */
  bounds?: DesktopRect;
}

/** A rectangle in display pixels. */
export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopSummary {
  id: string;
  projectPath: string;
  title: string;
  order: number;
  createdAt: string;
  display: number | null;
  size: DesktopSize;
  renderThreads: number;
  status: DesktopStatus;
  error?: string;
  /**
   * boxes: what a `starting` desktop is doing right now when that takes a while (installing the
   * desktop packages in its VM: the latest line of the install). Absent otherwise.
   */
  statusDetail?: string;
  /**
   * boxes: set when the desktop runs in a Linux VM (Ephemeral AI VMs) instead of on the daemon's
   * host. `connected: false` while the VM's link is down: the desktop keeps running there and the
   * view comes back once the link does.
   */
  box?: DesktopBoxInfo;
  audio: DesktopAudioAvailability;
  apps: DesktopAppSummary[];
  windows: DesktopWindow[];
  activeWindowId: string | null;
  /**
   * Who controls the desktop's input right now (runtime only; `null`: nobody claimed it). Absent from
   * daemons that predate automation: read it as `null`.
   */
  control?: DesktopControl | null;
  /** The video backend this desktop streams with (persisted). Absent from older daemons: read it as `rfb`. */
  video?: DesktopVideoBackend;
  /** The voxl stream's state when `video` is `voxl`; absent for `rfb`. */
  voxl?: DesktopVoxlStream;
}

// ---------------------------------------------------------------------------
// Automation, control and the action log (spec 2026-11-10 §2–§3)
// ---------------------------------------------------------------------------

/** Who issued an automation action. */
export type DesktopActor =
  | { kind: "chat"; threadId: string; label: string }
  | { kind: "external"; label: string };

export type DesktopController = "agent" | "user";

export interface DesktopControl {
  controller: DesktopController;
  /** The agent holding control, or (for `user`) the agent the user took it from, when known. */
  actor?: DesktopActor;
  /** ISO time control last changed hands. */
  since: string;
}

/** PUT {@link desktopRoutes.control}: `user` takes over, `agent` gives back, `null` clears. */
export interface DesktopControlRequest {
  controller: DesktopController | null;
}

export const DESKTOP_ACTION_KINDS = [
  "screenshot",
  "wait",
  "move",
  "click",
  "mouse_down",
  "mouse_up",
  "drag",
  "scroll",
  "key",
  "type",
  "clipboard_get",
  "clipboard_set"
] as const;
export type DesktopActionKind = (typeof DESKTOP_ACTION_KINDS)[number];

/** Actions that change nothing: allowed while the user has control, `read` tier for the tool. */
export const DESKTOP_READ_ONLY_ACTIONS: readonly DesktopActionKind[] = ["screenshot", "wait", "clipboard_get"];

export function isDesktopActionKind(value: unknown): value is DesktopActionKind {
  return typeof value === "string" && (DESKTOP_ACTION_KINDS as readonly string[]).includes(value);
}

export function isReadOnlyDesktopAction(kind: DesktopActionKind): boolean {
  return DESKTOP_READ_ONLY_ACTIONS.includes(kind);
}

export type DesktopMouseButton = "left" | "middle" | "right";
export type DesktopModifier = "ctrl" | "shift" | "alt" | "super";
export type DesktopScrollDirection = "up" | "down" | "left" | "right";

/**
 * POST {@link desktopRoutes.actions}. Coordinates are display pixels, or — with `screenshotId` —
 * pixels of that screenshot (mapped through its scale and origin; `DESKTOP_RESIZED` when the display
 * size changed since it was taken).
 */
export interface DesktopActionRequest {
  action: DesktopActionKind;
  actor: DesktopActor;
  x?: number;
  y?: number;
  screenshotId?: string;
  button?: DesktopMouseButton;
  /** click: 1–3. */
  count?: number;
  /** Held around a click / drag / scroll. */
  modifiers?: DesktopModifier[];
  /** drag: the end point (same space as `x`, `y`). */
  toX?: number;
  toY?: number;
  /** scroll. */
  direction?: DesktopScrollDirection;
  /** scroll: wheel clicks, 1–50 (default 3). */
  amount?: number;
  /** key: a `+`-separated combo ("ctrl+shift+t", "Return"). */
  keys?: string;
  /** key: 1–20. */
  repeat?: number;
  /** type (≤ {@link DESKTOP_TYPE_MAX_CHARS}) / clipboard_set (≤ {@link DESKTOP_CLIPBOARD_MAX_BYTES} UTF-8). */
  text?: string;
  /** screenshot crop / wait region (display pixels). */
  region?: DesktopRect;
  /** screenshot: crop to this window's bounds. */
  windowId?: string;
  /** screenshot: the image's long edge bound, 320–3840 (default {@link DESKTOP_SCREENSHOT_DEFAULT_MAX}). */
  maxSize?: number;
  /** wait: idle (still for `idleMs`) or change (after `since`). */
  for?: "idle" | "change";
  idleMs?: number;
  since?: number;
  timeoutMs?: number;
  /** Input actions: wait until idle (300 ms, ≤ 3 s) and return a screenshot. */
  screenshot?: boolean;
}

export interface DesktopScreenshotInfo {
  screenshotId: string;
  mimeType: "image/png" | "image/jpeg";
  /** The image's size. */
  width: number;
  height: number;
  /** Display pixels per image pixel (≥ 1). */
  scale: number;
  /** The image's top-left corner in display pixels (non-zero for a crop). */
  origin: { x: number; y: number };
}

export interface DesktopActionResponse {
  desktopId: string;
  action: DesktopActionKind;
  /** The log line ("Clicked at 412, 300"). */
  summary: string;
  /** The screen sequence observed after the action. */
  seq: number;
  display: DesktopSize;
  cursor?: { x: number; y: number };
  /** wait. */
  changed?: boolean;
  timedOut?: boolean;
  waitedMs?: number;
  /** clipboard_get. */
  text?: string;
  /** screenshot, or an input action with `screenshot: true`. */
  screenshot?: DesktopScreenshotInfo & { base64: string };
  control: DesktopControl | null;
  entry: DesktopActionEntry;
}

export interface DesktopActionEntry {
  id: string;
  at: string;
  actor: DesktopActor;
  kind: DesktopActionKind;
  summary: string;
  /** Display pixels. */
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  button?: DesktopMouseButton;
  count?: number;
  direction?: DesktopScrollDirection;
  /** type: the text, ≤ 60 chars (never clipboard contents). */
  text?: string;
  /** key: the combo as given. */
  keys?: string;
  screenshotId?: string;
  ok: boolean;
  error?: string;
}

export interface DesktopActionLogResponse {
  entries: DesktopActionEntry[];
}

/** `desktop.action`. */
export interface DesktopActionEventPayload {
  desktopId: string;
  entry: DesktopActionEntry;
}

/** Kept through MCP result slimming so the chat row can link the desktop and its screenshot. */
export interface DesktopToolReference {
  desktopId: string;
  projectPath: string;
  screenshotId?: string;
  action?: string;
  summary?: string;
}

export const DESKTOP_TYPE_MAX_CHARS = 4000;
export const DESKTOP_CLIPBOARD_MAX_BYTES = 1024 * 1024;
export const DESKTOP_SCREENSHOT_DEFAULT_MAX = 1920;
export const DESKTOP_SCREENSHOT_MIN_MAX = 320;
export const DESKTOP_SCREENSHOT_MAX_MAX = 3840;
export const DESKTOP_WAIT_DEFAULT_TIMEOUT_MS = 10_000;
export const DESKTOP_WAIT_MAX_TIMEOUT_MS = 60_000;
export const DESKTOP_IDLE_DEFAULT_MS = 500;
export const DESKTOP_IDLE_MIN_MS = 100;
export const DESKTOP_IDLE_MAX_MS = 10_000;
export const DESKTOP_ACTION_LOG_LIMIT = 50;
export const DESKTOP_SCREENSHOTS_KEPT = 50;
/** Agent control lapses this long after the agent's last action. */
export const DESKTOP_AGENT_CONTROL_LAPSE_MS = 2 * 60_000;

export const DESKTOP_CONTROLLED_BY_USER_CODE = "DESKTOP_CONTROLLED_BY_USER";
export const DESKTOP_RESIZED_CODE = "DESKTOP_RESIZED";
export const DESKTOP_NOT_RUNNING_CODE = "DESKTOP_NOT_RUNNING";
export const DESKTOP_UNSUPPORTED_VISUAL_CODE = "DESKTOP_UNSUPPORTED_VISUAL";

// ---------------------------------------------------------------------------
// voxl video backend (spec 2026-11-10 §5)
// ---------------------------------------------------------------------------

export type DesktopVideoBackend = "rfb" | "voxl";

export function isDesktopVideoBackend(value: unknown): value is DesktopVideoBackend {
  return value === "rfb" || value === "voxl";
}

/** A `voxl` desktop's stream: `ready` once voxl answers; `unavailable` means viewers use RFB. */
export interface DesktopVoxlStream {
  state: "starting" | "ready" | "unavailable";
  /** Why it is unavailable (no binary, it exited, …). */
  reason?: string;
}

/** The host's (or VM's) voxl. */
export interface DesktopVoxlStatus {
  available: boolean;
  version: string | null;
  path: string | null;
  reason?: string;
}

/** boxes: where a VM desktop runs (see {@link DesktopSummary.box}). */
export interface DesktopBoxInfo {
  id: string;
  connected: boolean;
}

export interface DesktopHostTool {
  name: string;
  path: string | null;
  required: boolean;
}

export interface DesktopHostStatus {
  /** Every required tool is present and tmux (≥ 3.2) is usable. */
  available: boolean;
  audioAvailable: boolean;
  tools: DesktopHostTool[];
  ffmpegPulse: boolean;
  ffmpegOpus: boolean;
  renderNode: boolean;
  tmuxUsable: boolean;
  warnings: string[];
  /** `sudo apt-get install -y …` for whatever is missing, or `null`. */
  installHint: string | null;
  /**
   * This host's missing packages can be installed by the daemon (`POST desktopRoutes.hostInstall`):
   * it may run apt-get as root. Absent when it cannot, when nothing is missing, and for a VM.
   */
  canInstall?: boolean;
  /**
   * A VM project's desktop stack: Orquester installs what is missing itself when a desktop
   * opens (`installHint` then only names it). Absent when the user must install it, and on the host.
   */
  installsOnOpen?: boolean;
  /** The optional voxl H.264 streamer (absent from daemons that predate it). */
  voxl?: DesktopVoxlStatus;
}

export interface LaunchAppRequest {
  /** Single-line shell command line (≤ 4096 chars). */
  command: string;
  /** Absolute, or relative to the project; defaults to the project. */
  cwd?: string;
  env?: Record<string, string>;
}

export interface CreateDesktopRequest {
  projectPath: string;
  title?: string;
  size?: DesktopSize;
  renderThreads?: number;
  app?: LaunchAppRequest;
  /** Defaults to `voxl` when available, else `rfb`. */
  video?: DesktopVideoBackend;
}

/** PATCH {@link desktopRoutes.desktop}: switch the video backend (restarts only the stream). */
export interface UpdateDesktopRequest {
  video?: DesktopVideoBackend;
}

export interface DesktopEntrySuggestion {
  name: string;
  command: string;
  icon: string | null;
  source: "system" | "user";
}

export interface RecentLaunch {
  command: string;
  cwd: string;
  env: Record<string, string>;
  lastUsedAt: string;
}

export interface DesktopSuggestionsResponse {
  entries: DesktopEntrySuggestion[];
  /** Project-relative paths of executables. */
  executables: string[];
  recent: RecentLaunch[];
}

// ---------------------------------------------------------------------------
// Routes, events, WebSocket framing
// ---------------------------------------------------------------------------

const desktopPath = (id: string): string => `/api/desktops/${encodeURIComponent(id)}`;

export const desktopRoutes = {
  list: "/api/desktops",
  create: "/api/desktops",
  /** The host's prerequisites; `?projectPath=` (boxes) answers for that project's machine: its VM for a box project. */
  host: "/api/desktops/host",
  /** Installs this host's missing desktop packages (apt-get as root); answers the new host status. */
  hostInstall: "/api/desktops/host/install",
  suggestions: "/api/desktops/suggestions",
  desktop: desktopPath,
  stop: (id: string): string => `${desktopPath(id)}/stop`,
  restart: (id: string): string => `${desktopPath(id)}/restart`,
  apps: (id: string): string => `${desktopPath(id)}/apps`,
  app: (id: string, appId: string): string => `${desktopPath(id)}/apps/${encodeURIComponent(appId)}`,
  appLog: (id: string, appId: string): string => `${desktopPath(id)}/apps/${encodeURIComponent(appId)}/log`,
  windowAction: (id: string, windowId: string, action: DesktopWindowAction): string =>
    `${desktopPath(id)}/windows/${encodeURIComponent(windowId)}/${action}`,
  /** RFB relay WebSocket (append `?token=`). */
  vncSocket: (id: string): string => `/ws-desktop/${encodeURIComponent(id)}`,
  /** Opus audio WebSocket (append `?token=`). */
  audioSocket: (id: string): string => `/ws-desktop-audio/${encodeURIComponent(id)}`,
  /** voxl relay WebSocket (append `?token=`): frames 1:1 with voxl's own `/ws`. */
  voxlSocket: (id: string): string => `/ws-desktop-voxl/${encodeURIComponent(id)}`,
  /** POST {@link DesktopActionRequest} → {@link DesktopActionResponse}. */
  actions: (id: string): string => `${desktopPath(id)}/actions`,
  /** GET → {@link DesktopActionLogResponse}. */
  actionLog: (id: string): string => `${desktopPath(id)}/actions/log`,
  /** GET → the image bytes. */
  screenshot: (id: string, screenshotId: string): string => `${desktopPath(id)}/screenshots/${encodeURIComponent(screenshotId)}`,
  /** PUT {@link DesktopControlRequest} → {@link DesktopSummary}. */
  control: (id: string): string => `${desktopPath(id)}/control`
} as const;

/** WebSocket path prefixes the SPA fallback must not swallow. */
export const DESKTOP_WS_PREFIXES = ["/ws-desktop/", "/ws-desktop-audio/", "/ws-desktop-voxl/"] as const;

/** The `/events` channel desktop lifecycle and window events go out on. */
export const DESKTOP_CHANNEL = "desktop";
export type DesktopEventType = "desktop.created" | "desktop.updated" | "desktop.closed" | "desktop.windows" | "desktop.action";

export interface DesktopClosedPayload {
  id: string;
}

export interface DesktopWindowsPayload {
  desktopId: string;
  windows: DesktopWindow[];
  activeWindowId: string | null;
}

export const DESKTOP_UNAVAILABLE_CODE = "DESKTOP_UNAVAILABLE";

/** Limits enforced by the daemon on launch requests. */
export const DESKTOP_MAX_COMMAND_LENGTH = 4096;
export const DESKTOP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Text-frame control messages on the RFB relay (binary frames are RFB bytes). */
export type DesktopVncControlMessage = { type: "ping"; t: number } | { type: "pong"; t: number };

/** First text message on the audio socket, and on any audio state change. */
export interface DesktopAudioStateMessage {
  type: "state";
  audio: DesktopAudioAvailability;
  reason?: string;
  sampleRate: 48000;
  channels: 2;
  frameMs: 10;
}

export type DesktopAudioServerJsonMessage = DesktopAudioStateMessage | { type: "pong" };
export type DesktopAudioClientMessage = { type: "ping" };

/**
 * Binary audio packet: `[u8 type=1][u8 flags=0][u16 reserved=0][u32 seq BE][opus packet]`.
 * A gap in `seq` means the server dropped packets for this socket (backpressure).
 */
export const DESKTOP_AUDIO_PACKET_OPUS = 1;
export const DESKTOP_AUDIO_HEADER_BYTES = 8;
