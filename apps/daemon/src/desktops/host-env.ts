import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_ENV_KEY_PATTERN } from "@orquester/api";

// Pure builders for a desktop's on-disk layout, its host script arguments and
// its apps' environment (desktop spec §5.3, §5.5). No I/O here.

/** The shipped POSIX scripts, run with `/bin/sh <script>` (no exec bit needed). */
export const DESKTOP_HOST_SCRIPT = fileURLToPath(new URL("./assets/desktop-host.sh", import.meta.url));
export const DESKTOP_APP_SCRIPT = fileURLToPath(new URL("./assets/app-run.sh", import.meta.url));

/** Every desktop's tmux service session is `orqsvc-desktop-<id>` (outside the reaped `orq-` names). */
export const DESKTOP_SESSION_PREFIX = "orqsvc-desktop-";
/** The service session's window running desktop-host.sh. */
export const DESKTOP_HOST_WINDOW = "host";

export function desktopSessionName(desktopId: string): string {
  return `${DESKTOP_SESSION_PREFIX}${desktopId}`;
}

export function appWindowName(appId: string): string {
  return `app-${appId}`;
}

/**
 * `sun_path` holds 108 bytes; stay well under it. The longest socket is
 * `<socket dir>/pulse/native`, so that is the path measured.
 */
export const SOCKET_PATH_LIMIT = 100;

/**
 * The short fallback socket dir for a desktop whose `<dir>/pulse/native` would
 * be longer than {@link SOCKET_PATH_LIMIT} bytes, or null when the desktop dir
 * itself fits. The caller creates it 0700 and records it as `socketDir`.
 */
export function fallbackSocketDir(
  dir: string,
  desktopId: string,
  host: { tmpDir: string; uid: number }
): string | null {
  if (Buffer.byteLength(join(dir, "pulse", "native")) <= SOCKET_PATH_LIMIT) {
    return null;
  }
  return join(host.tmpDir, `orqd-${host.uid}-${desktopId}`);
}

/** Every path of one desktop (§5.3). Sockets live in `socketDir` when the fallback is used. */
export interface DesktopLayout {
  dir: string;
  /** Where the Unix sockets live: `dir`, or the short tmp fallback. */
  socketDir: string;
  xauthority: string;
  vncSocket: string;
  pulseDir: string;
  pulseSocket: string;
  bus: string;
  /** The desktop's XDG_RUNTIME_DIR (0700). */
  runDir: string;
  defaultPa: string;
  clientConf: string;
  ready: string;
  hostExit: string;
  hostLog: string;
  appsDir: string;
}

export function desktopLayout(dir: string, socketDir: string | null): DesktopLayout {
  const sockets = socketDir ?? dir;
  return {
    dir,
    socketDir: sockets,
    xauthority: join(dir, "Xauthority"),
    vncSocket: join(sockets, "vnc.sock"),
    pulseDir: join(sockets, "pulse"),
    pulseSocket: join(sockets, "pulse", "native"),
    bus: join(sockets, "bus"),
    runDir: join(dir, "run"),
    defaultPa: join(dir, "default.pa"),
    clientConf: join(dir, "client.conf"),
    ready: join(dir, "ready"),
    hostExit: join(dir, "host.exit"),
    hostLog: join(dir, "host.log"),
    appsDir: join(dir, "apps")
  };
}

/** `<dir>/apps/<appId>.<ext>` — the app's env file, pgid, exit status and log. */
export function appFile(layout: DesktopLayout, appId: string, ext: "env" | "pgid" | "exit" | "log"): string {
  return join(layout.appsDir, `${appId}.${ext}`);
}

/** A PulseAudio modarg value, double-quoted (the paths are ours, but may hold spaces). */
function paArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The desktop's PulseAudio script: one native socket, one null sink `orq` as the
 * default. Anonymous auth on purpose: the socket's 0700 directory is the access
 * control — a per-desktop cookie would add nothing against same-uid processes,
 * which could read the cookie file just as well.
 */
export function defaultPaContent(layout: DesktopLayout): string {
  return [
    `load-module module-native-protocol-unix socket=${paArg(layout.pulseSocket)} auth-anonymous=1`,
    "load-module module-null-sink sink_name=orq",
    "set-default-sink orq",
    ""
  ].join("\n");
}

/** Apps must never autospawn a pulseaudio of their own when the desktop's is missing. */
export const CLIENT_CONF_CONTENT = "autospawn = no\n";

/** `desktop-host.sh <dir> <width> <height> <audio 0|1> <socket dir>` (none of it secret). */
export function hostScriptArgs(
  layout: DesktopLayout,
  size: { width: number; height: number },
  audio: boolean
): string[] {
  return [
    DESKTOP_HOST_SCRIPT,
    layout.dir,
    String(size.width),
    String(size.height),
    audio ? "1" : "0",
    layout.socketDir
  ];
}

/** Variables an app must never inherit: tmux's own, the daemon's ORQUESTER_* configuration, Wayland. */
function scrubbed(key: string): boolean {
  return key === "TMUX" || key === "TMUX_PANE" || key.startsWith("ORQUESTER_") || key === "WAYLAND_DISPLAY";
}

export interface AppEnvOptions {
  /** The session base env (`sessionEnvBase()` plus the session PATH). */
  base: Record<string, string>;
  layout: DesktopLayout;
  display: number;
  /** A `/dev/dri/renderD*` node exists (else software GL is forced). */
  renderNode: boolean;
  renderThreads: number;
  /** The user's variables, applied last. */
  user: Record<string, string>;
}

/**
 * An app's full environment (§5.5): the scrubbed session base, the desktop's
 * display/audio/bus wiring, the GL rules, then the user's variables last so an
 * app can override anything (`LP_NUM_THREADS` included). `WAYLAND_DISPLAY` is
 * dropped so toolkits pick X11.
 */
export function buildAppEnv(options: AppEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base)) {
    if (!scrubbed(key)) env[key] = value;
  }
  const { layout } = options;
  env.DISPLAY = `:${options.display}`;
  env.XAUTHORITY = layout.xauthority;
  env.XDG_SESSION_TYPE = "x11";
  env.PULSE_SERVER = `unix:${layout.pulseSocket}`;
  env.PULSE_CLIENTCONFIG = layout.clientConf;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${layout.bus}`;
  env.XDG_RUNTIME_DIR = layout.runDir;
  if (options.renderNode) {
    delete env.LIBGL_ALWAYS_SOFTWARE;
  } else {
    env.LIBGL_ALWAYS_SOFTWARE = "1";
  }
  env.LP_NUM_THREADS = String(options.renderThreads);
  for (const [key, value] of Object.entries(options.user)) {
    env[key] = value;
  }
  return env;
}

/** POSIX single-quoting: `'` becomes `'\''`. Safe for any value without NUL. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `<appId>.env` file app-run.sh sources with `set -a`: one `KEY='value'`
 * line per variable (keys that are not valid shell names are skipped — they
 * could not be assigned anyway), then ORQ_APP_CWD and ORQ_APP_COMMAND. Written
 * 0600 and deleted by the script once read.
 */
export function appEnvFileContent(env: Record<string, string>, cwd: string, command: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isReservedAppEnvKey(key) || SHELL_READONLY_VARS.has(key)) continue;
    if (!DESKTOP_ENV_KEY_PATTERN.test(key) || value.includes("\0")) continue;
    lines.push(`${key}=${shellQuote(value)}`);
  }
  lines.push(`ORQ_APP_CWD=${shellQuote(cwd)}`);
  lines.push(`ORQ_APP_COMMAND=${shellQuote(command)}`);
  return `${lines.join("\n")}\n`;
}

/** Names app-run.sh uses for itself: a launch env must not set them. */
export function isReservedAppEnvKey(key: string): boolean {
  return key.startsWith("__orq_") || key.startsWith("ORQ_APP_");
}

/** Read-only in bash (when /bin/sh is bash, assigning one aborts the `.`): never written. */
const SHELL_READONLY_VARS = new Set(["BASHOPTS", "BASH_VERSINFO", "EUID", "PPID", "SHELLOPTS", "UID"]);
