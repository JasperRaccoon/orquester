/**
 * What a box device host runs in its box, over `BoxConnection` (never SSH, never a shell around a
 * secret): where the device state lives, the probe, the pinned-tool install, the hub's and the
 * agent-device daemon's start commands, and a bounded `exec` helper.
 *
 * Secrets: the hub's session token and the agent-device daemon's token are generated in the box
 * (expo-device-hub's `--require-token` mints its own; agent-device writes `daemon.json`, 0600) and
 * read back over the box link into daemon memory. Neither ever appears in a process argument, an
 * env var the daemon sets, or a log line; the hub's stdout (its startup link carries the token)
 * goes to /dev/null.
 */

import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { BoxConnection, BoxExecOptions } from "../../../boxes/contracts.ts";
import { BOX_DEVICES_DIR, DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";

/** The detached `orq-agent` process id of the hub. */
export const HUB_PROC_ID = "orq-devices-hub";
/** The hub's ring buffer in `orq-agent` (stderr only: stdout goes to /dev/null). */
export const HUB_BUFFER_BYTES = 256 * 1024;
/** Spike: serve-sim H.264 fails in Apple VMs; MJPEG at this size and quality is ~2 Mbit/s at 5–7 fps. */
export const IOS_VM_STREAM_FLAGS: readonly string[] = ["--transport", "mjpeg", "--max-dimension", "1000", "--mjpeg-quality", "0.6"];
/** Physical Macs encode H.264 in hardware. */
export const IOS_HARDWARE_STREAM_FLAGS: readonly string[] = ["--transport", "h264"];

/** Where a box keeps its device state (tools, hub and agent-device state, uploads). */
export interface RemoteLayout {
  root: string;
  /** npm prefix of the pinned tools (the device-tools cache restores it on Blacksmith). */
  tools: string;
  /** `EXPO_DEVICE_HUB_STATE_DIR`: the hub writes `server-<port>.json` (pid, port, token; 0600) here. */
  hubState: string;
  /** `AGENT_DEVICE_STATE_DIR`: `daemon.json` (port, token; 0600). */
  agentState: string;
  /** Builds streamed in by `uploadFile`. */
  uploads: string;
  hubEntry: string;
  agentDeviceEntry: string;
}

/**
 * Blacksmith boxes use {@link BOX_DEVICES_DIR} (the workflow's paths step makes it the runner
 * user's and the device caches restore there); the owner's own machines use `~/.orquester/devices`
 * (no root needed).
 */
export function remoteLayout(input: { provider: string; home: string }): RemoteLayout {
  const root = input.provider === "byo" ? posix.join(input.home, ".orquester", "devices") : BOX_DEVICES_DIR;
  const tools = posix.join(root, "tools");
  return {
    root,
    tools,
    hubState: posix.join(root, "hub"),
    agentState: posix.join(root, "agent-device"),
    uploads: posix.join(root, "uploads"),
    hubEntry: posix.join(tools, "node_modules", "expo-device-hub", "dist", "server", "cli.mjs"),
    agentDeviceEntry: posix.join(tools, "node_modules", "agent-device", "bin", "agent-device.mjs")
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Prints `key=value` lines: the PATH processes get (the usual Homebrew and user dirs first), Node,
 * npm, the OS, whether it is a VM (`kern.hv_vmm_present`, macOS), Xcode and `simctl`, and KVM
 * (Linux). No secrets; constants only.
 */
export const PROBE_SCRIPT = `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
printf 'path=%s\\n' "$PATH"
printf 'os=%s\\n' "$(uname -s)"
node=$(command -v node 2>/dev/null || true)
printf 'node=%s\\n' "$node"
if [ -n "$node" ]; then printf 'node_version=%s\\n' "$("$node" --version 2>/dev/null)"; fi
printf 'npm=%s\\n' "$(command -v npm 2>/dev/null || true)"
if [ "$(uname -s)" = Darwin ]; then
  printf 'vm=%s\\n' "$(sysctl -n kern.hv_vmm_present 2>/dev/null)"
  printf 'xcode=%s\\n' "$(xcodebuild -version 2>/dev/null | tr '\\n' ' ')"
  if xcrun simctl help > /dev/null 2>&1; then echo simctl=1; else echo simctl=0; fi
else
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then echo kvm=1; else echo kvm=0; fi
fi
`;

export interface RemoteProbe {
  path: string;
  os: string;
  nodePath: string | null;
  /** Major version, or null when there is no Node. */
  nodeMajor: number | null;
  nodeVersion: string | null;
  npmPath: string | null;
  /** macOS: whether it is a virtual machine (no hardware H.264 encoder); null when unknown. */
  vm: boolean | null;
  /** macOS: `Xcode 26.6 Build version 17E202`, or null. */
  xcode: string | null;
  simctl: boolean;
  kvm: boolean | null;
}

export function parseProbe(stdout: string): RemoteProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const text = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "" ? null : value;
  };
  const nodeVersion = text("node_version");
  const major = nodeVersion ? Number(/^v?(\d+)\./.exec(nodeVersion)?.[1]) : NaN;
  const flag = (key: string) => (values.get(key) === "1" ? true : values.get(key) === "0" ? false : null);
  return {
    path: text("path") ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    os: text("os") ?? "unknown",
    nodePath: text("node"),
    nodeMajor: Number.isFinite(major) ? major : null,
    nodeVersion,
    npmPath: text("npm"),
    vm: flag("vm"),
    xcode: text("xcode"),
    simctl: values.get("simctl") === "1",
    kvm: flag("kvm")
  };
}

/** The env every device command in the box runs with: the probed PATH with Node's dir first. */
export function remoteEnv(probe: Pick<RemoteProbe, "path" | "nodePath">): Record<string, string> {
  const nodeDir = probe.nodePath ? posix.dirname(probe.nodePath) : null;
  return { PATH: nodeDir ? `${nodeDir}:${probe.path}` : probe.path, FORCE_COLOR: "0", NO_COLOR: "1" };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const DEVICE_TOOL_PACKAGES: readonly string[] = Object.entries(DEVICE_TOOL_VERSIONS).map(([name, version]) => `${name}@${version}`);

/**
 * Install the pinned tools into `$TOOLS` the way the cache-warming workflow does
 * (`DEVICE_TOOLS_STEP_SCRIPT`), so a restored cache and an install look the same. `$TOOLS` comes
 * from the env; the packages are this build's constants.
 */
export const INSTALL_TOOLS_SCRIPT = `set -eu
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || printf '{ "private": true }\\n' > package.json
npm install --no-audit --no-fund --save-exact ${DEVICE_TOOL_PACKAGES.map((spec) => `'${spec}'`).join(" ")}
`;

/** The installed version of a tool from its `package.json` text, or null. */
export function installedToolVersion(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The hub and the agent-device daemon
// ---------------------------------------------------------------------------

/**
 * The hub's detached command: `/bin/sh -c 'exec "$@" > /dev/null'` around Node and the hub CLI on
 * a random loopback port with `--require-token` (the startup link on stdout carries the token, so
 * stdout is dropped; stderr stays in `orq-agent`'s buffer). iOS VMs stream MJPEG
 * ({@link IOS_VM_STREAM_FLAGS}).
 */
export function hubCommand(input: {
  nodePath: string;
  layout: RemoteLayout;
  platform: "ios" | "android";
  streamFlags: readonly string[];
  env: Record<string, string>;
}): BoxExecOptions {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      'exec "$@" > /dev/null',
      HUB_PROC_ID,
      input.nodePath,
      input.layout.hubEntry,
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--require-token",
      "--hide-sidebar",
      "--hide-boot-device",
      "--platform",
      input.platform,
      ...input.streamFlags
    ],
    cwd: input.layout.root,
    env: { ...input.env, EXPO_DEVICE_HUB_STATE_DIR: input.layout.hubState },
    envUnset: ["EXPO_DEVICE_HUB_SESSION_TOKEN", "EXPO_DEVICE_HUB_BASE_PATH"],
    detach: { procId: HUB_PROC_ID, bufferBytes: HUB_BUFFER_BYTES }
  };
}

/** A hub state file (`server-<port>.json`). */
export interface HubState {
  pid: number;
  port: number;
  token: string | null;
}

export function parseHubState(text: string): HubState | null {
  try {
    const value = JSON.parse(text) as { pid?: unknown; port?: unknown; token?: unknown };
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port)) return null;
    return { pid: value.pid as number, port: value.port as number, token: typeof value.token === "string" ? value.token : null };
  } catch {
    return null;
  }
}

/** The env of every agent-device command in the box: our daemon's state dir, HTTP server, no idle exit. */
export function agentDeviceEnv(layout: RemoteLayout, env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    AGENT_DEVICE_STATE_DIR: layout.agentState,
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    // The daemon would exit after 5 idle minutes; the device service owns its life instead.
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1"
  };
}

/**
 * Node script (`node -e`, entry in `ORQ_AD_ENTRY`): reuse a healthy agent-device daemon of the
 * state dir, else start one (`devices --json` starts it detached — its own session, so it outlives
 * the call) and print `{"httpPort", "token"}` from its `daemon.json`. agent-device has no
 * `daemon start`; t3code starts it the same way.
 */
export const AGENT_DEVICE_START_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const state = process.env.AGENT_DEVICE_STATE_DIR;
const entry = process.env.ORQ_AD_ENTRY;
const file = path.join(state, 'daemon.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const healthy = async (port) => { try { return (await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
(async () => {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  let daemon = read();
  if (daemon && !(Number.isInteger(daemon.httpPort) && await healthy(daemon.httpPort))) {
    spawnSync(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state], { stdio: 'ignore', timeout: 30000 });
    fs.rmSync(file, { force: true });
    daemon = null;
  }
  if (!daemon) {
    const env = { ...process.env };
    delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG; delete env.ORQ_AD_ENTRY;
    const run = spawnSync(process.execPath, [entry, 'devices', '--json'], { env, encoding: 'utf8', timeout: 180000 });
    daemon = read();
    if (!daemon) { console.error('agent-device did not start its daemon: ' + String(run.stderr || run.error || '').slice(-1500)); process.exit(1); }
  }
  if (!Number.isInteger(daemon.httpPort) || typeof daemon.token !== 'string' || !await healthy(daemon.httpPort)) { console.error('the agent-device daemon is not healthy'); process.exit(1); }
  process.stdout.write(JSON.stringify({ httpPort: daemon.httpPort, token: daemon.token }) + '\n');
})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });
`;

export function parseAgentDeviceStart(stdout: string): { httpPort: number; token: string } | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const value = JSON.parse(line) as { httpPort?: unknown; token?: unknown };
    if (!Number.isInteger(value.httpPort) || typeof value.token !== "string" || value.token.length === 0) return null;
    return { httpPort: value.httpPort as number, token: value.token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

export interface RemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const OUTPUT_MAX = 4 * 1024 * 1024;

/**
 * Run a command in the box to completion (never through a shell unless the caller passes
 * `/bin/sh -c` with constant text). The exit code is -1 when it was killed; rejects when it could
 * not start, timed out or was aborted.
 */
export function execRemote(
  connection: BoxConnection,
  spec: Omit<BoxExecOptions, "signal" | "detach" | "pty">,
  options: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void } = {}
): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal));
      return;
    }
    let proc;
    try {
      proc = connection.exec(spec);
    } catch (error) {
      reject(error);
      return;
    }
    proc.stdin.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let open = 2;
    let exitCode: number | null | undefined;
    const maybeDone = () => {
      if (open === 0 && exitCode !== undefined) finish(null, exitCode);
    };
    const collect = (stream: NodeJS.ReadableStream, sink: (text: string) => void) => {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open -= 1;
        maybeDone();
      };
      stream.once("end", end);
      stream.once("close", end);
      stream.once("error", end);
      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        sink(text);
        if (options.onLine) {
          pending += text;
          const lines = pending.split(/\r?\n|\r/);
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) options.onLine(line);
        }
      });
    };
    collect(proc.stdout, (text) => {
      if (stdout.length < OUTPUT_MAX) stdout += text;
    });
    collect(proc.stderr, (text) => {
      if (stderr.length < OUTPUT_MAX) stderr += text;
    });
    const finish = (error: Error | null, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ exitCode: code ?? -1, stdout, stderr });
    };
    const onAbort = () => {
      proc.kill("SIGKILL");
      finish(abortError(options.signal!));
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          proc.kill("SIGKILL");
          finish(new Error(`${posix.basename(spec.command)} ${spec.args?.[0] ?? ""} timed out after ${Math.round(options.timeoutMs! / 1000)} s`.replace(/\s+/g, " ")));
        }, options.timeoutMs)
      : undefined;
    timer?.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    proc.once("error", (error) => finish(error));
    // Resolves once it exited and both streams ended (their last chunks may follow the exit).
    proc.once("exit", (code) => {
      exitCode = code;
      maybeDone();
    });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** The last non-empty lines of command output, for an owner-facing message (no secrets reach it). */
export function outputTail(text: string, lines = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ")
    .slice(0, 400);
}
