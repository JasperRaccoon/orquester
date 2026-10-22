import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import {
  tailscaleServeRoutes,
  type SetTailscaleServeRequest,
  type TailscaleServeErrorBody,
  type TailscaleServeProblem,
  type TailscaleServeProblemCode,
  type TailscaleServeStatus
} from "@orquester/api";

// Settings → Server → Remote access → "Tailscale HTTPS": serve the daemon's HTTP
// transport to the tailnet at https://<machine>.<tailnet>.ts.net through
// `tailscale serve`. The CLI runs with argument arrays (no shell) and bounded
// timeouts, and its output is never echoed: stderr can carry auth keys
// (`tskey-…`), so failures are mapped to fixed, actionable messages.

/** Bounds `tailscale status` (measured at up to ~2.6 s on a busy host). */
const STATUS_TIMEOUT_MS = 3_500;
/** Bounds `tailscale serve`, which may wait on the control plane. */
const SERVE_TIMEOUT_MS = 10_000;
const HTTPS_PORT = 443;
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The CLI could not be run at all, or did not finish in time. */
export class TailscaleCliError extends Error {
  constructor(readonly reason: "not-installed" | "timeout" | "spawn-failed") {
    super(`tailscale CLI ${reason}`);
    this.name = "TailscaleCliError";
  }
}

/** Runs `tailscale <args>`; rejects only with a {@link TailscaleCliError}. Injected in tests. */
export type TailscaleRunner = (args: readonly string[], timeoutMs: number) => Promise<TailscaleCommandResult>;

function execOnce(bin: string, args: readonly string[], timeoutMs: number): Promise<TailscaleCommandResult> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        bin,
        [...args],
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (failure.code === "ENOENT" || failure.code === "EACCES" || failure.code === "ENOTDIR") {
            reject(new TailscaleCliError("not-installed"));
          } else if (failure.killed) {
            reject(new TailscaleCliError("timeout"));
          } else if (typeof failure.code === "number") {
            resolve({ exitCode: failure.code, stdout: String(stdout), stderr: String(stderr) });
          } else {
            reject(new TailscaleCliError("spawn-failed"));
          }
        }
      );
    } catch {
      // execFile throws synchronously for some spawn failures (e.g. a bad PATH entry).
      reject(new TailscaleCliError("spawn-failed"));
    }
  });
}

/** The real CLI: `tailscale` on PATH, else (macOS) the one inside Tailscale.app. */
export const execTailscale: TailscaleRunner = async (args, timeoutMs) => {
  const bin = process.platform === "win32" ? "tailscale.exe" : "tailscale";
  try {
    return await execOnce(bin, args, timeoutMs);
  } catch (error) {
    if (process.platform === "darwin" && error instanceof TailscaleCliError && error.reason === "not-installed") {
      return execOnce(MAC_APP_CLI, args, timeoutMs);
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type StderrDiagnostic = "no-existing-handler" | "not-logged-in" | "permission-denied" | "https-disabled" | "daemon-not-running" | "unknown";

/**
 * Failure kinds named without quoting the CLI; anything unrecognized is
 * "unknown" rather than raw text.
 */
// Adapted from T3 Code (MIT): packages/tailscale/src/tailscale.ts
const STDERR_PATTERNS: ReadonlyArray<readonly [RegExp, Exclude<StderrDiagnostic, "unknown">]> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/failed to connect to local tailscaled|tailscaled.*(not running|doesn't appear to be running)|is tailscaled running/i, "daemon-not-running"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/HTTPS.*not (enabled|configured)|cert support is not enabled|serve is not enabled/i, "https-disabled"],
  [/permission denied|access denied|must be root|operation not permitted|use 'sudo tailscale|--operator/i, "permission-denied"]
];

export function stderrDiagnostic(stderr: string): StderrDiagnostic {
  return STDERR_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
}

export interface TailscaleNodeStatus {
  /** `BackendState`: Running, Stopped, NeedsLogin, NeedsMachineAuth, NoState, Starting. */
  backendState: string | null;
  /** MagicDNS name without the trailing dot. */
  dnsName: string | null;
  /** The tailnet grants this node the `https` capability; null when the CLI reports no capability map. */
  httpsEnabled: boolean | null;
}

/** Read `tailscale status --json`; null when it is not JSON. */
// Adapted from T3 Code (MIT): packages/tailscale/src/tailscale.ts
export function parseTailscaleStatus(raw: string): TailscaleNodeStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const self = record.Self && typeof record.Self === "object" ? (record.Self as Record<string, unknown>) : null;
  const dns = typeof self?.DNSName === "string" ? self.DNSName.trim().replace(/\.$/, "") : "";
  const capMap = self?.CapMap;
  return {
    backendState: typeof record.BackendState === "string" ? record.BackendState : null,
    dnsName: dns.length > 0 ? dns : null,
    httpsEnabled:
      capMap && typeof capMap === "object" && !Array.isArray(capMap) ? Object.hasOwn(capMap, "https") : null
  };
}

/**
 * What `tailscale serve status --json` serves on HTTPS port 443 at the root
 * path: a proxy target such as `http://127.0.0.1:7420`, a short description of
 * any other handler, or null when the port is free.
 */
export function parseServeTarget(raw: string, port = HTTPS_PORT): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const config = parsed as { TCP?: Record<string, Record<string, unknown>>; Web?: Record<string, { Handlers?: Record<string, Record<string, unknown>> }> };
  const tcp = config.TCP?.[String(port)];
  if (tcp && typeof tcp.TCPForward === "string") return `tcp://${tcp.TCPForward}`;
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    if (!hostPort.endsWith(`:${port}`)) continue;
    const handlers = web?.Handlers ?? {};
    const root = handlers["/"];
    if (root && typeof root.Proxy === "string") return root.Proxy;
    if (root) return root.Path !== undefined ? "a file path" : root.Text !== undefined ? "a text page" : "another handler";
    const paths = Object.keys(handlers);
    if (paths.length > 0) return `paths ${paths.join(", ")}`;
  }
  return tcp ? "another service" : null;
}

/** The local URL `tailscale serve` proxies to for the daemon's HTTP listener. */
export function localTarget(host: string, port: number): string {
  const trimmed = host.trim();
  if (trimmed === "" || trimmed === "0.0.0.0" || trimmed === "localhost") return `http://127.0.0.1:${port}`;
  if (trimmed === "::" || trimmed === "[::]") return `http://[::1]:${port}`;
  return trimmed.includes(":") && !trimmed.startsWith("[") ? `http://[${trimmed}]:${port}` : `http://${trimmed}:${port}`;
}

/** Same target, ignoring a trailing slash and `localhost` vs `127.0.0.1`. */
function sameTarget(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\/+$/, "").replace("://localhost:", "://127.0.0.1:");
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const MESSAGES: Record<TailscaleServeProblemCode, string> = {
  "not-installed": "The tailscale CLI is not installed on this machine (or not on the daemon's PATH). Install Tailscale from tailscale.com/download and sign in.",
  "daemon-not-running": "Tailscale is installed but its service (tailscaled) is not running. Start it, e.g. `sudo systemctl enable --now tailscaled`.",
  "not-logged-in": "This machine is not signed in to Tailscale. Run `tailscale up` (or sign in from the Tailscale app).",
  "needs-approval": "This machine is waiting for approval in the Tailscale admin console (Machines).",
  stopped: "Tailscale is turned off on this machine. Run `tailscale up` to connect it.",
  "no-magicdns": "Your tailnet gives this machine no MagicDNS name. Turn on MagicDNS in the Tailscale admin console (DNS).",
  "https-disabled": "HTTPS certificates are off for your tailnet. Turn on HTTPS Certificates in the Tailscale admin console (DNS), then try again.",
  "permission-denied": "The daemon's user may not change Tailscale's settings. Run `sudo tailscale set --operator=$USER` once as the daemon's user, then try again.",
  "http-disabled": "Turn on External HTTP access first: Tailscale HTTPS forwards to it.",
  "port-in-use": "Tailscale HTTPS on port 443 already serves something else on this machine.",
  timeout: "The tailscale CLI did not answer in time. Check `tailscale status` on this machine.",
  failed: "tailscale serve failed. Check `tailscale serve status` on this machine."
};

const problem = (code: TailscaleServeProblemCode, message = MESSAGES[code]): TailscaleServeProblem => ({ code, message });

/** A refused request: its problem plus the HTTP status the route answers. */
export class TailscaleServeError extends Error {
  constructor(
    readonly problem: TailscaleServeProblem,
    readonly statusCode: number
  ) {
    super(problem.message);
    this.name = "TailscaleServeError";
  }
}

const cliProblem = (error: unknown): TailscaleServeProblem =>
  error instanceof TailscaleCliError
    ? problem(error.reason === "not-installed" ? "not-installed" : error.reason === "timeout" ? "timeout" : "failed")
    : problem("failed");

function stderrProblem(stderr: string): TailscaleServeProblem {
  const diagnostic = stderrDiagnostic(stderr);
  return diagnostic === "unknown" || diagnostic === "no-existing-handler" ? problem("failed") : problem(diagnostic);
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface TailscaleServeDeps {
  run?: TailscaleRunner;
  /** The daemon's HTTP transport as configured now. */
  http: () => { enabled: boolean; host: string; port: number };
  /** The saved choice. */
  saved: () => boolean;
  /** Save the choice (daemon.json). */
  save: (enabled: boolean) => Promise<void>;
  log?: (message: string) => void;
}

interface Observed {
  node: TailscaleNodeStatus | null;
  /** What 443 serves; undefined when it could not be read. */
  target: string | null | undefined;
  problem: TailscaleServeProblem | null;
}

export class TailscaleServe {
  private readonly run: TailscaleRunner;
  /** Serializes changes: two toggles (or a toggle and a transport restart) never interleave CLI calls. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * The target this daemon last served (or found serving it), so a transport
   * restart on a new port re-points its own mapping and nothing else's.
   */
  private applied: string | null = null;

  constructor(private readonly deps: TailscaleServeDeps) {
    this.run = deps.run ?? execTailscale;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Read the CLI's view: node status, then what port 443 serves. */
  private async observe(): Promise<Observed> {
    let result: TailscaleCommandResult;
    try {
      result = await this.run(["status", "--json"], STATUS_TIMEOUT_MS);
    } catch (error) {
      return { node: null, target: undefined, problem: cliProblem(error) };
    }
    const node = parseTailscaleStatus(result.stdout);
    if (!node) {
      // `status --json` exits non-zero without JSON when tailscaled is down.
      const diagnostic = stderrDiagnostic(result.stderr);
      return {
        node: null,
        target: undefined,
        problem: problem(diagnostic === "unknown" || diagnostic === "no-existing-handler" ? "daemon-not-running" : diagnostic)
      };
    }
    const stateProblem =
      node.backendState === "NeedsLogin" || node.backendState === "NoState"
        ? problem("not-logged-in")
        : node.backendState === "NeedsMachineAuth"
          ? problem("needs-approval")
          : node.backendState === "Stopped"
            ? problem("stopped")
            : !node.dnsName
              ? problem("no-magicdns")
              : node.httpsEnabled === false
                ? problem("https-disabled")
                : null;
    if (stateProblem && stateProblem.code !== "https-disabled") {
      return { node, target: undefined, problem: stateProblem };
    }
    let target: string | null | undefined;
    try {
      const serve = await this.run(["serve", "status", "--json"], STATUS_TIMEOUT_MS);
      target = serve.exitCode === 0 ? parseServeTarget(serve.stdout) : undefined;
    } catch {
      target = undefined;
    }
    const http = this.deps.http();
    if (target && sameTarget(target, localTarget(http.host, http.port))) this.applied = target;
    return { node, target, problem: stateProblem };
  }

  private statusFrom(observed: Observed): TailscaleServeStatus {
    const http = this.deps.http();
    const ours = localTarget(http.host, http.port);
    const target = observed.target ?? null;
    const active = target !== null && sameTarget(target, ours);
    // A mapping this daemon made on its previous port is stale, not someone else's.
    const stale = target !== null && !active && this.applied !== null && sameTarget(target, this.applied);
    const otherTarget = target !== null && !active && !stale ? target : null;
    const enabled = this.deps.saved();
    let current = observed.problem;
    if (!current && !http.enabled) current = problem("http-disabled");
    if (!current && otherTarget) current = problem("port-in-use", `${MESSAGES["port-in-use"]} (${otherTarget}). Remove it with \`tailscale serve --https=443 off\`, then try again.`);
    return {
      available: observed.node !== null,
      dnsName: observed.node?.dnsName ?? null,
      httpsEnabled: observed.node?.httpsEnabled ?? null,
      enabled,
      active,
      url: observed.node?.dnsName ? `https://${observed.node.dnsName}/` : null,
      otherTarget,
      problem: current
    };
  }

  /** Read-only: what the CLI reports and what the daemon would serve. */
  status(): Promise<TailscaleServeStatus> {
    return this.serialized(async () => this.statusFrom(await this.observe()));
  }

  /**
   * Turn the mapping on or off and save the choice. Refuses (with an actionable
   * problem) when Tailscale cannot serve; never replaces a mapping it did not make.
   */
  setEnabled(enabled: boolean): Promise<TailscaleServeStatus> {
    return this.serialized(async () => {
      const observed = await this.observe();
      const http = this.deps.http();
      const ours = localTarget(http.host, http.port);
      const target = observed.target;
      if (!enabled) {
        // Only a mapping to this daemon is removed; someone else's stays.
        if (target != null && (sameTarget(target, ours) || (this.applied !== null && sameTarget(target, this.applied)))) {
          await this.serveOff();
          this.applied = null;
        }
        await this.deps.save(false);
        return this.statusFrom(await this.observe());
      }
      if (!http.enabled) throw new TailscaleServeError(problem("http-disabled"), 409);
      if (observed.problem) throw new TailscaleServeError(observed.problem, observed.problem.code === "timeout" ? 504 : 409);
      const stale = target != null && this.applied !== null && sameTarget(target, this.applied);
      if (target != null && !sameTarget(target, ours) && !stale) {
        throw new TailscaleServeError(this.statusFrom(observed).problem ?? problem("port-in-use"), 409);
      }
      if (target == null || !sameTarget(target, ours)) {
        await this.serveOn(ours);
      }
      await this.deps.save(true);
      return this.statusFrom(await this.observe());
    });
  }

  /**
   * Re-apply the saved choice when the HTTP transport (re)starts: its port may
   * have changed since the mapping was made. Best effort; logs, never throws.
   */
  reconcile(): Promise<void> {
    return this.serialized(async () => {
      const http = this.deps.http();
      if (!this.deps.saved() || !http.enabled) return;
      const observed = await this.observe();
      if (observed.problem || observed.target === undefined) {
        this.deps.log?.(`tailscale serve: not re-applied (${observed.problem?.code ?? "serve status unreadable"})`);
        return;
      }
      const ours = localTarget(http.host, http.port);
      if (observed.target !== null && sameTarget(observed.target, ours)) return;
      if (observed.target !== null && (this.applied === null || !sameTarget(observed.target, this.applied))) {
        this.deps.log?.("tailscale serve: port 443 serves something else; left alone");
        return;
      }
      try {
        await this.serveOn(ours);
        this.deps.log?.(`tailscale serve: HTTPS 443 → ${ours}`);
      } catch (error) {
        this.deps.log?.(`tailscale serve: re-apply failed (${error instanceof TailscaleServeError ? error.problem.code : "failed"})`);
      }
    });
  }

  private async serveOn(target: string): Promise<void> {
    const result = await this.runServe(["serve", "--bg", `--https=${HTTPS_PORT}`, target]);
    if (result.exitCode !== 0) throw new TailscaleServeError(stderrProblem(result.stderr), 409);
    this.applied = target;
  }

  private async serveOff(): Promise<void> {
    const result = await this.runServe(["serve", `--https=${HTTPS_PORT}`, "off"]);
    if (result.exitCode !== 0 && stderrDiagnostic(result.stderr) !== "no-existing-handler") {
      throw new TailscaleServeError(stderrProblem(result.stderr), 409);
    }
  }

  private async runServe(args: string[]): Promise<TailscaleCommandResult> {
    try {
      return await this.run(args, SERVE_TIMEOUT_MS);
    } catch (error) {
      const found = cliProblem(error);
      throw new TailscaleServeError(found, found.code === "timeout" ? 504 : 409);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `GET|PUT /api/remote-access/tailscale-serve`, on both transports. Under
 * `/api`, so the remote transport's auth hook gates them like every other route.
 */
export function registerTailscaleServeRoutes(app: FastifyInstance, serve: () => TailscaleServe | undefined): void {
  const unavailable = { code: "failed", message: "Tailscale HTTPS is not available on this daemon." } satisfies TailscaleServeErrorBody;
  app.get(tailscaleServeRoutes.serve, async (_request, reply) => {
    const controller = serve();
    if (!controller) return reply.code(503).send(unavailable);
    return controller.status();
  });
  app.put<{ Body: SetTailscaleServeRequest }>(tailscaleServeRoutes.serve, async (request, reply) => {
    const controller = serve();
    if (!controller) return reply.code(503).send(unavailable);
    if (typeof request.body?.enabled !== "boolean") {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "`enabled` must be a boolean." } satisfies TailscaleServeErrorBody);
    }
    try {
      return await controller.setEnabled(request.body.enabled);
    } catch (error) {
      if (error instanceof TailscaleServeError) {
        return reply.code(error.statusCode).send({ code: error.problem.code, message: error.problem.message } satisfies TailscaleServeErrorBody);
      }
      throw error;
    }
  });
}
