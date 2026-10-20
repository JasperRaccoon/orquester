/**
 * Dev servers in boxes and the Browser tab (spec §8.9).
 *
 * The server-side Chromium stays on the host, so a dev server listening in a
 * box is reached through a HOST loopback forward (`BoxConnection.forwardToHost`).
 * For a box project:
 *
 * - `suggestions()` turns every sniffed `http(s)://localhost:<port>` (the URL
 *   watcher reads box terminal output like any other) and every listening
 *   port the box reports (`sys.ports`) into a forward, and suggests the
 *   FORWARDED address. A forward takes the same port number on the host when
 *   it is free — absolute URLs and redirects the dev server emits then keep
 *   working, and a tab persisted across a daemon restart finds its forward
 *   again — else any free port.
 * - A Browser tab of a box project opened or navigated to `localhost:<port>`
 *   gets a same-port forward if none serves that port yet.
 * - Forwards stay up while the project has open sessions or a Browser tab
 *   points at them; once the project's sessions have all ended, the forwards
 *   no tab uses are closed. A destroyed box's forwards are closed.
 *
 * Host projects pass through untouched.
 */

import type { EventEmitter } from "node:events";

import type { BoxListeningPort, SessionSummary } from "@orquester/api";

import type { BoxConnection, BoxHostForward, BoxHub, BoxRegistry } from "../../contracts.ts";

/** Most suggestions per project, as the URL watcher keeps. */
const MAX_SUGGESTIONS = 8;
/** Box daemons whose ports are never offered. */
const SYSTEM_LISTENERS = new Set(["sshd", "tailscaled", "orq-agent", "systemd-resolved", "systemd-resolve", "containerd", "dockerd", "rpcbind", "chronyd", "cupsd"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);
const BINDABLE_ADDRESSES = new Set(["127.0.0.1", "0.0.0.0", "::", "::1", "localhost", "*"]);

export interface BoxDevForwardDeps {
  registry: Pick<BoxRegistry, "locate" | "get" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** The daemon's one session list (terminals and chats): a project's open tabs keep its forwards. */
  sessions: { list(projectPath?: string): SessionSummary[]; lifecycle: EventEmitter };
  /** The Browser tabs (`BrowserManager`). */
  browsers: { list(projectPath?: string): { projectPath: string; url: string }[]; lifecycle: EventEmitter };
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface ForwardEntry {
  boxPort: number;
  projectPath: string;
  forward: Promise<BoxHostForward>;
  /** Settled host port (once listening). */
  hostPort: number | null;
}

/** `{ scheme, port }` of a loopback URL, or null for anything else. */
export function loopbackTarget(url: string): { scheme: "http" | "https"; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) && !LOOPBACK_HOSTS.has(parsed.host.toLowerCase())) return null;
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  return Number.isInteger(port) && port > 0 && port < 65536 ? { scheme, port } : null;
}

/** Listening ports worth offering: user-range, reachable on loopback, not a system daemon. */
export function offerablePorts(ports: readonly BoxListeningPort[]): number[] {
  const out = new Set<number>();
  for (const entry of ports) {
    if (entry.port < 1024 || !BINDABLE_ADDRESSES.has(entry.address)) continue;
    const command = entry.command?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (SYSTEM_LISTENERS.has(command)) continue;
    out.add(entry.port);
  }
  return [...out].sort((a, b) => a - b);
}

export class BoxDevForwards {
  /** boxId → box port → forward. */
  private readonly forwards = new Map<string, Map<number, ForwardEntry>>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly deps: BoxDevForwardDeps) {
    const sweep = (): void => void this.sweep();
    deps.sessions.lifecycle.on("closed", sweep);
    deps.sessions.lifecycle.on("exited", sweep);
    deps.browsers.lifecycle.on("closed", sweep);
    const onBrowser = (summary: { projectPath?: string; url?: string }): void => {
      if (summary?.projectPath && summary.url) void this.followBrowser(summary.projectPath, summary.url);
    };
    deps.browsers.lifecycle.on("created", onBrowser);
    deps.browsers.lifecycle.on("updated", onBrowser);
    this.unsubscribe.push(
      () => {
        deps.sessions.lifecycle.off("closed", sweep);
        deps.sessions.lifecycle.off("exited", sweep);
        deps.browsers.lifecycle.off("closed", sweep);
        deps.browsers.lifecycle.off("created", onBrowser);
        deps.browsers.lifecycle.off("updated", onBrowser);
      },
      deps.registry.onChange((boxId) => {
        const record = deps.registry.get(boxId);
        if (!record || record.state === "destroyed") void this.closeBox(boxId);
      }),
      // A box that (re)connects: its persisted tabs' forwards come back.
      deps.hub.onConnectionChange((_boxId, connected) => {
        if (connected) void this.restore();
      })
    );
  }

  /** Stop listening and close every forward (daemon shutdown, tests). */
  async dispose(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    await Promise.all([...this.forwards.keys()].map((boxId) => this.closeBox(boxId)));
  }

  private connectionFor(projectPath: string): { boxId: string; connection: BoxConnection } | null {
    const location = this.deps.registry.locate(projectPath);
    if (location.kind !== "box") return null;
    const connection = location.connection ?? this.deps.hub.get(location.boxId);
    return connection?.connected ? { boxId: location.boxId, connection } : null;
  }

  /**
   * The Browser tab's suggestions for a project. Host projects: `sniffed` as
   * is. Box projects: the forwarded addresses of the sniffed ports, then the
   * box's other listening ports; none while the box is away.
   */
  async suggestions(projectPath: string, sniffed: readonly string[]): Promise<string[]> {
    const location = this.deps.registry.locate(projectPath);
    if (location.kind !== "box") return [...sniffed];
    const target = this.connectionFor(projectPath);
    if (!target) return [];
    const wanted: { scheme: "http" | "https"; port: number }[] = [];
    const seen = new Set<number>();
    for (const url of sniffed) {
      const loop = loopbackTarget(url);
      if (loop && !seen.has(loop.port)) {
        seen.add(loop.port);
        wanted.push(loop);
      }
    }
    try {
      for (const port of offerablePorts(await target.connection.request("sys.ports", {}, { timeoutMs: 10_000 }))) {
        if (!seen.has(port)) {
          seen.add(port);
          wanted.push({ scheme: "http", port });
        }
      }
    } catch (error) {
      this.deps.logger?.warn("box port list failed", { boxId: target.boxId, error: error instanceof Error ? error.message : String(error) });
    }
    const out: string[] = [];
    for (const { scheme, port } of wanted.slice(0, MAX_SUGGESTIONS)) {
      try {
        const hostPort = await this.ensure(target.boxId, target.connection, projectPath, port);
        out.push(`${scheme}://localhost:${hostPort}`);
      } catch (error) {
        this.deps.logger?.warn("box port forward failed", { boxId: target.boxId, port, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }

  /** The host port forwarding to `boxPort` of the project's box (made on first use). */
  async hostPortFor(projectPath: string, boxPort: number): Promise<number> {
    const target = this.connectionFor(projectPath);
    if (!target) throw Object.assign(new Error("The project's box is not connected."), { status: 409, code: "BOX_NOT_READY" });
    return this.ensure(target.boxId, target.connection, projectPath, boxPort);
  }

  private ensure(boxId: string, connection: BoxConnection, projectPath: string, boxPort: number, sameOnly = false): Promise<number> {
    let byPort = this.forwards.get(boxId);
    if (!byPort) {
      byPort = new Map();
      this.forwards.set(boxId, byPort);
    }
    const existing = byPort.get(boxPort);
    if (existing) return existing.forward.then((forward) => forward.hostPort);
    const entry: ForwardEntry = {
      boxPort,
      projectPath,
      hostPort: null,
      // The same port number when the host has it free, else any.
      forward: connection.forwardToHost(boxPort, { hostPort: boxPort }).catch((error: unknown) => {
        if (sameOnly) throw error;
        return connection.forwardToHost(boxPort);
      })
    };
    byPort.set(boxPort, entry);
    const ports = byPort;
    return entry.forward.then(
      (forward) => {
        entry.hostPort = forward.hostPort;
        return forward.hostPort;
      },
      (error: unknown) => {
        if (ports.get(boxPort) === entry) ports.delete(boxPort);
        throw error;
      }
    );
  }

  /** A box project's tab on `localhost:<port>` with no forward yet: forward that port to the same number. */
  private async followBrowser(projectPath: string, url: string): Promise<void> {
    const loop = loopbackTarget(url);
    if (!loop) return;
    const target = this.connectionFor(projectPath);
    if (!target) return;
    const byPort = this.forwards.get(target.boxId);
    if (byPort && [...byPort.values()].some((entry) => entry.hostPort === loop.port || entry.boxPort === loop.port)) return;
    await this.ensure(target.boxId, target.connection, projectPath, loop.port, true).catch(() => undefined);
  }

  /** Re-create the same-port forwards persisted Browser tabs of box projects point at (after a restart or reconnect). */
  async restore(): Promise<void> {
    await Promise.all(this.deps.browsers.list().map((tab) => this.followBrowser(tab.projectPath, tab.url)));
  }

  /** Host ports Browser tabs of `projectPath` currently point at. */
  private portsInUse(projectPath: string): Set<number> {
    const ports = new Set<number>();
    for (const tab of this.deps.browsers.list(projectPath)) {
      const loop = loopbackTarget(tab.url);
      if (loop) ports.add(loop.port);
    }
    return ports;
  }

  /** Close the forwards of projects with no open session, except those a Browser tab uses. */
  async sweep(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [boxId, byPort] of this.forwards) {
      for (const [boxPort, entry] of byPort) {
        if (this.deps.sessions.list(entry.projectPath).some((session) => session.status === "running")) continue;
        if (entry.hostPort !== null && this.portsInUse(entry.projectPath).has(entry.hostPort)) continue;
        byPort.delete(boxPort);
        closing.push(entry.forward.then((forward) => forward.close()).catch(() => undefined));
      }
      if (byPort.size === 0) this.forwards.delete(boxId);
    }
    await Promise.all(closing);
  }

  private async closeBox(boxId: string): Promise<void> {
    const byPort = this.forwards.get(boxId);
    if (!byPort) return;
    this.forwards.delete(boxId);
    await Promise.all([...byPort.values()].map((entry) => entry.forward.then((forward) => forward.close()).catch(() => undefined)));
  }

  /** Live forwards, for tests and status: box id, box port, host port. */
  list(): { boxId: string; boxPort: number; hostPort: number | null; projectPath: string }[] {
    return [...this.forwards].flatMap(([boxId, byPort]) =>
      [...byPort.values()].map((entry) => ({ boxId, boxPort: entry.boxPort, hostPort: entry.hostPort, projectPath: entry.projectPath }))
    );
  }
}
