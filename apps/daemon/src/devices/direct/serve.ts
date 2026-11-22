/**
 * `tailscale serve` on the owner's device machine (tailnet machines spec §4.5 item 1): the stream
 * gate's loopback port behind the machine's own MagicDNS HTTPS name, so an HTTPS Orquester page
 * can stream from it (a valid certificate, no mixed-content block). Everything runs ON the machine
 * through its box link, with the same CLI handling as the daemon's own serve route
 * (`boxes/tailscale/local.ts`: no shell, short timeouts, `sudo -n` only when Tailscale refuses the
 * user, never a password prompt) and the same ownership rules (`tailnet/decide.ts`: a route is ours
 * when it proxies to the live gate or sits on the port and target we recorded; any other app's
 * route is never changed, removed or taken over).
 *
 * The CLI: `tailscale` on the PATH (Linux, Homebrew), or inside the App Store app on macOS
 * (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`). Its record (`serve.json` beside the
 * gate) holds the port and target Orquester created.
 */

import { posix } from "node:path";

import type { MachineProblem } from "@orquester/api";

import type { BoxConnection } from "../../boxes/contracts.ts";
import {
  createLocalTailscale,
  parseProxyTarget,
  type CommandRunner,
  type LocalTailscale,
  type ProxyTarget,
  type TailscaleSnapshot
} from "../../boxes/tailscale/local.ts";
import { chooseHttpsPort, decideHttps, ownHttpsRoutes } from "../../tailnet/decide.ts";
import { execRemote } from "../hosts/box/remote.ts";

/** HTTPS ports tried, in order, for a machine's direct stream (apart from the daemon's own 10000–10005). */
export const GATE_SERVE_PORTS: readonly number[] = [10043, 10044, 10045, 10046, 10047, 8444];

/** Where the CLI is and who runs it, from {@link TAILSCALE_LOCATE_SCRIPT}. */
export interface MachineTailscaleCli {
  /** The CLI's path; null when Tailscale is not installed. */
  cli: string | null;
  user: string | null;
  uid: number | null;
}

/** Prints `cli=`, `user=`, `uid=` (constants only; the PATH comes from the env). */
export const TAILSCALE_LOCATE_SCRIPT = `for c in "$(command -v tailscale 2>/dev/null)" /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /usr/bin/tailscale; do
  if [ -n "$c" ] && [ -x "$c" ]; then printf 'cli=%s\\n' "$c"; break; fi
done
printf 'user=%s\\n' "$(id -un 2>/dev/null)"
printf 'uid=%s\\n' "$(id -u 2>/dev/null)"
`;

export function parseTailscaleLocate(stdout: string): MachineTailscaleCli {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const uid = Number(values.get("uid"));
  return { cli: values.get("cli") || null, user: values.get("user") || null, uid: values.get("uid") && Number.isInteger(uid) ? uid : null };
}

const RUN_TIMEOUT_MS = 35_000;

/**
 * The {@link CommandRunner} `createLocalTailscale` expects, run on the machine: `tailscale` (also
 * after `sudo -n`) is the located CLI; a non-zero exit rejects with its output, a missing CLI with
 * `ENOENT`.
 */
export function remoteTailscaleRunner(link: BoxConnection, located: MachineTailscaleCli, env: Record<string, string>): CommandRunner {
  return async (file, args, options) => {
    const resolve = (name: string): string | null => (name === "tailscale" ? located.cli : name);
    const command = resolve(file);
    const argv = file === "sudo" ? args.map((arg, index) => (arg === "tailscale" && args[index - 1] === "-n" ? (located.cli ?? arg) : arg)) : [...args];
    if (command === null || (file === "sudo" && located.cli === null && args.includes("tailscale"))) {
      throw Object.assign(new Error("tailscale is not installed"), { code: "ENOENT", stdout: "", stderr: "" });
    }
    const result = await execRemote(link, { command, args: argv, env }, { timeoutMs: Math.min(options.timeoutMs, RUN_TIMEOUT_MS) });
    if (result.exitCode !== 0) {
      const error = Object.assign(new Error(result.stderr.trim() || result.stdout.trim() || `${posix.basename(command)} exited ${result.exitCode}`), {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.exitCode === 127 ? { code: "ENOENT" } : {})
      });
      throw error;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

/** The machine's Tailscale, through `createLocalTailscale` with a runner on the machine. */
export function machineTailscale(link: BoxConnection, located: MachineTailscaleCli, env: Record<string, string>): LocalTailscale {
  return createLocalTailscale({
    // Unused here: only `snapshot`, `serveProxy` and `unserve` are called.
    daemonHttp: () => ({ host: "127.0.0.1", port: 0 }),
    run: remoteTailscaleRunner(link, located, env),
    user: () => located.user ?? "user",
    isRoot: () => located.uid === 0
  });
}

/** What Orquester recorded creating on the machine. */
export interface GateServeRecord {
  port: number;
  target: ProxyTarget;
}

export function parseGateServeRecord(text: string | null): GateServeRecord | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as { port?: unknown; target?: unknown };
    const target = typeof value.target === "string" ? parseProxyTarget(value.target) : null;
    if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535 || !target) return null;
    return { port: value.port as number, target };
  } catch {
    return null;
  }
}

export function serializeGateServeRecord(record: GateServeRecord): string {
  return `${JSON.stringify({ port: record.port, target: record.target.url })}\n`;
}

export type GateServeDecision =
  /** No direct tailnet route: Tailscale is missing, down, without HTTPS certificates, or unreadable (`problem` names the fix when there is one). */
  | { kind: "unavailable"; problem: "tailscale-unavailable" | "tailscale-https-disabled" | null }
  /** A route on `port` proxies to the live gate. `adopt`: record it (made before, or moved). */
  | { kind: "serving"; port: number; adopt: boolean }
  /** (Re)create Orquester's route on `port`. */
  | { kind: "create"; port: number }
  /** Every candidate port serves another app: nothing is changed. */
  | { kind: "no-port" };

export interface GateServeInput {
  snapshot: Pick<TailscaleSnapshot, "installed" | "running" | "dnsName" | "httpsCerts" | "serveKnown" | "routes" | "usedPorts">;
  /** The gate's loopback listener. */
  live: ProxyTarget;
  record: GateServeRecord | null;
  /** Whether the recorded target still answers (probed only when it is not the live gate); null when not probed. */
  recordTargetAlive: boolean | null;
}

/** One check's decision about the gate's serve route (pure; `decideHttps` and `chooseHttpsPort` are the ownership rules). */
export function decideGateServe(input: GateServeInput): GateServeDecision {
  const snap = input.snapshot;
  if (!snap.installed) return { kind: "unavailable", problem: null };
  if (!snap.running || !snap.dnsName) return { kind: "unavailable", problem: "tailscale-unavailable" };
  if (!snap.httpsCerts) return { kind: "unavailable", problem: "tailscale-https-disabled" };
  if (!snap.serveKnown) return { kind: "unavailable", problem: null };
  const record = input.record ? { enabled: true, port: input.record.port, target: input.record.target } : null;
  const decision = decideHttps({ serveKnown: true, live: input.live, record, routes: snap.routes, recordTargetAlive: input.recordTargetAlive });
  if (decision.kind === "serving") return { kind: "serving", port: decision.port, adopt: decision.adopt };
  if (decision.kind === "create") return { kind: "create", port: decision.port };
  // No record yet, or the recorded port now serves another app: the first free candidate.
  const port = chooseHttpsPort({
    record: decision.kind === "taken" ? record : null,
    routes: snap.routes,
    usedPorts: snap.usedPorts,
    candidates: GATE_SERVE_PORTS,
    previewPorts: new Set(),
    recordTargetAlive: input.recordTargetAlive
  });
  return port === null ? { kind: "no-port" } : { kind: "create", port };
}

/** The serve ports Orquester may remove when the gate stops: its own only. */
export function ownGateServePorts(input: { live: ProxyTarget | null; record: GateServeRecord | null; routes: TailscaleSnapshot["routes"] }): number[] {
  return ownHttpsRoutes({ live: input.live, record: input.record ? { enabled: true, port: input.record.port, target: input.record.target } : null, routes: input.routes });
}

/** The problem a decision or a failed change leaves for the owner, naming the machine and the fix; null when none. */
export function gateServeProblem(
  input:
    | { kind: "unavailable"; problem: "tailscale-unavailable" | "tailscale-https-disabled" | null }
    | { kind: "no-port" }
    | { kind: "permission"; user: string; macApp: boolean; command: string }
    | { kind: "failed"; message: string; command: string },
  machine: string
): MachineProblem | null {
  const fallback = "its simulators stream through Orquester instead of directly";
  switch (input.kind) {
    case "unavailable":
      if (input.problem === "tailscale-unavailable") {
        return { code: "tailscale-unavailable", message: `Tailscale isn't running on ${machine}, so ${fallback}.`, fix: `Start Tailscale on ${machine} (tailscale up, or open the Tailscale app).` };
      }
      if (input.problem === "tailscale-https-disabled") {
        return {
          code: "tailscale-https-disabled",
          message: `${machine} has no Tailscale HTTPS certificate, so ${fallback}.`,
          fix: "Turn on HTTPS Certificates in the Tailscale admin console (DNS page); Orquester then sets the direct route up by itself."
        };
      }
      return null;
    case "no-port":
      return {
        code: "serve-port-taken",
        message: `Every port Orquester tries for ${machine}'s direct stream (${GATE_SERVE_PORTS.join(", ")}) already serves another app, so ${fallback}.`,
        fix: `Free one of them on ${machine} (tailscale serve status shows what each serves); Orquester never takes another app's port.`
      };
    case "permission":
      return input.macApp
        ? {
            code: "tailscale-not-operator",
            message: `The Tailscale app on ${machine} doesn't let ${input.user} change what it serves, so ${fallback}.`,
            fix: `Sign in to the Tailscale app on ${machine} as ${input.user}, or run ${input.command} there.`
          }
        : {
            code: "tailscale-not-operator",
            message: `Tailscale on ${machine} doesn't let ${input.user} change what it serves, and sudo there needs a password, so ${fallback}.`,
            fix: `On ${machine}: sudo tailscale set --operator=${input.user}`
          };
    case "failed":
      return { code: "tailscale-unavailable", message: `tailscale serve failed on ${machine} (${input.message}), so ${fallback}.`, fix: `On ${machine}: ${input.command}` };
  }
}
