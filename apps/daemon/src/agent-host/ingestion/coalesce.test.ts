import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ThreadActivityItem } from "@orquester/api/agent-chat";

import {
  dropStaleContextWindowActivities,
  dropSupersededToolUpdatedActivities,
  projectSnapshotActivities,
  slimActivityEvent,
  stableToolCallId
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

describe("stable nested tool-call identity", () => {
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
    assert.deepEqual(
      dropSupersededToolUpdatedActivities([update, completion]).map((row) => row.id),
      ["d1"]
    );
  });
});

/**
 * The §5.6 cap is measured in **UTF-8 bytes**, not UTF-16 code units (R5 #16),
 * and the slimmer appends a one-character elision marker and never splits a
 * surrogate pair. So the invariant that holds for EVERY input is on
 * `byteLength`; a `.length` bound only happens to hold for ASCII.
 */
function assertCapped(value: string): void {
  const limit = 16384 + Buffer.byteLength("\u2026");
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
    const huge = "x".repeat(16384 + 1000);
    const [row] = projectSnapshotActivities([
      activity("d1", "tool.completed", { toolUseId: "c1", detail: huge })
    ]);
    assert.ok(row);
    const payload = row.payload as { detail: string; truncated?: boolean };
    assertCapped(payload.detail);
    assert.equal(payload.truncated, true, "'load full output' needs this flag");
  });

  it("slimActivityEvent slims an activity event and passes everything else through", () => {
    const huge = "x".repeat(16384 + 1000);
    const event = {
      type: "thread.activity-appended",
      payload: { activity: activity("d1", "tool.completed", { toolUseId: "c1", detail: huge }) }
    };
    const slimmed = slimActivityEvent(event);
    const payload = slimmed.payload.activity.payload as { detail: string };
    assertCapped(payload.detail);

    const other = { type: "thread.session-set", payload: { session: { status: "ready" } } };
    assert.deepEqual(slimActivityEvent(other), other);
    const small = {
      type: "thread.activity-appended",
      payload: { activity: activity("t1", "tool.started", { toolUseId: "c1" }) }
    };
    assert.deepEqual(slimActivityEvent(small), small);
  });

});

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

});
