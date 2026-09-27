/**
 * The drill-in's per-agent memory (§7.6, S12): re-opening an agent returns to
 * where the reader was — its disclosures, its reading position, its follow —
 * in memory only, never the thread's §7.2 LRU, bounded, and per thread.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRILL_IN_MEMORY_LIMIT,
  EMPTY_DRILL_IN_MEMORY,
  openDrillIn,
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
    const opened = openDrillIn(EMPTY_DRILL_IN_MEMORY, "a1");
    assert.equal(opened.position, null);
    assert.equal(opened.follow, true);
    assert.deepEqual(opened.disclosures.expandedGroupIds, []);
    assert.deepEqual(opened.collapsedTurnIds, []);
  });

  it("re-opening an agent restores its disclosures and a mid-list position, with follow OFF", () => {
    const memory = rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", entry());
    const opened = openDrillIn(memory, "a1");
    assert.deepEqual(opened.disclosures.expandedGroupIds, ["group-1"]);
    assert.deepEqual(opened.collapsedTurnIds, ["t1"]);
    assert.equal(opened.position?.rowId, "row-9", "where the reader was");
    assert.equal(opened.follow, false, "follow on would re-pin the list to its end and defeat the restore");
  });

  it("a reader who left at the end comes back to the end, following", () => {
    const atEnd = entry({ position: { rowId: "row-9", offsetWithinRow: 0, scrollOffset: 900, atEnd: true }, follow: true });
    const opened = openDrillIn(rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", atEnd), "a1");
    assert.equal(opened.position, null, "the content grew since: the end, not an old offset");
    assert.equal(opened.follow, true);
    assert.deepEqual(opened.disclosures.expandedGroupIds, ["group-1"], "its disclosures still come back");
  });

  it("a reader who re-armed follow (the pill, mod+J) comes back to the end, whatever position was published before", () => {
    // The re-pin's own scroll falls in the timeline's ignore window, so no at-end position is ever published
    // after it: the entry holds the reader's last mid-list position beside a follow that is armed again.
    const reArmed = entry({ follow: true });
    const opened = openDrillIn(rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", reArmed), "a1");
    assert.equal(opened.position, null, "following means at the end: the stale mid-list position is not restored");
    assert.equal(opened.follow, true);
    assert.deepEqual(opened.disclosures.expandedGroupIds, ["group-1"], "its disclosures still come back");
  });

  it("an entry keeps the last roster row seen, so a reopened agent the roster evicted keeps its title and kind", () => {
    const seen = { id: "a1", kind: "subagent", agentKind: "background", title: "dev server", status: "running" } as never;
    const opened = openDrillIn(rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", entry({ agent: seen })), "a1");
    assert.equal(opened.agent, seen);
    assert.equal(openDrillIn(EMPTY_DRILL_IN_MEMORY, "a1").agent, null, "none never seen");
    assert.equal(openDrillIn(rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a1", entry()), "a1").agent, null, "none remembered");
  });

  it("A → B saves A's and restores B's, and each keeps its own", () => {
    let memory = rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a", entry({ collapsedTurnIds: ["ta"] }));
    memory = rememberDrillIn(memory, "b", entry({ collapsedTurnIds: ["tb"] }));
    assert.deepEqual(openDrillIn(memory, "a").collapsedTurnIds, ["ta"]);
    assert.deepEqual(openDrillIn(memory, "b").collapsedTurnIds, ["tb"]);
    assert.equal(recallDrillIn(memory, "c"), null);
  });

  it(`keeps the ${DRILL_IN_MEMORY_LIMIT} most recent agents: the least recently remembered goes first`, () => {
    let memory = EMPTY_DRILL_IN_MEMORY;
    for (let index = 0; index < DRILL_IN_MEMORY_LIMIT; index += 1) {
      memory = rememberDrillIn(memory, `agent-${index}`, entry());
    }
    // Touching the oldest makes it recent; the next agent pushes out the second oldest.
    memory = rememberDrillIn(memory, "agent-0", entry());
    memory = rememberDrillIn(memory, "agent-new", entry());
    assert.equal(memory.size, DRILL_IN_MEMORY_LIMIT);
    assert.ok(recallDrillIn(memory, "agent-0"));
    assert.equal(recallDrillIn(memory, "agent-1"), null);
    assert.ok(recallDrillIn(memory, "agent-new"));
  });

  it("never mutates the memory it was given", () => {
    const before = rememberDrillIn(EMPTY_DRILL_IN_MEMORY, "a", entry());
    rememberDrillIn(before, "b", entry());
    assert.equal(before.size, 1);
    assert.equal(EMPTY_DRILL_IN_MEMORY.size, 0);
  });
});
