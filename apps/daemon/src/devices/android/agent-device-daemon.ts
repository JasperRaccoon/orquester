/**
 * The local agent-device daemon (devices spec §4, spikes §2): started under the host's private
 * environment (its state, home and claims dirs in the appdir; idle timeout off; HTTP server mode)
 * by the cheapest command that brings it up (`agent-device devices --json`; there is no
 * `daemon start`). It publishes `<AGENT_DEVICE_STATE_DIR>/daemon.json` (0600: port and token); this
 * writes the `--config` file (0600, `daemonBaseUrl` + `daemonAuthToken`) the agent-device runner
 * passes on every call, so the token never appears in argv. A restarted daemon reuses a healthy
 * agent-device daemon; a dead one is started again on the next check.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ExecFn, lastLine } from "./exec.ts";
import { type DeviceExecutor, LOCAL_EXECUTOR } from "./executor.ts";

export interface AgentDeviceEndpoint {
  baseUrl: string;
  token: string;
}

export interface AgentDeviceDaemonDeps {
  exec: ExecFn;
  nodePath: string;
  /** The installed agent-device entry module, or null. */
  entry: () => string | null;
  env: NodeJS.ProcessEnv;
  /** Its state dir where it runs (`daemon.json`). */
  stateDir: string;
  /** The `--config` file on this machine (always local: the agent-device CLI runs here). */
  configPath: string;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Where the agent-device daemon runs (absent: this machine); `exec` must run there too. */
  executor?: DeviceExecutor;
  /**
   * How this daemon reaches the agent-device daemon's port (absent: `http://127.0.0.1:<port>`); a
   * box host forwards it. Called again when the port changes.
   */
  endpoint?: (port: number) => Promise<string>;
}

/** `daemon.json` → the endpoint (HTTP mode: `httpPort`). */
export function parseDaemonInfo(text: string): AgentDeviceEndpoint | null {
  try {
    const info = JSON.parse(text) as { httpPort?: unknown; token?: unknown };
    if (typeof info.httpPort !== "number" || !Number.isInteger(info.httpPort) || info.httpPort <= 0) return null;
    if (typeof info.token !== "string" || info.token.length === 0) return null;
    return { baseUrl: `http://127.0.0.1:${info.httpPort}`, token: info.token };
  } catch {
    return null;
  }
}

/** The `--config` file's content. */
export function agentDeviceConfig(endpoint: AgentDeviceEndpoint): string {
  return `${JSON.stringify({ daemonBaseUrl: endpoint.baseUrl, daemonAuthToken: endpoint.token }, null, 2)}\n`;
}

export class AgentDeviceDaemon {
  private endpoint: AgentDeviceEndpoint | null = null;
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;
  private readonly x: DeviceExecutor;
  /** The reached base URL of the daemon's port. */
  private reached: { port: number; baseUrl: string } | null = null;

  constructor(private readonly deps: AgentDeviceDaemonDeps) {
    this.x = deps.executor ?? LOCAL_EXECUTOR;
  }

  /** The config file while the daemon is known to run. */
  configPath(): string | null {
    return this.endpoint ? this.deps.configPath : null;
  }

  error(): string | null {
    return this.lastError;
  }

  /** Reuse a healthy daemon or start one; writes the config file. */
  ensure(signal?: AbortSignal): Promise<void> {
    this.starting ??= this.doEnsure(signal).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Whether the known daemon still answers; forgets it when not. */
  async check(): Promise<boolean> {
    if (!this.endpoint) return false;
    if (await this.healthy(this.endpoint)) return true;
    this.endpoint = null;
    return false;
  }

  /** Forget the daemon without stopping it (a box link dropped; the next `ensure` finds it again). */
  forget(): void {
    this.endpoint = null;
    this.reached = null;
  }

  /** `agent-device daemon stop` for this state dir; the config file goes. */
  async stop(): Promise<void> {
    this.endpoint = null;
    this.reached = null;
    const entry = this.deps.entry();
    if (entry) {
      await this.deps
        .exec(this.deps.nodePath, [entry, "daemon", "stop", "--state-dir", this.deps.stateDir], { env: this.deps.env, timeoutMs: 15_000 })
        .catch(() => undefined);
    }
    await rm(this.deps.configPath, { force: true });
  }

  private async doEnsure(signal?: AbortSignal): Promise<void> {
    const existing = await this.readInfo();
    if (existing && (await this.healthy(existing))) {
      await this.publish(existing);
      return;
    }
    const entry = this.deps.entry();
    if (!entry) {
      this.lastError = "agent-device is not installed.";
      throw new Error(this.lastError);
    }
    await this.x.mkdir(this.deps.stateDir, { mode: 0o700 });
    const result = await this.deps.exec(this.deps.nodePath, [entry, "devices", "--json"], {
      env: this.deps.env,
      timeoutMs: 90_000,
      ...(signal ? { signal } : {})
    });
    const started = await this.readInfo();
    if (started && (await this.healthy(started))) {
      await this.publish(started);
      this.deps.logger.info(`[devices] agent-device daemon ready (${started.baseUrl})`);
      return;
    }
    this.lastError = `agent-device did not start: ${lastLine(result) || `exit ${result.exitCode}`}`;
    throw new Error(this.lastError);
  }

  private async publish(endpoint: AgentDeviceEndpoint): Promise<void> {
    const content = agentDeviceConfig(endpoint);
    const current = await readFile(this.deps.configPath, "utf8").catch(() => "");
    if (current !== content) {
      await mkdir(dirname(this.deps.configPath), { recursive: true, mode: 0o700 });
      const temp = `${this.deps.configPath}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temp, content, { mode: 0o600 });
      await rename(temp, this.deps.configPath);
    }
    this.endpoint = endpoint;
    this.lastError = null;
  }

  /** `daemon.json` where it runs, its port mapped to how this daemon reaches it. */
  private async readInfo(): Promise<AgentDeviceEndpoint | null> {
    const info = parseDaemonInfo((await this.x.readText(join(this.deps.stateDir, "daemon.json"))) ?? "");
    if (!info || !this.deps.endpoint) return info;
    const port = Number(new URL(info.baseUrl).port);
    if (this.reached?.port !== port) this.reached = { port, baseUrl: await this.deps.endpoint(port) };
    return { baseUrl: this.reached.baseUrl, token: info.token };
  }

  private async healthy(endpoint: AgentDeviceEndpoint): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }
}
