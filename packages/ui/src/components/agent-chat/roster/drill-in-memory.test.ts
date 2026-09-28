/**
 * The drill-in's per-agent memory (§7.6, S12): re-opening an agent returns to
 * where the reader was — its disclosures, its reading position, its follow —
 * in memory only, never the thread's §7.2 LRU, bounded, and per thread.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_DRILL_IN_MEMORY,
  drillInOpening,
  recallDrillIn,
  rememberDrillIn,
  type DrillInMemoryEntry
} from "./drill-in-memory";

const entry = (overrides: Partial<DrillInMemoryEntry> = {}): DrillInMemoryEntry => ({
  disclosures: {
    expandedTurnIds: [],
    expandedGroupIds: ["group-1"],
    expandedAgentIds: [],
    expandedReasoningIds: [],
    toolOutputOffsets: {}
  },
  collapsedTurnIds: ["t1"],
  collapsedShellRowIds: [],
  position: { rowId: "row-9", offsetWithinRow: 12, scrollOffset: 640, atEnd: false },
  follow: false,
  ...overrides
});

describe("the drill-in's per-agent memory", () => {
  it("an agent never opened opens as today: at its end, following, nothing open", () => {
    const opened = drillInOpening(null);
    assert.equal(opened.position, null);
    assert.equal(opened.follow, true);
    assert.deepEqual(opened.disclosures.expandedGroupIds, []);
    assert.deepEqual(opened.collapsedTurnIds, []);
  });

  it("re-opening an agent restores its disclosures and a mid-list position, with follow OFF", () => {
    const memory = rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", entry());
    const opened = drillInOpening(recallDrillIn(memory, "a1"));
    assert.deepEqual(opened.disclosures.expandedGroupIds, ["group-1"]);
    assert.deepEqual(opened.collapsedTurnIds, ["t1"]);
    assert.equal(opened.position?.rowId, "row-9", "where the reader was");
    assert.equal(opened.follow, false, "follow on would re-pin the list to its end and defeat the restore");
  });

  it("a reader who re-armed follow (the pill, mod+J) comes back to the end, whatever position was published before", () => {
    // The re-pin's own scroll falls in the timeline's ignore window, so no at-end position is ever published
    // after it: the entry holds the reader's last mid-list position beside a follow that is armed again.
    const reArmed = entry({ follow: true });
    const opened = drillInOpening(reArmed);
    assert.equal(opened.position, null, "following means at the end: the stale mid-list position is not restored");
    assert.equal(opened.follow, true);
    assert.deepEqual(opened.disclosures.expandedGroupIds, ["group-1"], "its disclosures still come back");
  });

  it("an entry keeps the last roster row seen, so a reopened agent the roster evicted keeps its title and kind", () => {
    const seen = { id: "a1", kind: "subagent", agentKind: "background", title: "dev server", status: "running" } as never;
    const opened = drillInOpening(recallDrillIn(rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", entry({ agent: seen })), "a1"));
    assert.equal(opened.agent?.title, "dev server");
    assert.equal(opened.agent?.agentKind, "background");
    assert.equal(drillInOpening(null).agent, null, "none never seen");
  });

  it("A → B saves A's and restores B's, and each keeps its own", () => {
    let memory = rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a", entry({ collapsedTurnIds: ["ta"] }));
    memory = rememberDrillIn(memory, "b", entry({ collapsedTurnIds: ["tb"] }));
    assert.deepEqual(drillInOpening(recallDrillIn(memory, "a")).collapsedTurnIds, ["ta"]);
    assert.deepEqual(drillInOpening(recallDrillIn(memory, "b")).collapsedTurnIds, ["tb"]);
    assert.equal(recallDrillIn(memory, "c"), null);
  });

  it("keeps the 50 most recent agents: the least recently remembered goes first", () => {
    let memory = EMPTY_DRILL_IN_MEMORY;
    for (let index = 0; index < 50; index += 1) {
      memory = rememberDrillIn(memory, `agent-${index}`, entry());
    }
    // Touching the oldest makes it recent; the next agent pushes out the second oldest.
    memory = rememberDrillIn(memory, "agent-0", entry());
    memory = rememberDrillIn(memory, "agent-new", entry());
    assert.equal(memory.size, 50);
    assert.ok(recallDrillIn(memory, "agent-0"));
    assert.equal(recallDrillIn(memory, "agent-1"), null);
    assert.ok(recallDrillIn(memory, "agent-new"));
  });
});
