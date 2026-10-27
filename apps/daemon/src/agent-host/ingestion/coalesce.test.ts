import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ThreadActivityItem } from "@orquester/api/agent-chat";

import { projectSnapshotActivities } from "./coalesce.ts";

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
    const rows = projectSnapshotActivities([
      activity("update", "tool.updated", { data: { toolUseId: "n1" } }),
      activity("complete", "tool.completed", { data: { toolUseId: "n1" } })
    ]);
    assert.deepEqual(rows.map((row) => row.id), ["complete"]);
  });
});

describe("snapshot tool updates (§5.6)", () => {
  it("drops an update a LATER completion in the same turn supersedes", () => {
    const kept = projectSnapshotActivities([
      activity("u1", "tool.updated", { toolUseId: "c1" }),
      activity("d1", "tool.completed", { toolUseId: "c1" }),
      activity("u2", "tool.updated", { toolUseId: "c1" }),
      activity("d2", "tool.completed", { toolUseId: "c1" }),
      activity("u3", "tool.updated", { toolUseId: "c1" })
    ]);
    // u3 belongs to a later call reusing the id and is still in flight.
    assert.deepEqual(
      kept.map((row) => row.id),
      ["d1", "d2", "u3"]
    );
  });

  it("does not drop across turns", () => {
    const kept = projectSnapshotActivities([
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
      projectSnapshotActivities([update, completion]).map((row) => row.id),
      ["d1"]
    );
  });
});

describe("snapshot context usage (§5.6)", () => {
  it("keeps only the newest resolvable row per turn", () => {
    const kept = projectSnapshotActivities([
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
    const kept = projectSnapshotActivities([
      activity("c1", "context-window.updated", { usedTokens: 10 }),
      activity("c2", "context-window.updated", { usedTokens: "nope" })
    ]);
    assert.deepEqual(
      kept.map((row) => row.id),
      ["c1", "c2"]
    );
  });

});
