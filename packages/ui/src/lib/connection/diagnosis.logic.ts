/**
 * Connection diagnosis: turn what the client knows about its connection into
 * "what failed" (a headline), "what to try" (steps) and the facts behind it,
 * plus the plain-text diagnostics report the user can copy. Pure: the toast
 * renders it, the tests drive it.
 */

import type { ConnectionStatus, Runtime } from "../../types";
import type { ConnectionLogState } from "./connection-log";
import { redactSecrets, redactUrl, type ConnectionFailureKind } from "./failure";

export type ConnectionDiagnosisKind =
  | ConnectionFailureKind
  /** The daemon announced it was stopping just before the connection failed. */
  | "restarting"
  /** The daemon speaks a newer protocol than this app. */
  | "client-outdated"
  /** The daemon speaks an older protocol than this app. */
  | "server-outdated"
  /** HTTP works, WebSockets do not. */
  | "ws-blocked";

export type ConnectionDiagnosisAction = "retry" | "sign-in" | "reload";

export interface ConnectionDiagnosis {
  kind: ConnectionDiagnosisKind;
  /** `error`: the app cannot work. `warn`: connected, but part of it cannot. */
  severity: "error" | "warn";
  /** Names what failed, e.g. "my-server refused the connection". */
  headline: string;
  steps: string[];
  facts: Array<readonly [label: string, value: string]>;
  /** The one button that fixes it, besides Copy diagnostics. */
  action: ConnectionDiagnosisAction | null;
}

export interface ConnectionDiagnosisInput {
  status: ConnectionStatus;
  /** >0 while the store's reconnect loop runs. */
  attempt: number;
  /** The store's own message (wrong password, lockout countdown). */
  connectionError: string | null;
  log: ConnectionLogState;
  /** What the user calls the server (the connection's name). */
  serverLabel: string;
  /** The connection's endpoint (`https://…`, `unix://…`). */
  endpoint: string;
  /** The terminal WebSocket URL, or null on a transport without one (the desktop's unix socket). */
  wsUrl: string | null;
  runtime: Runtime;
  /** The web app was loaded from this very server. */
  sameOrigin: boolean;
  /** `navigator.onLine`. */
  online: boolean;
  clientProtocol: number;
  clientBuild: string;
  now: number;
}

/** A `daemon.stopping` this recent explains the failure that follows it. */
export const RESTART_WINDOW_MS = 2 * 60_000;
/** Consecutive WebSocket closes, while HTTP is connected, that mean WebSockets are blocked. */
export const WS_BLOCKED_AFTER = 3;

const NETWORK_KINDS: ReadonlySet<ConnectionFailureKind> = new Set([
  "dns",
  "refused",
  "timeout",
  "unreachable",
  "proxy-down",
  "stalled",
  "unknown"
]);

/** Where the failure sits. Returns null when nothing is wrong. */
function locate(input: ConnectionDiagnosisInput): ConnectionDiagnosisKind | null {
  const { log, status } = input;
  if (status === "connected") {
    if (log.serverProtocol !== null && log.serverProtocol !== input.clientProtocol) {
      return log.serverProtocol > input.clientProtocol ? "client-outdated" : "server-outdated";
    }
    const ws = input.wsUrl ? log.ws[input.wsUrl] : undefined;
    if (ws && ws.failures >= WS_BLOCKED_AFTER) {
      return "ws-blocked";
    }
    return null;
  }
  const reconnecting = status === "connecting" && input.attempt > 0;
  if (!reconnecting && status !== "error") {
    return null;
  }
  if (!input.online) {
    return "offline";
  }
  const failure = log.lastFailure;
  if (!failure) {
    return status === "error" ? "unknown" : null;
  }
  if (
    NETWORK_KINDS.has(failure.kind) &&
    log.stoppingAt !== null &&
    // An announcement from before the last connect explained an earlier gap.
    log.stoppingAt >= (log.connectedAt ?? 0) &&
    failure.at >= log.stoppingAt &&
    failure.at - log.stoppingAt <= RESTART_WINDOW_MS
  ) {
    return "restarting";
  }
  return failure.kind;
}

function hostOf(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

function headline(kind: ConnectionDiagnosisKind, input: ConnectionDiagnosisInput): string {
  const server = input.serverLabel;
  const status = input.log.lastFailure?.status;
  switch (kind) {
    case "offline":
      return "This device is offline";
    case "dns":
      return `${server}'s address could not be found`;
    case "refused":
      return `${server} refused the connection`;
    case "tls":
      return `The secure connection to ${server} failed`;
    case "timeout":
      return `${server} did not answer in time`;
    case "unreachable":
      return input.sameOrigin ? `${server} stopped answering` : `Can't reach ${server}`;
    case "restarting":
      return `${server} is restarting`;
    case "proxy-down":
      return `${server}'s proxy answered${status ? ` ${status}` : ""}, but the daemon behind it did not`;
    case "not-orquester":
      return `Something other than Orquester answered at ${server}'s address`;
    case "server-error":
      return `${server} answered with an error${status ? ` (HTTP ${status})` : ""}`;
    case "unauthorized":
      return `Sign in to ${server} again`;
    case "locked":
      return input.connectionError ?? "Too many sign-in attempts from this device";
    case "stalled":
      return `The connection to ${server} went quiet`;
    case "client-outdated":
      return `This app is older than ${server}`;
    case "server-outdated":
      return `${server} runs an older Orquester than this app`;
    case "ws-blocked":
      return `Live terminals can't connect to ${server}`;
    case "unknown":
      return input.connectionError ?? `Can't connect to ${server}`;
  }
}

function steps(kind: ConnectionDiagnosisKind, input: ConnectionDiagnosisInput): string[] {
  const https = input.endpoint.startsWith("https://");
  const local = !hostOf(input.endpoint);
  const checkDaemon = local
    ? "Restart the Orquester app; it starts its own daemon."
    : "Check that the daemon runs on the server (`systemctl status orquester`, or `./deploy.sh verify` from your deploy checkout).";
  switch (kind) {
    case "offline":
      return ["Connect this device to a network. Orquester reconnects on its own."];
    case "dns":
      return [
        "Check the server address in the server switcher for typos.",
        "For a Tailscale address (…ts.net), make sure Tailscale is on and signed in on this device.",
        "A VPN or DNS filter on this device can hide the name; try another network."
      ];
    case "refused":
      return [
        "Nothing listens on that port: the daemon is stopped, or remote access uses another port.",
        checkDaemon,
        "On the server, check Settings → Server → Remote access for the host and port."
      ];
    case "tls":
      return [
        "The server's certificate is untrusted, expired, or issued for another name.",
        "Behind Caddy, make sure the domain points at the server so it can renew the certificate.",
        "Or connect through an address with a certificate browsers already trust, such as the server's Tailscale ts.net name."
      ];
    case "timeout":
      return [
        "The host may be asleep, overloaded, or off the network.",
        "A firewall dropping the port looks like this too; check that the port is open.",
        "Orquester keeps retrying on its own."
      ];
    case "unreachable":
      return [
        ...(input.sameOrigin ? ["It may be restarting; Orquester reconnects on its own when it is back."] : []),
        "Check this device's network connection.",
        checkDaemon,
        ...(https
          ? ["If the certificate is the problem, opening the address in a browser tab shows the warning."]
          : []),
        "A VPN, firewall, or ad blocker on this device can block the connection."
      ];
    case "restarting":
      return [
        "Wait a moment: Orquester reconnects on its own when the daemon is back.",
        "Terminal and chat sessions keep running through a restart."
      ];
    case "proxy-down":
      return [
        "The daemon may be restarting; Orquester keeps retrying.",
        `If it persists: ${checkDaemon}`
      ];
    case "not-orquester":
      return [
        "Another web server, a proxy error page, or a Wi-Fi sign-in page answered instead.",
        "Check the server address and port in the server switcher.",
        "On public Wi-Fi, open any web page to finish the network's sign-in, then retry."
      ];
    case "server-error":
      return ["Retry. If it keeps failing, check the daemon's log on the server and copy these diagnostics."];
    case "unauthorized":
      return [
        "The saved sign-in was refused: the password changed, or this device's sign-in was revoked.",
        "Sign in again with the server's username and password."
      ];
    case "locked":
      return [
        "The server pauses sign-ins from this address after repeated wrong passwords.",
        "Wait for the pause to end, then sign in with the correct password."
      ];
    case "stalled":
      return [
        "The network dropped, or the host stopped responding (asleep or overloaded).",
        "Orquester reconnects on its own."
      ];
    case "client-outdated":
      return input.runtime === "web"
        ? ["Reload to load the server's current app. Some features may misbehave until you do."]
        : ["Update the Orquester desktop app. Some features may misbehave until you do."];
    case "server-outdated":
      return [
        "Update Orquester on the server (`./deploy.sh deploy` from your deploy checkout).",
        "Some features may misbehave until you do."
      ];
    case "ws-blocked":
      return [
        "Requests reach the server, but its WebSocket connections are refused or dropped.",
        "A proxy, firewall, or VPN between this device and the server is blocking WebSocket upgrades: allow them (Caddy's reverse_proxy does by default).",
        "Chats keep working; terminals and browser tabs need the WebSocket."
      ];
    case "unknown":
      return ["Retry. If it keeps failing, copy these diagnostics."];
  }
}

function action(kind: ConnectionDiagnosisKind, input: ConnectionDiagnosisInput): ConnectionDiagnosisAction | null {
  switch (kind) {
    case "unauthorized":
      return "sign-in";
    case "client-outdated":
      return input.runtime === "web" ? "reload" : null;
    case "server-outdated":
    case "ws-blocked":
      return null;
    default:
      return "retry";
  }
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * Turn the connection state into what failed and what to try. Returns null
 * when nothing is wrong (or the app is still starting up).
 */
// Adapted from T3 Code (MIT): packages/client-runtime/src/connection/diagnosis.ts
export function presentConnectionDiagnosis(input: ConnectionDiagnosisInput): ConnectionDiagnosis | null {
  const kind = locate(input);
  if (kind === null) {
    return null;
  }
  const { log } = input;
  const failure = input.status === "connected" ? null : log.lastFailure;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", kind);
  add("HTTP status", failure?.status);
  add("Attempt", input.attempt > 0 ? input.attempt : null);
  add("Server", redactUrl(input.endpoint));
  add("App build", input.clientBuild);
  add("Server build", log.serverBuild);
  add(
    "Protocol",
    `app ${input.clientProtocol}, server ${log.serverProtocol ?? "unknown"}`
  );
  add("Restart announced", log.stoppingAt !== null ? iso(log.stoppingAt) : null);
  const ws = input.wsUrl ? log.ws[input.wsUrl] : undefined;
  if (ws && (kind === "ws-blocked" || ws.failures > 0)) {
    add("WebSocket", `${ws.failures} close(s) since connecting${ws.lastCloseCode !== null ? `, last code ${ws.lastCloseCode}` : ""}`);
  }
  add("Error", failure ? redactSecrets(failure.detail) : null);
  return {
    kind,
    severity: input.status === "connected" ? "warn" : "error",
    headline: headline(kind, input),
    steps: steps(kind, input),
    facts,
    action: action(kind, input)
  };
}

// ---------------------------------------------------------------------------
// The copyable report
// ---------------------------------------------------------------------------

/** One live check run when the diagnostics panel opens. */
export interface ProbeResult {
  /** `ok`: worked. `failed`: did not. `skipped`: not applicable here. `running`: not finished yet. */
  outcome: "ok" | "failed" | "skipped" | "running";
  /** One line: what was checked and what came back. */
  summary: string;
  durationMs?: number;
}

export interface DiagnosticsReportInput {
  diagnosis: ConnectionDiagnosis | null;
  input: ConnectionDiagnosisInput;
  http: ProbeResult;
  ws: ProbeResult;
  /** `navigator.userAgent` and whether the web app runs installed. */
  client: { runtimeLabel: string; userAgent: string };
  /** Exact secret values (the live credential) to strip wherever they appear. */
  secrets: ReadonlyArray<string | null | undefined>;
}

function probeLine(label: string, probe: ProbeResult): string {
  const took = probe.durationMs !== undefined ? ` (${Math.round(probe.durationMs)} ms)` : "";
  return `${label}: ${probe.outcome.toUpperCase()} — ${probe.summary}${took}`;
}

/**
 * The plain-text report behind Copy diagnostics: the server URL without
 * credentials, the client runtime and build, the live HTTP and WebSocket
 * checks, and the recent errors with timestamps. Every line is redacted, and
 * the live credential is stripped wherever it appears.
 */
// Adapted from T3 Code (MIT): packages/client-runtime/src/connection/diagnosis.ts
export function connectionDiagnosticsText(report: DiagnosticsReportInput): string {
  const { diagnosis, input } = report;
  const log = input.log;
  const lines: string[] = [
    "Orquester connection diagnostics",
    `Generated: ${iso(input.now)}`,
    "",
    `Server: ${input.serverLabel} — ${redactUrl(input.endpoint)}`,
    `Client: ${report.client.runtimeLabel}, build ${input.clientBuild}, protocol ${input.clientProtocol}`,
    `User agent: ${report.client.userAgent || "unknown"}`,
    `Network: ${input.online ? "online" : "offline"}`,
    `Status: ${input.status}${input.attempt > 0 ? ` (reconnect attempt ${input.attempt})` : ""}`,
    `Server reports: protocol ${log.serverProtocol ?? "unknown"}, build ${log.serverBuild ?? "unknown"}`,
    `Last connected: ${log.connectedAt !== null ? iso(log.connectedAt) : "never"}`,
    `Restart announced: ${log.stoppingAt !== null ? iso(log.stoppingAt) : "no"}`,
    ""
  ];
  if (diagnosis) {
    lines.push(`Diagnosis: ${diagnosis.headline} [${diagnosis.kind}]`);
    for (const step of diagnosis.steps) lines.push(`  - ${step}`);
  } else {
    lines.push("Diagnosis: no problem detected");
  }
  lines.push("", probeLine("HTTP check", report.http), probeLine("WebSocket check", report.ws), "");
  if (log.recent.length === 0) {
    lines.push("Recent errors: none");
  } else {
    lines.push("Recent errors (oldest first):");
    for (const entry of log.recent) {
      const repeat = entry.count > 1 ? ` ×${entry.count}` : "";
      const status = entry.status !== undefined ? ` HTTP ${entry.status}` : "";
      lines.push(`  ${iso(entry.at)}  ${entry.kind}${status}${repeat}  ${entry.detail}`);
    }
  }
  return lines.map((line) => redactSecrets(line, report.secrets)).join("\n");
}
