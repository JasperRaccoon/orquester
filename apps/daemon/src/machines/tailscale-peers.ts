/**
 * The daemon host's view of its tailnet (tailnet machines spec §4.1.1–4.1.2): `Self` and every
 * `Peer` from Tailscale's LocalAPI (`GET /localapi/v0/status` over `tailscaled.sock`), falling
 * back to `tailscale status --json` (no shell, short timeout) when the socket is not there or
 * refuses. When neither works the read is a `tailscale-unavailable` problem that names the fix.
 *
 * Read-only: nothing here changes Tailscale state. The JSON is parsed field by field and anything
 * unexpected is skipped, never thrown on; stderr and raw bodies are never logged or returned.
 */

import { execFile } from "node:child_process";
import { request } from "node:http";

import { machineOsOfTailscale, type MachineOs, type MachineProblem } from "@orquester/api";

/** Where `tailscaled` listens on Linux (world-writable on hosts where the daemon user may read status). */
export const TAILSCALED_SOCKET = "/var/run/tailscale/tailscaled.sock";
/** The Host header the LocalAPI requires on its unix socket. */
const LOCALAPI_HOST = "local-tailscaled.sock";
const LOCALAPI_STATUS_PATH = "/localapi/v0/status";
const READ_TIMEOUT_MS = 5_000;
/** A status body is a few KiB per peer; anything far larger is not a status. */
const MAX_STATUS_BYTES = 16 * 1024 * 1024;

/** One node of the tailnet as the registry uses it. */
export interface TailnetNode {
  /** Tailscale's stable node id (`ID` in the status JSON; `StableID` in some builds). */
  stableId: string;
  /** The OS hostname as Tailscale reports it ("jasper", "Eduard’s MacBook Pro"). */
  hostName: string;
  /** MagicDNS name without the trailing dot; null when the node has none. */
  dnsName: string | null;
  os: MachineOs;
  online: boolean;
  /** ISO time last seen; null when Tailscale reports the zero time (online now, or never). */
  lastSeenAt: string | null;
  /** IPv4 first. */
  tailnetIps: string[];
}

export interface TailnetStatus {
  /** `Running` when connected; `Stopped`, `NeedsLogin`, … otherwise (then `self` and `peers` are empty). */
  backendState: string;
  /** This daemon's own node; null when the status has none (logged out). */
  self: TailnetNode | null;
  peers: TailnetNode[];
}

export type TailnetRead = { ok: true; status: TailnetStatus; via: "localapi" | "cli" } | { ok: false; problem: MachineProblem };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const STABLE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function nodeOf(value: unknown): TailnetNode | null {
  if (!isRecord(value)) return null;
  const rawId = typeof value.StableID === "string" ? value.StableID : typeof value.ID === "string" ? value.ID : "";
  if (!STABLE_ID.test(rawId)) return null;
  const dns = typeof value.DNSName === "string" ? value.DNSName.trim().replace(/\.$/, "").toLowerCase() : "";
  const hostName = typeof value.HostName === "string" && value.HostName.trim() !== "" ? value.HostName.trim() : (dns.split(".")[0] ?? "");
  if (hostName === "") return null;
  const ips = (Array.isArray(value.TailscaleIPs) ? value.TailscaleIPs : []).filter((ip): ip is string => typeof ip === "string" && ip.length > 0);
  ips.sort((a, b) => Number(!IPV4.test(a)) - Number(!IPV4.test(b)));
  const seen = typeof value.LastSeen === "string" ? Date.parse(value.LastSeen) : Number.NaN;
  // Go's zero time (0001-01-01) is "not recorded".
  const lastSeenAt = Number.isFinite(seen) && seen > 0 ? new Date(seen).toISOString() : null;
  return {
    stableId: rawId,
    hostName,
    dnsName: dns || null,
    os: machineOsOfTailscale(typeof value.OS === "string" ? value.OS : null),
    online: value.Online === true,
    lastSeenAt,
    tailnetIps: ips
  };
}

/**
 * Parse a LocalAPI / `tailscale status --json` body. Null when it is not a status at all; a
 * stopped or logged-out backend reads as no nodes (Tailscale keeps its last map, which is stale).
 */
export function parseTailnetStatus(json: string): TailnetStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.BackendState !== "string") return null;
  if (value.BackendState !== "Running") return { backendState: value.BackendState, self: null, peers: [] };
  const self = nodeOf(value.Self);
  const peers: TailnetNode[] = [];
  const seen = new Set<string>(self ? [self.stableId] : []);
  for (const entry of Object.values(isRecord(value.Peer) ? value.Peer : {})) {
    const node = nodeOf(entry);
    if (!node || seen.has(node.stableId)) continue;
    seen.add(node.stableId);
    peers.push(node);
  }
  peers.sort((a, b) => a.hostName.localeCompare(b.hostName) || a.stableId.localeCompare(b.stableId));
  return { backendState: "Running", self, peers };
}

/** Reads one status body; rejects when the source is not usable. */
export type StatusSource = () => Promise<string>;

/** The LocalAPI status over `socketPath`. */
export function localApiStatusSource(socketPath = TAILSCALED_SOCKET): StatusSource {
  return () =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, path: LOCALAPI_STATUS_PATH, method: "GET", headers: { Host: LOCALAPI_HOST }, timeout: READ_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`LocalAPI answered ${res.statusCode ?? "nothing"}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_STATUS_BYTES) {
            req.destroy(new Error("LocalAPI status too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("LocalAPI timed out")));
      req.on("error", reject);
      req.end();
    });
}

/** `tailscale status --json` (no shell). */
export function cliStatusSource(binary = "tailscale"): StatusSource {
  return () =>
    new Promise((resolve, reject) => {
      execFile(binary, ["status", "--json"], { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_STATUS_BYTES, encoding: "utf8" }, (error, stdout) => {
        // `tailscale status` exits non-zero when stopped but still prints the status JSON.
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
}

export const TAILSCALE_UNAVAILABLE_PROBLEM: MachineProblem = Object.freeze({
  code: "tailscale-unavailable",
  message: "Orquester can't read this server's Tailscale status, so it can't list your tailnet machines.",
  fix: "Install Tailscale on the Orquester host and run `sudo tailscale up`; if it runs already, check that `tailscale status` works for the user the Orquester daemon runs as."
});

/** Tailscale answers but is not connected to the tailnet (stopped, logged out). */
export function tailscaleNotRunningProblem(backendState: string): MachineProblem {
  const state = backendState.replace(/[^A-Za-z]/g, "").slice(0, 40) || "unknown";
  return {
    code: "tailscale-unavailable",
    message: `Tailscale on the Orquester host is not connected to your tailnet (state: ${state}).`,
    fix: state === "NeedsLogin" ? "Run `sudo tailscale up` on the Orquester host and sign in." : "Run `sudo tailscale up` on the Orquester host."
  };
}

export interface TailnetReaderOptions {
  localApi?: StatusSource;
  cli?: StatusSource;
}

/** Read the tailnet: the LocalAPI first, then the CLI; never rejects. */
export function createTailnetReader(options: TailnetReaderOptions = {}): () => Promise<TailnetRead> {
  const sources: { via: "localapi" | "cli"; read: StatusSource }[] = [
    { via: "localapi", read: options.localApi ?? localApiStatusSource() },
    { via: "cli", read: options.cli ?? cliStatusSource() }
  ];
  return async () => {
    for (const source of sources) {
      let body: string;
      try {
        body = await source.read();
      } catch {
        continue;
      }
      const status = parseTailnetStatus(body);
      if (!status) continue;
      if (status.backendState !== "Running") return { ok: false, problem: tailscaleNotRunningProblem(status.backendState) };
      return { ok: true, status, via: source.via };
    }
    return { ok: false, problem: TAILSCALE_UNAVAILABLE_PROBLEM };
  };
}
