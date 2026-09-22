import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLIM_MAX_STRING_BYTES, type ThreadActivityItem } from "@orquester/api/agent-chat";

import {
  coalesceToolUpdates,
  dropStaleContextWindowActivities,
  dropSupersededToolUpdatedActivities,
  projectSnapshotActivities,
  slimActivityEvent,
  stableToolCallId,
  toolLifecycleIdentity
} from "./coalesce.ts";

function activity(
  id: string,
  activityKind: string,
  payload: Record<string, unknown>,
  turnId: string | null = "turn-1"
): ThreadActivityItem {
  return {
    kind: "activity",
    id,
    tone: "tool",
    activityKind,
    summary: id,
    payload,
    turnId,
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z"
  };
}

describe("coalesceToolUpdates (§5.6, 50 ms window)", () => {
  it("keeps only the latest update per stable id, in arrival order", () => {
    const kept = coalesceToolUpdates([
      activity("a1", "tool.updated", { toolUseId: "c1" }),
      activity("b1", "tool.updated", { toolUseId: "c2" }),
      activity("a2", "tool.updated", { toolUseId: "c1" })
    ]);
    assert.deepEqual(
      kept.map((row) => row.id),
      ["b1", "a2"]
    );
  });

  it("matches per turn, because a revert discards whole turns", () => {
    const kept = coalesceToolUpdates([
      activity("a1", "tool.updated", { toolUseId: "c1" }, "turn-1"),
      activity("a2", "tool.updated", { toolUseId: "c1" }, "turn-2")
    ]);
    assert.equal(kept.length, 2);
  });

  it("a call with no stable id passes through unchanged", () => {
    const kept = coalesceToolUpdates([
      activity("a1", "tool.updated", { title: "Read" }),
      activity("a2", "tool.updated", { title: "Read" })
    ]);
    assert.equal(kept.length, 2);
  });

  it("reads a nested data.toolUseId too", () => {
    assert.equal(stableToolCallId(activity("a", "tool.updated", { data: { toolUseId: "n1" } })), "n1");
    assert.equal(stableToolCallId(activity("a", "tool.updated", { toolUseId: "   " })), null);
  });
});

describe("dropSupersededToolUpdatedActivities (§5.6 snapshot drop)", () => {
  it("drops an update a LATER completion in the same turn supersedes", () => {
    const kept = dropSupersededToolUpdatedActivities([
      activity("u1", "tool.updated", { toolUseId: "c1" }),
      activity("d1", "tool.completed", { toolUseId: "c1" }),
      activity("u2", "tool.updated", { toolUseId: "c1" })
    ]);
    // u2 belongs to a later call reusing the id and is still in flight.
    assert.deepEqual(
      kept.map((row) => row.id),
      ["d1", "u2"]
    );
  });

  it("does not drop across turns", () => {
    const kept = dropSupersededToolUpdatedActivities([
      activity("u1", "tool.updated", { toolUseId: "c1" }, "turn-1"),
      activity("d1", "tool.completed", { toolUseId: "c1" }, "turn-2")
    ]);
    assert.equal(kept.length, 2);
  });

  it("falls back to the itemType/label/detail triple, normalising a trailing 'complete'", () => {
    const update = activity("u1", "tool.updated", {
      itemType: "command_execution",
      title: "Run tests",
      detail: "pnpm test"
    });
    const completion = activity("d1", "tool.completed", {
      itemType: "command_execution",
      title: "Run tests completed",
      detail: "pnpm test"
    });
    assert.equal(toolLifecycleIdentity(update), toolLifecycleIdentity(completion));
    assert.deepEqual(
      dropSupersededToolUpdatedActivities([update, completion]).map((row) => row.id),
      ["d1"]
    );
  });

  it("rows with no identity pass through", () => {
    const rows = [
      activity("u1", "tool.updated", {}),
      activity("d1", "tool.completed", {})
    ];
    assert.equal(dropSupersededToolUpdatedActivities(rows).length, 2);
  });
});

/**
 * The §5.6 cap is measured in **UTF-8 bytes**, not UTF-16 code units (R5 #16),
 * and the slimmer appends a one-character elision marker and never splits a
 * surrogate pair. So the invariant that holds for EVERY input is on
 * `byteLength`; a `.length` bound only happens to hold for ASCII.
 */
function assertCapped(value: string): void {
  const limit = SLIM_MAX_STRING_BYTES + Buffer.byteLength("\u2026");
  assert.ok(
    Buffer.byteLength(value) <= limit,
    `capped string was ${Buffer.byteLength(value)} bytes, limit ${limit}`
  );
  assert.ok(
    value.endsWith("\u2026"),
    "the elision marker is what the UI renders as truncated"
  );
  // A split surrogate pair would make the string unencodable downstream.
  assert.equal(value, Buffer.from(value, "utf8").toString("utf8"));
}

describe("the §5.6 read projection is the single choke point (R5 #1)", () => {
  it("slims a row on its way out, and stamps truncated", () => {
    const huge = "x".repeat(SLIM_MAX_STRING_BYTES + 1000);
    const [row] = projectSnapshotActivities([
      activity("d1", "tool.completed", { toolUseId: "c1", detail: huge })
    ]);
    assert.ok(row);
    const payload = row.payload as { detail: string; truncated?: boolean };
    assertCapped(payload.detail);
    assert.equal(payload.truncated, true, "'load full output' needs this flag");
  });

  it("caps by BYTES, not code units, for multi-byte and astral text", () => {
    // 4 UTF-8 bytes per emoji (a surrogate PAIR, so 2 code units): 8 000 of
    // them are 32 KB on the wire but only 16 000 code units, which a
    // `.length` check would wave straight through a 16 KB cap.
    const [emojiRow] = projectSnapshotActivities([
      activity("d1", "tool.completed", {
        toolUseId: "c1",
        detail: "\u{1F600}".repeat(8000)
      })
    ]);
    assertCapped((emojiRow!.payload as { detail: string }).detail);

    // 3 bytes per CJK character — the ~4x overshoot R5 #16 measured.
    const [cjkRow] = projectSnapshotActivities([
      activity("d2", "tool.completed", {
        toolUseId: "c2",
        detail: "\u6f22".repeat(SLIM_MAX_STRING_BYTES)
      })
    ]);
    assertCapped((cjkRow!.payload as { detail: string }).detail);
  });

  it("returns a small row by REFERENCE, so the client's memoisation holds", () => {
    const rows = [activity("t1", "tool.started", { toolUseId: "c1" })];
    const [projected] = projectSnapshotActivities(rows);
    assert.equal(projected, rows[0]);
  });

  it("slimActivityEvent slims an activity event and passes everything else through", () => {
    const huge = "x".repeat(SLIM_MAX_STRING_BYTES + 1000);
    const event = {
      type: "thread.activity-appended",
      payload: { activity: activity("d1", "tool.completed", { toolUseId: "c1", detail: huge }) }
    };
    const slimmed = slimActivityEvent(event);
    assert.notEqual(slimmed, event);
    const payload = slimmed.payload.activity.payload as { detail: string };
    assertCapped(payload.detail);

    const other = { type: "thread.session-set", payload: { session: { status: "ready" } } };
    assert.equal(slimActivityEvent(other), other);
    const small = {
      type: "thread.activity-appended",
      payload: { activity: activity("t1", "tool.started", { toolUseId: "c1" }) }
    };
    assert.equal(slimActivityEvent(small), small);
  });

  it("the drops still run, and run BEFORE slimming", () => {
    const kept = projectSnapshotActivities([
      activity("u1", "tool.updated", { toolUseId: "c1" }),
      activity("d1", "tool.completed", { toolUseId: "c1" }),
      activity("c1", "context-window.updated", { usedTokens: 10 }),
      activity("c2", "context-window.updated", { usedTokens: 20 })
    ]);
    assert.deepEqual(
      kept.map((row) => row.id),
      ["d1", "c2"]
    );
  });

  it("a slimmer that throws costs the row its size, never its existence", () => {
    // `slimActivityPayload` is W2's; ingestion must degrade, not drop.
    const rows = [activity("d1", "tool.completed", { toolUseId: "c1", data: cyclic() })];
    const kept = projectSnapshotActivities(rows);
    assert.equal(kept.length, 1);
  });
});

function cyclic(): unknown {
  const node: Record<string, unknown> = {};
  node.self = node;
  return node;
}

describe("dropStaleContextWindowActivities (§5.6 snapshot drop)", () => {
  it("keeps only the newest resolvable row per turn", () => {
    const kept = dropStaleContextWindowActivities([
      activity("c1", "context-window.updated", { usedTokens: 10 }, "turn-1"),
      activity("c2", "context-window.updated", { usedTokens: 20 }, "turn-1"),
      activity("c3", "context-window.updated", { usedTokens: 30 }, "turn-2"),
      activity("t1", "tool.started", {}, "turn-1")
    ]);
    assert.deepEqual(
      kept.map((row) => row.id),
      ["c2", "c3", "t1"]
    );
  });

  it("a malformed row passes through and never shadows a valid earlier one", () => {
    const kept = dropStaleContextWindowActivities([
      activity("c1", "context-window.updated", { usedTokens: 10 }),
      activity("c2", "context-window.updated", { usedTokens: "nope" })
    ]);
    assert.deepEqual(
      kept.map((row) => row.id),
      ["c1", "c2"]
    );
  });

  it("returns the same array when there is nothing to drop", () => {
    const rows = [activity("t1", "tool.started", {})];
    assert.equal(dropStaleContextWindowActivities(rows), rows);
  });
});
