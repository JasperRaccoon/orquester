/**
 * Wake-on-LAN (tailnet machines spec §4.8): wakes a paired machine that sleeps by having another
 * machine on its LAN broadcast the magic packet. The daemon is often not on that LAN (a server
 * elsewhere), so the packet is sent by a connected paired machine whose `orq-agent` lists
 * `wake-sender` (`net.wake`), or by the daemon's own host when it is on that LAN.
 *
 * - **What is known.** `orq-agent` reports its NICs at connect and on change; the registry keeps
 *   each wired NIC's MAC and last known address in `machines.json` (`wol`), so they are there while
 *   the machine sleeps ({@link mergeWolNics}).
 * - **Who sends.** A sender has an IPv4 network that holds the target NIC's last address. The
 *   owner's wake may use any of their connected machines; an agent's never a Hidden one. Up to
 *   {@link MAX_WAKE_ATTEMPTS} senders send at once (two homes often number their LANs alike, so the
 *   first match is not always the right LAN); the answer names the first that sent.
 * - **Why not.** With no sender, the answer says what is missing and how to fix it, without naming
 *   a machine an agent may not know about.
 */

import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

import type { BoxNetWakeParams, BoxNic, MachineOs, MachineProblem, MachineVisibility, WakeMachineResponse } from "@orquester/api";
import type { StoredMachineWol, StoredWolNic } from "@orquester/config";

import type { BoxConnection } from "../boxes/contracts.ts";
import type { MachineWakeOptions, MachineWakePort } from "./ports.ts";

/** At most this many senders are asked for one wake. */
export const MAX_WAKE_ATTEMPTS = 3;
/** How long a sender may take to say it sent. */
const WAKE_REQUEST_TIMEOUT_MS = 15_000;
/** The two ports network adapters listen for magic packets on. */
const WAKE_PORTS = [9, 7] as const;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function ipv4ToInt(ip: string): number | null {
  if (!IPV4.test(ip)) return null;
  return ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

const intToIpv4 = (value: number): string => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");

/** The network number of `ip`/`prefix`, or null for a malformed address. */
function networkOf(ip: string, prefix: number): number | null {
  const value = ipv4ToInt(ip);
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) * size;
}

/** `192.168.2.0/24` for 192.168.2.21/24; null for a malformed address. */
export function subnetLabel(ip: string, prefix: number): string | null {
  const network = networkOf(ip, prefix);
  return network === null ? null : `${intToIpv4(network)}/${prefix}`;
}

/** Whether `ip` is inside the network `lan` is on (the sender's own prefix decides its broadcast domain). */
export function inSubnet(lan: { ipv4: string; prefixLength: number }, ip: string): boolean {
  const own = networkOf(lan.ipv4, lan.prefixLength);
  return own !== null && own === networkOf(ip, lan.prefixLength) && lan.ipv4 !== ip;
}

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

const sameNic = (a: StoredWolNic, b: StoredWolNic): boolean =>
  a.mac === b.mac && a.name === b.name && a.ipv4 === b.ipv4 && a.prefixLength === b.prefixLength && a.broadcast === b.broadcast && a.wolEnabled === b.wolEnabled;

/**
 * The `wol` to store after a NIC report, or null when nothing changed. Only wired NICs are kept
 * (Wi-Fi does not wake reliably). A NIC reported without an address (a link going down before
 * sleep) keeps the last one known for its MAC, and an unknown wake-on setting keeps the last one
 * told (the probe runs after the hello). A NIC no longer reported is dropped. Unknown fields of a
 * kept NIC, and of the record, are preserved.
 */
export function mergeWolNics(previous: StoredMachineWol | undefined, reported: readonly BoxNic[], at: string): StoredMachineWol | null {
  const before = new Map((previous?.nics ?? []).map((nic) => [nic.mac, nic]));
  const nics: StoredWolNic[] = reported
    .filter((nic) => nic.wired)
    .map((nic) => {
      const old = before.get(nic.mac);
      const keepAddress = nic.ipv4 === null && typeof old?.ipv4 === "string";
      return {
        ...(old ?? {}),
        name: nic.name,
        mac: nic.mac,
        ipv4: keepAddress ? old!.ipv4 : nic.ipv4,
        prefixLength: keepAddress ? old!.prefixLength : nic.prefixLength,
        broadcast: keepAddress ? old!.broadcast : nic.broadcast,
        wolEnabled: nic.wolEnabled ?? old?.wolEnabled ?? null
      };
    });
  if (!previous) return nics.length > 0 ? { nics, updatedAt: at } : null;
  const unchanged = nics.length === previous.nics.length && nics.every((nic, index) => sameNic(nic, previous.nics[index]!));
  return unchanged ? null : { ...previous, nics, updatedAt: at };
}

// ---------------------------------------------------------------------------
// Choosing senders
// ---------------------------------------------------------------------------

/** One IPv4 network a sender can broadcast on. */
export interface WakeLan {
  ipv4: string;
  prefixLength: number;
  broadcast: string;
  wired: boolean;
}

/** A machine that can send a wake now, with its networks. */
export interface WakeSenderCandidate {
  machineId: string;
  name: string;
  /** The daemon's own host. */
  self: boolean;
  visibility: MachineVisibility;
  lans: readonly WakeLan[];
}

/** One packet to ask for: `senderId` broadcasts the magic packet for `mac` on `broadcast`. */
export interface WakeAttempt {
  senderId: string;
  senderName: string;
  self: boolean;
  mac: string;
  broadcast: string;
}

/** The target's NICs a packet can wake: wake-on not known to be off, and an address known. */
export function wakeableNics(nics: readonly StoredWolNic[]): (StoredWolNic & { ipv4: string; prefixLength: number })[] {
  return nics.filter((nic): nic is StoredWolNic & { ipv4: string; prefixLength: number } => nic.wolEnabled !== false && typeof nic.ipv4 === "string" && typeof nic.prefixLength === "number");
}

/**
 * The packets to send for a target, best first: senders on a wired network, then by name; one per
 * sender (its wired network if it has one there), at most {@link MAX_WAKE_ATTEMPTS}. An agent's wake
 * never uses a Hidden machine (the daemon's own host is never Hidden to it).
 */
export function planWake(targetId: string, targetNics: readonly StoredWolNic[], candidates: readonly WakeSenderCandidate[], options: MachineWakeOptions = {}): WakeAttempt[] {
  const nics = wakeableNics(targetNics);
  const found: (WakeAttempt & { wired: boolean })[] = [];
  for (const sender of candidates) {
    if (sender.machineId === targetId) continue;
    if (options.agent === true && !sender.self && sender.visibility === "hidden") continue;
    let best: (WakeAttempt & { wired: boolean }) | null = null;
    for (const nic of nics) {
      for (const lan of sender.lans) {
        if (!inSubnet(lan, nic.ipv4)) continue;
        if (best === null || (lan.wired && !best.wired)) best = { senderId: sender.machineId, senderName: sender.name, self: sender.self, mac: nic.mac, broadcast: lan.broadcast, wired: lan.wired };
      }
    }
    if (best) found.push(best);
  }
  found.sort((a, b) => Number(b.wired) - Number(a.wired) || a.senderName.localeCompare(b.senderName) || a.senderId.localeCompare(b.senderId));
  return found.slice(0, MAX_WAKE_ATTEMPTS).map(({ wired: _wired, ...attempt }) => attempt);
}

// ---------------------------------------------------------------------------
// Why not
// ---------------------------------------------------------------------------

const BIOS_HINT = "also check Wake-on-LAN is enabled in its BIOS or UEFI settings";

function adapterFix(os: MachineOs, nic: StoredWolNic | undefined): string {
  const name = nic?.name && nic.name.length > 0 ? nic.name : "<adapter>";
  switch (os) {
    case "linux":
      return `On the machine run \`sudo ethtool -s ${name} wol g\`, and keep it on across reboots (NetworkManager: \`sudo nmcli connection modify <connection> 802-3-ethernet.wake-on-lan magic\`); ${BIOS_HINT}.`;
    case "windows":
      return `In Device Manager → Network adapters → ${name} → Power Management, allow it to wake the computer, and turn on "Wake on Magic Packet" under Advanced; ${BIOS_HINT}.`;
    case "macos":
      return "Turn on \"Wake for network access\" in System Settings → Energy (Battery → Options on a laptop), and keep the Mac on power.";
    default:
      return `Turn on Wake-on-LAN (magic packet) for its network adapter; ${BIOS_HINT}.`;
  }
}

/** The machine as the wake sees it. */
export interface WakeMachineView {
  machineId: string;
  name: string;
  self: boolean;
  os: MachineOs;
  visibility: MachineVisibility;
  /** Its paired box, or null when not paired. */
  boxId: string | null;
  wol: StoredMachineWol | null;
}

/** What is missing for a wake of `target`, as the problem the answer carries. */
export function wakeUnavailable(target: WakeMachineView): MachineProblem {
  const problem = (message: string, fix: string): MachineProblem => ({ code: "wake-unavailable", machineId: target.machineId, message, fix });
  const nics = target.wol?.nics ?? [];
  if (nics.length === 0) {
    if (target.boxId === null) {
      return problem(`Orquester doesn't know ${target.name}'s network adapter.`, `Pair ${target.name} and let it connect once while it is awake on a wired network; Orquester then learns what it needs to wake it.`);
    }
    return problem(
      `Orquester has not seen a wired network adapter on ${target.name}.`,
      `Connect ${target.name} by Ethernet and let it connect to Orquester once while awake (Wake-on-LAN does not work over Wi-Fi).`
    );
  }
  const enabled = nics.filter((nic) => nic.wolEnabled !== false);
  if (enabled.length === 0) return problem(`Wake-on-LAN is turned off on ${target.name}'s network adapter.`, adapterFix(target.os, nics[0]));
  const addressed = wakeableNics(enabled);
  if (addressed.length === 0) {
    return problem(`Orquester doesn't know which network ${target.name} is on.`, `Let ${target.name} connect to Orquester once while it is awake on its wired network.`);
  }
  const subnets = [...new Set(addressed.map((nic) => subnetLabel(nic.ipv4, nic.prefixLength)).filter((label): label is string => label !== null))];
  return problem(
    `No other paired machine on ${subnets.join(" or ")} is online to send the wake packet.`,
    `Keep another paired machine on that network awake and connected to Orquester, then try again; ${BIOS_HINT} and in ${target.name}'s network adapter settings.`
  );
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** The daemon's own host as a sender (when it is on the target's LAN). */
export interface LocalWakeSender {
  /** The host's IPv4 networks with a broadcast address. */
  lans(): readonly WakeLan[];
  send(params: Required<Pick<BoxNetWakeParams, "mac" | "broadcast">>): Promise<void>;
}

export interface MachineWakeDeps {
  /** Every machine the registry lists, the daemon's own host included (`self`). */
  machines(): readonly WakeMachineView[];
  /** The live link of a paired machine's box, or null. */
  connection(boxId: string): Pick<BoxConnection, "connected" | "capabilities" | "nics" | "request"> | null;
  /** The daemon's own host; absent: it never sends. */
  local?: LocalWakeSender;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export class MachineWake implements MachineWakePort {
  constructor(private readonly deps: MachineWakeDeps) {}

  canWake(machineId: string, options: MachineWakeOptions = {}): { canWake: boolean; via?: string } {
    const attempts = this.plan(machineId, options);
    return attempts.length > 0 ? { canWake: true, via: attempts[0]!.senderId } : { canWake: false };
  }

  async wake(machineId: string, options: MachineWakeOptions = {}): Promise<WakeMachineResponse> {
    const target = this.deps.machines().find((machine) => machine.machineId === machineId);
    if (!target || target.self) {
      return { sent: false, via: null, problem: { code: "wake-unavailable", machineId, message: "There is no such machine to wake.", fix: "Pick a machine from the Machines list." } };
    }
    const attempts = this.plan(machineId, options);
    if (attempts.length === 0) return { sent: false, via: null, problem: wakeUnavailable(target) };
    const outcomes = await Promise.allSettled(attempts.map((attempt) => this.send(attempt)));
    const first = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    if (first !== -1) return { sent: true, via: attempts[first]!.senderId };
    const failure = outcomes[0] as PromiseRejectedResult;
    const sender = attempts[0]!.senderName;
    return {
      sent: false,
      via: null,
      problem: {
        code: "wake-unavailable",
        machineId,
        message: `${sender} could not send the wake packet: ${errorText(failure.reason)}`,
        fix: `Try again; if it keeps failing, check ${sender} is online and connected to Orquester.`
      }
    };
  }

  private plan(machineId: string, options: MachineWakeOptions): WakeAttempt[] {
    const machines = this.deps.machines();
    const target = machines.find((machine) => machine.machineId === machineId);
    if (!target || target.self || !target.wol) return [];
    return planWake(machineId, target.wol.nics, this.candidates(machines), options);
  }

  private candidates(machines: readonly WakeMachineView[]): WakeSenderCandidate[] {
    const out: WakeSenderCandidate[] = [];
    for (const machine of machines) {
      const base = { machineId: machine.machineId, name: machine.name, self: machine.self, visibility: machine.visibility };
      if (machine.self) {
        if (this.deps.local) out.push({ ...base, lans: this.deps.local.lans() });
        continue;
      }
      if (machine.boxId === null) continue;
      const link = this.deps.connection(machine.boxId);
      // Only an orq-agent that says it can send is asked (an older one would answer UNKNOWN_METHOD).
      if (!link?.connected || !link.capabilities?.includes("wake-sender")) continue;
      const lans = (link.nics ?? []).flatMap((nic): WakeLan[] =>
        nic.ipv4 !== null && nic.prefixLength !== null && nic.broadcast !== null ? [{ ipv4: nic.ipv4, prefixLength: nic.prefixLength, broadcast: nic.broadcast, wired: nic.wired }] : []
      );
      if (lans.length > 0) out.push({ ...base, lans });
    }
    return out;
  }

  private async send(attempt: WakeAttempt): Promise<void> {
    const params = { mac: attempt.mac, broadcast: attempt.broadcast };
    if (attempt.self) {
      if (!this.deps.local) throw new Error("this host can't send wake packets");
      await this.deps.local.send(params);
      return;
    }
    const machine = this.deps.machines().find((entry) => entry.machineId === attempt.senderId);
    const link = machine?.boxId ? this.deps.connection(machine.boxId) : null;
    if (!link?.connected) throw new Error("it is no longer connected");
    await link.request("net.wake", params, { timeoutMs: WAKE_REQUEST_TIMEOUT_MS });
  }
}

// ---------------------------------------------------------------------------
// The daemon's own host
// ---------------------------------------------------------------------------

/** The magic packet: 6 × 0xFF, then the MAC 16 times. */
function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac.replaceAll(":", ""), "hex");
  if (bytes.length !== 6) throw new Error("not a MAC address");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/**
 * The daemon's host as a sender: its up, non-internal IPv4 networks with a broadcast address, and
 * an IPv4 UDP broadcast with SO_BROADCAST from the address on that network. `ports`: where the
 * packet goes (default 9 and 7).
 */
export function createLocalWakeSender(options: { ports?: readonly number[] } = {}): LocalWakeSender {
  const ports = options.ports ?? WAKE_PORTS;
  const lans = (): WakeLan[] =>
    Object.entries(networkInterfaces()).flatMap(([, entries]) =>
      (entries ?? []).flatMap((entry): WakeLan[] => {
        if (entry.family !== "IPv4" || entry.internal || !entry.cidr) return [];
        const prefix = Number(entry.cidr.split("/")[1]);
        const network = networkOf(entry.address, prefix);
        if (network === null || prefix >= 31 || entry.address.startsWith("169.254.")) return [];
        return [{ ipv4: entry.address, prefixLength: prefix, broadcast: intToIpv4(network + 2 ** (32 - prefix) - 1), wired: true }];
      })
    );
  return {
    lans,
    async send({ mac, broadcast }) {
      const lan = lans().find((entry) => entry.broadcast === broadcast);
      if (!lan) throw new Error(`${broadcast} is not the broadcast address of a network this host is on`);
      const packet = magicPacket(mac);
      const socket = createSocket("udp4");
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind({ address: lan.ipv4, port: 0 }, () => {
            socket.off("error", reject);
            resolve();
          });
        });
        socket.setBroadcast(true);
        for (const port of ports) {
          await new Promise<void>((resolve, reject) => socket.send(packet, port, broadcast, (error) => (error ? reject(error) : resolve())));
        }
      } finally {
        socket.close();
      }
    }
  };
}
