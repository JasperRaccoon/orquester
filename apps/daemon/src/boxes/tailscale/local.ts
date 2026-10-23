/**
 * Tailscale on the daemon's own machine, through its `tailscale` CLI (no shell, short timeouts).
 *
 * The daemon listens on loopback, so a tailnet URL reaches it only where `tailscale serve` proxies
 * an HTTPS port of this machine's MagicDNS name to the daemon's HTTP port. {@link LocalTailscale.state}
 * reports whether that is so (cached briefly; it never throws), and {@link LocalTailscale.serve}
 * sets it up, retrying once through `sudo -n` when Tailscale refuses the daemon's user.
 */

import { execFile } from "node:child_process";
import { userInfo } from "node:os";

import type { BoxLocalTailscale } from "@orquester/api";

/** The HTTPS port "Set up for me" serves Orquester on (443 is often another server's). */
export const DEFAULT_TAILSCALE_SERVE_PORT = 10000;
const RUN_TIMEOUT_MS = 5_000;
/** Serving can take a moment while Tailscale provisions the certificate. */
const SERVE_TIMEOUT_MS = 30_000;
const CACHE_MS = 10_000;
/** Ports tried, in order, when the default one serves something else. */
const PORT_CANDIDATES = [DEFAULT_TAILSCALE_SERVE_PORT, 10001, 10002, 10003, 10004, 10005, 8443];

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a program without a shell; rejects when it cannot start (`code` "ENOENT") or exits non-zero
 * (the error carries `stdout`/`stderr`).
 */
export type CommandRunner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<RunResult>;

export const execFileRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export interface DaemonHttpAddress {
  host: string;
  port: number;
}

export interface LocalTailscaleDeps {
  /** Where the daemon's HTTP transport listens (`transports.http`), read per call. */
  daemonHttp: () => DaemonHttpAddress;
  run?: CommandRunner;
  /** The daemon's OS user (named in the operator remedy). */
  user?: () => string;
  now?: () => number;
}

export type ServeResult =
  | { ok: true; port: number; sudo: boolean }
  | { ok: false; reason: "permission"; message: string; commands: string[] }
  | { ok: false; reason: "failed"; message: string };

export interface LocalTailscale {
  /** The current state (cached {@link CACHE_MS}; `fresh` re-reads). Never rejects. */
  state(options?: { fresh?: boolean }): Promise<BoxLocalTailscale>;
  /** The last state read, without running anything. */
  cached(): BoxLocalTailscale | null;
  /** Serve the daemon on `port` of this machine's tailnet name. Never rejects. */
  serve(port: number): Promise<ServeResult>;
}

// ---- parsing --------------------------------------------------------------------------------------

export interface ParsedStatus {
  running: boolean;
  dnsName: string | null;
  tailnetIp: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `tailscale status --json`: the backend state, this machine's DNS name and first IPv4. */
export function parseTailscaleStatus(json: string): ParsedStatus {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { running: false, dnsName: null, tailnetIp: null };
  }
  if (!isRecord(value)) return { running: false, dnsName: null, tailnetIp: null };
  const self = isRecord(value.Self) ? value.Self : {};
  const rawName = typeof self.DNSName === "string" ? self.DNSName.trim().replace(/\.$/, "").toLowerCase() : "";
  const ips = [self.TailscaleIPs, value.TailscaleIPs].flatMap((list) => (Array.isArray(list) ? list : [])).filter((ip): ip is string => typeof ip === "string");
  const ipv4 = ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null;
  return { running: value.BackendState === "Running", dnsName: rawName || null, tailnetIp: ipv4 };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WILDCARD = new Set(["", "0.0.0.0", "::", "[::]"]);

/** The address `tailscale serve` should proxy to: loopback unless the daemon binds one specific other host. */
export function serveTarget(daemon: DaemonHttpAddress): string {
  const host = daemon.host.trim();
  if (LOOPBACK.has(host) || WILDCARD.has(host)) return `http://127.0.0.1:${daemon.port}`;
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${daemon.port}`;
}

/** A serve proxy target (`http://127.0.0.1:47831`, `127.0.0.1:47831`, `47831`) that reaches the daemon. */
function proxiesToDaemon(target: string, daemon: DaemonHttpAddress): boolean {
  const text = target.trim();
  if (/^\d+$/.test(text)) return Number(text) === daemon.port;
  let url: URL;
  try {
    url = new URL(/^[a-z+]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (Number(url.port || 80) !== daemon.port) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  const host = url.hostname.toLowerCase();
  const bound = daemon.host.trim().toLowerCase();
  if (LOOPBACK.has(host)) return LOOPBACK.has(bound) || WILDCARD.has(bound);
  return host === bound || host === `[${bound}]` || WILDCARD.has(bound);
}

export interface ParsedServe {
  /** HTTPS ports of this machine's name that proxy `/` to the daemon. */
  daemonPorts: number[];
  /** Ports that serve something (anything) already. */
  usedPorts: number[];
}

/** `tailscale serve status --json` (also its `Foreground` sessions): which ports serve the daemon. */
export function parseServeStatus(json: string, dnsName: string | null, daemon: DaemonHttpAddress): ParsedServe {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { daemonPorts: [], usedPorts: [] };
  }
  if (!isRecord(value)) return { daemonPorts: [], usedPorts: [] };
  const configs: Record<string, unknown>[] = [value];
  if (isRecord(value.Foreground)) configs.push(...Object.values(value.Foreground).filter(isRecord));
  const daemonPorts = new Set<number>();
  const usedPorts = new Set<number>();
  const name = dnsName?.toLowerCase() ?? null;
  for (const config of configs) {
    const tcp = isRecord(config.TCP) ? config.TCP : {};
    for (const [portText, handler] of Object.entries(tcp)) {
      const port = Number(portText);
      if (!Number.isInteger(port)) continue;
      usedPorts.add(port);
      // `--tls-terminated-tcp`: TLS ends at Tailscale, the bytes go to the daemon.
      if (isRecord(handler) && typeof handler.TCPForward === "string" && handler.TerminateTLS && proxiesToDaemon(handler.TCPForward, daemon)) {
        daemonPorts.add(port);
      }
    }
    const web = isRecord(config.Web) ? config.Web : {};
    for (const [hostPort, site] of Object.entries(web)) {
      const at = hostPort.lastIndexOf(":");
      if (at < 0) continue;
      const host = hostPort.slice(0, at).toLowerCase();
      const port = Number(hostPort.slice(at + 1));
      if (!Number.isInteger(port)) continue;
      usedPorts.add(port);
      if (name && host !== name) continue;
      if (isRecord(tcp[String(port)]) && (tcp[String(port)] as Record<string, unknown>).HTTPS === false) continue;
      const handlers = isRecord(site) && isRecord(site.Handlers) ? site.Handlers : {};
      const root = handlers["/"];
      if (isRecord(root) && typeof root.Proxy === "string" && proxiesToDaemon(root.Proxy, daemon)) daemonPorts.add(port);
    }
  }
  return { daemonPorts: [...daemonPorts].sort((a, b) => a - b), usedPorts: [...usedPorts] };
}

export function tailnetUrl(dnsName: string, port: number): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

export function serveCommand(port: number, daemon: DaemonHttpAddress): string {
  return ["tailscale", ...serveArgs(port, daemon)].join(" ");
}

function serveArgs(port: number, daemon: DaemonHttpAddress): string[] {
  return ["serve", "--bg", `--https=${port}`, serveTarget(daemon)];
}

/** Tailscale's refusals for a user who may not change its config. */
export function isPermissionError(text: string): boolean {
  return /access denied|must be root|operator|permission denied|not permitted/i.test(text);
}

function outputOf(error: unknown): string {
  const record = (error ?? {}) as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [record.stderr, record.stdout, record.message].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n");
}

/** The first line of Tailscale's answer, and the page it points at (e.g. "enable Serve on your tailnet"). */
function failureLine(text: string): string {
  let line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0 && !/^Command failed:/.test(part)) ?? "tailscale serve failed";
  if (line.length > 300) line = `${line.slice(0, 297)}…`;
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];
  return link && !line.includes(link) ? `${line} ${link}` : line;
}

// ---- the service ----------------------------------------------------------------------------------

export function createLocalTailscale(deps: LocalTailscaleDeps): LocalTailscale {
  const run = deps.run ?? execFileRunner;
  const now = deps.now ?? Date.now;
  const user = deps.user ?? (() => userInfo().username);
  let cache: { at: number; value: BoxLocalTailscale } | null = null;
  let inflight: Promise<BoxLocalTailscale> | null = null;

  const read = async (): Promise<BoxLocalTailscale> => {
    const daemon = deps.daemonHttp();
    const base = (installed: boolean, running = false, dnsName: string | null = null, tailnetIp: string | null = null): BoxLocalTailscale => ({
      installed,
      running,
      dnsName,
      tailnetIp,
      servePort: DEFAULT_TAILSCALE_SERVE_PORT,
      serving: false,
      suggestedUrl: dnsName ? tailnetUrl(dnsName, DEFAULT_TAILSCALE_SERVE_PORT) : null,
      serveCommand: installed ? serveCommand(DEFAULT_TAILSCALE_SERVE_PORT, daemon) : null
    });
    let status: ParsedStatus;
    try {
      status = parseTailscaleStatus((await run("tailscale", ["status", "--json"], { timeoutMs: RUN_TIMEOUT_MS })).stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return base(false);
      // Installed, but tailscaled is down (or answered garbage): stdout may still carry the state.
      const stdout = (error as { stdout?: unknown }).stdout;
      status = typeof stdout === "string" && stdout.trim().startsWith("{") ? parseTailscaleStatus(stdout) : { running: false, dnsName: null, tailnetIp: null };
    }
    if (!status.running) return base(true, false, status.dnsName, status.tailnetIp);
    let serve: ParsedServe = { daemonPorts: [], usedPorts: [] };
    try {
      serve = parseServeStatus((await run("tailscale", ["serve", "status", "--json"], { timeoutMs: RUN_TIMEOUT_MS })).stdout, status.dnsName, daemon);
    } catch {
      // Unknown: reported as not serving.
    }
    const serving = serve.daemonPorts.length > 0;
    const servePort = serving
      ? (serve.daemonPorts.includes(DEFAULT_TAILSCALE_SERVE_PORT) ? DEFAULT_TAILSCALE_SERVE_PORT : serve.daemonPorts[0]!)
      : (PORT_CANDIDATES.find((port) => !serve.usedPorts.includes(port)) ?? DEFAULT_TAILSCALE_SERVE_PORT);
    return {
      installed: true,
      running: true,
      dnsName: status.dnsName,
      tailnetIp: status.tailnetIp,
      servePort,
      serving,
      suggestedUrl: status.dnsName ? tailnetUrl(status.dnsName, servePort) : null,
      serveCommand: serveCommand(servePort, daemon)
    };
  };

  const state = (options: { fresh?: boolean } = {}): Promise<BoxLocalTailscale> => {
    if (!options.fresh && cache && now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = read()
      .catch((): BoxLocalTailscale => ({
        installed: false,
        running: false,
        dnsName: null,
        tailnetIp: null,
        servePort: DEFAULT_TAILSCALE_SERVE_PORT,
        serving: false,
        suggestedUrl: null,
        serveCommand: null
      }))
      .then((value) => {
        cache = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const serve = async (port: number): Promise<ServeResult> => {
    const daemon = deps.daemonHttp();
    const args = serveArgs(port, daemon);
    const command = serveCommand(port, daemon);
    cache = null;
    try {
      await run("tailscale", args, { timeoutMs: SERVE_TIMEOUT_MS });
      return { ok: true, port, sudo: false };
    } catch (error) {
      const output = outputOf(error);
      if (!isPermissionError(output)) return { ok: false, reason: "failed", message: failureLine(output) };
    }
    // Refused for this user: sudo only when it works without a password prompt.
    let sudo = false;
    try {
      await run("sudo", ["-n", "true"], { timeoutMs: RUN_TIMEOUT_MS });
      sudo = true;
    } catch {
      // No passwordless sudo.
    }
    if (sudo) {
      try {
        await run("sudo", ["-n", "tailscale", ...args], { timeoutMs: SERVE_TIMEOUT_MS });
        return { ok: true, port, sudo: true };
      } catch (error) {
        const output = outputOf(error);
        if (!isPermissionError(output)) return { ok: false, reason: "failed", message: failureLine(output) };
      }
    }
    const name = user();
    const operator = `sudo tailscale set --operator=${name}`;
    return {
      ok: false,
      reason: "permission",
      message: `Tailscale doesn't let this server's user (${name}) change what it serves. Run \`${operator}\` once, then "Set up for me" works — or run \`sudo ${command}\` yourself.`,
      commands: [operator, `sudo ${command}`]
    };
  };

  return { state, cached: () => cache?.value ?? null, serve };
}
