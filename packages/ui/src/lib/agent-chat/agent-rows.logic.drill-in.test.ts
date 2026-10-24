/**
 * On-demand agent rows, end to end through the client's own derivations: a
 * drill-in of an agent the snapshot left out, once its `agent-rows` frame
 * landed, is the drill-in a full snapshot gives — for every agent of a fleet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentRowsFrameOf,
  foldThread,
  messageStreamingContext,
  omitOnDemandAgentRows,
  toThreadSnapshot,
  type AgentChatStreamFrame,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { EMPTY_AGENT_DRILL_IN, projectAgentDrillIn } from "./drill-in.logic";
import { applyFrame, createReducerState, type AgentChatReducerState } from "./reducer.logic";
import { agentFleetLog } from "./testing/agent-fleet";

function fleet() {
  const log = agentFleetLog();
  const fold = foldThread(log);
  const full = toThreadSnapshot(fold);
  return { log, fold, full, omitted: omitOnDemandAgentRows(full) };
}

const opened = (thread: ThreadSnapshotPayload): AgentChatReducerState =>
  [
    { kind: "snapshot", thread } as AgentChatStreamFrame,
    { kind: "synchronized", hostInstanceId: "host-1", streamId: "s-1" } as AgentChatStreamFrame
  ].reduce(applyFrame, createReducerState("s1"));

function drillIn(state: AgentChatReducerState, agentId: string) {
  const { slice } = state;
  return projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
    items: slice.entries,
    agentId,
    messageStreaming: messageStreamingContext(slice),
    agent: slice.roster.find((row) => row.id === agentId) ?? null
  }).stable.result;
}

describe("on-demand agent rows — the drill-in", () => {
  it("leaves out exactly the settled agents of the fleet", () => {
    const { full, omitted } = fleet();
    const status = Object.fromEntries(full.roster.map((row) => [row.id, row.status]));
    assert.equal(status.a5, "running");
    assert.equal(status.sh, "running");
    assert.deepEqual(omitted.omittedAgentIds, ["a1", "a2", "a3", "a4", "a6", "n1"]);
    assert.ok(omitted.items.length < full.items.length / 2, `${omitted.items.length} of ${full.items.length} rows`);
  });

  it("an omitted agent's drill-in, once its frame landed, is the full snapshot's — every agent of the fleet", () => {
    const { fold, full, omitted } = fleet();
    const whole = opened(full);
    const lazy = opened(omitted);
    assert.deepEqual(lazy.slice.omittedAgentIds, omitted.omittedAgentIds);
    const agents = [...new Set(full.items.flatMap((item) => (item.agentId !== undefined ? [item.agentId] : [])))];
    assert.ok(agents.length >= 8);
    for (const agentId of agents) {
      const frame = agentRowsFrameOf({ items: full.items, roster: fold.roster, seq: fold.seq, agentIds: [agentId] });
      const loaded = applyFrame(lazy, frame);
      assert.equal(loaded.slice.omittedAgentIds?.includes(agentId) ?? false, false, agentId);
      const rows = drillIn(whole, agentId);
      assert.ok(rows.length > 0, `${agentId} has a drill-in to compare`);
      assert.deepEqual(drillIn(loaded, agentId), rows, agentId);
      if (omitted.omittedAgentIds?.includes(agentId)) {
        assert.notDeepEqual(drillIn(lazy, agentId), rows, `${agentId}'s drill-in needed its frame`);
      }
    }
    // The pending approval's call stayed: its card joins it.
    assert.ok(lazy.slice.entries.some((item) => item.id === "a6-edit-start"));
    assert.equal(lazy.slice.pending.approvals[0]?.toolUseId, "a6-edit");
  });

  it("every agent loaded, one frame after another, gives back the full window, and nothing is omitted", () => {
    const { fold, full, omitted } = fleet();
    let state = opened(omitted);
    for (const agentId of omitted.omittedAgentIds ?? []) {
      state = applyFrame(state, agentRowsFrameOf({ items: full.items, roster: fold.roster, seq: fold.seq, agentIds: [agentId] }));
    }
    assert.equal(state.slice.omittedAgentIds, undefined);
    assert.deepEqual(state.slice.entries, full.items);
    assert.deepEqual(state.fold.items, full.items);
    // One frame for all of them gives the same.
    const batch = applyFrame(
      opened(omitted),
      agentRowsFrameOf({ items: full.items, roster: fold.roster, seq: fold.seq, agentIds: omitted.omittedAgentIds ?? [] })
    );
    assert.deepEqual(batch.slice.entries, full.items);
  });

  it("a frame older than the fold is dropped: its agents stay omitted, nothing rolls back", () => {
    const { fold, full, omitted } = fleet();
    const state = opened(omitted);
    const stale = agentRowsFrameOf({ items: full.items, roster: fold.roster, seq: fold.seq - 1, agentIds: ["a1"] });
    assert.equal(applyFrame(state, stale), state);
  });
});
