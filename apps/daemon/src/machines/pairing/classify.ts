/**
 * SSH failures as {@link MachineProblem}s (tailnet machines spec §4.10): `ssh` exits 255 for its own
 * errors, and its stderr names which one. The problem names the machine and the fix; raw stderr is
 * never kept, returned or logged (a banner or a remote line may carry keys or `tskey-` values).
 */

import type { MachineProblem, MachineProblemCode } from "@orquester/api";

import type { SshRunResult } from "./runner.ts";

/** Who and where the failed run tried to reach, for the message. */
export interface SshFailureContext {
  machineId: string;
  /** The machine's name in Orquester (`jasper`). */
  machineName: string;
  /** What `ssh` was pointed at: a MagicDNS name, a tailnet IP or a `~/.ssh/config` alias. */
  destination: string;
  /** The login user, when known. */
  user: string | null;
  port: number | null;
  /** The private key the daemon offers (its `.pub` is what the machine must authorize). */
  identityFile: string | null;
}

/** Ordered: the first match wins (a changed key also prints "Host key verification failed"). */
const PATTERNS: ReadonlyArray<{ detail: string; test: RegExp }> = [
  { detail: "changed", test: /REMOTE HOST IDENTIFICATION HAS CHANGED|POSSIBLE DNS SPOOFING|Host key for \S+ has changed|Offending \S+ key in/i },
  { detail: "unknown", test: /No \S+ host key is known for|Host key verification failed/i },
  { detail: "resolve", test: /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|No address associated with hostname|Unknown host/i },
  { detail: "auth", test: /Permission denied \(|Too many authentication failures|Authentication failed|no mutual signature|Load key .*: (invalid format|bad permissions|incorrect passphrase)|UNPROTECTED PRIVATE KEY FILE|Received disconnect from .*: 2: Too many/i },
  { detail: "refused", test: /Connection refused/i },
  { detail: "timeout", test: /Connection timed out|Operation timed out|timed out during banner|No route to host|Network is unreachable|Host is down|Host is unreachable/i },
  { detail: "dropped", test: /Connection (closed|reset) by|kex_exchange_identification|banner exchange|Broken pipe|stdio forwarding failed|channel \d+: open failed|ProxyCommand|proxy dialog failed/i }
];

/** `jasper` or `jasper (jasper.tail1234.ts.net:2222)` — what the owner recognizes. */
function where(context: SshFailureContext): string {
  const port = context.port !== null && context.port !== 22 ? `:${context.port}` : "";
  return context.destination === context.machineName && !port ? context.machineName : `${context.machineName} (${context.destination}${port})`;
}

function login(context: SshFailureContext): string {
  return context.user ? `${context.user}@${context.destination}` : context.destination;
}

/**
 * Classify a failed `ssh` run; null when `ssh` itself succeeded and the remote command failed
 * (exit status other than 255, not killed): that is the caller's (`pair-bootstrap-failed`).
 */
export function classifySshFailure(result: SshRunResult, context: SshFailureContext): MachineProblem | null {
  const { machineId, machineName } = context;
  const problem = (code: MachineProblemCode, message: string, fix?: string): MachineProblem => ({ code, machineId, message, ...(fix ? { fix } : {}) });
  if (result.spawnError !== undefined) {
    return problem("ssh-unreachable", "The Orquester server has no ssh client, so it can't pair machines over SSH.", "Install OpenSSH's client (the `ssh` command) on the Orquester server.");
  }
  if (!result.timedOut && result.code !== 255) return null;
  const match = PATTERNS.find((pattern) => pattern.test.test(result.stderr));
  const pub = `${context.identityFile ?? "~/.ssh/id_ed25519"}.pub`;
  switch (result.timedOut ? "timeout" : (match?.detail ?? "other")) {
    case "changed":
      return problem(
        "ssh-host-key-changed",
        `The SSH host key of ${where(context)} changed since the Orquester server last saw it, so pairing is blocked.`,
        `If ${machineName} was reinstalled or its SSH server was reset, remove the old key on the Orquester server (\`ssh-keygen -R ${context.destination}\`) and pair again; otherwise someone may be intercepting the connection.`
      );
    case "unknown":
      return problem("ssh-host-key-unknown", `The SSH host key of ${where(context)} isn't known to the Orquester server yet.`, "Confirm its fingerprint to pair.");
    case "resolve":
      return problem(
        "ssh-resolve-failed",
        `The Orquester server can't resolve ${context.destination}, the SSH address of ${machineName}.`,
        `Check the name or ~/.ssh/config alias, turn on MagicDNS in the tailnet, or pair with ${machineName}'s tailnet IP.`
      );
    case "auth":
      return problem(
        "ssh-auth-refused",
        `SSH from the Orquester server to ${machineName} must log in without a password, and ${login(context)} refused its key.`,
        `Add the Orquester server's key (${pub}) to ${context.user ? `${context.user}'s` : "the user's"} ~/.ssh/authorized_keys on ${machineName} (for example \`ssh-copy-id -i ${pub} ${login(context)}\` from the Orquester server), or set the right user or identity file, then pair again.`
      );
    case "refused":
      return problem(
        "ssh-unreachable",
        `${where(context)} refused the SSH connection: its SSH server isn't running or listens on another port.`,
        `Turn on SSH on ${machineName} (Linux: \`sudo systemctl enable --now ssh\`; macOS: System Settings → General → Sharing → Remote Login), or set its SSH port, then pair again.`
      );
    case "timeout":
      return problem(
        "ssh-unreachable",
        `${where(context)} didn't answer over SSH: it may be asleep or off, or offline from the tailnet.`,
        `Wake ${machineName} (open a Mac's lid, or press its power button) and check it is online in Tailscale, then pair again.`
      );
    case "dropped":
      return problem("ssh-unreachable", `The SSH connection to ${where(context)} closed before login.`, `Check that SSH on ${machineName} accepts connections from the Orquester server (firewall, MaxStartups, a ProxyJump in ~/.ssh/config), then pair again.`);
    default:
      return problem("ssh-unreachable", `SSH from the Orquester server to ${where(context)} failed.`, `Run \`ssh ${login(context)} true\` on the Orquester server to see why, fix it, then pair again.`);
  }
}
