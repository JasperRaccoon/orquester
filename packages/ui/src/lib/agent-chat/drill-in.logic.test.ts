import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  messageStreamingContext,
  type RuntimeSubagentStatus,
  type ThreadItem,
  type ThreadSessionState
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import { EMPTY_AGENT_DRILL_IN, projectAgentDrillIn } from "./drill-in.logic";
import { activity, head, message, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

type MessageRow = Extract<AgentChatTimelineRow, { kind: "message" }>;

/**
 * One subagent's share of a thread: a command it ran inside the parent's turn
 * `t1` and its answer there, then words it wrote after that turn ended, which
 * no turn carried. Both messages still say `streaming: true`: the answer's
 * host was killed before it closed it, and the turnless words predate the
 * ingestion that settles them.
 */
function agentItems(): ThreadItem[] {
  return [
    activity(
      "tool.started",
      { itemType: "command_execution", toolUseId: "call-1", title: "ls", command: "ls", status: "inProgress" },
      { id: "start", agentId: "a1", turnId: "t1", createdAt: stamp(1) }
    ),
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-1", title: "ls", command: "ls", status: "completed" },
      { id: "done", agentId: "a1", turnId: "t1", createdAt: stamp(2) }
    ),
    message("assistant", "Found the manifest", {
      id: "answer",
      agentId: "a1",
      turnId: "t1",
      streaming: true,
      createdAt: stamp(3)
    }),
    message("reasoning", "", { id: "words", agentId: "a1", turnId: null, streaming: true, createdAt: stamp(4) })
  ];
}

function drillIn(session: ThreadSessionState, agentStatus: RuntimeSubagentStatus): AgentChatTimelineRow[] {
  return projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
    items: agentItems(),
    agentId: "a1",
    messageStreaming: messageStreamingContext({
      head: head({ session }),
      roster: [{ id: "a1", status: agentStatus }]
    })
  }).stable.result;
}

function messageRow(rows: readonly AgentChatTimelineRow[], id: string): MessageRow {
  const row = rows.find((candidate): candidate is MessageRow => candidate.kind === "message" && candidate.id === id);
  assert.ok(row, `a message row ${id}: ${rows.map((candidate) => candidate.id).join(", ")}`);
  return row;
}

const turnFolds = (rows: readonly AgentChatTimelineRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "turn-fold" ? [row.turnId] : []));

describe("a drill-in's words read as streaming only while something can still write them", () => {
  it("an old log's stuck turnless agent message is no 'Thinking' shimmer, and its settled turn folds", () => {
    // The parent's turn is over and the agent completed: nothing writes either message any more.
    const rows = drillIn({ status: "ready", activeTurnId: null }, "completed");
    assert.equal(messageRow(rows, "words").streaming, undefined, "the turnless words read settled");
    assert.equal(messageRow(rows, "answer").streaming, undefined, "so does the answer its dead host left open");
    assert.deepEqual(turnFolds(rows), ["t1"], "and the answer no longer holds its turn's fold open");
    const fold = rows.find((row) => row.kind === "turn-fold");
    assert.equal(fold?.kind === "turn-fold" && fold.expanded, true, "a drill-in's folds start open");
  });

  it("a live one still streams", () => {
    // A background agent after its parent's turn: only the agent is at work.
    const background = drillIn({ status: "ready", activeTurnId: null }, "running");
    assert.equal(messageRow(background, "words").streaming, true, "the agent is still writing its words");
    assert.equal(messageRow(background, "answer").streaming, true);
    assert.deepEqual(turnFolds(background), [], "a streaming answer keeps its turn unfolded");

    // Inside the parent's running turn.
    const inTurn = drillIn({ status: "running", activeTurnId: "t1" }, "running");
    assert.equal(messageRow(inTurn, "answer").streaming, true);
    assert.equal(messageRow(inTurn, "words").streaming, true);
  });

  it("nothing streams once the session is gone, whatever the roster last said", () => {
    const rows = drillIn({ status: "stopped", activeTurnId: null }, "running");
    assert.equal(messageRow(rows, "words").streaming, undefined);
    assert.equal(messageRow(rows, "answer").streaming, undefined);
    assert.deepEqual(turnFolds(rows), ["t1"]);
  });

  it("re-derives when only the context moved: the agent settling settles its words", () => {
    const items = agentItems();
    const live = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items,
      agentId: "a1",
      messageStreaming: messageStreamingContext({
        head: head({ session: { status: "ready", activeTurnId: null } }),
        roster: [{ id: "a1", status: "running" }]
      })
    });
    assert.equal(messageRow(live.stable.result, "words").streaming, true);

    const settled = projectAgentDrillIn(live, {
      items,
      agentId: "a1",
      messageStreaming: messageStreamingContext({
        head: head({ session: { status: "ready", activeTurnId: null } }),
        roster: [{ id: "a1", status: "completed" }]
      })
    });
    assert.equal(messageRow(settled.stable.result, "words").streaming, undefined);
    assert.deepEqual(turnFolds(settled.stable.result), ["t1"]);
  });

  it("keeps the child's own rows only, and every unchanged row object across a re-derivation", () => {
    const context = messageStreamingContext({
      head: head({ session: { status: "ready", activeTurnId: null } }),
      roster: [{ id: "a1", status: "completed" }]
    });
    const items = [
      message("user", "the parent's prompt", { id: "prompt", createdAt: stamp(0) }),
      ...agentItems(),
      message("assistant", "the parent's answer", { id: "parent", turnId: "t1", createdAt: stamp(5) })
    ];
    const first = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, { items, agentId: "a1", messageStreaming: context });
    assert.ok(
      first.stable.result.every((row) => row.id !== "prompt" && row.id !== "parent"),
      "the parent's own rows are the parent's"
    );
    const again = projectAgentDrillIn(first, { items: [...items], agentId: "a1", messageStreaming: context });
    assert.equal(again.stable, first.stable, "nothing moved, so nothing re-renders");

    const other = projectAgentDrillIn(first, { items, agentId: "a2", messageStreaming: context });
    assert.equal(other.stable.result.length, 0, "another agent's view never reuses this one's rows");
  });
});
