/**
 * The Devices fleet view's pure logic (devices phase 2 §2.9): which hosts and leases show and in
 * what order, how a host's kind and status read, what a host and a lease cost so far, the pool
 * header's numbers, and the hub path a lease's thumbnail is polled from. No React, no store.
 *
 * Costs are estimates, like the boxes': uptime × the host's estimated $/h. A lease's share is the
 * host's $/h split evenly across the leases on it now, times the lease's own age.
 */

import {
  deviceProfile,
  deviceRoutes,
  type DeviceActionEntry,
  type DeviceFormFactor,
  type DeviceHostStatus,
  type DeviceHostSummary,
  type DeviceLeaseState,
  type DeviceLeaseSummary,
  type DevicePlacementMode,
  type DevicePoolSummary,
  type DevicesSettings
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Grouping and order
// ---------------------------------------------------------------------------

/** One host's section of the grid: its card, then its leased devices. */
export interface FleetGroup {
  hostId: string;
  /** Null when a lease names a host the host list does not have (yet). */
  host: DeviceHostSummary | null;
  leases: DeviceLeaseSummary[];
}

const LEASE_STATE_RANK: Readonly<Record<DeviceLeaseState, number>> = { ready: 0, starting: 1, suspended: 2, lost: 3, released: 4 };

const HOST_STATUS_RANK: Readonly<Record<DeviceHostStatus, number>> = {
  ready: 0,
  starting: 1,
  installing: 1,
  unreachable: 2,
  "needs-setup": 3,
  failed: 4,
  stopping: 5,
  disabled: 6
};

/** Live leases first (ready, starting, suspended, lost), oldest first within a state. */
function compareLeases(a: DeviceLeaseSummary, b: DeviceLeaseSummary): number {
  return LEASE_STATE_RANK[a.state] - LEASE_STATE_RANK[b.state] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function hostStartedAt(host: DeviceHostSummary): string {
  return host.box?.startedAt ?? "";
}

/** This host first, then hosts by status (ready first), then the longest-running, then label. */
function compareHosts(a: DeviceHostSummary, b: DeviceHostSummary): number {
  const local = Number(b.kind === "local") - Number(a.kind === "local");
  if (local !== 0) return local;
  return (
    HOST_STATUS_RANK[a.status] - HOST_STATUS_RANK[b.status] ||
    hostStartedAt(a).localeCompare(hostStartedAt(b)) ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The grid's sections: every host that runs devices or could (a host that is off and holds no
 * lease is left out), each with its leases in {@link compareLeases} order; leases on a host the
 * list does not know come last, under a group of their own. Released leases never show.
 */
export function groupFleet(hosts: readonly DeviceHostSummary[] | null, leases: readonly DeviceLeaseSummary[] | null): FleetGroup[] {
  const byHost = new Map<string, DeviceLeaseSummary[]>();
  for (const lease of leases ?? []) {
    if (lease.state === "released") continue;
    const list = byHost.get(lease.hostId);
    if (list) list.push(lease);
    else byHost.set(lease.hostId, [lease]);
  }
  const known = new Set<string>();
  const groups: FleetGroup[] = [];
  for (const host of [...(hosts ?? [])].sort(compareHosts)) {
    known.add(host.id);
    const mine = byHost.get(host.id) ?? [];
    if (mine.length === 0 && host.status === "disabled") continue;
    groups.push({ hostId: host.id, host, leases: mine.sort(compareLeases) });
  }
  const orphans = [...byHost.keys()].filter((id) => !known.has(id)).sort();
  for (const hostId of orphans) groups.push({ hostId, host: null, leases: byHost.get(hostId)!.sort(compareLeases) });
  return groups;
}

// ---------------------------------------------------------------------------
// Hosts: kind, status
// ---------------------------------------------------------------------------

function providerLabel(provider: string): string {
  if (provider === "byo") return "Your machine";
  return provider.length > 0 ? provider[0]!.toUpperCase() + provider.slice(1) : "Rented";
}

/** "This host", "Your machine", or the provider and OS of a rented box: "Blacksmith macOS". */
export function hostKindLabel(host: Pick<DeviceHostSummary, "kind" | "platforms" | "box">): string {
  if (host.kind === "local") return "This host";
  if (host.kind === "byo") return "Your machine";
  const os = host.platforms.includes("ios") ? "macOS" : "Linux";
  return host.box ? `${providerLabel(host.box.provider)} ${os}` : `Rented ${os}`;
}

export type FleetTone = "ok" | "info" | "warn" | "danger" | "muted";

export interface HostStatusView {
  /** The fleet's words for it (phase 2): a host is ready, provisioning, suspended, offline or lost. */
  key: "ready" | "draining" | "provisioning" | "suspended" | "offline" | "lost" | "stopping";
  label: string;
  tone: FleetTone;
  /** One line under the status; null for none. */
  detail: string | null;
}

/** How a host's status reads on its card. */
export function hostStatusView(host: Pick<DeviceHostSummary, "kind" | "status" | "statusDetail" | "pool">): HostStatusView {
  const detail = host.statusDetail;
  switch (host.status) {
    case "ready":
      if (host.pool?.draining && host.pool.drainReason === "deadline") {
        return { key: "draining", label: "Ending soon (deadline)", tone: "warn", detail: detail ?? DEADLINE_DRAIN_TEXT };
      }
      return host.pool?.draining
        ? { key: "draining", label: "Draining", tone: "warn", detail: detail ?? "Takes no new devices; destroyed once empty." }
        : { key: "ready", label: "Ready", tone: "ok", detail };
    case "starting":
      return { key: "provisioning", label: "Provisioning", tone: "info", detail: detail ?? (host.kind === "local" ? "Starting its device hub." : "Renting and preparing the host.") };
    case "installing":
      return { key: "provisioning", label: "Provisioning", tone: "info", detail: detail ?? "Installing device tools." };
    case "unreachable":
      return { key: "suspended", label: "Suspended", tone: "warn", detail: detail ?? "Its link dropped; its devices keep running." };
    case "needs-setup":
      return { key: "offline", label: "Needs setup", tone: "warn", detail: detail ?? "Settings → Devices lists what is missing." };
    case "disabled":
      return { key: "offline", label: "Off", tone: "muted", detail: detail ?? "Its platform is off in Settings → Devices." };
    case "stopping":
      return { key: "stopping", label: "Stopping", tone: "muted", detail };
    case "failed":
      return host.kind === "local"
        ? { key: "offline", label: "Failed", tone: "danger", detail }
        : { key: "lost", label: "Lost", tone: "danger", detail: detail ?? "The host is gone; its devices ended." };
  }
}

const DEADLINE_DRAIN_TEXT = "Near its time limit: takes no new devices; destroyed once its devices end.";

/**
 * Why the card's Resume is off: a host drained near its time limit (the daemon refuses to resume
 * it); null when Resume works (or the host is not draining).
 */
export function resumeBlockedReason(host: Pick<DeviceHostSummary, "pool">): string | null {
  return host.pool?.draining && host.pool.drainReason === "deadline" ? `Can't resume: ${DEADLINE_DRAIN_TEXT.charAt(0).toLowerCase()}${DEADLINE_DRAIN_TEXT.slice(1)}` : null;
}

/** Whether the card offers Drain (or Resume): a rented or paired host that can take leases. */
export function canDrain(host: Pick<DeviceHostSummary, "kind" | "status">): boolean {
  return host.kind !== "local" && (host.status === "ready" || host.status === "starting" || host.status === "unreachable");
}

/** Whether the card offers Destroy: a rented box (a paired machine of the owner's is unpaired in Settings, not destroyed). */
export function canDestroy(host: Pick<DeviceHostSummary, "kind" | "status" | "box">): boolean {
  return host.kind === "box" && host.box !== undefined && host.status !== "stopping";
}

/** Whether the card offers Warm caches: a pool host (its caches are what new pool hosts start from). */
export function canWarmCaches(host: Pick<DeviceHostSummary, "kind" | "pool" | "platforms">): boolean {
  return host.kind === "box" && host.pool !== undefined && host.platforms.length > 0;
}

// ---------------------------------------------------------------------------
// Time and cost
// ---------------------------------------------------------------------------

/** Milliseconds from `iso` to `now`, never negative; 0 for an unreadable time. */
export function msSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, now - at);
}

/** An uptime: "<1m", "42m", "3h 5m", "2d 4h". */
export function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "just now", "12s ago", "4m ago", "2h ago", "3d ago". */
export function formatAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface Cost {
  /** Estimated $/h. */
  hourlyUsd: number;
  /** Estimated spend so far. */
  spentUsd: number;
}

/**
 * A rented host's $/h and what it cost so far; null for this host, a free one (a paired machine)
 * or a price the provider did not report.
 */
export function hostCost(host: Pick<DeviceHostSummary, "box">, now: number): Cost | null {
  const box = host.box;
  if (!box || box.hourlyUsd === null || !Number.isFinite(box.hourlyUsd) || box.hourlyUsd <= 0) return null;
  return { hourlyUsd: box.hourlyUsd, spentUsd: (box.hourlyUsd * msSince(box.startedAt, now)) / 3_600_000 };
}

/**
 * A lease's share of its host's cost: the host's $/h split evenly across the `sharers` leases on
 * it now (at least 1), times the lease's age. Null where the host has no price (this host).
 */
export function leaseCostShare(lease: Pick<DeviceLeaseSummary, "createdAt">, host: Pick<DeviceHostSummary, "box"> | null, sharers: number, now: number): Cost | null {
  if (!host) return null;
  const cost = hostCost(host, now);
  if (!cost) return null;
  const hourlyUsd = cost.hourlyUsd / Math.max(1, Math.floor(sharers));
  return { hourlyUsd, spentUsd: (hourlyUsd * msSince(lease.createdAt, now)) / 3_600_000 };
}

/** How many of a group's leases share its host's cost: those that still hold a device. */
export function costSharers(leases: readonly Pick<DeviceLeaseSummary, "state">[]): number {
  return leases.filter((lease) => lease.state === "ready" || lease.state === "starting" || lease.state === "suspended").length;
}

// ---------------------------------------------------------------------------
// The pool header
// ---------------------------------------------------------------------------

const PLACEMENT_LABELS: Readonly<Record<DevicePlacementMode, string>> = {
  "local-only": "This host only",
  "prefer-local": "This host first",
  "pool-only": "Pool only"
};

export interface PoolView {
  placement: DevicePlacementMode | null;
  placementLabel: string;
  /** Rented hosts (not counting this host). */
  poolHosts: number;
  /** Devices running under a lease, across every host that can take one. */
  used: number;
  /** How many devices the fleet may run at once now. */
  total: number;
  queue: number;
  /** The pool's summed estimated $/h. */
  hourlyUsd: number;
  /** The `maxHourlyUsd` cap; null until the settings load. */
  capUsd: number | null;
  /** hourlyUsd / capUsd, 0 when there is no cap to compare with. */
  spendRatio: number;
  spendTone: FleetTone;
  /** What the rented hosts cost so far. */
  spentUsd: number;
  /** The "Rent device hosts without asking" switch; null until the settings load. */
  rentWithoutAsking: boolean | null;
}

/** The meter's tone: ok below 75 %, warn up to the cap, danger at or above it. */
export function spendTone(ratio: number): FleetTone {
  if (ratio >= 1) return "danger";
  if (ratio >= 0.75) return "warn";
  return "ok";
}

/**
 * The pool header's numbers: capacity summed over the hosts (this one included) that are not off
 * or gone, the queue and $/h from the pool summary (or the hosts' prices before one arrived), the
 * cap and switches from the settings.
 */
export function poolView(
  pool: DevicePoolSummary | null,
  settings: DevicesSettings | null,
  hosts: readonly DeviceHostSummary[] | null,
  now: number
): PoolView {
  let used = 0;
  let total = 0;
  let boxHourly = 0;
  let spentUsd = 0;
  let poolHosts = 0;
  for (const host of hosts ?? []) {
    if (host.status !== "disabled" && host.status !== "failed" && host.status !== "stopping") {
      used += host.capacity.used;
      total += host.capacity.total;
    }
    if (host.kind !== "local") poolHosts += 1;
    const cost = hostCost(host, now);
    if (cost) {
      boxHourly += cost.hourlyUsd;
      spentUsd += cost.spentUsd;
    }
  }
  const hourlyUsd = pool?.hourlyUsd ?? boxHourly;
  const capUsd = settings?.pool.maxHourlyUsd ?? null;
  const spendRatio = capUsd !== null && capUsd > 0 ? hourlyUsd / capUsd : 0;
  const placement = settings?.pool.placement ?? null;
  return {
    placement,
    placementLabel: placement ? PLACEMENT_LABELS[placement] : "—",
    poolHosts: pool?.hosts ?? poolHosts,
    used,
    total,
    queue: pool?.queue ?? 0,
    hourlyUsd,
    capUsd,
    spendRatio,
    spendTone: capUsd === 0 && hourlyUsd > 0 ? "danger" : spendTone(spendRatio),
    spentUsd,
    rentWithoutAsking: settings ? settings.pool.rentWithoutAsking : null
  };
}

/** A 0–1 fill for a meter (used / total), 0 when there is no total. */
export function meterFill(used: number, total: number): number {
  if (!(total > 0) || !(used > 0)) return 0;
  return Math.min(1, used / total);
}

// ---------------------------------------------------------------------------
// Leases: words, thumbnail
// ---------------------------------------------------------------------------

/** The newest action-log row, or null. */
export function lastAction(log: readonly DeviceActionEntry[] | undefined): DeviceActionEntry | null {
  return log && log.length > 0 ? log[log.length - 1]! : null;
}

/** What covers the thumbnail for a lease that is not live, or null when it streams. */
export function leaseStateNote(lease: Pick<DeviceLeaseSummary, "state" | "progress" | "error">): { label: string; tone: FleetTone } | null {
  switch (lease.state) {
    case "ready":
      return null;
    case "starting":
      return { label: lease.progress?.label ?? "Starting…", tone: "info" };
    case "suspended":
      return { label: "Suspended — host link dropped", tone: "warn" };
    case "lost":
      return { label: lease.error ?? "Lost — its host or device is gone", tone: "danger" };
    case "released":
      return { label: "Released", tone: "muted" };
  }
}

/**
 * The route a lease's ~1 fps thumbnail is polled from (GET `deviceRoutes.thumbnail`: the daemon
 * takes the hub's screenshot, downscales it and answers a small JPEG). Null while it has nothing
 * to show (not ready, no stream yet, or a stream kind without a hub screenshot).
 */
export function thumbnailPath(lease: Pick<DeviceLeaseSummary, "id" | "state" | "stream">): string | null {
  if (lease.state !== "ready" || !lease.stream || lease.stream.deviceParam.length === 0) return null;
  switch (lease.stream.kind) {
    case "serve-emu":
    case "serve-sim":
      return deviceRoutes.thumbnail(lease.id);
    case "vphone":
      return null;
  }
}

/** The lease's form factor, from its profile (a phone when unknown). */
export function leaseFormFactor(lease: Pick<DeviceLeaseSummary, "profile">): DeviceFormFactor {
  return deviceProfile(lease.profile)?.formFactor ?? "phone";
}

/** Width / height of the thumbnail frame: the screen's when known, else the form factor's. */
export function thumbnailAspect(lease: Pick<DeviceLeaseSummary, "profile" | "screen">): number {
  const screen = lease.screen;
  if (screen && screen.width > 0 && screen.height > 0) return screen.width / screen.height;
  switch (leaseFormFactor(lease)) {
    case "tablet":
      return 3 / 4;
    case "foldable":
      return 5 / 6;
    case "phone":
      return 9 / 19.5;
  }
}

export interface ChatRef {
  title: string;
  agentName: string | null;
  /** The chat is still a session this client knows. */
  known: boolean;
}

/** The chat that holds a lease, as the card names it. */
export function chatRef(
  threadId: string,
  sessions: readonly { id: string; title: string; refId: string }[],
  agents: readonly { id: string; name: string }[]
): ChatRef {
  const session = sessions.find((entry) => entry.id === threadId);
  if (!session) return { title: "Chat not open", agentName: null, known: false };
  const agent = agents.find((entry) => entry.id === session.refId);
  return { title: session.title.trim() || "Untitled chat", agentName: agent?.name ?? (session.refId || null), known: true };
}
