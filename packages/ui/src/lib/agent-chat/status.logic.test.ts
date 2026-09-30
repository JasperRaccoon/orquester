import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
isCompactingThread,
latestContextWindowActivity
} from "./status.logic";
import { activity,resetBuilders,stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("context window", () => {
  it("reads the newest context-window activity and skips malformed ones", () => {
    const found = latestContextWindowActivity([
      activity("context-window.updated", { usedTokens: 10, maxTokens: 100 }, { createdAt: stamp(1) }),
      activity("context-window.updated", { usedTokens: "nope" }, { createdAt: stamp(2) })
    ]);
    assert.equal(found?.usage.usedTokens, 10);
    assert.equal(latestContextWindowActivity([]), null);
  });
});

// ---------------------------------------------------------------------------
// The compaction phase
// ---------------------------------------------------------------------------

describe("the compaction phase", () => {
  const compacting = () =>
    activity("context-compaction", { state: "compacting" }, {
      tone: "info",
      summary: "Compacting context",
      createdAt: stamp(1)
    });

  const live = { sessionStatus: "running" as const, turnStatus: "running" as const };

  it("ends on `compacted`", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compacted", beforeTokens: 800, afterTokens: 11 }, {
            summary: "Context compacted",
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      false
    );
  });

  it("ends on `compaction-failed`", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compaction-failed", error: "quota" }, {
            tone: "error",
            summary: "Context compaction failed",
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      false
    );
  });

  it("ends when the turn settles even though no terminal marker ever arrived", () => {
    // The host may abandon a compaction after a deadline; a phase that only a
    // marker could end would then shimmer forever.
    assert.equal(
      isCompactingThread({ activities: [compacting()], sessionStatus: "running", turnStatus: "completed" }),
      false
    );
  });

  it("ends when the session is no longer live", () => {
    for (const sessionStatus of ["ready", "stopped", "error"] as const) {
      assert.equal(
        isCompactingThread({ activities: [compacting()], sessionStatus, turnStatus: "running" }),
        false,
        sessionStatus
      );
    }
    assert.equal(
      isCompactingThread({ activities: [compacting()], sessionStatus: "starting", turnStatus: null }),
      true,
      "a starting session is still live"
    );
  });

  it("is off for an old log, which only ever recorded the settled marker", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          activity("thread.state.changed", { state: "compacted", beforeTokens: 800, afterTokens: 11 }, {
            summary: "Compacted",
            createdAt: stamp(1)
          })
        ],
        ...live
      }),
      false
    );
    assert.equal(isCompactingThread({ activities: [], ...live }), false);
  });

  it("reads the LATEST marker, so a second compaction re-enters the phase", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compacted" }, { createdAt: stamp(2) }),
          activity("context-compaction", { state: "compacting" }, { createdAt: stamp(3) })
        ],
        ...live
      }),
      true
    );
  });

  it("ignores everything that is not a compaction marker", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("tool.completed", { itemType: "command_execution", command: "ls" }, {
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      true
    );
  });
});
