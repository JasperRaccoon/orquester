/**
 * The daemon's side of an owner's machine's stream gate (tailnet machines spec §4.5; the gate
 * itself is `gate.mjs`). One per own-machine device host (`hosts/box-host.ts` makes it; the iOS and
 * Android box hosts call it after their hub is up). Over the machine's box link it:
 *
 * 1. uploads `gate.mjs` and `hub-paths.mjs` into `<devices root>/gate/` and writes the gate's 0600
 *    `config.json` (host id, machine id, the per-host secret, the hub's state dir, the port it had
 *    before): the secret is made here once and read back after a daemon restart, like the hub's
 *    token — never in an argument, an environment variable, a summary or a log;
 * 2. reuses the running gate (its `state.json`, then its `status` through a forward with the
 *    control bearer: same host, same version) or starts it as the detached `orq-agent` process
 *    {@link GATE_PROC_ID};
 * 3. long-polls the gate's `events` and hands them on (`DirectStreamActivity`: streams open per
 *    device → the hub proxy's viewer counts, input → control handoff), keeping the LAN addresses
 *    and telling the gate the machine's current id;
 * 4. keeps `tailscale serve` on the machine pointing its HTTPS name at the gate (`serve.ts`): on
 *    every ensure, then every {@link SERVE_CHECK_MS}; a check that finds the gate gone starts it again.
 *
 * Failures never fail the host: the direct routes are simply not offered, and a serve problem
 * (operator rights, HTTPS certificates, no free port) is reported with its fix.
 */

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import timers from "node:timers/promises";

import type { MachineProblem } from "@orquester/api";

import type { BoxConnection, BoxHostForward } from "../../boxes/contracts.ts";
import { parseProxyTarget, tailnetUrl, type ProxyTarget } from "../../boxes/tailscale/local.ts";
import type { DeviceDirectStream } from "../host.ts";
import { execRemote } from "../hosts/box/remote.ts";
import { controlToken, signStreamTicket, type GateEvents } from "./gate.mjs";
import {
  decideGateServe,
  gateServeProblem,
  machineTailscale,
  ownGateServePorts,
  parseGateServeRecord,
  parseTailscaleLocate,
  serializeGateServeRecord,
  TAILSCALE_LOCATE_SCRIPT,
  type MachineTailscaleCli
} from "./serve.ts";

/** The gate's detached `orq-agent` process id. */
export const GATE_PROC_ID = "orq-devices-gate";
const GATE_BUFFER_BYTES = 64 * 1024;
const GATE_FILES = ["gate.mjs", "hub-paths.mjs"] as const;
const GATE_SOURCES: Record<(typeof GATE_FILES)[number], string> = {
  "gate.mjs": readFileSync(new URL("./gate.mjs", import.meta.url), "utf8"),
  "hub-paths.mjs": readFileSync(new URL("./hub-paths.mjs", import.meta.url), "utf8")
};
/** The gate code's version: a running gate of another version is replaced. */
export const GATE_VERSION = createHash("sha256")
  .update(GATE_FILES.map((name) => GATE_SOURCES[name]).join("\u0000"))
  .digest("hex")
  .slice(0, 16);

/** How often the serve route is checked (and a gone gate started again) while the host runs. */
export const SERVE_CHECK_MS = 120_000;
const STATUS_TIMEOUT_MS = 5_000;
/** The gate answers a long poll within 25 s. */
const EVENTS_TIMEOUT_MS = 40_000;

/** Where the gate's events go (the hub proxy, through `wiring.ts`). */
export interface DirectStreamActivity {
  viewers(hostId: string, device: string, count: number): void;
  input(hostId: string, device: string): void;
}

export interface DirectStreamGateDeps {
  hostId: string;
  /** "jasper": for problem messages. */
  machineName(): string;
  /** The machine's registry id now (`ts:` once matched); the gate's identity answers it. */
  machineId(): string | null;
  connection(): BoxConnection | undefined;
  activity?: DirectStreamActivity;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: shorter waits. */
  timing?: Partial<{ startMs: number; pollMs: number; retryMs: number; serveCheckMs: number }>;
}

/** Where the gate runs on the machine. */
export interface GatePlace {
  nodePath: string;
  /** The machine's device root (`~/.orquester/devices`): the gate lives in `<root>/gate/`. */
  root: string;
  /** The hub's `EXPO_DEVICE_HUB_STATE_DIR`. */
  hubStateDir: string;
  /** The probed PATH env. */
  env: Record<string, string>;
}

interface GateFiles {
  dir: string;
  config: string;
  state: string;
  serve: string;
}

interface Running {
  forward: BoxHostForward;
  /** The gate's port on the machine. */
  port: number;
}

function filesOf(place: GatePlace): GateFiles {
  const dir = posix.join(place.root, "gate");
  return { dir, config: posix.join(dir, "config.json"), state: posix.join(dir, "state.json"), serve: posix.join(dir, "serve.json") };
}

async function readText(link: BoxConnection, path: string): Promise<string | null> {
  try {
    const stream = await link.readFile(path, { length: 512 * 1024 });
    let text = "";
    for await (const chunk of stream) text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    return text;
  } catch {
    return null;
  }
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A gate events answer, or null when it is not one. */
export function parseGateEvents(value: unknown): GateEvents | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.boot !== "string" || !Number.isInteger(body.seq) || typeof body.viewers !== "object" || body.viewers === null) return null;
  const viewers: Record<string, number> = {};
  for (const [device, count] of Object.entries(body.viewers as Record<string, unknown>)) if (typeof count === "number" && Number.isInteger(count) && count > 0) viewers[device] = count;
  const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  return {
    boot: body.boot,
    seq: body.seq as number,
    hostId: typeof body.hostId === "string" ? body.hostId : "",
    machineId: typeof body.machineId === "string" ? body.machineId : null,
    viewers,
    inputs: strings(body.inputs),
    lan: strings(body.lan).filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class DirectStreamGate {
  private readonly events = new EventEmitter();
  private readonly timing: { startMs: number; pollMs: number; retryMs: number; serveCheckMs: number };
  private secret: Buffer | null = null;
  private running: Running | null = null;
  private place: GatePlace | null = null;
  private ensuring: Promise<void> | null = null;
  private poll: AbortController | null = null;
  private serveTimer: ReturnType<typeof setInterval> | null = null;
  private located: MachineTailscaleCli | null = null;
  private tailnet: { url: string; port: number } | null = null;
  private serveProblemValue: MachineProblem | null = null;
  private lan: string[] = [];
  private boot: string | null = null;
  private seq = 0;
  private viewers = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: DirectStreamGateDeps) {
    this.timing = { startMs: 20_000, pollMs: 250, retryMs: 2_000, serveCheckMs: SERVE_CHECK_MS, ...deps.timing };
  }

  /** The direct routes while the gate runs; null otherwise. */
  stream(): DeviceDirectStream | null {
    const secret = this.secret;
    const running = this.running;
    if (!secret || !running) return null;
    const hostId = this.deps.hostId;
    return {
      tailnetUrl: this.tailnet?.url ?? null,
      lanUrls: this.lan.map((ip) => `http://${ip}:${running.port}`),
      issueTicket: ({ device, expiresAt, origin }) => signStreamTicket(secret, { hostId, device, expiresAt, origin })
    };
  }

  /** The serve route's problem with its fix (the host lists it with its own). */
  problems(): MachineProblem[] {
    return this.serveProblemValue ? [this.serveProblemValue] : [];
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  /** Start or reuse the gate and check its serve route (joins one in progress). Never rejects. */
  ensure(place: GatePlace): Promise<void> {
    this.closed = false;
    this.place = place;
    this.ensuring ??= this.runEnsure(place)
      .catch((error) => this.deps.logger.warn(`[devices] the direct stream gate on ${this.deps.hostId} did not start`, errorText(error)))
      .finally(() => {
        this.ensuring = null;
      });
    return this.ensuring;
  }

  /** The machine stops being used (idle, teardown): stop the gate and remove Orquester's serve route there. */
  async stop(): Promise<void> {
    await this.ensuring;
    this.closed = true;
    this.stopTimers();
    const link = this.deps.connection();
    const place = this.place;
    const running = this.running;
    if (link?.connected && place) {
      await this.unserve(link, place).catch((error) => this.deps.logger.warn(`[devices] removing the serve route on ${this.deps.hostId} failed`, errorText(error)));
      if (running) await this.request(running, "stop", { method: "POST" }).catch(() => undefined);
      await link.request("proc.release", { procId: GATE_PROC_ID }).catch(() => undefined);
    }
    await this.forget();
    this.tailnet = null;
    this.serveProblemValue = null;
    this.emitChange();
  }

  /** Stop watching (the daemon stops, the host goes): the gate keeps running there for the next start. */
  async dispose(): Promise<void> {
    this.closed = true;
    this.stopTimers();
    await this.forget();
    this.events.removeAllListeners();
  }

  // -------------------------------------------------------------------------

  private async runEnsure(place: GatePlace): Promise<void> {
    const link = this.deps.connection();
    if (!link?.connected) return;
    const files = filesOf(place);
    if (!this.running || !(await this.alive(this.running))) {
      await this.forget();
      await this.start(link, place, files);
    }
    if (this.closed) return;
    this.watchEvents();
    this.serveTimer ??= setInterval(() => void this.tick(), this.timing.serveCheckMs);
    this.serveTimer.unref?.();
    await this.checkServe(link, place, files).catch((error) => this.deps.logger.warn(`[devices] checking tailscale serve on ${this.deps.hostId} failed`, errorText(error)));
    this.emitChange();
  }

  /** Reuse the gate the state file names (same host and version), else start one. */
  private async start(link: BoxConnection, place: GatePlace, files: GateFiles): Promise<void> {
    await link.request("fs.mkdir", { path: files.dir, recursive: true, mode: 0o700 });
    for (const name of GATE_FILES) {
      const path = posix.join(files.dir, name);
      if ((await readText(link, path)) !== GATE_SOURCES[name]) await link.writeFile(path, GATE_SOURCES[name], { mode: 0o600, mkdirs: true });
    }
    const config = parseJson(await readText(link, files.config));
    const stored = typeof config?.secret === "string" && config.hostId === this.deps.hostId ? Buffer.from(config.secret, "base64url") : null;
    this.secret = stored && stored.length >= 32 ? stored : randomBytes(32);

    const state = parseJson(await readText(link, files.state));
    const statePort = Number.isInteger(state?.port) ? (state!.port as number) : null;
    if (statePort !== null) {
      const found = await this.connect(link, statePort);
      if (found) {
        const status = await this.request(found, "status").catch(() => null);
        if (status && status.hostId === this.deps.hostId && status.version === GATE_VERSION) {
          this.running = found;
          return;
        }
        // Another version (or a gate this secret does not open): it stops before the new one starts.
        if (status) await this.request(found, "stop", { method: "POST" }).catch(() => undefined);
        await found.forward.close().catch(() => undefined);
      }
    }

    const text = `${JSON.stringify({
      hostId: this.deps.hostId,
      machineId: this.deps.machineId(),
      secret: this.secret.toString("base64url"),
      hubStateDir: place.hubStateDir,
      statePath: files.state,
      // The port it had: the serve route keeps pointing at it.
      port: statePort ?? 0,
      version: GATE_VERSION
    })}\n`;
    await link.writeFile(files.config, text, { mode: 0o600, mkdirs: true });
    await link.request("fs.rm", { path: files.state, force: true }).catch(() => undefined);
    await link.request("proc.release", { procId: GATE_PROC_ID }).catch(() => undefined);
    const proc = link.exec({
      command: place.nodePath,
      args: [posix.join(files.dir, "gate.mjs"), files.config],
      cwd: files.dir,
      env: place.env,
      detach: { procId: GATE_PROC_ID, bufferBytes: GATE_BUFFER_BYTES }
    });
    let exited: string | null = null;
    let stderr = "";
    proc.stdout.resume();
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.once("exit", (code, signal) => {
      exited = `exit ${code ?? signal ?? "?"}`;
    });
    proc.once("error", (error) => {
      exited = error.message;
    });
    const deadline = Date.now() + this.timing.startMs;
    for (;;) {
      if (exited !== null) throw new Error(`the gate exited at start (${exited}): ${stderr.trim().split("\n").pop() ?? ""}`);
      const started = parseJson(await readText(link, files.state));
      if (started && Number.isInteger(started.port) && started.version === GATE_VERSION) {
        const found = await this.connect(link, started.port as number);
        const status = found ? await this.request(found, "status").catch(() => null) : null;
        if (found && status?.hostId === this.deps.hostId) {
          this.running = found;
          return;
        }
        await found?.forward.close().catch(() => undefined);
      }
      if (Date.now() > deadline) throw new Error(`the gate did not start within ${Math.round(this.timing.startMs / 1000)} s`);
      // The gate signals readiness only through its state file: look again shortly.
      await timers.setTimeout(this.timing.pollMs);
    }
  }

  private async connect(link: BoxConnection, port: number): Promise<Running | null> {
    try {
      return { forward: await link.forwardToHost(port), port };
    } catch {
      return null;
    }
  }

  private async alive(running: Running): Promise<boolean> {
    const status = await this.request(running, "status").catch(() => null);
    return status?.hostId === this.deps.hostId && status.version === GATE_VERSION;
  }

  private async request(running: Running, name: string, init: { method?: string; query?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!this.secret) throw new Error("no gate secret");
    const signals = [AbortSignal.timeout(init.timeoutMs ?? STATUS_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])];
    const response = await fetch(`http://127.0.0.1:${running.forward.hostPort}/.orq/gate/${name}${init.query ?? ""}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${controlToken(this.secret)}` },
      signal: AbortSignal.any(signals)
    });
    if (!response.ok) throw new Error(`the gate answered ${response.status}`);
    const body = parseJson(await response.text());
    if (!body) throw new Error("the gate's answer is not JSON");
    return body;
  }

  /** Long-poll the gate's events while it runs. */
  private watchEvents(): void {
    if (this.poll || !this.running) return;
    const abort = new AbortController();
    this.poll = abort;
    void this.pollLoop(abort.signal).finally(() => {
      if (this.poll === abort) this.poll = null;
    });
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const running = this.running;
      if (!running) return;
      try {
        const query = `?boot=${encodeURIComponent(this.boot ?? "")}&after=${this.seq}&machineId=${encodeURIComponent(this.deps.machineId() ?? "")}`;
        const events = parseGateEvents(await this.request(running, "events", { query, timeoutMs: EVENTS_TIMEOUT_MS, signal }));
        if (!events) throw new Error("the gate's events are not readable");
        failures = 0;
        this.apply(events);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        if (!this.deps.connection()?.connected || failures >= 3) {
          // The gate (or the link) is gone: no direct route until the next ensure starts it again.
          this.deps.logger.info(`[devices] lost the direct stream gate on ${this.deps.hostId}: ${errorText(error)}`);
          await this.forget();
          this.emitChange();
          return;
        }
        await timers.setTimeout(this.timing.retryMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private apply(events: GateEvents): void {
    this.boot = events.boot;
    this.seq = events.seq;
    this.reportViewers(new Map(Object.entries(events.viewers)));
    for (const device of events.inputs) this.deps.activity?.input(this.deps.hostId, device);
    if (events.lan.join(",") !== this.lan.join(",")) {
      this.lan = events.lan;
      this.emitChange();
    }
  }

  private reportViewers(next: Map<string, number>): void {
    for (const device of new Set([...this.viewers.keys(), ...next.keys()])) {
      const count = next.get(device) ?? 0;
      if ((this.viewers.get(device) ?? 0) !== count) this.deps.activity?.viewers(this.deps.hostId, device, count);
    }
    this.viewers = next;
  }

  /** The periodic check: the gate again when it is gone, its serve route otherwise. */
  private async tick(): Promise<void> {
    const place = this.place;
    const link = this.deps.connection();
    if (!place || !link?.connected || this.closed || this.ensuring) return;
    if (!this.running) {
      await this.ensure(place);
      return;
    }
    await this.checkServe(link, place, filesOf(place)).catch((error) => this.deps.logger.warn(`[devices] checking tailscale serve on ${this.deps.hostId} failed`, errorText(error)));
  }

  private liveTarget(): ProxyTarget | null {
    return this.running ? parseProxyTarget(`http://127.0.0.1:${this.running.port}`) : null;
  }

  private async tailscale(link: BoxConnection, place: GatePlace) {
    // Located again while missing: Tailscale may have been installed since.
    if (!this.located || this.located.cli === null) {
      const result = await execRemote(link, { command: "/bin/sh", args: ["-c", TAILSCALE_LOCATE_SCRIPT], env: place.env }, { timeoutMs: 15_000 });
      this.located = parseTailscaleLocate(result.stdout);
    }
    return { located: this.located, cli: machineTailscale(link, this.located, place.env) };
  }

  private async checkServe(link: BoxConnection, place: GatePlace, files: GateFiles): Promise<void> {
    const live = this.liveTarget();
    if (!live) return;
    const { located, cli } = await this.tailscale(link, place);
    const snapshot = await cli.snapshot({ fresh: true });
    const record = parseGateServeRecord(await readText(link, files.serve));
    const recordTargetAlive = record && record.target.port !== live.port ? await this.listening(link, record.target.port) : null;
    const decision = decideGateServe({ snapshot, live, record, recordTargetAlive });
    const machine = this.deps.machineName();
    const before = JSON.stringify([this.tailnet, this.serveProblemValue]);
    switch (decision.kind) {
      case "unavailable":
        this.tailnet = null;
        this.serveProblemValue = gateServeProblem(decision, machine);
        break;
      case "no-port":
        this.tailnet = null;
        this.serveProblemValue = gateServeProblem(decision, machine);
        break;
      case "serving":
        if (decision.adopt || record?.port !== decision.port) await link.writeFile(files.serve, serializeGateServeRecord({ port: decision.port, target: live }), { mode: 0o600, mkdirs: true });
        this.tailnet = { url: tailnetUrl(snapshot.dnsName!, decision.port), port: decision.port };
        this.serveProblemValue = null;
        break;
      case "create": {
        const result = await cli.serveProxy(decision.port, live.url);
        if (result.ok) {
          await link.writeFile(files.serve, serializeGateServeRecord({ port: decision.port, target: live }), { mode: 0o600, mkdirs: true });
          this.tailnet = { url: tailnetUrl(snapshot.dnsName!, decision.port), port: decision.port };
          this.serveProblemValue = null;
        } else {
          this.tailnet = null;
          this.serveProblemValue =
            result.reason === "permission"
              ? gateServeProblem({ kind: "permission", user: located.user ?? snapshot.user, macApp: (located.cli ?? "").includes("Tailscale.app"), command: result.command }, machine)
              : gateServeProblem({ kind: "failed", message: result.message, command: result.command }, machine);
        }
        break;
      }
    }
    if (JSON.stringify([this.tailnet, this.serveProblemValue]) !== before) this.emitChange();
  }

  /** Remove Orquester's own serve route(s) on the machine and its record. */
  private async unserve(link: BoxConnection, place: GatePlace): Promise<void> {
    const files = filesOf(place);
    const record = parseGateServeRecord(await readText(link, files.serve));
    const live = this.liveTarget();
    if (!record && !live) return;
    const { cli } = await this.tailscale(link, place);
    const snapshot = await cli.snapshot({ fresh: true });
    if (snapshot.serveKnown) {
      for (const port of ownGateServePorts({ live, record, routes: snapshot.routes })) {
        const result = await cli.unserve(port);
        if (!result.ok) this.deps.logger.warn(`[devices] tailscale serve --https=${port} off on ${this.deps.hostId} failed: ${result.message}`);
      }
    }
    await link.request("fs.rm", { path: files.serve, force: true }).catch(() => undefined);
  }

  private async listening(link: BoxConnection, port: number): Promise<boolean> {
    try {
      const socket = await link.openTcp(port);
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }

  private stopTimers(): void {
    this.poll?.abort();
    this.poll = null;
    if (this.serveTimer) clearInterval(this.serveTimer);
    this.serveTimer = null;
  }

  /** Drop the forward and the viewers the gate reported (the hub proxy counts them gone). */
  private async forget(): Promise<void> {
    const running = this.running;
    this.running = null;
    this.poll?.abort();
    this.poll = null;
    this.boot = null;
    this.seq = 0;
    this.reportViewers(new Map());
    await running?.forward.close().catch(() => undefined);
  }

  private emitChange(): void {
    this.events.emit("change");
  }
}
