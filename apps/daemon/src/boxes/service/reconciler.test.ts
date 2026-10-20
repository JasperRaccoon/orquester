import assert from "node:assert/strict";
import test from "node:test";

import type { StoredBox } from "@orquester/config";

import type { ProviderInstanceStatus, ProviderManagedInstance } from "../contracts.ts";
import { instanceMarker } from "./lifecycle.ts";
import {
  decideReconcile,
  DESTROY_RETRY_MS,
  ORPHAN_GRACE_MS,
  orphanKey,
  PROVIDER_ERROR_GRACE_MS,
  statusTargets,
  UNREACHABLE_AFTER_MS,
  type ReconcileInput
} from "./reconciler.ts";

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
    installationId: INSTALL,
    orphanSweepPausedUntil: null,
    resumeAllowed: true,
    errorSince: new Map(),
    retries: new Map(),
    ...overrides
  };
}

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const INSTALL = "1a2b3c4d";
const OTHER_INSTALL = "99999999";

/** An instance of a box made since installation ids: `orq-<installation>-<box>`, the box id from a tag. */
function installed(boxId: string, installation = INSTALL, extra: Partial<ProviderManagedInstance> = {}): ProviderManagedInstance {
  return instance(boxId, { name: `orq-${installation}-${boxId}`, ...extra });
}

test("an orphan is destroyed only after the grace period this process has seen it", () => {
  const orphan = installed(B);
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

test("a live record whose instance is gone becomes destroyed; one the provider keeps reporting failed is destroyed", () => {
  const records = [box(A), box(B)];
  const base = input({ records, listings: new Map([["hetzner", []]]), connected: () => false });
  assert.deepEqual(
    statusTargets(base).map((record) => record.id),
    [A, B]
  );
  const statuses = new Map<string, ProviderInstanceStatus>([
    [A, { state: "gone", detail: "Deleted in the dashboard", publicIp: null, hourlyUsd: null }],
    [B, { state: "error", detail: "Host failure", publicIp: null, hourlyUsd: null }]
  ]);
  const first = decideReconcile({ ...base, statuses });
  assert.deepEqual(first.actions, [{ kind: "mark-gone", boxId: A, reason: "provider-gone", message: "Deleted in the dashboard" }]);
  assert.equal(first.errorSince.get(B), NOW);
  const later = decideReconcile({ ...base, records: [box(B)], now: NOW + PROVIDER_ERROR_GRACE_MS, statuses, errorSince: first.errorSince });
  assert.deepEqual(later.actions, [{ kind: "destroy", boxId: B, reason: "provider-error", message: "Host failure" }]);
});

test("one error reading never destroys a box, nor does any while orq-agent is connected", () => {
  const records = [box(A)];
  const failed = new Map([["hetzner", [instance(A, { state: "error" })]]]);
  const running = new Map([["hetzner", [instance(A)]]]);
  const first = decideReconcile(input({ records, listings: failed, connected: () => false }));
  assert.deepEqual(first.actions, []);
  // It reads running again: the error clock starts over.
  const recovered = decideReconcile(input({ records, now: NOW + 60_000, listings: running, errorSince: first.errorSince, connected: () => false }));
  assert.equal(recovered.errorSince.size, 0);
  const again = decideReconcile(
    input({ records, now: NOW + PROVIDER_ERROR_GRACE_MS, listings: failed, errorSince: recovered.errorSince, connected: () => false })
  );
  assert.deepEqual(again.actions, []);
  // Long in error, but its orq-agent is connected: it is alive, whatever the provider says.
  const connected = decideReconcile(
    input({ records, now: NOW + PROVIDER_ERROR_GRACE_MS, listings: failed, errorSince: first.errorSince, connected: () => true })
  );
  assert.deepEqual(connected.actions, []);
  // A listing that failed keeps the clock.
  const unlisted = decideReconcile(input({ records, listings: new Map([["hetzner", null]]), errorSince: first.errorSince }));
  assert.equal(unlisted.errorSince.get(A), NOW);
});

test("deadlines hold when the provider cannot be listed or is not connected", () => {
  const due = { purpose: "temporary", deadlineAt: "2026-10-20T11:59:00.000Z" } as const;
  const records = [box(A, due), box(B, { ...due, provider: "vultr" }), box("cccccccccccc", { ...due, state: "provisioning" })];
  const { actions } = decideReconcile(input({ records, listings: new Map([["hetzner", null]]) }));
  assert.deepEqual(actions, [
    { kind: "destroy", boxId: A, reason: "time-limit", message: null },
    { kind: "destroy", boxId: B, reason: "time-limit", message: null },
    { kind: "destroy", boxId: "cccccccccccc", reason: "time-limit", message: null }
  ]);
});

test("a failed destroy is retried with a growing backoff, also when the listing fails", () => {
  const failed = box(A, { state: "destroy-failed", pendingDestroyReason: "agent" });
  const listings = new Map([["hetzner", null]]);
  const first = decideReconcile(input({ records: [failed], listings }));
  assert.deepEqual(first.actions, [], "the destroy that failed just ran");
  assert.deepEqual(first.retries.get(A), { attempt: 0, at: NOW + DESTROY_RETRY_MS[0]! });
  const early = decideReconcile(input({ records: [failed], listings, now: NOW + DESTROY_RETRY_MS[0]! - 1, retries: first.retries }));
  assert.deepEqual(early.actions, []);
  const due = NOW + DESTROY_RETRY_MS[0]!;
  const retried = decideReconcile(input({ records: [failed], listings, now: due, retries: early.retries }));
  assert.deepEqual(retried.actions, [{ kind: "destroy", boxId: A, reason: "agent", message: null }]);
  assert.deepEqual(retried.retries.get(A), { attempt: 1, at: due + DESTROY_RETRY_MS[1]! });
  // While the retry runs (busy, `destroying`) its backoff carries over to the next failure.
  const running = decideReconcile(input({ records: [{ ...failed, state: "destroying" }], listings, busy: () => true, retries: retried.retries }));
  assert.deepEqual(running.retries.get(A), retried.retries.get(A));
  // Gone at the provider: the record is closed instead.
  const gone = decideReconcile(
    input({
      records: [failed],
      listings: new Map([["hetzner", []]]),
      statuses: new Map([[A, { state: "gone", detail: null, publicIp: null, hourlyUsd: null }]]),
      retries: retried.retries
    })
  );
  assert.deepEqual(gone.actions, [{ kind: "mark-gone", boxId: A, reason: "agent", message: null }]);
});

test("a destroying record resumes its destroy even when the listing fails", () => {
  const { actions } = decideReconcile(
    input({ records: [box(A, { state: "destroying", pendingDestroyReason: "chat-closed" })], listings: new Map([["hetzner", null]]) })
  );
  assert.deepEqual(actions, [{ kind: "destroy", boxId: A, reason: "chat-closed", message: null }]);
});

test("with the plugin off, interrupted project setups are not resumed", () => {
  const records = [box(A, { state: "provisioning" })];
  const { actions } = decideReconcile(input({ records, listings: new Map([["hetzner", [instance(A)]]]), resumeAllowed: false }));
  assert.deepEqual(actions, []);
});

test("only this installation's boxes are swept: another appdir's, and older unrecorded ones, are left alone", () => {
  const C = "cccccccccccc";
  const D = "dddddddddddd";
  const ours = installed(A);
  const theirs = installed(B, OTHER_INSTALL);
  // Made before installation ids: one has a (destroyed) record here, one has none.
  const legacyRecorded = instance(C);
  const legacyUnknown = instance(D);
  const all = [ours, theirs, legacyRecorded, legacyUnknown];
  const seen = new Map(all.map((candidate) => [orphanKey("hetzner", candidate), NOW - ORPHAN_GRACE_MS]));
  const { actions } = decideReconcile(
    input({ records: [box(C, { state: "destroyed" })], listings: new Map([["hetzner", all]]), firstSeen: seen })
  );
  assert.deepEqual(actions, [
    { kind: "destroy-orphan", provider: "hetzner", instance: ours },
    { kind: "destroy-orphan", provider: "hetzner", instance: legacyRecorded }
  ]);
  // Another installation's instance never matches this installation's record either.
  const lookalike = decideReconcile(
    input({ records: [box(B, { name: `orq-${INSTALL}-${B}` })], listings: new Map([["hetzner", [theirs]]]), connected: () => false })
  );
  assert.deepEqual(statusTargets(input({ records: [box(B)], listings: new Map([["hetzner", [theirs]]]) })).map((record) => record.id), [B]);
  assert.deepEqual(lookalike.actions, []);
});

test("instance markers: tag or name box ids, the installation from the name", () => {
  // Tag providers report the tag's box id; name-only providers the name's `<installation>-<box>`.
  assert.deepEqual(instanceMarker({ name: `orq-${INSTALL}-${A}`, boxId: A }), { boxId: A, installationId: INSTALL });
  assert.deepEqual(instanceMarker({ name: `orq-${INSTALL}-${A}`, boxId: `${INSTALL}-${A}` }), { boxId: A, installationId: INSTALL });
  assert.deepEqual(instanceMarker({ name: `orq-${A}`, boxId: A }), { boxId: A, installationId: null });
  assert.deepEqual(instanceMarker({ name: "renamed-by-hand", boxId: A }), { boxId: A, installationId: null });
  assert.equal(instanceMarker({ name: "orq-test-t2-123", boxId: null }), null);
  assert.equal(instanceMarker({ name: `orq-${A}`, boxId: "box-0123abcd" }), null);
});

test("while the orphan sweep is paused, unrecorded boxes are kept; recorded leftovers still go", () => {
  const unrecorded = installed(A);
  const leftover = installed(B);
  const seen = new Map([unrecorded, leftover].map((candidate) => [orphanKey("hetzner", candidate), NOW - ORPHAN_GRACE_MS]));
  const listings = new Map([["hetzner", [unrecorded, leftover]]]);
  const records = [box(B, { state: "destroyed" })];
  const paused = decideReconcile(input({ records, listings, firstSeen: seen, orphanSweepPausedUntil: NOW + 1 }));
  assert.deepEqual(paused.actions, [{ kind: "destroy-orphan", provider: "hetzner", instance: leftover }]);
  assert.deepEqual(paused.kept, [{ provider: "hetzner", instance: unrecorded }]);
  const after = decideReconcile(input({ records, listings, firstSeen: seen, orphanSweepPausedUntil: NOW }));
  assert.equal(after.actions.length, 2);
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
