/**
 * A made-up fleet for the fleet view's tests and its dev harness (`apps/web/dev/devices-fleet`):
 * this host, rented Blacksmith Linux and macOS hosts in each state, a paired machine, leases on
 * them, and the chats that hold them. Times are relative to `now`.
 */

import {
  DEFAULT_DEVICES_SETTINGS,
  type DeviceActionEntry,
  type DeviceHostSummary,
  type DeviceLeaseSummary,
  type DevicePoolSummary,
  type DevicesSettings
} from "@orquester/api";

export const FIXTURE_NOW = Date.parse("2026-10-27T15:00:00.000Z");

const ago = (minutes: number, now = FIXTURE_NOW): string => new Date(now - minutes * 60_000).toISOString();

export function fixtureHost(over: Partial<DeviceHostSummary> = {}): DeviceHostSummary {
  return {
    id: "local",
    kind: "local",
    label: "This machine",
    platforms: ["android"],
    status: "ready",
    statusDetail: null,
    readiness: { ready: true, checks: [], checkedAt: null },
    capacity: { used: 0, total: 4 },
    ...over
  };
}

export function fixtureBoxHost(id: string, over: Partial<DeviceHostSummary> & { hourlyUsd?: number | null; startedMinutesAgo?: number } = {}, now = FIXTURE_NOW): DeviceHostSummary {
  const { hourlyUsd = 0.64, startedMinutesAgo = 60, ...rest } = over;
  return fixtureHost({
    id: `box:${id}`,
    kind: "box",
    label: id,
    box: { boxId: id, provider: "blacksmith", hourlyUsd, startedAt: ago(startedMinutesAgo, now), deadlineAt: new Date(now + 4 * 3_600_000).toISOString() },
    pool: { draining: false, warm: false, idleSince: null },
    ...rest
  });
}

export function fixtureLease(id: string, over: Partial<DeviceLeaseSummary> & { minutesAgo?: number } = {}, now = FIXTURE_NOW): DeviceLeaseSummary {
  const { minutesAgo = 10, ...rest } = over;
  const hostId = rest.hostId ?? "local";
  const platform = rest.platform ?? "android";
  return {
    id,
    key: `${hostId}/${id}`,
    threadId: "chat-1",
    hostId,
    deviceId: id,
    platform,
    profile: platform === "ios" ? "iphone-17-pro" : "pixel-9",
    name: platform === "ios" ? "iPhone 17 Pro" : "Pixel 9",
    osVersion: platform === "ios" ? "iOS 26" : "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    stream: { kind: platform === "ios" ? "serve-sim" : "serve-emu", deviceParam: id },
    createdAt: ago(minutesAgo, now),
    lastUsedAt: ago(1, now),
    ...rest
  };
}

export interface FleetFixture {
  hosts: DeviceHostSummary[];
  leases: DeviceLeaseSummary[];
  pool: DevicePoolSummary;
  settings: DevicesSettings;
  actions: Record<string, DeviceActionEntry[]>;
  sessions: { id: string; title: string; refId: string; kind: "agent-chat"; projectPath: string }[];
  agents: { id: string; name: string }[];
}

/** A busy fleet: every host kind and status the cards draw. */
export function fleetFixture(now = FIXTURE_NOW): FleetFixture {
  const hosts: DeviceHostSummary[] = [
    fixtureBoxHost("bs-mac-1", { label: "mac-pool-1", platforms: ["ios"], hourlyUsd: 1.92, startedMinutesAgo: 133, capacity: { used: 3, total: 8 }, pool: { draining: false, warm: true, idleSince: null } }, now),
    fixtureHost({ capacity: { used: 2, total: 4 } }),
    fixtureBoxHost("bs-linux-1", { label: "linux-pool-1", hourlyUsd: 0.64, startedMinutesAgo: 95, capacity: { used: 5, total: 6 } }, now),
    fixtureBoxHost("bs-linux-2", { label: "linux-pool-2", status: "starting", statusDetail: "Restoring the Android SDK cache…", hourlyUsd: 0.64, startedMinutesAgo: 2, capacity: { used: 0, total: 6 } }, now),
    fixtureBoxHost("bs-linux-3", { label: "linux-pool-3", hourlyUsd: 0.64, startedMinutesAgo: 240, capacity: { used: 1, total: 6 }, pool: { draining: true, warm: false, idleSince: null } }, now),
    fixtureBoxHost("bs-mac-2", { label: "mac-pool-2", platforms: ["ios"], status: "unreachable", statusDetail: null, hourlyUsd: 1.92, startedMinutesAgo: 61, capacity: { used: 1, total: 8 } }, now),
    fixtureHost({ id: "box:byo-1", kind: "byo", label: "Jasper's MacBook Pro", platforms: ["ios"], capacity: { used: 1, total: 4 }, box: { boxId: "byo-1", provider: "byo", hourlyUsd: 0, startedAt: ago(600, now), deadlineAt: null } })
  ];
  const leases: DeviceLeaseSummary[] = [
    fixtureLease("emulator-5554", { threadId: "chat-1", minutesAgo: 42 }, now),
    fixtureLease("emulator-5556", { threadId: "chat-2", profile: "pixel-tablet", name: "Pixel Tablet", controller: "user", openedBy: "user", minutesAgo: 18 }, now),
    fixtureLease("A1B2-ios-1", { hostId: "box:bs-mac-1", platform: "ios", threadId: "chat-3", minutesAgo: 75 }, now),
    fixtureLease("A1B2-ios-2", { hostId: "box:bs-mac-1", platform: "ios", threadId: "chat-4", profile: "ipad-pro-13", name: "iPad Pro 13-inch", osVersion: "iPadOS 26", minutesAgo: 30 }, now),
    fixtureLease("A1B2-ios-3", { hostId: "box:bs-mac-1", platform: "ios", threadId: "chat-5", state: "starting", deviceId: null, key: null, stream: undefined, progress: { step: "start-device", label: "Booting the simulator…", startedAt: ago(1, now) }, minutesAgo: 1 }, now),
    ...[0, 1, 2, 3, 4].map((n) =>
      fixtureLease(`emulator-56${n}0`, { hostId: "box:bs-linux-1", threadId: `chat-${6 + n}`, profile: n === 2 ? "pixel-fold" : "pixel-9", name: n === 2 ? "Pixel Fold" : "Pixel 9", minutesAgo: 80 - n * 11 }, now)
    ),
    fixtureLease("emulator-5700", { hostId: "box:bs-linux-3", threadId: "chat-11", minutesAgo: 200 }, now),
    fixtureLease("C3D4-ios-1", { hostId: "box:bs-mac-2", platform: "ios", threadId: "chat-12", state: "suspended", minutesAgo: 55 }, now),
    fixtureLease("E5F6-ios-1", { hostId: "box:byo-1", platform: "ios", threadId: "chat-2", name: "iPhone 17 Pro Max", profile: "iphone-17-pro-max", minutesAgo: 9 }, now),
    fixtureLease("emulator-5900", { hostId: "box:gone", threadId: "chat-13", state: "lost", error: "Its host is gone. Call open_device again.", minutesAgo: 120 }, now)
  ];
  const titles = [
    "Checkout flow regression",
    "Onboarding screenshots",
    "iOS deep links",
    "iPad split view layout",
    "Push permission prompt",
    "Smoke test: search",
    "Smoke test: cart",
    "Foldable hinge layout",
    "Dark mode audit",
    "Accessibility labels",
    "Long-running soak test",
    "Widget refresh",
    "Offline sync"
  ];
  const sessions = titles.map((title, index) => ({
    id: `chat-${index + 1}`,
    title,
    refId: index % 3 === 1 ? "codex" : "claude",
    kind: "agent-chat" as const,
    projectPath: "/w/acme/shop-app"
  }));
  const action = (leaseId: string, minutesAgo: number, summary: string, over: Partial<DeviceActionEntry> = {}): DeviceActionEntry => ({
    id: `${leaseId}-${minutesAgo}`,
    leaseId,
    at: ago(minutesAgo, now),
    actor: "agent",
    kind: "tap",
    summary,
    ok: true,
    ...over
  });
  const actions: Record<string, DeviceActionEntry[]> = {
    "emulator-5554": [action("emulator-5554", 3, "Opened com.acme.shop"), action("emulator-5554", 0.2, "Tapped @e7 “Add to cart”")],
    "emulator-5556": [action("emulator-5556", 1, "Swiped up", { actor: "user", kind: "swipe" })],
    "A1B2-ios-1": [action("A1B2-ios-1", 0.5, "Typed 12 characters", { kind: "type" })],
    "A1B2-ios-2": [action("A1B2-ios-2", 4, "Took a screenshot", { kind: "screenshot" })],
    "emulator-5610": [action("emulator-5610", 2, "Tap @e3 failed: not found", { ok: false, error: "not found" })]
  };
  const settings: DevicesSettings = {
    ...structuredClone(DEFAULT_DEVICES_SETTINGS),
    pool: { ...structuredClone(DEFAULT_DEVICES_SETTINGS.pool), placement: "prefer-local", maxHourlyUsd: 10, rentWithoutAsking: true }
  };
  return {
    hosts,
    leases,
    pool: { hosts: 6, capacity: { used: 11, total: 40 }, hourlyUsd: 7.68, queue: 3 },
    settings,
    actions,
    sessions,
    agents: [
      { id: "claude", name: "Claude Code" },
      { id: "codex", name: "Codex" }
    ]
  };
}
