/**
 * A scripted Mac box for box-host tests: a `BoxConnection` whose exec, files, detached processes
 * and forwards act like a Blacksmith Mac running `xcrun simctl`, expo-device-hub and agent-device,
 * and a `fetch` that answers for the forwarded hub and agent-device ports. Every command and hub
 * call is logged in order. For tests only.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";

import type { BoxDetachedProcInfo, BoxSysInfo } from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxHostForward, BoxProcess } from "../../../boxes/contracts.ts";
import { localSysInfo } from "../../../boxes/testing.ts";
import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { AGENT_DEVICE_START_SCRIPT, HUB_PROC_ID, INSTALL_TOOLS_SCRIPT, PROBE_SCRIPT } from "./remote.ts";
import { FRAME_SIZE_SCRIPT } from "./simctl.ts";

/** What `simctl list -j devicetypes runtimes` answers on the fake Mac (Xcode 26.6 on Blacksmith). */
export const FAKE_SIM_CATALOG = {
  devicetypes: [
    { name: "iPhone 17 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", productFamily: "iPhone" },
    { name: "iPhone 17 Pro Max", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max", productFamily: "iPhone" },
    { name: "iPad Pro 13-inch (M4)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB", productFamily: "iPad" }
  ],
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
      name: "iOS 26.2",
      version: "26.2",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        { name: "iPhone 17 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", productFamily: "iPhone" },
        { name: "iPad Pro 13-inch (M4)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB", productFamily: "iPad" }
      ]
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      name: "iOS 27.0",
      version: "27.0",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        { name: "iPhone 17 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", productFamily: "iPhone" },
        { name: "iPhone 17 Pro Max", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max", productFamily: "iPhone" },
        { name: "iPad Pro 13-inch (M4)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB", productFamily: "iPad" }
      ]
    }
  ]
};

interface FakeSim {
  udid: string;
  name: string;
  state: "Shutdown" | "Booted";
  runtimeId: string;
}

class FakeProcess extends EventEmitter implements BoxProcess {
  readonly stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(
    readonly pid: number,
    readonly procId: string | null,
    private readonly onKill?: () => void
  ) {
    super();
  }

  finish(code: number, stdout = "", stderr = ""): void {
    setImmediate(() => {
      this.stdout.end(stdout);
      this.stderr.end(stderr);
      this.exitCode = code;
      this.emit("exit", code, null);
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.onKill?.();
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", null, signal);
    return true;
  }

  resize(): void {}
}

export interface FakeMacBoxOptions {
  boxId?: string;
  home?: string;
  /** Tools already restored from the cache. */
  toolsInstalled?: boolean;
  vm?: boolean;
  nodeVersion?: string | null;
  /** Successive screenshot sizes (bytes) `simctl io screenshot` answers; the last repeats. */
  frames?: number[];
}

export class FakeMacBox {
  readonly log: string[] = [];
  readonly files = new Map<string, string>();
  readonly sims = new Map<string, FakeSim>();
  /** Directories that exist (`fs.stat`), e.g. a restored runner cache. */
  readonly dirs = new Set<string>();
  readonly hubToken = "hub-session-token-SECRET";
  readonly agentToken = "agent-device-token-SECRET";
  readonly hubPort = 41_234;
  readonly agentPort = 42_345;
  readonly sys: BoxSysInfo;
  /** Every exec's options, for checks that no secret reaches argv or env. */
  readonly execs: BoxExecOptions[] = [];
  hub: { proc: FakeProcess; pid: number; running: boolean } | null = null;
  agentRunning = false;
  connected = true;
  frames: number[];
  vm: boolean;
  nodeVersion: string | null;
  /** Make the next `simctl <verb>` fail. */
  failNext: string | null = null;
  private readonly status = new EventEmitter();
  private nextPid = 5000;
  private nextUdid = 1;
  private readonly openForwards = new Set<number>();

  constructor(private readonly options: FakeMacBoxOptions = {}) {
    this.sys = localSysInfo({ os: "darwin", arch: "arm64", home: options.home ?? "/Users/runner", user: "runner" });
    this.frames = [...(options.frames ?? [24_000, 2_400_000])];
    this.vm = options.vm ?? true;
    this.nodeVersion = options.nodeVersion === undefined ? "v22.11.0" : options.nodeVersion;
    if (options.toolsInstalled) this.installTools("/var/lib/orquester/devices/tools");
  }

  get forwards(): number[] {
    return [...this.openForwards];
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.status.emit("status", connected);
  }

  private installTools(tools: string): void {
    for (const [name, version] of Object.entries(DEVICE_TOOL_VERSIONS)) {
      this.files.set(`${tools}/node_modules/${name}/package.json`, JSON.stringify({ name, version }));
    }
  }

  private simctl(args: string[]): { code: number; stdout?: string; stderr?: string } {
    const [verb, ...rest] = args;
    if (this.failNext === verb) {
      this.failNext = null;
      return { code: 1, stderr: `An error was encountered processing the command (${verb}).` };
    }
    switch (verb) {
      case "list":
        if (rest.includes("devices")) {
          const devices: Record<string, unknown[]> = {};
          for (const sim of this.sims.values()) {
            (devices[sim.runtimeId] ??= []).push({ udid: sim.udid, name: sim.name, state: sim.state, isAvailable: true });
          }
          return { code: 0, stdout: JSON.stringify({ devices }) };
        }
        return { code: 0, stdout: JSON.stringify(FAKE_SIM_CATALOG) };
      case "create": {
        const udid = `0000000${this.nextUdid++}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`.slice(-36);
        this.sims.set(udid, { udid, name: rest[0]!, state: "Shutdown", runtimeId: rest[2]! });
        return { code: 0, stdout: `${udid}\n` };
      }
      case "boot": {
        const sim = this.sims.get(rest[0]!);
        if (!sim) return { code: 1, stderr: "Invalid device" };
        sim.state = "Booted";
        return { code: 0 };
      }
      case "bootstatus":
        return this.sims.get(rest[0]!)?.state === "Booted" ? { code: 0 } : { code: 1, stderr: "not booted" };
      case "shutdown": {
        const sim = this.sims.get(rest[0]!);
        if (!sim) return { code: 1, stderr: "Invalid device" };
        if (sim.state === "Shutdown") return { code: 149, stderr: "Unable to shutdown device in current state: Shutdown" };
        sim.state = "Shutdown";
        return { code: 0 };
      }
      case "delete":
        return this.sims.delete(rest[0]!) ? { code: 0 } : { code: 1, stderr: "Invalid device" };
      default:
        return { code: 0 };
    }
  }

  connection(): BoxConnection {
    const box = this;
    const exec = (options: BoxExecOptions): BoxProcess => {
      if (!box.connected) throw Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });
      box.execs.push(options);
      const args = options.args ?? [];
      const proc = new FakeProcess(box.nextPid++, options.detach?.procId ?? null);
      if (options.command === "/bin/sh" && args[0] === "-c") {
        const script = args[1];
        if (script === PROBE_SCRIPT) {
          box.log.push("probe");
          const node = box.nodeVersion ? "/Users/runner/hostedtoolcache/node/22.11.0/arm64/bin/node" : "";
          proc.finish(
            0,
            [
              "path=/opt/homebrew/bin:/usr/bin:/bin",
              "os=Darwin",
              `node=${node}`,
              ...(box.nodeVersion ? [`node_version=${box.nodeVersion}`] : []),
              "npm=/usr/local/bin/npm",
              `vm=${box.vm ? 1 : 0}`,
              "xcode=Xcode 26.6 Build version 17E202 ",
              "simctl=1"
            ].join("\n") + "\n"
          );
        } else if (script === INSTALL_TOOLS_SCRIPT) {
          box.log.push("install-tools");
          box.installTools(options.env?.TOOLS ?? "");
          proc.finish(0, "added 120 packages\n");
        } else if (script === 'exec "$@" > /dev/null') {
          box.log.push(`hub-start ${args.slice(5).join(" ")}`);
          const stateDir = options.env?.EXPO_DEVICE_HUB_STATE_DIR ?? "";
          const hubProc = new FakeProcess(box.nextPid++, HUB_PROC_ID, () => {
            if (box.hub) box.hub.running = false;
            box.files.delete(`${stateDir}/server-${box.hubPort}.json`);
          });
          box.hub = { proc: hubProc, pid: hubProc.pid, running: true };
          setImmediate(() => box.files.set(`${stateDir}/server-${box.hubPort}.json`, JSON.stringify({ pid: hubProc.pid, port: box.hubPort, url: "x", token: box.hubToken })));
          return hubProc;
        } else if (script === FRAME_SIZE_SCRIPT) {
          box.log.push(`frame ${args[3]}`);
          const size = box.frames.length > 1 ? box.frames.shift()! : (box.frames[0] ?? 0);
          proc.finish(0, `${size}\n`);
        } else {
          box.log.push(`sh ${args[2] ?? ""}`);
          proc.finish(0);
        }
        return proc;
      }
      if (options.command === "xcrun" && args[0] === "simctl") {
        box.log.push(`simctl ${args.slice(1).join(" ")}`);
        const result = box.simctl(args.slice(1));
        proc.finish(result.code, result.stdout ?? "", result.stderr ?? "");
        return proc;
      }
      if (args[0] === "-e" && args[1] === AGENT_DEVICE_START_SCRIPT) {
        box.log.push("agent-device-start");
        box.agentRunning = true;
        proc.finish(0, `${JSON.stringify({ httpPort: box.agentPort, token: box.agentToken })}\n`);
        return proc;
      }
      if (args[0]?.endsWith("agent-device.mjs")) {
        box.log.push(`agent-device ${args.slice(1).join(" ")}`);
        if (args[1] === "daemon" && args[2] === "stop") box.agentRunning = false;
        proc.finish(0, "{}\n");
        return proc;
      }
      box.log.push(`${options.command} ${args.join(" ")}`);
      if (options.command === "find") proc.finish(0, `${args[0]}/Payload/Demo.app\n`);
      else proc.finish(0);
      return proc;
    };

    const procs = (): BoxDetachedProcInfo[] =>
      box.hub
        ? [{ procId: HUB_PROC_ID, pid: box.hub.running ? box.hub.pid : null, running: box.hub.running, exitCode: null, signal: null, outputBytes: 0, bufferStart: 0 }]
        : [];

    const connection = {
      boxId: box.options.boxId ?? "mac1",
      sys: box.sys,
      paths: { kind: "identity" as const },
      get connected() {
        return box.connected;
      },
      agentVersion: "test",
      detachedProcs: procs,
      async request(method: string, params: Record<string, unknown>) {
        if (!box.connected) throw Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });
        switch (method) {
          case "proc.list":
            return procs();
          case "proc.signal":
            box.log.push(`proc.signal ${String(params.signal)}`);
            if (box.hub?.running) box.hub.proc.kill(params.signal as NodeJS.Signals);
            return undefined;
          case "proc.release":
            if (box.hub && !box.hub.running) box.hub = null;
            return undefined;
          case "fs.mkdir":
            return undefined;
          case "fs.stat":
            return box.dirs.has(String(params.path)) ? { path: params.path, kind: "dir", size: 0, mtimeMs: 0, mode: 0o755, identity: "1:1" } : null;
          case "fs.readdir": {
            const prefix = `${String(params.path)}/`;
            return [...box.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => ({ name: path.slice(prefix.length), kind: "file", size: 1, mtimeMs: 0 }));
          }
          case "fs.rm":
            for (const path of [...box.files.keys()]) if (path === params.path || path.startsWith(`${String(params.path)}/`)) box.files.delete(path);
            return undefined;
          default:
            throw new Error(`UNKNOWN_METHOD ${method}`);
        }
      },
      async requestRaw() {
        throw new Error("UNKNOWN_METHOD");
      },
      exec,
      attach() {
        throw new Error("attach is not supported");
      },
      async openTcp() {
        throw new Error("openTcp is not supported");
      },
      async forwardToHost(boxPort: number): Promise<BoxHostForward> {
        const hostPort = boxPort + 1000;
        box.openForwards.add(hostPort);
        return {
          hostPort,
          boxPort,
          close: async () => void box.openForwards.delete(hostPort)
        };
      },
      async openChannel() {
        throw new Error("openChannel is not supported");
      },
      async readFile(path: string) {
        if (!box.connected) throw new Error("Box is not connected");
        const text = box.files.get(path);
        if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return Readable.from([Buffer.from(text)]);
      },
      async writeFile(path: string, data: Readable | Uint8Array | string) {
        const chunks: Buffer[] = [];
        if (typeof data === "string" || data instanceof Uint8Array) chunks.push(Buffer.from(data));
        else for await (const chunk of data) chunks.push(Buffer.from(chunk as Buffer));
        box.files.set(path, Buffer.concat(chunks).toString("utf8"));
        box.log.push(`write ${path}`);
      },
      async readTar() {
        throw new Error("readTar is not supported");
      },
      async writeTar() {
        throw new Error("writeTar is not supported");
      },
      onEvent() {
        return () => undefined;
      },
      onStatus(listener: (connected: boolean) => void) {
        box.status.on("status", listener);
        return () => void box.status.off("status", listener);
      }
    };
    return connection as unknown as BoxConnection;
  }

  /** `fetch` for the forwarded ports (host port = box port + 1000). */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const port = Number(url.port) - 1000;
    const auth = new Headers(init?.headers).get("authorization");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!this.connected || !this.openForwards.has(Number(url.port))) throw new TypeError("fetch failed: ECONNREFUSED");
    if (port === this.hubPort) {
      if (!this.hub?.running) throw new TypeError("fetch failed: ECONNREFUSED");
      if (url.pathname === "/readyz") return new Response("ok");
      if (auth !== `Bearer ${this.hubToken}`) return json(401, { error: "unauthorized" });
      const body = init?.body ? (JSON.parse(String(init.body)) as { udid?: string }) : {};
      this.log.push(`hub ${url.pathname} ${body.udid ?? ""}`.trim());
      if (url.pathname.endsWith("/grid/api/shutdown")) {
        const sim = body.udid ? this.sims.get(body.udid) : undefined;
        if (sim) sim.state = "Shutdown";
      }
      return json(200, { ok: true });
    }
    if (port === this.agentPort) {
      if (!this.agentRunning) throw new TypeError("fetch failed: ECONNREFUSED");
      return url.pathname === "/health" ? new Response("ok") : json(404, {});
    }
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
}
