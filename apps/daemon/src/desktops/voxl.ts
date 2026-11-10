import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { DesktopVoxlStatus } from "@orquester/api";
import {
  DESKTOP_MAX_HEIGHT,
  DESKTOP_MAX_WIDTH,
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH,
  voxlBinaryPath
} from "@orquester/config";
import { sessionPath } from "../tmux.ts";
import { resolveTool } from "./host-status.ts";

// voxl as a desktop's optional H.264 video backend (spec 2026-11-10 §5): the pure builders for its
// command line, its environment file and its log, the relay's filter for what a viewer sends it,
// and how the daemon finds the binary and talks to it (port, /healthz). The process lifecycle is
// `voxl-streams.ts`.
//
// voxl listens on 127.0.0.1 only, with its login on and a random per-desktop password that reaches
// it through `VOXL_PASSWORD` in a 0600 env file in the desktop dir — never an argv, a log line or an
// API response. File transfer and audio are off (Orquester's own audio path stays the only one).

/** The shipped runner, run with `/bin/sh` as the desktop session's `voxl` window. */
export const VOXL_SCRIPT = fileURLToPath(new URL("./assets/voxl-run.sh", import.meta.url));
/** The service session's window running voxl-run.sh. */
export const VOXL_WINDOW = "voxl";

/** voxl's files in a desktop dir: its environment (the password: 0600), its output and its exit status. */
export interface VoxlFiles {
  env: string;
  log: string;
  exit: string;
}

export function voxlFiles(dir: string): VoxlFiles {
  return { env: join(dir, "voxl.env"), log: join(dir, "voxl.log"), exit: join(dir, "voxl.exit") };
}

/**
 * voxl's arguments (none of them secret). Every default that matters is spelled out: the listen
 * address (voxl's is 0.0.0.0), file transfer (on by default, under $HOME) and audio.
 */
export function voxlArgs(port: number): string[] {
  return [
    "--addr=127.0.0.1",
    `--port=${port}`,
    "--enable-basic-auth=true",
    "--file-transfers=none",
    "--audio-enabled=false",
    "--microphone-enabled=false",
    "--enable-clipboard=true",
    "--enable-resize=true"
  ];
}

export interface VoxlEnvOptions {
  display: number;
  xauthority: string;
  /** The desktop's XDG_RUNTIME_DIR: voxl keeps its scratch-keymap note there. */
  runDir: string;
  password: string;
  port: number;
}

/** POSIX single-quoting: `'` becomes `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `voxl.env`, which voxl-run.sh sources with `set -a`. `ORQ_VOXL_PORT` is the daemon's own note of
 * the port (read back after a daemon restart, with the password). `RUST_LOG=info`: the listen line
 * the daemon waits for is an info line, whatever RUST_LOG the tmux server has.
 */
export function voxlEnvFileContent(options: VoxlEnvOptions): string {
  const env: Record<string, string> = {
    DISPLAY: `:${options.display}`,
    XAUTHORITY: options.xauthority,
    XDG_RUNTIME_DIR: options.runDir,
    VOXL_PASSWORD: options.password,
    RUST_LOG: "info",
    ORQ_VOXL_PORT: String(options.port)
  };
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
}

/** The port and password in a `voxl.env` this daemon wrote, or null when it is not one. */
export function parseVoxlEnvFile(text: string | null): { port: number; password: string } | null {
  if (text === null) return null;
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)='([^']*)'$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const port = Number(values.get("ORQ_VOXL_PORT"));
  const password = values.get("VOXL_PASSWORD") ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || password.length === 0) return null;
  return { port, password };
}

/** A fresh per-start password (hex: never needs quoting). */
export function newVoxlPassword(): string {
  return randomBytes(24).toString("hex");
}

/** voxl's log says it listens on `port` (`… INFO voxl] listening on http://127.0.0.1:<port>`). */
export function voxlListening(log: string, port: number): boolean {
  return log.split("\n").some((line) => line.trimEnd().endsWith(`listening on http://127.0.0.1:${port}`));
}

/** voxl could not bind its port (it panics on `bind`: exit 134). */
export function voxlBindFailed(log: string): boolean {
  return /AddrInUse|Address already in use/.test(log);
}

/** Noise voxl prints with Xvnc (it captures with GetImage instead of Xvfb's framebuffer): never a reason. */
const HARMLESS_LOG = /framebuffer not found|falling back to GetImage/i;
const MAX_REASON = 300;

/** The line of voxl's log that best says why it stopped (the last error-looking one, else the last one), or "". */
export function voxlFailureLine(log: string): string {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !HARMLESS_LOG.test(line));
  const pick = [...lines].reverse().find((line) => /error|panicked|failed|refused|cannot|can't/i.test(line)) ?? lines.at(-1) ?? "";
  return pick.slice(0, MAX_REASON);
}

/**
 * A viewer's text frame, as the relay passes it on to voxl: `sz,w,h` (the viewer's window size,
 * which voxl applies to the display) is clamped to the desktop size limits — voxl itself accepts
 * up to 32768×32768 — and dropped (null) when it is not two integers. Everything else is unchanged.
 */
export function filterVoxlClientText(text: string): string | null {
  if (!text.startsWith("sz,") && text !== "sz") return text;
  const match = /^sz,(\d{1,6}),(\d{1,6})$/.exec(text);
  if (!match) return null;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return `sz,${clamp(Number(match[1]), DESKTOP_MIN_WIDTH, DESKTOP_MAX_WIDTH)},${clamp(Number(match[2]), DESKTOP_MIN_HEIGHT, DESKTOP_MAX_HEIGHT)}`;
}

/** A free 127.0.0.1 port, as the OS hands one out (bound, read, closed; the caller passes it on). */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port was allocated"))));
    });
  });
}

/**
 * A port for voxl in a VM, where the daemon cannot bind one first: random, below Linux's ephemeral
 * range (32768+) so no outgoing connection holds it. A taken one fails voxl's bind, and the start
 * retries with another.
 */
export function randomVoxlPort(): number {
  return randomInt(20_000, 32_768);
}

/**
 * One `GET /healthz` over `stream` (voxl answers it without the login): true on a 200. The stream
 * is ended either way.
 */
export function voxlHealthz(stream: Duplex, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let head = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    stream.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n");
      if (end >= 0) finish(/^HTTP\/1\.[01] 200 /.test(head.slice(0, end + 1)));
      else if (head.length > 4096) finish(false);
    });
    stream.once("error", () => finish(false));
    stream.once("close", () => finish(false));
    stream.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

/** Where `/usr/local/bin` is not on the sessions' PATH, deploy's symlink is still found. */
const DEPLOY_LINK = "/usr/local/bin/voxl";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The voxl binary to use, in order: `ORQUESTER_VOXL_BIN` (when set it is the only candidate),
 * `<appdir>/bin/voxl`, the sessions' PATH, then `/usr/local/bin/voxl` (install-voxl.sh's link).
 */
export function resolveVoxlBinary(options: { baseDir: string; env?: NodeJS.ProcessEnv; path?: string }): {
  path: string | null;
  reason?: string;
} {
  const explicit = (options.env ?? process.env).ORQUESTER_VOXL_BIN?.trim();
  if (explicit) {
    return executable(explicit) ? { path: explicit } : { path: null, reason: `ORQUESTER_VOXL_BIN (${explicit}) is not an executable file.` };
  }
  const inAppdir = voxlBinaryPath(options.baseDir);
  if (executable(inAppdir)) return { path: inAppdir };
  const onPath = resolveTool("voxl", options.path ?? sessionPath());
  if (onPath) return { path: onPath };
  if (executable(DEPLOY_LINK)) return { path: DEPLOY_LINK };
  return { path: null, reason: "voxl is not installed on the server (deploy/install-voxl.sh installs it)." };
}

/** `voxl 0.3.4` → `0.3.4`; null for anything else. */
export function parseVoxlVersion(stdout: string): string | null {
  const match = /^voxl (\S+)\s*$/m.exec(stdout);
  return match ? match[1]! : null;
}

const VERSION_TIMEOUT_MS = 10_000;

/** `<bin> --version` (bounded): its version, or why it did not run (a missing library, another arch). */
export function voxlVersionOf(bin: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<{ version: string } | { reason: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: timeoutMs, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }, (error, stdout, stderr) => {
      const version = parseVoxlVersion(String(stdout ?? ""));
      if (!error && version) {
        resolve({ version });
        return;
      }
      const detail = String(stderr ?? "").trim().split("\n").at(-1) || (error?.message ?? "no version printed");
      resolve({ reason: `${bin} --version failed: ${detail.slice(0, MAX_REASON)}` });
    });
  });
}

/**
 * This host's voxl (R4.7): resolved on every call (installing it lights it up without a restart),
 * `--version` run once per path and modification time. Optional: it never makes desktops unavailable.
 */
export class VoxlProbe {
  private cached: { key: string; result: Promise<{ version: string } | { reason: string }> } | null = null;

  constructor(
    private readonly options: {
      baseDir: string;
      env?: () => NodeJS.ProcessEnv;
      path?: () => string;
      version?: (bin: string) => Promise<{ version: string } | { reason: string }>;
    }
  ) {}

  async status(): Promise<DesktopVoxlStatus> {
    const found = resolveVoxlBinary({ baseDir: this.options.baseDir, env: this.options.env?.(), path: this.options.path?.() });
    if (found.path === null) return { available: false, version: null, path: null, reason: found.reason };
    let mtime = 0;
    try {
      mtime = statSync(found.path).mtimeMs;
    } catch {
      /* raced with a removal: the version run says so */
    }
    const key = `${found.path}\0${mtime}`;
    if (this.cached?.key !== key) {
      this.cached = { key, result: (this.options.version ?? voxlVersionOf)(found.path) };
    }
    const result = await this.cached.result;
    return "version" in result
      ? { available: true, version: result.version, path: found.path }
      : { available: false, version: null, path: found.path, reason: result.reason };
  }
}
