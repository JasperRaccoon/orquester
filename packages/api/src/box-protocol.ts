/**
 * The wire protocol between the daemon and `orq-agent`, the program Orquester
 * runs in every box (spec 2026-10-19-ephemeral-ai-vms-design.md §5). Pure
 * types and small pure helpers: shared by the daemon (`apps/daemon/src/boxes`)
 * and `orq-agent` (`apps/box-agent`), so both sides compile against one source.
 *
 * ## Transport
 *
 * One WebSocket per box, opened BY THE BOX to `boxRoutes.connect` (it dials
 * out, so NAT, containers and Actions runners work). Two frame types:
 *
 * - **Text frames**: one JSON {@link BoxControlMessage} each.
 * - **Binary frames**: channel data — `[u32 BE channel id][u8 stream][payload…]`
 *   ({@link encodeDataFrame} / {@link decodeDataFrame}).
 *
 * The first frame is the box's {@link BoxHello}. The daemon answers
 * {@link BoxWelcome} or {@link BoxReject} and closes on reject. No other frame
 * may precede `welcome`.
 *
 * ## Requests
 *
 * Either side may send `req`; the other answers `res` with the same `id`.
 * Ids are per sender (each side counts its own from 1). Unknown methods answer
 * `{ ok: false, error: { code: "UNKNOWN_METHOD" } }`. Methods are namespaced
 * (see {@link BOX_RPC_NAMESPACES}); typed core methods are in
 * {@link BoxHostToBoxMethods} and {@link BoxBoxToHostMethods}; features may add
 * more under their own namespace and type them where they live.
 *
 * ## Channels
 *
 * A channel is a bidirectional byte stream with an open/close handshake:
 * `open` → `opened` | `open-failed`, then data frames, `eof` (half-close of one
 * stream), `exit` (exec only: the process ended — sent after all its output),
 * and `close` (either side; frees the id). Channel ids: the daemon opens EVEN
 * ids (2, 4, …), the box opens ODD ids (1, 3, …) — no collisions.
 *
 * `close` is not answered; data arriving for a closed id is dropped, and ids
 * are never reused within one connection. The side that finishes sends it:
 * the box after `exit` (exec/attach) or after its last stream-1 `eof`
 * (file-read, tar-read, tcp). For `file-write` and `tar-write` the box
 * confirms success with `eof` on stream 1 and then `close`; a `close` that
 * carries `error` (or arrives without that `eof`) means the write failed and
 * nothing was replaced.
 *
 * Streams within a channel ({@link BoxStream}): `0` = data toward the box
 * (stdin, upload bytes, tcp bytes from host), `1` = data from the box (stdout,
 * download bytes, tcp bytes from box), `2` = stderr (exec only).
 *
 * **Flow control**: each side may send at most {@link BOX_CHANNEL_WINDOW_BYTES}
 * of unacknowledged data per channel per direction; the receiver returns
 * `credit` as it consumes. A sender with no credit pauses its source.
 *
 * ## Detached processes and reattach
 *
 * An `exec` with `detach` keeps running if the connection drops (daemon
 * restart, network blip). `orq-agent` keeps its output in a ring buffer of
 * `detach.bufferBytes` and reports it in the next `hello.procs`. The daemon
 * reattaches with an `attach` channel from the byte offset it last saw;
 * output before the buffer's start is lost and reported as `droppedBytes`.
 * Offsets count stdout and stderr bytes together, in emission order.
 *
 * ## Secrets
 *
 * Tokens travel only inside `hello`/`welcome`, `token.*` and `git.credential`
 * results, and `exec` env. Neither side logs a control frame's params, env or
 * results; logs carry method names, channel kinds and sizes only.
 */

import type { BoxArch, BoxLibc, BoxOs } from "./boxes.ts";

/** Bumped on any incompatible change. Both sides refuse a different major. */
export const BOX_PROTOCOL_VERSION = 1;

/** Per-channel, per-direction unacknowledged-bytes window. */
export const BOX_CHANNEL_WINDOW_BYTES = 1024 * 1024;

/** Largest payload in one binary frame (the 5-byte header comes on top). */
export const BOX_MAX_FRAME_PAYLOAD = 256 * 1024;

/** How often each side pings; a peer silent for 3 intervals is considered gone. */
export const BOX_HEARTBEAT_MS = 15_000;

/** Default ring buffer for detached process output. */
export const BOX_DETACH_BUFFER_BYTES = 4 * 1024 * 1024;

export type BoxStream = 0 | 1 | 2;
export const BOX_STREAM_TO_BOX: BoxStream = 0;
export const BOX_STREAM_FROM_BOX: BoxStream = 1;
export const BOX_STREAM_STDERR: BoxStream = 2;

// ---------------------------------------------------------------------------
// Box facts
// ---------------------------------------------------------------------------

/** What `orq-agent` reports about its machine in `hello`. */
export interface BoxSysInfo {
  os: BoxOs;
  arch: BoxArch;
  /** Linux only; null elsewhere or when undetectable. */
  libc: BoxLibc | null;
  hostname: string;
  /** e.g. "Ubuntu 24.04.1 LTS", "macOS 15.5", "Windows Server 2022". */
  osRelease: string;
  /** The account `orq-agent` runs as. */
  user: string;
  isRoot: boolean;
  /** Passwordless sudo (or Administrator on Windows). */
  canElevate: boolean;
  home: string;
  /** Default shell: "/bin/bash", "/bin/zsh", "powershell.exe". */
  shell: string;
  /** Whether tmux ≥ 3.2 is available for persistent terminals. */
  tmux: boolean;
  /** Whether a working Docker daemon is reachable. */
  docker: boolean;
  cpus: number;
  memBytes: number;
  /** GPU names from nvidia-smi or the OS, empty when none. */
  gpus: string[];
  /** Absolute path of the running `orq-agent` executable. */
  agentPath: string;
  /** `orq-agent`'s own state dir (buffers, tool installs). */
  dataDir: string;
  /** Running inside a container (no systemd, limited kernel features). */
  container: boolean;
  /**
   * Linux: `/dev/kvm` exists and the account processes run as can open it read-write (Android
   * emulators need it). False elsewhere; absent from `orq-agent` builds that predate it.
   */
  kvm?: boolean;
}

/**
 * How host paths map to box paths (spec §8.6). POSIX boxes use the host's
 * absolute paths unchanged. Windows boxes put them under a drive prefix:
 * host `/var/lib/orquester/x` → `C:\orq\var\lib\orquester\x`.
 */
export type BoxPathMap = { kind: "identity" } | { kind: "windows-prefix"; prefix: string };

export const BOX_WINDOWS_PATH_PREFIX = "C:\\orq";

export function boxPathMapFor(os: BoxOs): BoxPathMap {
  return os === "win32" ? { kind: "windows-prefix", prefix: BOX_WINDOWS_PATH_PREFIX } : { kind: "identity" };
}

/** Map an absolute POSIX host path to the box's path. Throws on a relative path. */
export function hostToBoxPath(map: BoxPathMap, hostPath: string): string {
  if (!hostPath.startsWith("/")) {
    throw new Error(`Not an absolute host path: ${hostPath}`);
  }
  if (map.kind === "identity") return hostPath;
  const segments = hostPath.split("/").filter((segment) => segment.length > 0);
  return [map.prefix.replace(/[\\/]+$/, ""), ...segments].join("\\");
}

/** Inverse of {@link hostToBoxPath}; null when the box path is outside the mapping. */
export function boxToHostPath(map: BoxPathMap, boxPath: string): string | null {
  if (map.kind === "identity") return boxPath.startsWith("/") ? boxPath : null;
  const prefix = map.prefix.replace(/[\\/]+$/, "");
  const normalized = boxPath.replace(/\//g, "\\");
  if (normalized.toLowerCase() === prefix.toLowerCase()) return "/";
  if (!normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) return null;
  const rest = normalized.slice(prefix.length + 1).split("\\").filter((segment) => segment.length > 0);
  return `/${rest.join("/")}`;
}

/**
 * The executable name for a platform in `boxRoutes.agentBinary`:
 * `linux-x64`, `linux-arm64-musl`, `darwin-arm64`, `win32-x64`, …
 */
export function boxAgentPlatform(os: BoxOs, arch: BoxArch, libc: BoxLibc | null): string {
  return os === "linux" && libc === "musl" ? `${os}-${arch}-musl` : `${os}-${arch}`;
}

export const BOX_AGENT_PLATFORMS: readonly string[] = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-arm64",
  "darwin-x64",
  "win32-x64"
];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * How a box proves who it is:
 * - `bootstrap` — the single-use token minted at creation (first connect only).
 * - `credential` — the per-box credential issued in the first `welcome`.
 * - `github-oidc` — a GitHub Actions OIDC JWT (macOS runners); the daemon checks
 *   repository, run id and audience against the dispatch it made.
 */
export type BoxAuth =
  | { kind: "bootstrap"; token: string }
  | { kind: "credential"; boxId: string; credential: string }
  | { kind: "github-oidc"; boxId: string; jwt: string };

export interface BoxDetachedProcInfo {
  procId: string;
  /** OS pid, when running. */
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Total output bytes emitted so far (stdout+stderr). */
  outputBytes: number;
  /** Offset of the first byte still in the ring buffer. */
  bufferStart: number;
  /**
   * Set when a previous `orq-agent` started the process and this one could not follow it after
   * a restart (its output ended with that `orq-agent`): why, and whether it was stopped. Such a
   * process is not running, refuses an attach (`LOST`), and is released like any ended one.
   */
  lost?: string;
}

export interface BoxHello {
  t: "hello";
  protocol: number;
  agentVersion: string;
  auth: BoxAuth;
  sys: BoxSysInfo;
  procs: BoxDetachedProcInfo[];
}

export interface BoxAgentConfig {
  paths: BoxPathMap;
  heartbeatMs: number;
  /** Ports `orq-agent` should listen on in the box (127.0.0.1) and pipe to host targets (re-established on every connect). */
  forwards: BoxForwardSpec[];
}

export interface BoxForwardSpec {
  /** Box-local port to listen on (127.0.0.1 only). */
  boxPort: number;
  /** Opaque daemon-side target id passed back in `host-tcp` channel opens. */
  target: string;
}

export interface BoxWelcome {
  t: "welcome";
  boxId: string;
  /** Issued once, on a `bootstrap` hello: `orq-agent` stores it (mode 0600) and uses it for every later connect. */
  credential?: string;
  config: BoxAgentConfig;
}

export type BoxRejectCode =
  | "AUTH_FAILED"
  | "PROTOCOL_MISMATCH"
  | "AGENT_OUTDATED"
  | "BOX_DESTROYED"
  | "BOXES_DISABLED"
  | "DUPLICATE";

export interface BoxReject {
  t: "reject";
  code: BoxRejectCode;
  message: string;
  /** `AGENT_OUTDATED`: where to download the matching build (box-authenticated). */
  upgradeUrl?: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface BoxRpcError {
  code: string;
  message: string;
}

export interface BoxRequestMessage {
  t: "req";
  id: number;
  method: string;
  params: unknown;
}

export type BoxResponseMessage =
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: BoxRpcError };

export interface BoxEventMessage {
  t: "event";
  name: string;
  data: unknown;
}

/** Reserved method namespaces; a feature adds methods only under its own. */
export const BOX_RPC_NAMESPACES = [
  "fs", // file system (host → box)
  "sys", // machine info, ports, stats (host → box)
  "proc", // detached processes (host → box)
  "forward", // port forwards (host → box)
  "agent", // orq-agent self-management (host → box)
  "token", // agent access tokens (box → host)
  "git", // git credentials (box → host)
  "sync", // config and transcript sync (both)
  "tooling", // plugin tooling installs (host → box)
  "mcp" // MCP bridge bookkeeping (both)
] as const;

export interface BoxFsStat {
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  /** Device + inode as a string, for rename conflict checks; null on Windows when unavailable. */
  identity: string | null;
}

export interface BoxFsDirEntry {
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface BoxListeningPort {
  port: number;
  /** "127.0.0.1", "0.0.0.0", "::" … */
  address: string;
  pid: number | null;
  command: string | null;
}

export interface BoxStats {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
}

/** Core host → box methods: `method → [params, result]`. */
export interface BoxHostToBoxMethods {
  "fs.stat": [{ path: string; followSymlinks?: boolean }, BoxFsStat | null];
  "fs.readdir": [{ path: string }, BoxFsDirEntry[]];
  "fs.realpath": [{ path: string }, string];
  "fs.mkdir": [{ path: string; recursive?: boolean; mode?: number }, void];
  "fs.rename": [{ from: string; to: string }, void];
  "fs.rm": [{ path: string; recursive?: boolean; force?: boolean }, void];
  "fs.chmod": [{ path: string; mode: number }, void];
  "fs.symlink": [{ target: string; path: string }, void];
  /** Watch a tree; changes arrive as `fs.change` events tagged with `watchId`. */
  "fs.watch": [{ watchId: string; path: string; recursive: boolean; ignore?: string[] }, void];
  "fs.unwatch": [{ watchId: string }, void];
  "sys.info": [Record<string, never>, BoxSysInfo];
  "sys.ports": [Record<string, never>, BoxListeningPort[]];
  "sys.stats": [Record<string, never>, BoxStats];
  "proc.list": [Record<string, never>, BoxDetachedProcInfo[]];
  "proc.signal": [{ procId: string; signal: string }, void];
  /** Forget a finished detached process and its buffer. */
  "proc.release": [{ procId: string }, void];
  /** Listen on box 127.0.0.1:`boxPort` and pipe each connection to host `target` (a `host-tcp` channel). */
  "forward.listen": [BoxForwardSpec, void];
  "forward.unlisten": [{ boxPort: number }, void];
  /** Create directories (with parents) owned by the box's working user. */
  "agent.ensurePaths": [{ paths: string[] }, void];
  /** Replace the executable with the build at `url` (sha256-checked) and restart; the connection drops and returns. */
  "agent.update": [{ url: string; sha256: string }, void];
  /** Exit for good (the box is being destroyed, or the macOS job should end successfully). */
  "agent.shutdown": [{ reason: string }, void];
}

/** Core box → host methods. */
export interface BoxBoxToHostMethods {
  /**
   * An agent CLI in the box needs its access token (spec §7). Never returns a refresh token.
   * `agent` is the CLI; `accountId` the managed account the session was launched with;
   * `rejectedAccessToken` the token the CLI was just refused with (renewed when still current).
   */
  "token.get": [
    { agent: "claude" | "codex" | "grok"; accountId: string; minValidSeconds?: number; rejectedAccessToken?: string },
    { accessToken: string; expiresAt: number | null; extra?: Record<string, string> }
  ];
  /**
   * `git credential <operation>` protocol: `input` is the helper's stdin (key=value lines), the
   * result its stdout. Only `get` returns credentials; `store`/`erase` are accepted and ignored.
   */
  "git.credential": [{ operation: "get" | "store" | "erase"; input: string }, { output: string }];
}

export type BoxMethodName<M> = keyof M & string;
export type BoxMethodParams<M, K extends keyof M> = M[K] extends [infer P, unknown] ? P : never;
export type BoxMethodResult<M, K extends keyof M> = M[K] extends [unknown, infer R] ? R : never;

/** `fs.change` event payload. */
export interface BoxFsChangeEvent {
  watchId: string;
  changes: { path: string; type: "create" | "update" | "delete" }[];
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface BoxPtySpec {
  cols: number;
  rows: number;
  term?: string;
}

export type BoxChannelSpec =
  /** Host → box: run a process. With `pty` stdout carries the terminal and stderr is unused. */
  | {
      kind: "exec";
      command: string;
      args: string[];
      cwd?: string;
      /** Merged over `orq-agent`'s own environment (with `envUnset` removed first). */
      env?: Record<string, string>;
      envUnset?: string[];
      pty?: BoxPtySpec;
      /** Keep running across disconnects (see the module doc). `procId` is chosen by the daemon. */
      detach?: { procId: string; bufferBytes?: number };
      /** Run inside a shell (`sh -c` / `powershell -Command`): `command` is the whole command line and `args` must be empty. */
      shell?: boolean;
    }
  /** Host → box: reattach to a detached process, replaying output from `fromOffset`. Input works as for `exec`. */
  | { kind: "attach"; procId: string; fromOffset: number }
  /** Host → box: TCP connection to `host:port` as seen from the box (default host 127.0.0.1). */
  | { kind: "tcp"; host?: string; port: number }
  /** Host → box: a stream connection to the Unix socket at `path` (absolute) in the box: a desktop's VNC, X11 and PulseAudio sockets. */
  | { kind: "unix"; path: string }
  /** Box → host: a connection accepted on a `forward.listen` port, for daemon target `target`. */
  | { kind: "host-tcp"; target: string; boxPort: number }
  /** Host → box: stream a file's bytes (stream 1). */
  | { kind: "file-read"; path: string; offset?: number; length?: number }
  /** Host → box: write a file from stream 0; atomic (temp + rename) unless `append`. `opened.info.bytes` = 0. */
  | { kind: "file-write"; path: string; mode?: number; mkdirs?: boolean; append?: boolean }
  /** Host → box: a directory (or file) as a tar stream (stream 1). */
  | { kind: "tar-read"; path: string; exclude?: string[] }
  /**
   * Host → box: extract a tar stream (stream 0) into directory `path`. `compression: "gzip"`: the
   * stream is gzipped and `orq-agent` inflates it before `tar` reads it (an `orq-agent` older than
   * the field ignores it and its `tar` fails on the gzip bytes, so a sender falls back to plain).
   */
  | { kind: "tar-write"; path: string; compression?: "gzip" }
  /** Box → host: an SSH agent connection (OpenSSH agent protocol bytes); the daemon answers with host keys. */
  | { kind: "ssh-agent" }
  /** Box → host: a stdio MCP server bridged to the host (`orq-agent mcp-bridge <serverId>`). */
  | { kind: "mcp-bridge"; serverId: string };

export type BoxChannelKind = BoxChannelSpec["kind"];

export interface BoxChannelOpenedInfo {
  /** exec/attach: OS pid. */
  pid?: number;
  /** attach: bytes lost before `fromOffset` because the buffer had moved on. */
  droppedBytes?: number;
  /** file-read: total file size. */
  size?: number;
}

export type BoxControlMessage =
  | BoxHello
  | BoxWelcome
  | BoxReject
  | { t: "ping"; id: number }
  | { t: "pong"; id: number }
  | BoxRequestMessage
  | BoxResponseMessage
  | BoxEventMessage
  | { t: "open"; ch: number; spec: BoxChannelSpec }
  | { t: "opened"; ch: number; info?: BoxChannelOpenedInfo }
  | { t: "open-failed"; ch: number; error: BoxRpcError }
  | { t: "eof"; ch: number; stream: BoxStream }
  | { t: "exit"; ch: number; code: number | null; signal: string | null }
  | { t: "resize"; ch: number; cols: number; rows: number }
  | { t: "signal"; ch: number; signal: string }
  | { t: "credit"; ch: number; bytes: number }
  /** `error` (optional): why the sender gave up on the channel (a failed write, a broken transfer). */
  | { t: "close"; ch: number; error?: BoxRpcError };

// ---------------------------------------------------------------------------
// Binary frames
// ---------------------------------------------------------------------------

export const BOX_DATA_FRAME_HEADER_BYTES = 5;

export function encodeDataFrame(channel: number, stream: BoxStream, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) {
    throw new RangeError(`Bad channel id ${channel}`);
  }
  if (payload.byteLength > BOX_MAX_FRAME_PAYLOAD) {
    throw new RangeError(`Frame payload of ${payload.byteLength} bytes exceeds ${BOX_MAX_FRAME_PAYLOAD}`);
  }
  const frame = new Uint8Array(BOX_DATA_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, channel, false);
  view.setUint8(4, stream);
  frame.set(payload, BOX_DATA_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeDataFrame(frame: Uint8Array): { channel: number; stream: BoxStream; payload: Uint8Array } {
  if (frame.byteLength < BOX_DATA_FRAME_HEADER_BYTES) {
    throw new RangeError("Data frame shorter than its header");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const stream = view.getUint8(4);
  if (stream !== 0 && stream !== 1 && stream !== 2) {
    throw new RangeError(`Bad stream ${stream}`);
  }
  return {
    channel: view.getUint32(0, false),
    stream,
    payload: frame.subarray(BOX_DATA_FRAME_HEADER_BYTES)
  };
}

/** Parse a text frame; null when it is not a well-formed control message (the peer then closes with 1002). */
export function parseControlMessage(text: string): BoxControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const t = (value as { t?: unknown }).t;
  return typeof t === "string" ? (value as BoxControlMessage) : null;
}
