import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TimelineItem } from "./run-view.ts";
import { followsNewRun, pickBlockId, pickRunId } from "./runs-mode.ts";

const step = (nodeId: string, status: TimelineItem["status"], extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({
    key: nodeId,
    kind: "step",
    nodeId,
    name: nodeId,
    type: "code",
    category: "code",
    isTrigger: false,
    depth: 0,
    step: 1,
    total: 3,
    status,
    view: { icon: "pending", tone: "neutral", label: status, live: status === "running" },
    notReached: false,
    attempt: status === "pending" ? 0 : 1,
    durationMs: null,
    hopCount: 0,
    hopsSummary: "",
    disabled: false,
    unreachable: false,
    pinned: false,
    ...extra
  }) as TimelineItem;

describe("runs mode", () => {
  it("shows the run asked for, else the newest live one, else the newest", () => {
    const runs = [
      { id: "r3", status: "succeeded" as const },
      { id: "r2", status: "running" as const },
      { id: "r1", status: "failed" as const }
    ];
    assert.equal(pickRunId("old", runs), "old", "an older run than the page holds");
    assert.equal(pickRunId(null, runs), "r2");
    assert.equal(pickRunId(null, [runs[0]!, runs[2]!]), "r3");
    assert.equal(pickRunId(undefined, []), null);
  });

  it("keeps the picked block while the run has it; else the run's own default", () => {
    const items = [step("t", "succeeded"), step("a", "failed"), step("b", "skipped")];
    assert.equal(pickBlockId(items, "b"), "b");
    assert.equal(pickBlockId(items, "gone"), "a", "the failed block");
    assert.equal(pickBlockId(items, null), "a");
    const live = [step("t", "succeeded"), step("a", "running")];
    assert.equal(pickBlockId(live, null), "a", "the live block");
    assert.equal(pickBlockId([], null), null);
  });

  it("a trigger's new run takes over only a view the user did not pick", () => {
    assert.equal(followsNewRun({ picked: null, newestBefore: "r1", newestNow: "r2" }), true);
    assert.equal(followsNewRun({ picked: "r1", newestBefore: "r1", newestNow: "r2" }), false);
    assert.equal(followsNewRun({ picked: null, newestBefore: "r2", newestNow: "r2" }), false);
  });
});
