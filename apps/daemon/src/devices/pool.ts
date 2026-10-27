/**
 * Where a new lease goes (devices spec §6; phase 2 §2.3–2.4 extends it into the pool scheduler).
 * Pure: the service passes the hosts as they are now and acts on the answer.
 *
 * Phase 1 rules, in order:
 * 1. the platform is off in Settings → Devices → `disabled`;
 * 2. a named host (`hostId`) is used alone;
 * 3. otherwise local first (unless `pool-only`), then the busiest ready box host that still has
 *    room (best fit packs hosts, so idle ones can be torn down);
 * 4. no room, but a host is starting or installing → `wait` for it;
 * 5. a host that needs setup the daemon can do itself (every missing check has a fix action) →
 *    `setup` (the owner enabling the platform is the consent);
 * 6. a factory can rent one more host (and the mode allows the pool) → `provision`;
 * 7. hosts exist but are full → `full` (`DEVICE_CAPACITY`); otherwise `not-ready`
 *    (`PLATFORM_NOT_READY` with the missing checks).
 *
 * Phase 2 (`decidePool`) adds scale-up ahead of demand, warm minimums, caps and the wait queue.
 */

import type { DeviceHostKind, DeviceHostStatus, DevicePlatform, DeviceReadinessCheck, DevicesSettings } from "@orquester/api";

/** A host as placement sees it. */
export interface PlacementHost {
  id: string;
  kind: DeviceHostKind;
  platforms: readonly DevicePlatform[];
  status: DeviceHostStatus;
  checks: readonly DeviceReadinessCheck[];
  used: number;
  total: number;
  /** Phase 2: draining hosts take no new lease. */
  draining?: boolean;
}

export type Placement =
  | { kind: "host"; hostId: string }
  | { kind: "wait"; hostId: string }
  | { kind: "setup"; hostId: string; actions: string[] }
  | { kind: "provision"; platform: DevicePlatform }
  | { kind: "full"; hostIds: string[] }
  | { kind: "not-ready"; hostId: string | null; missing: DeviceReadinessCheck[] }
  | { kind: "disabled" };

export interface PlacementInput {
  platform: DevicePlatform;
  hosts: readonly PlacementHost[];
  settings: DevicesSettings;
  /** A factory can rent one more host for the platform. */
  canProvision: boolean;
  /** Only this host (the panel's picker on an existing device). */
  hostId?: string;
}

function platformEnabled(settings: DevicesSettings, platform: DevicePlatform): boolean {
  return platform === "android" ? settings.android.enabled : settings.ios.enabled;
}

const hasRoom = (host: PlacementHost): boolean => host.status === "ready" && !host.draining && host.used < host.total;
const missingChecks = (host: PlacementHost): DeviceReadinessCheck[] => host.checks.filter((check) => check.state !== "ok");
const selfFixable = (host: PlacementHost): boolean => {
  const missing = missingChecks(host);
  return missing.length > 0 && missing.every((check) => check.fixActionId !== undefined && check.state !== "working");
};

export function choosePlacement(input: PlacementInput): Placement {
  const { platform, settings } = input;
  if (!platformEnabled(settings, platform)) return { kind: "disabled" };
  const mode = settings.pool.placement;
  let hosts = input.hosts.filter((host) => host.platforms.includes(platform));
  if (input.hostId !== undefined) hosts = hosts.filter((host) => host.id === input.hostId);
  else if (mode === "pool-only") hosts = hosts.filter((host) => host.kind !== "local");
  else if (mode === "local-only") hosts = hosts.filter((host) => host.kind === "local");

  const local = hosts.find((host) => host.kind === "local" && hasRoom(host));
  if (local) return { kind: "host", hostId: local.id };
  const fits = hosts
    .filter((host) => host.kind !== "local" && hasRoom(host))
    .sort((a, b) => a.total - a.used - (b.total - b.used) || a.id.localeCompare(b.id));
  if (fits[0]) return { kind: "host", hostId: fits[0].id };

  const coming = hosts.find((host) => host.status === "starting" || host.status === "installing");
  if (coming) return { kind: "wait", hostId: coming.id };
  const fixable = hosts.find((host) => host.status === "needs-setup" && selfFixable(host));
  if (fixable) return { kind: "setup", hostId: fixable.id, actions: missingChecks(fixable).map((check) => check.fixActionId!) };
  if (input.hostId === undefined && input.canProvision && mode !== "local-only") return { kind: "provision", platform };

  const full = hosts.filter((host) => host.status === "ready" && host.used >= host.total);
  if (full.length > 0) return { kind: "full", hostIds: full.map((host) => host.id) };
  const broken = hosts.find((host) => host.status !== "disabled") ?? hosts[0];
  return { kind: "not-ready", hostId: broken?.id ?? null, missing: broken ? missingChecks(broken) : [] };
}
