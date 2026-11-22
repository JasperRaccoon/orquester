/**
 * The seams between the machines registry and the features that act on machines (spec
 * 2026-11-22-tailnet-machines-and-agent-ssh-design.md). The registry (`machines/`) owns policy and
 * summaries; pairing, agent SSH and Wake-on-LAN implement these ports and are wired in at startup,
 * and boxes and devices read {@link MachineAccessPort} to enforce visibility and capabilities.
 */
import type {
  MachineCapabilities,
  MachineCapability,
  MachineOs,
  MachineProblem,
  MachineSshOverrides,
  MachineSudoInfo,
  MachineVisibility,
  PairMachineOverSshRequest,
  PairMachineOverSshResponse,
  WakeMachineResponse
} from "@orquester/api";

/** What the registry knows about one machine when another feature acts on it. */
export interface MachineTarget {
  machineId: string;
  name: string;
  hostname: string | null;
  /** MagicDNS name without the trailing dot, when the machine is a tailnet peer. */
  dnsName: string | null;
  tailnetIps: readonly string[];
  os: MachineOs;
  /** The paired BYO box behind this machine, if paired. */
  boxId: string | null;
  /** The owner's per-machine SSH overrides (user, port, identity file, `~/.ssh/config` alias). */
  ssh: MachineSshOverrides;
}

/** The last pairing-time probe of a machine: passwordless sudo and the problems found, each with its fix. */
export interface MachineProbeResult {
  sudo: MachineSudoInfo;
  problems: readonly MachineProblem[];
  /** ISO time of the probe. */
  probedAt: string;
}

/** Pair over SSH and the probe that runs with it; implemented by `machines/pairing`. */
export interface MachinePairingPort {
  pairOverSsh(target: MachineTarget, request: PairMachineOverSshRequest): Promise<PairMachineOverSshResponse>;
  /** The latest probe of a machine, or null if it was never probed. */
  lastProbe(machineId: string): MachineProbeResult | null;
}

/** One machine-level agent SSH alias: a Free-use machine with Commands and SSH on, reached through its paired box. */
export interface MachineSshAccessEntry {
  machineId: string;
  boxId: string;
  /** The alias name without the `orq-` prefix, from `agentSshAliasName`. */
  alias: string;
}

/**
 * Machine-level agent SSH aliases; implemented by the agent SSH feature. The registry calls `sync`
 * with the complete current set whenever policies or pairings change; entries not in the set are
 * revoked.
 */
export interface MachineSshAccessPort {
  sync(entries: readonly MachineSshAccessEntry[]): Promise<void>;
}

/**
 * Who a wake is for. The owner's own wake may be sent by any of their connected machines; an agent's
 * (`agent: true`) never by a Hidden one, and its answer never names one.
 */
export interface MachineWakeOptions {
  agent?: boolean;
}

/** Wake-on-LAN; implemented by the wake feature. */
export interface MachineWakePort {
  canWake(machineId: string, options?: MachineWakeOptions): { canWake: boolean; via?: string };
  wake(machineId: string, options?: MachineWakeOptions): Promise<WakeMachineResponse>;
}

/** A paired machine's effective policy, as boxes and devices see it. */
export interface MachineBoxPolicy {
  machineId: string;
  visibility: MachineVisibility;
  capabilities: MachineCapabilities;
}

/** Implemented by the registry; boxes, devices and agent tools read it to enforce visibility and capabilities. */
export interface MachineAccessPort {
  /** The policy of the paired machine behind a BYO box, or null when the box is not a paired machine. */
  policyOfBox(boxId: string): MachineBoxPolicy | null;
  /**
   * Whether agents may use this box for a capability. Boxes that are not paired machines (rentals)
   * are always allowed; a Hidden machine or one with the capability off is not.
   */
  allowsBox(boxId: string, capability: MachineCapability): boolean;
  /** Notifies after any policy change, so callers can re-filter. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}
