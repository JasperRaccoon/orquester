/**
 * Machines — every tailnet machine and paired bring-your-own machine in one list, with the
 * owner's per-machine policy (spec docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md
 * §4.1, §4.2, §4.8, §4.10).
 *
 * - A **machine** is a tailnet peer read from the daemon host's Tailscale LocalAPI, a paired BYO box
 *   (`boxes.ts`, `provider: "byo"`), or both once matched (by tailnet IP or node key). Its id is
 *   {@link tailnetMachineId} when it has a peer, else {@link boxMachineId}.
 * - The owner sets its {@link MachineVisibility} and {@link MachineCapabilities}; the daemon
 *   enforces them in every tool, route and placement decision. A Hidden machine never appears in an
 *   agent-facing result.
 * - {@link MachineProblem} is the cross-cutting "error that names the fix", shared with devices,
 *   pairing, agent SSH and the daemon's own Tailscale setup (`tailnet.ts`).
 *
 * Persisted policy (`machines.json`) and the migration rule live in `@orquester/config` `machines.ts`.
 * Nothing here carries a secret: SSH private keys and `orq-agent` credentials stay on the daemon.
 */

import type { BoxOs, ByoMachineKind } from "./boxes.ts";

export type { MachineCapabilities, MachineCapability, MachinePolicy, MachineVisibility } from "@orquester/config";
export {
  MACHINE_CAPABILITIES,
  MACHINE_VISIBILITIES,
  NEW_TAILNET_PEER_POLICY,
  isMachineVisibility,
  migratedByoMachinePolicy,
  resolveMachinePolicy
} from "@orquester/config";
import type { MachineCapabilities, MachineVisibility } from "@orquester/config";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Prefix of a tailnet peer's machine id: `ts:<StableID>` (Tailscale's stable node id). */
export const TAILNET_MACHINE_ID_PREFIX = "ts:";
/** Prefix of a paired machine with no tailnet peer: `box:<boxId>`. */
export const BOX_MACHINE_ID_PREFIX = "box:";

/** The characters a StableID or box id may hold in a machine id. */
const MACHINE_ID_PART = /^[A-Za-z0-9._-]{1,128}$/;

/** What a machine id names. */
export type MachineIdParts = { kind: "tailnet"; stableId: string } | { kind: "box"; boxId: string };

/**
 * A tailnet peer's id. A paired machine matched to a peer takes this id; its `machines.json`
 * record moves from the `box:` key to it on first match (the record's `byoBoxId` keeps the link).
 */
export function tailnetMachineId(stableId: string): string {
  if (!MACHINE_ID_PART.test(stableId)) throw new Error(`Not a Tailscale StableID: ${JSON.stringify(stableId)}`);
  return `${TAILNET_MACHINE_ID_PREFIX}${stableId}`;
}

/** A paired machine's id while no tailnet peer matches it. Same form as its device-host id. */
export function boxMachineId(boxId: string): string {
  if (!MACHINE_ID_PART.test(boxId)) throw new Error(`Not a box id: ${JSON.stringify(boxId)}`);
  return `${BOX_MACHINE_ID_PREFIX}${boxId}`;
}

/** Parse a machine id; null for anything else (callers answer `MACHINE_NOT_FOUND`). */
export function parseMachineId(id: string): MachineIdParts | null {
  if (id.startsWith(TAILNET_MACHINE_ID_PREFIX)) {
    const stableId = id.slice(TAILNET_MACHINE_ID_PREFIX.length);
    return MACHINE_ID_PART.test(stableId) ? { kind: "tailnet", stableId } : null;
  }
  if (id.startsWith(BOX_MACHINE_ID_PREFIX)) {
    const boxId = id.slice(BOX_MACHINE_ID_PREFIX.length);
    return MACHINE_ID_PART.test(boxId) ? { kind: "box", boxId } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Facts and states
// ---------------------------------------------------------------------------

/** A machine's operating system, from Tailscale's `OS` or `orq-agent`'s `sys.os`. */
export type MachineOs = "linux" | "macos" | "windows" | "other";
export const MACHINE_OS_LABELS: Readonly<Record<MachineOs, string>> = { linux: "Linux", macos: "macOS", windows: "Windows", other: "Other" };

/** {@link MachineOs} of a Tailscale status `OS` string (`linux`, `macOS`, `windows`, `iOS`, …). */
export function machineOsOfTailscale(os: string | null | undefined): MachineOs {
  switch ((os ?? "").trim().toLowerCase()) {
    case "linux":
      return "linux";
    case "macos":
    case "darwin":
      return "macos";
    case "windows":
      return "windows";
    default:
      return "other";
  }
}

/** {@link MachineOs} of an `orq-agent`-reported {@link BoxOs}. */
export function machineOsOfBox(os: BoxOs): MachineOs {
  return os === "darwin" ? "macos" : os === "win32" ? "windows" : "linux";
}

/** The BYO kind a machine of this OS pairs as; null when it cannot be paired. */
export function byoKindOfMachineOs(os: MachineOs): ByoMachineKind | null {
  return os === "other" ? null : os;
}

/**
 * One state per machine (spec §4.1.1):
 * - `not-paired` — a tailnet peer with no `orq-agent` pairing;
 * - `pairing` — a pairing (by command or over SSH) is under way;
 * - `ready` — paired and `orq-agent` is connected;
 * - `offline` — paired, the peer is online but `orq-agent` is not connected;
 * - `asleep` — paired, and its tailnet peer is offline (asleep or off; Wake may be offered).
 */
export type MachineState = "not-paired" | "pairing" | "ready" | "offline" | "asleep";
export const MACHINE_STATES: readonly MachineState[] = ["not-paired", "pairing", "ready", "offline", "asleep"];

/** Whether and how a machine can be woken (spec §4.8). */
export interface MachineWakeInfo {
  /** A magic packet can be sent: WoL details are known and a sender is on its subnet. */
  canWake: boolean;
  /** The machine id that would send it (the daemon's own machine is listed with `self: true`). */
  via?: string;
}

/** What the probes know about elevation on a paired machine (spec §7.4). */
export interface MachineSudoInfo {
  /** Passwordless sudo (Administrator on Windows): a chat with SSH there is effectively root. Absent: unknown. */
  passwordless?: boolean;
}

/** One machine as the Machines list, `list_machines` and the approval flow see it. */
export interface MachineSummary {
  /** {@link tailnetMachineId} or {@link boxMachineId}. */
  id: string;
  /** The owner's name for a paired machine, else the tailnet hostname. */
  name: string;
  /** The tailnet hostname (`jasper`); null for a paired machine with no peer. */
  hostname: string | null;
  /** MagicDNS name without the trailing dot (`jasper.tail1234.ts.net`); null when none. */
  dnsName: string | null;
  os: MachineOs;
  /** Tailscale IPs (IPv4 first), empty for a machine with no peer. */
  tailnetIps: string[];
  /** The tailnet peer is online (no peer: `orq-agent` is connected). */
  online: boolean;
  /** ISO time last seen on the tailnet or by `orq-agent`; null when never. */
  lastSeenAt: string | null;
  state: MachineState;
  visibility: MachineVisibility;
  capabilities: MachineCapabilities;
  /** The paired BYO box record; null when not paired. */
  boxId: string | null;
  /** The daemon's own machine (Tailscale `Self`): listed, never pairable or removable. */
  self?: boolean;
  /** The `orq-<name>` alias the caller may `ssh` to right now; absent when none (spec §4.3.7). */
  sshAlias?: string;
  wake: MachineWakeInfo;
  sudo: MachineSudoInfo;
  /** Probe, pairing and reachability problems, each with its fix; empty when none. */
  problems: MachineProblem[];
}

// ---------------------------------------------------------------------------
// Problems: errors that name the fix (spec §4.10)
// ---------------------------------------------------------------------------

/**
 * Stable classification of every failure in the spec. The member doc says what it means; the
 * {@link MachineProblem} carrying it names the machine and the exact fix.
 */
export type MachineProblemCode =
  /** Neither the LocalAPI socket nor `tailscale status --json` works on the daemon host. */
  | "tailscale-unavailable"
  /** The daemon's user may not change `tailscale serve` (fix: `tailscale set --operator=<user>`). */
  | "tailscale-not-operator"
  /** HTTPS certificates are off for the tailnet (fix: enable them in the tailnet admin console). */
  | "tailscale-https-disabled"
  /** Pairing over SSH met an unknown host key: confirm its fingerprint. */
  | "ssh-host-key-unknown"
  /** The host key differs from the pinned or known one: pairing is blocked. */
  | "ssh-host-key-changed"
  /** SSH authentication was refused (wrong user or key). */
  | "ssh-auth-refused"
  /** The SSH port could not be reached (timeout, refused, no route). */
  | "ssh-unreachable"
  /** The host name or `~/.ssh/config` alias did not resolve. */
  | "ssh-resolve-failed"
  /** A step needed `sudo -n` and it is not available (Orquester never prompts). */
  | "sudo-unavailable"
  /** `/dev/kvm` is not usable by the account (fix: add the user to the `kvm` group). */
  | "kvm-permission"
  /** systemd linger is off, so user services die on logout (fix: `loginctl enable-linger <user>`). */
  | "linger-off"
  /** `xcode-select` does not point at Xcode (fix: `sudo xcode-select -s /Applications/Xcode.app`). */
  | "xcode-path"
  /** macOS developer mode / DevToolsSecurity is off (fix: `DevToolsSecurity -enable`). */
  | "devtools-security-off"
  /** The machine's tailnet peer is offline: asleep or off (a Mac with its lid closed). */
  | "machine-asleep"
  /** Windows: no interactive desktop session is logged in for the desktop-session helper. */
  | "no-desktop-session"
  /** Windows: Windows Hypervisor Platform is off or unusable (`emulator -accel-check`). */
  | "whpx-off"
  /** Linux: `tailscaled`, `sshd` or `orq-agent` lacks its `OOMScoreAdjust` drop-in (spec §4.9). */
  | "oom-protection-missing"
  /** The `tailscale serve` port Orquester wants is owned by another live app (never taken over). */
  | "serve-port-taken"
  /** No connected machine (nor the daemon host) can send a magic packet to it, or WoL is off on its NICs. */
  | "wake-unavailable"
  /** The pairing bootstrap ran over SSH but failed; the message carries its last meaningful line (never secrets). */
  | "pair-bootstrap-failed";

export const MACHINE_PROBLEM_CODES: readonly MachineProblemCode[] = [
  "tailscale-unavailable",
  "tailscale-not-operator",
  "tailscale-https-disabled",
  "ssh-host-key-unknown",
  "ssh-host-key-changed",
  "ssh-auth-refused",
  "ssh-unreachable",
  "ssh-resolve-failed",
  "sudo-unavailable",
  "kvm-permission",
  "linger-off",
  "xcode-path",
  "devtools-security-off",
  "machine-asleep",
  "no-desktop-session",
  "whpx-off",
  "oom-protection-missing",
  "serve-port-taken",
  "wake-unavailable",
  "pair-bootstrap-failed"
];

export function isMachineProblemCode(value: unknown): value is MachineProblemCode {
  return typeof value === "string" && (MACHINE_PROBLEM_CODES as readonly string[]).includes(value);
}

/** A classified failure: which machine, what is wrong, and the exact fix. Never raw stderr or a secret. */
export interface MachineProblem {
  code: MachineProblemCode;
  /** The machine that needs the fix; absent for the daemon host itself. */
  machineId?: string;
  /** One line naming the machine: "jasper can't open /dev/kvm". */
  message: string;
  /** The fix, a command or a place to click: "sudo usermod -aG kvm jasper, then log out and in". */
  fix?: string;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/** `GET machineRoutes.list`. */
export interface MachinesResponse {
  machines: MachineSummary[];
  /** Daemon-wide problems (Tailscale unavailable on the daemon host); empty when none. */
  problems: MachineProblem[];
}

export interface MachineResponse {
  machine: MachineSummary;
}

/** Per-machine SSH overrides for "Pair over SSH" (persisted; `null` clears a field). */
export interface MachineSshOverrides {
  user?: string | null;
  port?: number | null;
  /** Absolute path of a private key on the daemon's machine. */
  identityFile?: string | null;
  /** An existing `~/.ssh/config` host alias to connect through. */
  sshAlias?: string | null;
}

/** `PATCH machineRoutes.machine(id)`: the fields to change. Owner only. */
export interface UpdateMachineRequest {
  visibility?: MachineVisibility;
  /** Only the named capabilities change. */
  capabilities?: Partial<MachineCapabilities>;
  ssh?: MachineSshOverrides;
}

/**
 * `POST machineRoutes.pairSsh(id)` (owner only, spec §4.2.1–4.2.4). The first call omits
 * `acceptHostKeyFingerprint`; an unknown host key answers `confirm-host-key`, and the owner's
 * second call passes the shown fingerprint. The overrides given here are saved on the machine.
 */
export interface PairMachineOverSshRequest {
  user?: string;
  port?: number;
  identityFile?: string;
  sshAlias?: string;
  /** The SHA256 fingerprint the owner confirmed (`SHA256:…`); must equal the key the daemon then sees. */
  acceptHostKeyFingerprint?: string;
  /** The machine's name in Orquester; default its tailnet hostname. */
  name?: string;
}

/** The host key "Pair over SSH" asks the owner to confirm. */
export interface MachineSshHostKey {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  keyType: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
  /** The host or alias it was read from. */
  host: string;
}

/**
 * `POST machineRoutes.pairSsh(id)`:
 * - `confirm-host-key` — nothing ran; confirm {@link MachineSshHostKey.fingerprint} and call again;
 * - `pairing` — the bootstrap ran; the machine is `pairing` and becomes `ready` when `orq-agent`
 *   connects (follow {@link MACHINES_CHANGED_EVENT}); gaps it could not fix are in `machine.problems`;
 * - `failed` — a classified failure (`ssh-*`, `sudo-unavailable`, `pair-bootstrap-failed`).
 * Request errors (unknown machine, not owner, already paired) are HTTP errors with {@link MachineErrorCode}.
 */
export type PairMachineOverSshResponse =
  | { status: "confirm-host-key"; hostKey: MachineSshHostKey }
  | { status: "pairing"; machine: MachineSummary }
  | { status: "failed"; problem: MachineProblem };

/**
 * `DELETE machineRoutes.machine(id)` (owner only, spec §4.2.7): a paired machine's `orq-agent`
 * uninstalls, its credential is revoked and every key or alias Orquester added for it is removed;
 * an unpaired peer's policy resets to `NEW_TAILNET_PEER_POLICY`.
 */
export interface RemoveMachineResponse {
  /** False when the machine was not connected: `orq-agent uninstall-service` must be run on it by hand. */
  uninstalled: boolean;
  /** Cleanup that could not be done (e.g. an `authorized_keys` line on an offline machine). */
  problems: MachineProblem[];
}

/** `wake_machine`'s input (the route takes the id in its path). */
export interface WakeMachineRequest {
  machineId: string;
}

/**
 * `POST machineRoutes.wake(id)`: the magic packet was handed to a sender. The machine's state then
 * follows its tailnet peer and `orq-agent` reconnecting; `sent` is not "it woke up".
 */
export interface WakeMachineResponse {
  sent: boolean;
  /** The sending machine's id; null when nothing was sent. */
  via: string | null;
  /** Why nothing was sent (`wake-unavailable`, …). */
  problem?: MachineProblem;
}

// ---------------------------------------------------------------------------
// Routes, events, errors
// ---------------------------------------------------------------------------

const machinePath = (id: string): string => `/api/machines/${encodeURIComponent(id)}`;

/**
 * Both transports. An agent principal (`list_machines`, `wake_machine` through `DaemonApi`) gets only
 * machines visible to its chat (never Hidden, capability-filtered) and may only wake; a person gets
 * every machine. Pairing, policy changes and removal are owner-only (403 `MACHINE_OWNER_ONLY`). A
 * machine hidden from the caller answers 404 `MACHINE_NOT_FOUND`, exactly like an unknown id.
 */
export const machineRoutes = {
  /** `GET` → {@link MachinesResponse}. */
  list: "/api/machines",
  /** `GET` → {@link MachineResponse}; `PATCH` {@link UpdateMachineRequest} → {@link MachineResponse}; `DELETE` → {@link RemoveMachineResponse}. */
  machine: machinePath,
  /** `POST` {@link PairMachineOverSshRequest} → {@link PairMachineOverSshResponse}. */
  pairSsh: (id: string): string => `${machinePath(id)}/pair-ssh`,
  /** `POST` (no body) → {@link WakeMachineResponse}. */
  wake: (id: string): string => `${machinePath(id)}/wake`
} as const;

/** The `/events` channel machine changes go out on. */
export const MACHINES_CHANNEL = "machines";
/** Payload: {@link MachinesResponse} (the owner's full list). */
export const MACHINES_CHANGED_EVENT = "machines.changed";

export type MachineErrorCode =
  | "MACHINE_NOT_FOUND"
  | "MACHINE_INVALID_REQUEST"
  /** 403: pairing, policy changes and removal are for the owner, never an agent. */
  | "MACHINE_OWNER_ONLY"
  /**
   * 403: an agent asked the route to wake an Ask-first machine. Only Free-use machines wake from the
   * route; an Ask-first one wakes through `wake_machine`, after the owner approves its card.
   */
  | "MACHINE_APPROVAL_REQUIRED"
  /** 409: a pairing is already running, or the machine is paired already. */
  | "MACHINE_PAIRING_IN_PROGRESS"
  | "MACHINE_ALREADY_PAIRED"
  /** 409: the machine is used by a project or a chat (release it first). */
  | "MACHINE_IN_USE"
  /** 409: the daemon's own machine, or an OS that cannot be paired. */
  | "MACHINE_UNSUPPORTED";
