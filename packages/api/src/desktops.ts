// Desktop tabs: a virtual X display (Xvnc + Openbox + PulseAudio + D-Bus) that
// one or more GUI apps run in, streamed to the tab over RFB and an Opus audio
// socket. See docs/superpowers/specs/2026-09-30-desktop-tab-design.md.

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
  audio: DesktopAudioAvailability;
  apps: DesktopAppSummary[];
  windows: DesktopWindow[];
  activeWindowId: string | null;
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
  host: "/api/desktops/host",
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
  audioSocket: (id: string): string => `/ws-desktop-audio/${encodeURIComponent(id)}`
} as const;

/** WebSocket path prefixes the SPA fallback must not swallow. */
export const DESKTOP_WS_PREFIXES = ["/ws-desktop/", "/ws-desktop-audio/"] as const;

/** The `/events` channel desktop lifecycle and window events go out on. */
export const DESKTOP_CHANNEL = "desktop";
export type DesktopEventType = "desktop.created" | "desktop.updated" | "desktop.closed" | "desktop.windows";

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
