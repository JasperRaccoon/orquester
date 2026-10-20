/** Wire fixtures shared by the boxes tests (not a test file itself). */

import type {
  BoxConfigChangeSet,
  BoxKindAvailability,
  BoxOffersResponse,
  BoxProviderInfo,
  BoxSummary
} from "@orquester/api";

export function box(overrides: Partial<BoxSummary> = {}): BoxSummary {
  return {
    id: "b1",
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    providerLabel: "Hetzner",
    region: "fsn1",
    regionLabel: "Falkenstein",
    size: "cx22",
    sizeLabel: "CX22",
    image: null,
    os: "linux",
    arch: "x64",
    state: "ready",
    stateReason: null,
    destroyedReason: null,
    hourlyUsd: 0.0119,
    estimatedCostUsd: 0.42,
    createdAt: "2026-10-20T08:00:00.000Z",
    readyAt: "2026-10-20T08:04:00.000Z",
    deadlineAt: null,
    destroyedAt: null,
    connected: true,
    lastSeenAt: "2026-10-20T09:59:00.000Z",
    project: { workspace: "jaspersito", name: "JasperEngine", path: "/w/jaspersito/JasperEngine" },
    threadId: null,
    purposeNote: null,
    setup: [
      { id: "create", label: "Create the box", state: "done", startedAt: null, finishedAt: null, message: null },
      { id: "connect", label: "Connect", state: "done", startedAt: null, finishedAt: null, message: null }
    ],
    ...overrides
  };
}

export function provider(overrides: Partial<BoxProviderInfo> = {}): BoxProviderInfo {
  return {
    id: "hetzner",
    label: "Hetzner",
    kinds: ["linux"],
    website: "https://www.hetzner.com/",
    credentialsUrl: "https://console.hetzner.cloud/",
    credentialFields: [{ id: "token", label: "API token", secret: true }],
    status: "connected",
    error: null,
    keyHint: "a1b2",
    accountNote: "New accounts need an ID check.",
    maxLifetimeMinutes: null,
    ...overrides
  };
}

export function kind(overrides: Partial<BoxKindAvailability> = {}): BoxKindAvailability {
  return {
    kind: "linux",
    providers: ["hetzner", "vultr"],
    fromHourlyUsd: 0.0119,
    maxLifetimeMinutes: null,
    unavailableReason: null,
    ...overrides
  };
}

export function offers(overrides: Partial<BoxOffersResponse> = {}): BoxOffersResponse {
  return {
    provider: "hetzner",
    kind: "linux",
    sizes: [
      { id: "cx32", label: "CX32", vcpu: 4, ramGb: 8, diskGb: 80, gpu: null, hourlyUsd: 0.0119 * 2, regions: [] },
      { id: "cx22", label: "CX22", vcpu: 2, ramGb: 4, diskGb: 40, gpu: null, hourlyUsd: 0.0119, regions: ["fsn1", "nbg1"] },
      { id: "ccx13", label: "CCX13", vcpu: 2, ramGb: 8, diskGb: 80, gpu: null, hourlyUsd: 0.0238, regions: ["ash"] }
    ],
    regions: [
      { id: "fsn1", label: "Falkenstein", country: "DE" },
      { id: "nbg1", label: "Nuremberg", country: "DE" },
      { id: "ash", label: "Ashburn", country: "US" }
    ],
    images: [],
    priceSource: "live",
    fetchedAt: "2026-10-20T10:00:00.000Z",
    ...overrides
  };
}

export function change(overrides: Partial<BoxConfigChangeSet> = {}): BoxConfigChangeSet {
  return {
    id: "c1",
    boxId: "b1",
    threadId: "t1",
    createdAt: "2026-10-20T10:00:00.000Z",
    decidedAt: null,
    state: "pending",
    files: [
      { path: "/home/u/.claude/settings.json", change: "modified", executable: false, diff: "-a\n+b", truncated: false, binary: false }
    ],
    ...overrides
  };
}
