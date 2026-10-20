import assert from "node:assert/strict";
import test from "node:test";

import type { StoredBox } from "@orquester/config";

import type { ProviderInstanceStatus, ProviderManagedInstance } from "../contracts.ts";
import { decideReconcile, ORPHAN_GRACE_MS, orphanKey, statusTargets, UNREACHABLE_AFTER_MS, type ReconcileInput } from "./reconciler.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function box(id: string, extra: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "small",
    name: `orq-${id}`,
    createdAt: "2026-10-20T10:00:00.000Z",
    state: "ready",
    providerRef: { id: `i-${id}` },
    ...extra
  };
}

function instance(boxId: string | null, extra: Partial<ProviderManagedInstance> = {}): ProviderManagedInstance {
  return { ref: { id: `i-${boxId}` }, name: boxId ? `orq-${boxId}` : "something-else", boxId, createdAt: null, state: "running", ...extra };
}

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  const records = overrides.records ?? [];
  return {
    now: NOW,
    records,
    knownIds: new Set(records.map((record) => record.id)),
    listings: new Map(),
    statuses: new Map(),
    connected: () => true,
    disconnectedSince: () => null,
    busy: () => false,
    firstSeen: new Map(),
    ...overrides
  };
}

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

test("an orphan is destroyed only after the grace period this process has seen it", () => {
  const orphan = instance(B);
  const first = decideReconcile(input({ listings: new Map([["hetzner", [orphan]]]) }));
  assert.deepEqual(first.actions, []);
  assert.equal(first.firstSeen.get(orphanKey("hetzner", orphan)), NOW);

  const later = decideReconcile(
    input({ now: NOW + ORPHAN_GRACE_MS, listings: new Map([["hetzner", [orphan]]]), firstSeen: first.firstSeen })
  );
  assert.deepEqual(later.actions, [{ kind: "destroy-orphan", provider: "hetzner", instance: orphan }]);
});

test("a destroyed record's leftover instance is an orphan; a live record's is not", () => {
  const records = [box(A, { state: "destroyed" }), box(B)];
  const listings = new Map([["hetzner", [instance(A), instance(B)]]]);
  const seen = new Map([[orphanKey("hetzner", instance(A)), NOW - ORPHAN_GRACE_MS]]);
  const { actions } = decideReconcile(input({ records, listings, firstSeen: seen }));
  assert.deepEqual(actions, [{ kind: "destroy-orphan", provider: "hetzner", instance: instance(A) }]);
});

test("instances without this build's box id, or of a record it cannot parse, are left alone", () => {
  const foreign = instance(null, { name: "orq-test-t2-123" });
  const newer = instance(B);
  const seen = new Map([
    [orphanKey("hetzner", foreign), NOW - ORPHAN_GRACE_MS * 2],
    [orphanKey("hetzner", newer), NOW - ORPHAN_GRACE_MS * 2]
  ]);
  const { actions } = decideReconcile(
    input({ knownIds: new Set([B]), listings: new Map([["hetzner", [foreign, newer]]]), firstSeen: seen })
  );
  assert.deepEqual(actions, []);
});

test("a live record whose instance is gone becomes destroyed; one the provider reports failed is destroyed", () => {
  const records = [box(A), box(B)];
  const base = input({ records, listings: new Map([["hetzner", []]]) });
  assert.deepEqual(
    statusTargets(base).map((record) => record.id),
    [A, B]
  );
  const statuses = new Map<string, ProviderInstanceStatus>([
    [A, { state: "gone", detail: "Deleted in the dashboard", publicIp: null, hourlyUsd: null }],
    [B, { state: "error", detail: "Host failure", publicIp: null, hourlyUsd: null }]
  ]);
  const { actions } = decideReconcile({ ...base, statuses });
  assert.deepEqual(actions, [
    { kind: "mark-gone", boxId: A, reason: "provider-gone", message: "Deleted in the dashboard" },
    { kind: "destroy", boxId: B, reason: "provider-error", message: "Host failure" }
  ]);
});

test("a box past its deadline is destroyed for its time limit", () => {
  const records = [box(A, { purpose: "temporary", deadlineAt: "2026-10-20T11:59:00.000Z" })];
  const { actions } = decideReconcile(input({ records, listings: new Map([["hetzner", [instance(A)]]]) }));
  assert.deepEqual(actions, [{ kind: "destroy", boxId: A, reason: "time-limit", message: null }]);
});

test("ready but disconnected for the window while running → unreachable; not before", () => {
  const records = [box(A)];
  const listings = new Map([["hetzner", [instance(A)]]]);
  const recent = decideReconcile(
    input({ records, listings, connected: () => false, disconnectedSince: () => NOW - UNREACHABLE_AFTER_MS + 1 })
  );
  assert.deepEqual(recent.actions, []);
  const long = decideReconcile(input({ records, listings, connected: () => false, disconnectedSince: () => NOW - UNREACHABLE_AFTER_MS }));
  assert.deepEqual(long.actions, [{ kind: "mark-unreachable", boxId: A }]);
});

test("crash leftovers: provisioning records resume or are torn down, destroying records resume their destroy", () => {
  const records = [
    // Project box whose create landed but whose ref was never written: resume with the found instance.
    box(A, { state: "provisioning", providerRef: undefined }),
    // Temporary box mid-setup: nobody waits for it, tear it down.
    box(B, { state: "provisioning", purpose: "temporary" }),
    // Never reached the provider.
    box("cccccccccccc", { state: "provisioning", providerRef: undefined }),
    box("dddddddddddd", { state: "destroying", pendingDestroyReason: "deleted" })
  ];
  const listings = new Map([["hetzner", [instance(A), instance(B), instance("dddddddddddd")]]]);
  const { actions } = decideReconcile(input({ records, listings }));
  assert.deepEqual(actions, [
    { kind: "resume", boxId: A, ref: { id: `i-${A}` } },
    { kind: "destroy", boxId: B, reason: "provisioning-failed", message: "Setup was interrupted by a restart." },
    {
      kind: "mark-gone",
      boxId: "cccccccccccc",
      reason: "provisioning-failed",
      message: "Setup was interrupted before the provider created the machine."
    },
    { kind: "destroy", boxId: "dddddddddddd", reason: "deleted", message: null }
  ]);
});

test("busy boxes and providers whose listing failed are not judged", () => {
  const records = [box(A, { state: "provisioning" }), box(B, { provider: "vultr" })];
  const { actions } = decideReconcile(
    input({ records, listings: new Map([["hetzner", []], ["vultr", null]]), busy: (id) => id === A })
  );
  assert.deepEqual(actions, []);
});
