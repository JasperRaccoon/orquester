/**
 * The machines registry (tailnet machines spec §4.1): one list of the daemon host's tailnet peers
 * and the paired bring-your-own boxes, with the owner's policy for each.
 *
 * - **Sources.** Peers come from the Tailscale LocalAPI ({@link TailnetRead}, polled every
 *   {@link MACHINES_POLL_MS} and on demand); paired machines from the box records
 *   ({@link MachineBoxSource}); policy from `machines.json` ({@link MachinePolicyStore}), resolved
 *   only by `resolveMachinePolicy`.
 * - **Matching.** A paired box is linked to its peer by a `machines.json` record keyed `ts:<StableID>`
 *   whose `byoBoxId` names it. A box not linked yet is matched by the evidence the box connection
 *   gives: the hostname `orq-agent` reports in its hello, compared with the peer's MagicDNS label and
 *   hostname, for an OS-compatible peer that is online while the box is connected and is not linked
 *   to another box. Only a unique candidate matches (two peers named alike link nothing). The box
 *   link does not carry tailnet IPs or a node key, so neither can be compared. A match moves the
 *   box's record to the peer's key (`byoBoxId` keeps the link); a linked peer that left the tailnet
 *   is matched again the same way. "Pair over SSH" links the box it created explicitly
 *   ({@link MachineRegistry.linkBox}).
 * - **Migration.** A paired box with no record gets `migratedByoMachinePolicy` written once (Ask
 *   first, devices from its `deviceHost`, commands and chats on).
 * - **Effects of a policy.** Capabilities are the source of truth: a box's `deviceHost` flag is kept
 *   equal to "may host device simulators" (the devices code reads it); a machine lent to a chat is
 *   given back once it may no longer run commands; {@link MachineSshAccessPort.sync} gets the full
 *   set of Free-use machines with Commands and SSH on; {@link MachineAccessPort.onChange} listeners
 *   hear about every policy change. `machines.changed` goes out only when the owner's list changed.
 *
 * Agents (any principal but `user`) see only {@link agentVisible} machines; the routes enforce it.
 */

import {
  agentSshAlias,
  agentSshAliasName,
  boxMachineId,
  machineOsOfBox,
  resolveMachinePolicy,
  tailnetMachineId,
  TAILNET_MACHINE_ID_PREFIX,
  type BoxNic,
  type BoxSummary,
  type MachineCapability,
  type MachineOs,
  type MachinePolicy,
  type MachineProblem,
  type MachinesResponse,
  type MachineState,
  type MachineSummary
} from "@orquester/api";
import type { StoredBox, StoredMachine } from "@orquester/config";

import type {
  MachineAccessPort,
  MachineBoxPolicy,
  MachinePairingPort,
  MachineSshAccessEntry,
  MachineSshAccessPort,
  MachineTarget,
  MachineWakePort
} from "./ports.ts";
import type { MachinePolicyStore } from "./store.ts";
import type { TailnetNode, TailnetRead } from "./tailscale-peers.ts";
import { mergeWolNics, type WakeMachineView } from "./wake.ts";

/** How often the tailnet is read while the daemon runs. */
export const MACHINES_POLL_MS = 15_000;
/** A list request re-reads the tailnet when the last read is older than this. */
const FRESH_MS = 5_000;

/** What the registry needs to know about a paired box's live link. */
export interface MachineBoxConnection {
  connected: boolean;
  /** The hostname `orq-agent` reported in its hello. */
  hostname: string;
  os: MachineOs;
  /** Passwordless sudo, Administrator, or running as root. */
  elevated: boolean;
}

/** The box side, over the box service (`wiring.ts`). */
export interface MachineBoxSource {
  /** Every bring-your-own box record (`provider: "byo"`). */
  byoRecords(): readonly StoredBox[];
  /** The box's link since its first connect in this process; null before. */
  connection(boxId: string): MachineBoxConnection | null;
  /** The box as the box routes show it (its per-chat `sshAlias`). */
  summary(boxId: string): BoxSummary | undefined;
  /** A box record or connection changed. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Keep the record's "Use for device simulators" flag in step with the policy. */
  setDeviceHost(boxId: string, deviceHost: boolean): Promise<void>;
  /** Give back a machine lent to a chat. */
  release(boxId: string): Promise<void>;
}

export interface MachineRegistryDeps {
  store: MachinePolicyStore;
  boxes: MachineBoxSource;
  readTailnet: () => Promise<TailnetRead>;
  /** `machines.changed` with the owner's list. */
  publish: (payload: MachinesResponse) => void;
  now?: () => number;
  logger?: Pick<Console, "warn">;
  pollMs?: number;
}

/** One merged machine, before it is summarized. */
interface Merged {
  id: string;
  peer: TailnetNode | null;
  box: StoredBox | null;
  stored: StoredMachine | undefined;
  self: boolean;
}

/** Who asks: the owner sees everything; an agent only what it may use, with its chat's aliases. */
export type MachineViewer = { kind: "owner" } | { kind: "agent"; threadId: string | null };

const OWNER: MachineViewer = { kind: "owner" };

/** "Eduard’s MacBook Pro.local" → "eduards-macbook-pro": the comparable part of a hostname. */
function hostKey(name: string): string {
  return name
    .split(".")[0]!
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function peerKeys(peer: TailnetNode): Set<string> {
  const keys = new Set([hostKey(peer.hostName)]);
  if (peer.dnsName) keys.add(hostKey(peer.dnsName));
  keys.delete("");
  return keys;
}

const osCompatible = (a: MachineOs, b: MachineOs): boolean => a === b || a === "other" || b === "other";

function boxOs(box: StoredBox, link: MachineBoxConnection | null): MachineOs {
  if (link) return link.os;
  if (box.os === "linux" || box.os === "darwin" || box.os === "win32") return machineOsOfBox(box.os);
  return box.kind === "macos" ? "macos" : box.kind === "windows" ? "windows" : "linux";
}

const latest = (...times: (string | null | undefined)[]): string | null =>
  times.filter((time): time is string => typeof time === "string" && Number.isFinite(Date.parse(time))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

/** Whether an agent may see a machine at all: never the daemon host, never Hidden, never one with every use switched off. */
export function agentVisible(machine: Pick<MachineSummary, "self" | "visibility" | "capabilities">): boolean {
  if (machine.self === true || machine.visibility === "hidden") return false;
  return machine.capabilities.devices || machine.capabilities.commands || machine.capabilities.chats;
}

/** A stored record with only what the owner chose kept (the record of an unpaired machine after removal). */
function resetPolicy(record: StoredMachine): StoredMachine | null {
  const { visibility: _visibility, capabilities: _capabilities, byoBoxId: _byo, updatedAt: _updated, ...rest } = record;
  const kept = Object.keys(rest).length > 0 ? rest : null;
  return kept as StoredMachine | null;
}

export class MachineRegistry implements MachineAccessPort {
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  private tailnet: TailnetRead | null = null;
  private tailnetAt = 0;
  private reading: Promise<void> | null = null;
  private merged: Merged[] = [];
  /** Box ids seen in this process: a link to one of them that disappears is a removal. */
  private readonly seenBoxes = new Set<string>();
  /** Machines a "Pair over SSH" call is running for. */
  private readonly pairingNow = new Set<string>();
  private pairing: MachinePairingPort | null = null;
  private wake: MachineWakePort | null = null;
  private sshAccess: MachineSshAccessPort | null = null;
  private readonly listeners = new Set<() => void>();
  private lastPublished: string | null = null;
  private lastPolicies: string | null = null;
  private lastSshEntries: string | null = null;
  private sshSyncing = false;
  private readonly pendingDeviceHost = new Map<string, boolean>();
  private readonly releasing = new Set<string>();
  /** Effects that failed: not retried before the next tailnet poll (no hot retry loop). */
  private readonly failedEffects = new Set<string>();
  private aliases = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribeBoxes: (() => void) | null = null;
  private rebuildQueued = false;
  private stopped = false;
  /** `machines.json` was read: before that nothing is merged (a merge would write over the owner's file). */
  private started = false;

  constructor(private readonly deps: MachineRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? console;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Load `machines.json`, read the tailnet once and start polling. Call after the box records loaded. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.deps.store.load();
    this.started = true;
    this.unsubscribeBoxes = this.deps.boxes.onChange(() => this.queueRebuild());
    await this.refresh();
    const pollMs = this.deps.pollMs ?? MACHINES_POLL_MS;
    this.timer = setInterval(() => void this.refresh(), pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeBoxes?.();
    this.unsubscribeBoxes = null;
    await this.reading?.catch(() => undefined);
    await this.deps.store.flush();
  }

  setPairing(port: MachinePairingPort | null): void {
    this.pairing = port;
    this.rebuild();
  }

  setWake(port: MachineWakePort | null): void {
    this.wake = port;
    this.rebuild();
  }

  setSshAccess(port: MachineSshAccessPort | null): void {
    this.sshAccess = port;
    this.lastSshEntries = null;
    this.rebuild();
  }

  /** Re-read the tailnet now (one read at a time), then rebuild. Never rejects. */
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const read = await this.deps.readTailnet();
        this.tailnet = read;
        this.tailnetAt = this.now();
      } catch (error) {
        this.logger.warn("[machines] reading the tailnet failed", error instanceof Error ? error.message : String(error));
      }
      this.failedEffects.clear();
      if (!this.stopped) this.rebuild();
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /** Re-read the tailnet when the last read is older than a few seconds. */
  async ensureFresh(): Promise<void> {
    if (this.now() - this.tailnetAt > FRESH_MS) await this.refresh();
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** The list as `viewer` may see it. */
  list(viewer: MachineViewer = OWNER): MachinesResponse {
    const all = this.merged.map((machine) => this.summarize(machine, viewer));
    const machines = viewer.kind === "owner" ? all : all.filter(agentVisible);
    const problems = viewer.kind === "owner" && this.tailnet && !this.tailnet.ok ? [this.tailnet.problem] : [];
    return { machines, problems };
  }

  /** One machine as `viewer` may see it; undefined when unknown or hidden from `viewer`. */
  get(machineId: string, viewer: MachineViewer = OWNER): MachineSummary | undefined {
    const machine = this.merged.find((entry) => entry.id === machineId);
    if (!machine) return undefined;
    const summary = this.summarize(machine, viewer);
    return viewer.kind === "owner" || agentVisible(summary) ? summary : undefined;
  }

  /** What another feature acts on (pairing, wake). */
  target(machineId: string): MachineTarget | undefined {
    const machine = this.merged.find((entry) => entry.id === machineId);
    if (!machine) return undefined;
    const ssh = machine.stored?.ssh;
    return {
      machineId: machine.id,
      name: this.nameOf(machine),
      hostname: machine.peer?.hostName ?? null,
      dnsName: machine.peer?.dnsName ?? null,
      tailnetIps: machine.peer?.tailnetIps ?? [],
      os: this.osOf(machine),
      boxId: machine.box?.id ?? null,
      ssh: {
        ...(ssh?.user !== undefined ? { user: ssh.user } : {}),
        ...(ssh?.port !== undefined ? { port: ssh.port } : {}),
        ...(ssh?.identityFile !== undefined ? { identityFile: ssh.identityFile } : {}),
        ...(ssh?.alias !== undefined ? { sshAlias: ssh.alias } : {})
      }
    };
  }

  /** Whether any machine is visible to agents (the `list_machines` tool and its instruction line). */
  anyAgentVisible(): boolean {
    return this.list({ kind: "agent", threadId: null }).machines.length > 0;
  }

  /** The current policy of a machine (stored, else the migration rule or the new-peer default). */
  policyOf(machineId: string): MachinePolicy | undefined {
    const machine = this.merged.find((entry) => entry.id === machineId);
    return machine ? this.policy(machine) : undefined;
  }

  // ---- MachineAccessPort ----------------------------------------------------------------------

  policyOfBox(boxId: string): MachineBoxPolicy | null {
    const machine = this.merged.find((entry) => entry.box?.id === boxId);
    if (machine) return { machineId: machine.id, ...this.policy(machine) };
    // A record newer than the last rebuild: the same rule the rebuild applies.
    const record = this.deps.boxes.byoRecords().find((entry) => entry.id === boxId);
    if (!record) return null;
    const stored = Object.entries(this.deps.store.all()).find(([, entry]) => entry.byoBoxId === boxId);
    let machineId = stored?.[0];
    if (machineId === undefined) {
      try {
        machineId = boxMachineId(boxId);
      } catch {
        return null;
      }
    }
    return { machineId, ...resolveMachinePolicy(stored?.[1], record) };
  }

  allowsBox(boxId: string, capability: MachineCapability): boolean {
    const policy = this.policyOfBox(boxId);
    if (!policy) return true;
    return policy.visibility !== "hidden" && policy.capabilities[capability];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // ---- writes (the routes check who asks) -------------------------------------------------------

  /** Persist a policy change for one machine (owner only; validated by the route). */
  async updatePolicy(machineId: string, change: { visibility?: MachinePolicy["visibility"]; capabilities?: Partial<MachinePolicy["capabilities"]>; ssh?: Record<string, string | number | null> }): Promise<MachineSummary | undefined> {
    const machine = this.merged.find((entry) => entry.id === machineId);
    if (!machine) return undefined;
    const current = this.policy(machine);
    const at = new Date(this.now()).toISOString();
    await this.deps.store.update((records) => {
      const record: StoredMachine = { ...(records[machineId] ?? {}) };
      if (change.visibility !== undefined || change.capabilities !== undefined) {
        record.visibility = change.visibility ?? current.visibility;
        record.capabilities = { ...current.capabilities, ...(change.capabilities ?? {}) };
      }
      if (change.ssh !== undefined) {
        const ssh: Record<string, unknown> = { ...(record.ssh ?? {}) };
        for (const [key, value] of Object.entries(change.ssh)) {
          if (value === null) delete ssh[key];
          else ssh[key] = value;
        }
        if (Object.keys(ssh).length > 0) record.ssh = ssh as StoredMachine["ssh"];
        else delete record.ssh;
      }
      if (machine.box) record.byoBoxId = machine.box.id;
      record.updatedAt = at;
      records[machineId] = record;
    });
    this.rebuild();
    return this.get(machineId);
  }

  /** After a paired machine was removed, or to forget an unpaired peer's policy: back to the new-peer default. */
  async resetMachine(machineId: string): Promise<void> {
    await this.deps.store.update((records) => {
      const record = records[machineId];
      if (!record) return false;
      const kept = machineId.startsWith(TAILNET_MACHINE_ID_PREFIX) ? resetPolicy(record) : null;
      if (kept) records[machineId] = kept;
      else delete records[machineId];
    });
    this.rebuild();
  }

  /** "Pair over SSH" created `boxId` for `machineId`: link them now, before `orq-agent` connects. */
  async linkBox(machineId: string, boxId: string): Promise<void> {
    await this.deps.store.update((records) => {
      for (const [id, record] of Object.entries(records)) {
        if (id !== machineId && record.byoBoxId === boxId) delete records[id];
      }
      records[machineId] = { ...(records[machineId] ?? {}), byoBoxId: boxId };
    });
    this.rebuild();
  }

  /** Mark a "Pair over SSH" run (its machine reads `pairing`); false when one runs already. */
  beginPairing(machineId: string): boolean {
    if (this.pairingNow.has(machineId)) return false;
    this.pairingNow.add(machineId);
    this.rebuild();
    return true;
  }

  endPairing(machineId: string): void {
    this.pairingNow.delete(machineId);
    this.rebuild();
  }

  pairingPort(): MachinePairingPort | null {
    return this.pairing;
  }

  wakePort(): MachineWakePort | null {
    return this.wake;
  }

  /** Every listed machine as the wake chooses senders and targets (the daemon's own host included). */
  wakeMachines(): WakeMachineView[] {
    return this.merged.map((machine) => ({
      machineId: machine.id,
      name: this.nameOf(machine),
      self: machine.self,
      os: this.osOf(machine),
      visibility: this.policy(machine).visibility,
      boxId: machine.box?.id ?? null,
      wol: machine.stored?.wol ?? null
    }));
  }

  /**
   * A paired machine's box reported its NICs (hello or `sys.nics`): keep the wired ones in its
   * record's `wol` ({@link mergeWolNics}), which stays while the machine is offline. A box that is
   * not a paired machine is ignored; nothing is written when nothing changed. The list is rebuilt
   * either way: a sender's new address changes what can be woken. Never rejects.
   */
  async recordNics(boxId: string, nics: readonly BoxNic[]): Promise<void> {
    if (!this.started || this.stopped) return;
    let machine = this.merged.find((entry) => entry.box?.id === boxId);
    if (!machine) {
      // A box paired since the last merge.
      this.rebuild();
      machine = this.merged.find((entry) => entry.box?.id === boxId);
    }
    if (!machine) return;
    const machineId = machine.id;
    try {
      await this.deps.store.update((records) => {
        const record = records[machineId] ?? {};
        const wol = mergeWolNics(record.wol, nics, new Date(this.now()).toISOString());
        if (!wol) return false;
        records[machineId] = { ...record, wol };
      });
    } catch (error) {
      this.logger.warn(`[machines] could not save ${machineId}'s network adapters`, error instanceof Error ? error.message : String(error));
    }
    if (!this.stopped) this.rebuild();
  }

  // ---- the merge ------------------------------------------------------------------------------

  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    queueMicrotask(() => {
      this.rebuildQueued = false;
      if (!this.stopped) this.rebuild();
    });
  }

  /**
   * Merge the sources into {@link merged}, persist what the merge decided (links, re-keys,
   * migrations, removals) and run the effects of the policies. Synchronous over cached sources, so
   * {@link MachineAccessPort} answers from current records; the store write is best-effort (a
   * read-only store keeps deciding the same way every time).
   */
  rebuild(): void {
    if (!this.started) return;
    const records = this.deps.store.all();
    const boxes = this.deps.boxes.byoRecords().filter((box) => box.provider === "byo");
    const boxById = new Map(boxes.map((box) => [box.id, box]));
    const status = this.tailnet?.ok ? this.tailnet.status : null;
    const peers = status?.peers ?? [];
    const peerById = new Map(peers.map((peer) => [tailnetMachineId(peer.stableId), peer]));
    let changed = false;

    // Links a removed box left behind (a box this process saw that is gone now).
    for (const [id, record] of Object.entries(records)) {
      if (!record.byoBoxId || boxById.has(record.byoBoxId) || !this.seenBoxes.has(record.byoBoxId)) continue;
      const kept = id.startsWith(TAILNET_MACHINE_ID_PREFIX) ? resetPolicy(record) : null;
      if (kept) records[id] = kept;
      else delete records[id];
      changed = true;
    }
    for (const box of boxes) this.seenBoxes.add(box.id);

    // box id → the record id linking it (the first one; duplicates are dropped).
    const linkOf = new Map<string, string>();
    for (const [id, record] of Object.entries(records)) {
      const boxId = record.byoBoxId;
      if (!boxId || !boxById.has(boxId)) continue;
      if (linkOf.has(boxId)) {
        // A second record naming the same box keeps its policy but not the link.
        const { byoBoxId: _duplicate, ...rest } = record;
        records[id] = rest;
        changed = true;
        continue;
      }
      linkOf.set(boxId, id);
    }

    // Match boxes not linked to a peer that is on the tailnet now (only with a fresh peer list).
    if (status) {
      const takenPeers = new Set([...linkOf.values()].filter((id) => peerById.has(id)));
      for (const box of boxes) {
        const linked = linkOf.get(box.id);
        if (linked !== undefined && peerById.has(linked)) continue;
        const link = this.deps.boxes.connection(box.id);
        if (!link) continue;
        const key = hostKey(link.hostname);
        if (key === "") continue;
        const candidates = peers.filter((peer) => {
          const id = tailnetMachineId(peer.stableId);
          if (takenPeers.has(id) || !osCompatible(peer.os, link.os)) return false;
          if (link.connected && !peer.online) return false;
          return peerKeys(peer).has(key);
        });
        if (candidates.length !== 1) continue;
        const peerId = tailnetMachineId(candidates[0]!.stableId);
        records[peerId] = this.moved(linked !== undefined ? records[linked] : undefined, records[peerId], box.id);
        if (linked !== undefined) delete records[linked];
        linkOf.set(box.id, peerId);
        takenPeers.add(peerId);
        changed = true;
      }
    }

    // Paired boxes with no record yet: the migration rule, written once.
    for (const box of boxes) {
      if (linkOf.has(box.id)) {
        const id = linkOf.get(box.id)!;
        const record = records[id]!;
        if (record.visibility === undefined) {
          const policy = resolveMachinePolicy(undefined, box);
          records[id] = { ...record, visibility: policy.visibility, capabilities: { ...policy.capabilities } };
          changed = true;
        }
        continue;
      }
      let id: string;
      try {
        id = boxMachineId(box.id);
      } catch {
        continue;
      }
      const policy = resolveMachinePolicy(undefined, box);
      records[id] = { ...(records[id] ?? {}), visibility: policy.visibility, capabilities: { ...policy.capabilities }, byoBoxId: box.id };
      linkOf.set(box.id, id);
      changed = true;
    }

    // The list: the daemon's own machine, every peer, then paired boxes with no peer now.
    const merged: Merged[] = [];
    const boxOfRecord = new Map([...linkOf.entries()].map(([boxId, id]) => [id, boxById.get(boxId)!]));
    if (status?.self) {
      const id = tailnetMachineId(status.self.stableId);
      merged.push({ id, peer: status.self, box: null, stored: records[id], self: true });
    }
    for (const [id, peer] of peerById) merged.push({ id, peer, box: boxOfRecord.get(id) ?? null, stored: records[id], self: false });
    for (const [id, box] of boxOfRecord) {
      if (peerById.has(id)) continue;
      merged.push({ id, peer: null, box, stored: records[id], self: false });
    }
    this.merged = merged;
    this.aliases = this.machineAliases();

    if (changed) {
      void this.deps.store
        .update((current) => {
          // Replace with the merge's view, keeping anything written meanwhile for ids it did not touch.
          for (const id of Object.keys(current)) if (!(id in records)) delete current[id];
          Object.assign(current, records);
        })
        .catch((error: unknown) => this.logger.warn("[machines] could not save machine links", error instanceof Error ? error.message : String(error)));
    }
    this.applyEffects();
  }

  /** A box's record moving onto its peer's key: the side the owner chose last wins, and the link is kept. */
  private moved(fromBox: StoredMachine | undefined, atPeer: StoredMachine | undefined, boxId: string): StoredMachine {
    const ownerSet = (record: StoredMachine | undefined): number => (record?.visibility !== undefined && record.updatedAt ? Date.parse(record.updatedAt) || 0 : -1);
    const [winner, loser] = ownerSet(atPeer) >= ownerSet(fromBox) && atPeer?.visibility !== undefined ? [atPeer, fromBox] : [fromBox, atPeer];
    return { ...(loser ?? {}), ...(winner ?? {}), byoBoxId: boxId };
  }

  private policy(machine: Merged): MachinePolicy {
    return resolveMachinePolicy(machine.stored, machine.box ?? undefined);
  }

  private nameOf(machine: Merged): string {
    return machine.box?.machineName ?? machine.peer?.hostName ?? machine.box?.name ?? machine.id;
  }

  private osOf(machine: Merged): MachineOs {
    const fromPeer = machine.peer?.os ?? "other";
    if (fromPeer !== "other" || !machine.box) return fromPeer;
    return boxOs(machine.box, this.deps.boxes.connection(machine.box.id));
  }

  private stateOf(machine: Merged, link: MachineBoxConnection | null): MachineState {
    if (machine.self) return "ready";
    if (this.pairingNow.has(machine.id)) return "pairing";
    if (!machine.box) return "not-paired";
    if (machine.box.state === "pairing") return "pairing";
    if (link?.connected) return "ready";
    if (machine.peer && !machine.peer.online) return "asleep";
    return "offline";
  }

  /** Machine-level aliases: Free use with Commands and SSH on, paired; made unique in id order. */
  private machineAliases(): Map<string, string> {
    const aliases = new Map<string, string>();
    const used = new Set<string>();
    for (const machine of [...this.merged].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!machine.box || machine.self) continue;
      const policy = this.policy(machine);
      if (policy.visibility !== "free" || !policy.capabilities.commands) continue;
      const base = agentSshAliasName(this.nameOf(machine));
      if (base === null) continue;
      let name = base;
      for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
      used.add(name);
      aliases.set(machine.id, name);
    }
    return aliases;
  }

  private summarize(machine: Merged, viewer: MachineViewer): MachineSummary {
    const policy = this.policy(machine);
    const link = machine.box ? this.deps.boxes.connection(machine.box.id) : null;
    const state = this.stateOf(machine, link);
    const probe = machine.self ? null : (this.pairing?.lastProbe(machine.id) ?? null);
    const wake = machine.self ? { canWake: false } : (this.wake?.canWake(machine.id, { agent: viewer.kind === "agent" }) ?? { canWake: false });
    const name = this.nameOf(machine);
    const problems: MachineProblem[] = [...(probe?.problems ?? [])];
    if (state === "asleep" && !problems.some((problem) => problem.code === "machine-asleep")) {
      problems.push({
        code: "machine-asleep",
        machineId: machine.id,
        message: `${name} is asleep or turned off.`,
        fix: wake.canWake
          ? "Wake it from here, or turn it on."
          : this.osOf(machine) === "macos"
            ? "Open its lid, or keep it on power in clamshell mode with a display attached."
            : "Turn it on (Wake-on-LAN needs a wired connection and another paired machine on its network)."
      });
    }
    let sshAlias: string | undefined;
    const aliasName = this.aliases.get(machine.id);
    if (aliasName !== undefined) sshAlias = agentSshAlias(aliasName);
    else if (viewer.kind === "agent" && viewer.threadId !== null && machine.box && machine.box.purpose === "temporary" && machine.box.threadId === viewer.threadId) {
      // An Ask-first machine lent to this very chat: the chat's own alias for it.
      sshAlias = this.deps.boxes.summary(machine.box.id)?.sshAlias;
    }
    const sudo = probe?.sudo ?? (link ? { passwordless: link.elevated } : {});
    return {
      id: machine.id,
      name,
      hostname: machine.peer?.hostName ?? null,
      dnsName: machine.peer?.dnsName ?? null,
      os: this.osOf(machine),
      tailnetIps: [...(machine.peer?.tailnetIps ?? [])],
      online: machine.peer ? machine.peer.online : link?.connected === true,
      lastSeenAt: latest(machine.peer?.lastSeenAt, machine.box?.lastSeenAt),
      state,
      visibility: policy.visibility,
      capabilities: { ...policy.capabilities },
      boxId: machine.box?.id ?? null,
      ...(machine.self ? { self: true } : {}),
      ...(sshAlias !== undefined ? { sshAlias } : {}),
      wake: { canWake: wake.canWake, ...(wake.via !== undefined ? { via: wake.via } : {}) },
      sudo: { ...sudo },
      problems
    };
  }

  // ---- effects --------------------------------------------------------------------------------

  private applyEffects(): void {
    for (const machine of this.merged) {
      const box = machine.box;
      if (!box) continue;
      const policy = this.policy(machine);
      const devices = policy.visibility !== "hidden" && policy.capabilities.devices;
      const deviceKey = `devices:${box.id}`;
      if ((box.deviceHost === true) !== devices && this.pendingDeviceHost.get(box.id) !== devices && !this.failedEffects.has(deviceKey)) {
        this.pendingDeviceHost.set(box.id, devices);
        void this.deps.boxes.setDeviceHost(box.id, devices).then(
          () => {
            this.pendingDeviceHost.delete(box.id);
            this.queueRebuild();
          },
          (error: unknown) => {
            this.pendingDeviceHost.delete(box.id);
            this.failedEffects.add(deviceKey);
            this.logger.warn(`[machines] could not update ${box.id}'s device setting`, error instanceof Error ? error.message : String(error));
          }
        );
      }
      const commands = policy.visibility !== "hidden" && policy.capabilities.commands;
      const releaseKey = `release:${box.id}`;
      if (!commands && box.purpose === "temporary" && box.state !== "destroyed" && !this.releasing.has(box.id) && !this.failedEffects.has(releaseKey)) {
        this.releasing.add(box.id);
        void this.deps.boxes.release(box.id).then(
          () => {
            this.releasing.delete(box.id);
            this.queueRebuild();
          },
          (error: unknown) => {
            this.releasing.delete(box.id);
            this.failedEffects.add(releaseKey);
            this.logger.warn(`[machines] could not give ${box.id} back from its chat`, error instanceof Error ? error.message : String(error));
          }
        );
      }
    }

    const policies = JSON.stringify(this.merged.map((machine) => [machine.id, machine.box?.id ?? null, this.policy(machine)]));
    if (policies !== this.lastPolicies) {
      this.lastPolicies = policies;
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          this.logger.warn("[machines] a policy listener failed", error instanceof Error ? error.message : String(error));
        }
      }
    }

    this.syncSsh();

    const payload = this.list(OWNER);
    const text = JSON.stringify(payload);
    if (text !== this.lastPublished) {
      this.lastPublished = text;
      this.deps.publish(payload);
    }
  }

  private syncSsh(): void {
    const port = this.sshAccess;
    if (!port || this.sshSyncing) return;
    const aliases = this.machineAliases();
    const entries: MachineSshAccessEntry[] = this.merged
      .filter((machine) => machine.box && aliases.has(machine.id))
      .map((machine) => ({ machineId: machine.id, boxId: machine.box!.id, alias: aliases.get(machine.id)! }));
    const text = JSON.stringify(entries);
    if (text === this.lastSshEntries) return;
    this.sshSyncing = true;
    void port
      .sync(entries)
      .then(
        () => {
          this.lastSshEntries = text;
        },
        (error: unknown) => this.logger.warn("[machines] syncing machine SSH aliases failed", error instanceof Error ? error.message : String(error))
      )
      .finally(() => {
        this.sshSyncing = false;
        // A change that came in while syncing is synced now; a failure waits for the next poll.
        if (this.lastSshEntries === text) this.queueRebuild();
      });
  }
}
