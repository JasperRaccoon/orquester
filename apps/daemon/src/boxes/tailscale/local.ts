/**
 * Tailscale on the daemon's own machine, through its `tailscale` CLI (no shell, short timeouts).
 * One instance serves the whole daemon (created in `startDaemon`): the boxes' Connection card reads
 * {@link LocalTailscale.state}, and the daemon-level tailnet service (`../../tailnet/`: Settings →
 * Server's HTTPS address, its 30 s repair, shared previews) reads {@link LocalTailscale.snapshot}.
 *
 * The daemon listens on loopback, so a tailnet URL reaches it only where `tailscale serve` proxies
 * an HTTPS port of this machine's MagicDNS name to the daemon's HTTP port. `state`/`snapshot` report
 * what is served (cached briefly; they never throw). Every serve change — {@link LocalTailscale.serve},
 * {@link LocalTailscale.serveProxy}, {@link LocalTailscale.unserve} — runs one at a time, first as
 * the daemon's user (it may be Tailscale's operator) and, when Tailscale refuses that user, once
 * more through `sudo -n` (never a password prompt). {@link LocalTailscale.setOperator} makes the
 * daemon's user the operator, after which no change needs sudo.
 *
 * Tailscale's raw output is never logged: `tailscale debug prefs` carries node state, and only its
 * `OperatorUser` is read.
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
export const SERVE_PORT_CANDIDATES: readonly number[] = [DEFAULT_TAILSCALE_SERVE_PORT, 10001, 10002, 10003, 10004, 10005, 8443];
/** A user name `tailscale set --operator=` accepts from us (it goes into an argument, never a shell). */
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

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
  /** Whether the daemon runs as root (then no change needs sudo). Default: `process.getuid() === 0`. */
  isRoot?: () => boolean;
  now?: () => number;
}

export type ServeResult =
  | { ok: true; port: number; sudo: boolean }
  | { ok: false; reason: "permission"; message: string; commands: string[] }
  | { ok: false; reason: "failed"; message: string };

/** One serve change's outcome. `command` is what the owner can run themselves (with `sudo`). */
export type ChangeResult =
  | { ok: true; sudo: boolean }
  | { ok: false; reason: "permission"; message: string; command: string }
  | { ok: false; reason: "failed"; message: string; command: string };

/** Where a serve handler proxies to: an `http://` origin with no path. */
export interface ProxyTarget {
  /** Lowercase, without IPv6 brackets. */
  host: string;
  port: number;
  /** `http://<host>:<port>` (IPv6 bracketed). */
  url: string;
}

/** One HTTPS (or TCP) port `tailscale serve` handles for this machine. */
export interface ServeRoute {
  port: number;
  /** `web`: an HTTP(S) site on this machine's name; `tcp`: a TCP forward; `other`: anything else on the port. */
  kind: "web" | "tcp" | "other";
  /** Clients reach it over TLS (an HTTPS site, or a TLS-terminated TCP forward). */
  https: boolean;
  /** The `/` handler's proxy (web) or the forward's address (tcp); null for files, text, paths or another scheme. */
  target: ProxyTarget | null;
}

/** Everything one read of the CLI tells. */
export interface TailscaleSnapshot {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  tailnetIp: string | null;
  /** HTTPS certificates are on for this machine's name (`CertDomains` lists it). */
  httpsCerts: boolean;
  /** `tailscale serve status` could be read (otherwise `routes` says nothing). */
  serveKnown: boolean;
  routes: ServeRoute[];
  /** Ports that serve something already, on any name. */
  usedPorts: number[];
  /** The daemon's user may change serve config without sudo; null when that could not be told. */
  operatorOk: boolean | null;
  /** The daemon's OS user. */
  user: string;
}

export interface LocalTailscale {
  /** The current state (cached {@link CACHE_MS}; `fresh` re-reads). Never rejects. */
  state(options?: { fresh?: boolean }): Promise<BoxLocalTailscale>;
  /** The last state read, without running anything. */
  cached(): BoxLocalTailscale | null;
  /** The full read behind {@link state} (same cache). Never rejects. */
  snapshot(options?: { fresh?: boolean }): Promise<TailscaleSnapshot>;
  /** Serve the daemon on `port` of this machine's tailnet name. Never rejects. */
  serve(port: number): Promise<ServeResult>;
  /** `tailscale serve --bg --https=<port> <target>`. Never rejects. */
  serveProxy(port: number, target: string): Promise<ChangeResult>;
  /** `tailscale serve --https=<port> off`: removes that port's handler. Never rejects; the caller checks it is its own first. */
  unserve(port: number): Promise<ChangeResult>;
  /** `tailscale set --operator=<daemon user>` (through `sudo -n` unless root). Never rejects. */
  setOperator(): Promise<ChangeResult>;
  /** The command that makes the daemon's user the operator, for the owner to run. */
  operatorCommand(): string;
}

// ---- parsing --------------------------------------------------------------------------------------

export interface ParsedStatus {
  running: boolean;
  dnsName: string | null;
  tailnetIp: string | null;
  /** `CertDomains` lists this machine's name: HTTPS certificates are on. */
  httpsCerts: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const NOT_RUNNING: ParsedStatus = { running: false, dnsName: null, tailnetIp: null, httpsCerts: false };

/** `tailscale status --json`: the backend state, this machine's DNS name, first IPv4 and certificate domains. */
export function parseTailscaleStatus(json: string): ParsedStatus {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ...NOT_RUNNING };
  }
  if (!isRecord(value)) return { ...NOT_RUNNING };
  const self = isRecord(value.Self) ? value.Self : {};
  const rawName = typeof self.DNSName === "string" ? self.DNSName.trim().replace(/\.$/, "").toLowerCase() : "";
  const ips = [self.TailscaleIPs, value.TailscaleIPs].flatMap((list) => (Array.isArray(list) ? list : [])).filter((ip): ip is string => typeof ip === "string");
  const ipv4 = ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null;
  const certDomains = Array.isArray(value.CertDomains) ? value.CertDomains.filter((domain): domain is string => typeof domain === "string") : [];
  const dnsName = rawName || null;
  const httpsCerts = dnsName !== null && certDomains.some((domain) => domain.trim().replace(/\.$/, "").toLowerCase() === dnsName);
  return { running: value.BackendState === "Running", dnsName, tailnetIp: ipv4, httpsCerts };
}

/** `tailscale debug prefs`: whether `OperatorUser` is `user`. Null when the output is not prefs. */
export function parseOperatorUser(json: string, user: string): boolean | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  // Omitted when empty.
  return typeof value.OperatorUser === "string" && value.OperatorUser === user;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD = new Set(["", "0.0.0.0", "::"]);

const bare = (host: string): string => host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
const isLoopbackHost = (host: string): boolean => LOOPBACK.has(bare(host));

/** The address `tailscale serve` should proxy to: loopback unless the daemon binds one specific other host. */
export function serveTarget(daemon: DaemonHttpAddress): string {
  const host = bare(daemon.host);
  if (LOOPBACK.has(host) || WILDCARD.has(host)) return `http://127.0.0.1:${daemon.port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${daemon.port}`;
}

/** A serve proxy (`http://127.0.0.1:47831`, `127.0.0.1:47831`, `47831`) as a {@link ProxyTarget}; null for anything else. */
export function parseProxyTarget(text: string): ProxyTarget | null {
  const raw = text.trim();
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    return port >= 1 && port <= 65535 ? { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` } : null;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z+]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const port = Number(url.port || 80);
  const host = bare(url.hostname);
  return { host, port, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` };
}

/** Whether two targets reach the same listener (every loopback name counts as the same host). */
export function sameProxyTarget(a: ProxyTarget, b: ProxyTarget): boolean {
  if (a.port !== b.port) return false;
  return a.host === b.host || (isLoopbackHost(a.host) && isLoopbackHost(b.host));
}

/** A proxy target that reaches the daemon bound at `daemon`. */
export function reachesDaemon(target: ProxyTarget, daemon: DaemonHttpAddress): boolean {
  if (target.port !== daemon.port) return false;
  const bound = bare(daemon.host);
  if (isLoopbackHost(target.host)) return LOOPBACK.has(bound) || WILDCARD.has(bound);
  return target.host === bound || WILDCARD.has(bound);
}

/** `tailscale serve status --json` (also its `Foreground` sessions): every port this machine's name serves. */
export function parseServeRoutes(json: string, dnsName: string | null): { routes: ServeRoute[]; usedPorts: number[] } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { routes: [], usedPorts: [] };
  }
  if (!isRecord(value)) return { routes: [], usedPorts: [] };
  const configs: Record<string, unknown>[] = [value];
  if (isRecord(value.Foreground)) configs.push(...Object.values(value.Foreground).filter(isRecord));
  const routes = new Map<number, ServeRoute>();
  const usedPorts = new Set<number>();
  const name = dnsName?.toLowerCase() ?? null;
  for (const config of configs) {
    const tcp = isRecord(config.TCP) ? config.TCP : {};
    for (const [portText, handler] of Object.entries(tcp)) {
      const port = Number(portText);
      if (!Number.isInteger(port)) continue;
      usedPorts.add(port);
      if (isRecord(handler) && typeof handler.TCPForward === "string") {
        // `--tls-terminated-tcp`: TLS ends at Tailscale, the bytes go to the forward.
        routes.set(port, { port, kind: "tcp", https: Boolean(handler.TerminateTLS), target: parseProxyTarget(handler.TCPForward) });
      } else if (!routes.has(port)) {
        routes.set(port, { port, kind: "other", https: isRecord(handler) && handler.HTTPS === true, target: null });
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
      const handler = tcp[String(port)];
      const https = !(isRecord(handler) && handler.HTTPS === false);
      const handlers = isRecord(site) && isRecord(site.Handlers) ? site.Handlers : {};
      const root = handlers["/"];
      const onlyRoot = Object.keys(handlers).length === 1;
      const target = onlyRoot && isRecord(root) && typeof root.Proxy === "string" ? parseProxyTarget(root.Proxy) : null;
      routes.set(port, { port, kind: "web", https, target });
    }
  }
  return { routes: [...routes.values()].sort((a, b) => a.port - b.port), usedPorts: [...usedPorts].sort((a, b) => a - b) };
}

export interface ParsedServe {
  /** HTTPS ports of this machine's name that proxy `/` to the daemon. */
  daemonPorts: number[];
  /** Ports that serve something (anything) already. */
  usedPorts: number[];
}

/** Which ports of {@link parseServeRoutes} serve the daemon over HTTPS. */
function daemonPortsOf(routes: readonly ServeRoute[], daemon: DaemonHttpAddress): number[] {
  return routes.filter((route) => route.https && route.target !== null && reachesDaemon(route.target, daemon)).map((route) => route.port);
}

/** `tailscale serve status --json` (also its `Foreground` sessions): which ports serve the daemon. */
export function parseServeStatus(json: string, dnsName: string | null, daemon: DaemonHttpAddress): ParsedServe {
  const { routes, usedPorts } = parseServeRoutes(json, dnsName);
  return { daemonPorts: daemonPortsOf(routes, daemon), usedPorts };
}

export function tailnetUrl(dnsName: string, port: number): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

export function serveCommand(port: number, daemon: DaemonHttpAddress): string {
  return ["tailscale", ...serveArgs(port, serveTarget(daemon))].join(" ");
}

function serveArgs(port: number, target: string): string[] {
  return ["serve", "--bg", `--https=${port}`, target];
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
function failureLine(text: string, fallback: string): string {
  let line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0 && !/^Command failed:/.test(part)) ?? fallback;
  if (/timed out|ETIMEDOUT|SIGTERM/.test(text) && !/https:\/\//.test(text)) line = `${fallback}: Tailscale did not answer in time`;
  if (line.length > 300) line = `${line.slice(0, 297)}…`;
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];
  return link && !line.includes(link) ? `${line} ${link}` : line;
}

// ---- the service ----------------------------------------------------------------------------------

export function createLocalTailscale(deps: LocalTailscaleDeps): LocalTailscale {
  const run = deps.run ?? execFileRunner;
  const now = deps.now ?? Date.now;
  const user = deps.user ?? (() => userInfo().username);
  const isRoot = deps.isRoot ?? (() => typeof process.getuid === "function" && process.getuid() === 0);
  let cache: { at: number; value: TailscaleSnapshot } | null = null;
  let inflight: Promise<TailscaleSnapshot> | null = null;
  /** What the last change run as the daemon's user showed: allowed (true), refused (false), or nothing yet. */
  let changedWithoutSudo: boolean | null = null;
  /** Serve changes run one at a time (the repair loop, previews and "Set up for me" share them). */
  let changes: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = changes.then(task, task);
    changes = next.catch(() => undefined);
    return next;
  };

  const readOperator = async (name: string): Promise<boolean | null> => {
    if (isRoot()) return true;
    let fromPrefs: boolean | null = null;
    try {
      fromPrefs = parseOperatorUser((await run("tailscale", ["debug", "prefs"], { timeoutMs: RUN_TIMEOUT_MS })).stdout, name);
    } catch {
      // An older CLI, or tailscaled refusing: fall back to what the last change showed.
    }
    if (fromPrefs === true) return true;
    return changedWithoutSudo ?? fromPrefs;
  };

  const read = async (): Promise<TailscaleSnapshot> => {
    const name = user();
    const base = (installed: boolean, status: ParsedStatus = NOT_RUNNING): TailscaleSnapshot => ({
      installed,
      running: status.running,
      dnsName: status.dnsName,
      tailnetIp: status.tailnetIp,
      httpsCerts: status.httpsCerts,
      serveKnown: false,
      routes: [],
      usedPorts: [],
      operatorOk: null,
      user: name
    });
    let status: ParsedStatus;
    try {
      status = parseTailscaleStatus((await run("tailscale", ["status", "--json"], { timeoutMs: RUN_TIMEOUT_MS })).stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return base(false);
      // Installed, but tailscaled is down (or answered garbage): stdout may still carry the state.
      const stdout = (error as { stdout?: unknown }).stdout;
      status = typeof stdout === "string" && stdout.trim().startsWith("{") ? parseTailscaleStatus(stdout) : { ...NOT_RUNNING };
    }
    if (!status.running) return base(true, status);
    const snapshot = base(true, status);
    try {
      const parsed = parseServeRoutes((await run("tailscale", ["serve", "status", "--json"], { timeoutMs: RUN_TIMEOUT_MS })).stdout, status.dnsName);
      snapshot.routes = parsed.routes;
      snapshot.usedPorts = parsed.usedPorts;
      snapshot.serveKnown = true;
    } catch {
      // Unknown: reported as not serving.
    }
    snapshot.operatorOk = await readOperator(name);
    return snapshot;
  };

  const unknown = (): TailscaleSnapshot => ({
    installed: false,
    running: false,
    dnsName: null,
    tailnetIp: null,
    httpsCerts: false,
    serveKnown: false,
    routes: [],
    usedPorts: [],
    operatorOk: null,
    user: user()
  });

  const snapshot = (options: { fresh?: boolean } = {}): Promise<TailscaleSnapshot> => {
    if (!options.fresh && cache && now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = read()
      .catch(unknown)
      .then((value) => {
        cache = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const boxState = (snap: TailscaleSnapshot): BoxLocalTailscale => {
    const daemon = deps.daemonHttp();
    const daemonPorts = daemonPortsOf(snap.routes, daemon);
    const serving = snap.running && daemonPorts.length > 0;
    const servePort = serving
      ? (daemonPorts.includes(DEFAULT_TAILSCALE_SERVE_PORT) ? DEFAULT_TAILSCALE_SERVE_PORT : daemonPorts[0]!)
      : snap.running
        ? (SERVE_PORT_CANDIDATES.find((port) => !snap.usedPorts.includes(port)) ?? DEFAULT_TAILSCALE_SERVE_PORT)
        : DEFAULT_TAILSCALE_SERVE_PORT;
    return {
      installed: snap.installed,
      running: snap.running,
      dnsName: snap.dnsName,
      tailnetIp: snap.tailnetIp,
      servePort,
      serving,
      suggestedUrl: snap.dnsName ? tailnetUrl(snap.dnsName, servePort) : null,
      serveCommand: snap.installed ? serveCommand(servePort, daemon) : null,
      ...(snap.running && snap.operatorOk !== null ? { operatorOk: snap.operatorOk } : {})
    };
  };

  /** Run one `tailscale` change as the daemon's user, then once through `sudo -n` if Tailscale refuses it. */
  const change = (args: string[], timeoutMs: number, label: string): Promise<ChangeResult> =>
    exclusive(async () => {
      const command = `sudo tailscale ${args.join(" ")}`;
      cache = null;
      try {
        await run("tailscale", args, { timeoutMs });
        changedWithoutSudo = true;
        return { ok: true, sudo: false };
      } catch (error) {
        const output = outputOf(error);
        if (!isPermissionError(output)) return { ok: false, reason: "failed", message: failureLine(output, label), command };
        changedWithoutSudo = false;
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
          await run("sudo", ["-n", "tailscale", ...args], { timeoutMs });
          return { ok: true, sudo: true };
        } catch (error) {
          const output = outputOf(error);
          if (!isPermissionError(output)) return { ok: false, reason: "failed", message: failureLine(output, label), command };
        }
      }
      return {
        ok: false,
        reason: "permission",
        message: `Tailscale doesn't let this server's user (${user()}) change what it serves, and sudo needs a password.`,
        command
      };
    });

  const operatorCommand = (): string => `sudo tailscale set --operator=${user()}`;

  const serve = async (port: number): Promise<ServeResult> => {
    const result = await change(serveArgs(port, serveTarget(deps.daemonHttp())), SERVE_TIMEOUT_MS, "tailscale serve failed");
    if (result.ok) return { ok: true, port, sudo: result.sudo };
    if (result.reason === "failed") return { ok: false, reason: "failed", message: result.message };
    const name = user();
    const operator = operatorCommand();
    return {
      ok: false,
      reason: "permission",
      message: `Tailscale doesn't let this server's user (${name}) change what it serves. Run \`${operator}\` once, then "Set up for me" works — or run \`${result.command}\` yourself.`,
      commands: [operator, result.command]
    };
  };

  const setOperator = (): Promise<ChangeResult> =>
    exclusive(async () => {
      const name = user();
      const command = operatorCommand();
      if (!SAFE_USER.test(name)) return { ok: false, reason: "failed", message: `This server's user name (${JSON.stringify(name)}) can't be passed to Tailscale.`, command };
      cache = null;
      const args = ["set", `--operator=${name}`];
      try {
        if (isRoot()) await run("tailscale", args, { timeoutMs: RUN_TIMEOUT_MS });
        else await run("sudo", ["-n", "tailscale", ...args], { timeoutMs: RUN_TIMEOUT_MS });
        changedWithoutSudo = true;
        return { ok: true, sudo: !isRoot() };
      } catch (error) {
        const output = outputOf(error);
        if (/password is required|a terminal is required|not in the sudoers|may not run sudo|sudo:/i.test(output) || isPermissionError(output)) {
          return { ok: false, reason: "permission", message: `This server's user (${name}) can't run sudo without a password, so Orquester can't make it Tailscale's operator.`, command };
        }
        return { ok: false, reason: "failed", message: failureLine(output, "tailscale set --operator failed"), command };
      }
    });

  return {
    state: async (options) => boxState(await snapshot(options)),
    cached: () => (cache ? boxState(cache.value) : null),
    snapshot,
    serve,
    serveProxy: (port, target) => change(serveArgs(port, target), SERVE_TIMEOUT_MS, "tailscale serve failed"),
    unserve: (port) => change(["serve", `--https=${port}`, "off"], RUN_TIMEOUT_MS * 2, "tailscale serve off failed"),
    setOperator,
    operatorCommand
  };
}
