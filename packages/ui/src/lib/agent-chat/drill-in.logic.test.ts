import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  messageStreamingContext,
  NOTHING_STREAMS,
  type RuntimeSubagentStatus,
  type ThreadItem,
  type ThreadMessageItem,
  type ThreadSessionState,
  type Turn
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import { EMPTY_AGENT_DRILL_IN, projectAgentDrillIn, type AgentDrillInProjection } from "./drill-in.logic";
import { deriveTimelineEntriesFromItems, EMPTY_TIMELINE_PROJECTION } from "./entries.logic";
import { deriveTimelineRows, deriveTimelineRowsWithState, type TimelineRowsInput } from "./rows.logic";
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

const foldLabels = (rows: readonly AgentChatTimelineRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "turn-fold" ? [row.label] : []));

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

describe("a turn fold's timing: the parent's turn in the parent view, the agent's own rows in its drill-in", () => {
  /**
   * One thread: the parent's turn `t1` ran 9 s — its prompt, the call that
   * launched a background agent, its answer — and the agent's share of it: a
   * thought, then a call it started there, which ran on after the turn
   * settled and completed an hour later, stamped with the turn it started in.
   */
  const call = (status: string) => ({
    itemType: "command_execution",
    toolUseId: "call-1",
    title: "npm run build",
    command: "npm run build",
    status
  });
  const thread = {
    items: [
      message("user", "Build it in the background", { id: "u1", createdAt: stamp(1) }),
      activity(
        "tool.completed",
        { itemType: "command_execution", toolUseId: "call-p", command: "ls", status: "completed" },
        { id: "parent-call", turnId: "t1", createdAt: stamp(4) }
      ),
      message("reasoning", "Checking the build", { id: "think", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
      activity("tool.started", call("inProgress"), {
        id: "start",
        agentId: "a1",
        turnId: "t1",
        createdAt: stamp(3)
      }),
      message("assistant", "It is building.", {
        id: "answer",
        turnId: "t1",
        createdAt: stamp(9),
        updatedAt: stamp(10)
      }),
      activity("tool.completed", call("completed"), {
        id: "done",
        agentId: "a1",
        turnId: "t1",
        createdAt: stamp(3_600)
      })
    ] as ThreadItem[],
    turns: [
      {
        turnId: "t1",
        state: "completed",
        turnCount: null,
        requestedAt: stamp(1),
        startedAt: stamp(1),
        completedAt: stamp(10),
        assistantMessageId: null,
        userMessageId: "u1"
      }
    ] as Turn[]
  };

  it("the parent's fold is its settled turn's own 9 s; the agent's drill-in keeps its rows' span", () => {
    const parent = deriveTimelineRows({
      timelineEntries: deriveTimelineEntriesFromItems(thread.items, EMPTY_TIMELINE_PROJECTION).entries,
      latestTurn: null,
      runningTurnId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turns: thread.turns,
      supportsConversationRollback: false
    });
    assert.deepEqual(foldLabels(parent), ["Worked for 9.0s"]);
    // The drill-in is projected from the same thread view, its turns included — and times the agent's work by the
    // agent's own rows: its call ran for most of an hour, however soon the parent's turn settled.
    const drillIn = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      ...thread,
      agentId: "a1",
      messageStreaming: NOTHING_STREAMS
    });
    assert.deepEqual(foldLabels(drillIn.stable.result), ["Worked for 59m 58s"]);
  });
});

describe("a drill-in's 'Worked for …' follows a streaming thinking block", () => {
  /**
   * One thread. The parent's turn `t0` ran 5 s: its prompt, a call of its own, agent `a1`'s `ls` and
   * answer, the parent's answer. Its turn `t1` is running since 10 s: its prompt, then the agent's
   * build and a thought the agent is still writing — the last row of the agent's `t1` fold, which the
   * drill-in times by the agent's own rows (it passes no turns): from the build to the thought's last
   * write.
   */
  const command = (toolUseId: string, title: string) => ({
    itemType: "command_execution",
    toolUseId,
    title,
    command: title,
    status: "completed"
  });
  const before: ThreadItem[] = [
    message("user", "Look around", { id: "u0", createdAt: stamp(0) }),
    activity("tool.completed", command("call-p", "git status"), { id: "status", turnId: "t0", createdAt: stamp(1) }),
    activity("tool.completed", command("call-0", "ls"), { id: "ls", agentId: "a1", turnId: "t0", createdAt: stamp(2) }),
    message("assistant", "Listed the files.", { id: "listed", agentId: "a1", turnId: "t0", createdAt: stamp(4) }),
    message("assistant", "The agent listed them.", { id: "seen", turnId: "t0", createdAt: stamp(5) }),
    message("user", "Now build it", { id: "u1", createdAt: stamp(10) }),
    activity("tool.completed", command("call-1", "npm run build"), {
      id: "build",
      agentId: "a1",
      turnId: "t1",
      createdAt: stamp(11)
    })
  ];
  const thought = message("reasoning", "The build", {
    id: "think",
    agentId: "a1",
    turnId: "t1",
    streaming: true,
    createdAt: stamp(12)
  });
  /** The thought as a later frame has it: its text grown, its last write moved. */
  const written = (text: string, at: number, streaming = true): ThreadMessageItem => ({
    ...thought,
    text,
    streaming,
    updatedAt: stamp(at)
  });
  const items = (latest: ThreadMessageItem): ThreadItem[] => [...before, latest];
  // The parent's turn is running and the agent is at work: the thought reads as streaming.
  const working = messageStreamingContext({
    head: head({ session: { status: "running", activeTurnId: "t1" } }),
    roster: [{ id: "a1", status: "running" }]
  });
  const drill = (previous: AgentDrillInProjection, latest: ThreadMessageItem): AgentDrillInProjection =>
    projectAgentDrillIn(previous, { items: items(latest), agentId: "a1", messageStreaming: working });
  /** A row of the derivation itself — a rebuild makes every row a new object, the fast path keeps the untouched. */
  const derivedRow = (projection: AgentDrillInProjection, id: string): AgentChatTimelineRow => {
    const row = projection.rows?.rows.find((candidate) => candidate.id === id);
    assert.ok(row, `a row ${id}`);
    return row;
  };

  it("each token moves the label of the fold the thought ends, and consecutive tokens keep the fast path", () => {
    const first = drill(EMPTY_AGENT_DRILL_IN, thought);
    assert.deepEqual(foldLabels(first.stable.result), ["Worked for 2.0s", "Worked for 1.0s"]);

    const second = drill(first, written("The build passed", 17));
    assert.equal(
      derivedRow(second, "listed"),
      derivedRow(first, "listed"),
      "the streamed-text fast path took the token: a row it did not touch is the same object"
    );
    assert.deepEqual(foldLabels(second.stable.result), ["Worked for 2.0s", "Worked for 6.0s"]);

    const third = drill(second, written("The build passed; now the tests", 46));
    assert.equal(derivedRow(third, "listed"), derivedRow(second, "listed"), "and the next token too");
    assert.deepEqual(foldLabels(third.stable.result), ["Worked for 2.0s", "Worked for 35s"]);
  });

  it("once the thought settles, its fold closes on its final duration", () => {
    const streaming = drill(drill(EMPTY_AGENT_DRILL_IN, thought), written("The build passed", 17));
    const closed = drill(streaming, written("The build passed.", 53, false));
    assert.deepEqual(foldLabels(closed.stable.result), ["Worked for 2.0s", "Worked for 42s"]);
  });

  it("the parent's view is unchanged: the agent's tokens leave its rows as they were", () => {
    const noneExpanded = new Set<string>();
    const turns = [
      {
        turnId: "t0",
        state: "completed",
        turnCount: null,
        requestedAt: stamp(0),
        startedAt: stamp(0),
        completedAt: stamp(5),
        assistantMessageId: null,
        userMessageId: "u0"
      },
      {
        turnId: "t1",
        state: "running",
        turnCount: null,
        requestedAt: stamp(10),
        startedAt: stamp(10),
        completedAt: null,
        assistantMessageId: null,
        userMessageId: "u1"
      }
    ] as Turn[];
    // The window's input, as `store.ts` builds it while `t1` runs.
    const parentInput = (timelineEntries: TimelineRowsInput["timelineEntries"]): TimelineRowsInput => ({
      timelineEntries,
      latestTurn: { turnId: "t1", state: "running", startedAt: stamp(10), completedAt: null },
      runningTurnId: "t1",
      expandedTurnIds: noneExpanded,
      expandedWorkGroupIds: noneExpanded,
      isWorking: true,
      activeTurnStartedAt: stamp(10),
      turns,
      supportsConversationRollback: false,
      messageStreaming: working
    });
    const firstTimeline = deriveTimelineEntriesFromItems(items(thought), EMPTY_TIMELINE_PROJECTION);
    const first = deriveTimelineRowsWithState(parentInput(firstTimeline.entries));
    assert.deepEqual(
      foldLabels(first.rows),
      ["Worked for 5.0s"],
      "its settled turn reads its own duration, and its running one is not folded"
    );

    const nextTimeline = deriveTimelineEntriesFromItems(items(written("The build passed", 17)), firstTimeline);
    const next = deriveTimelineRowsWithState(parentInput(nextTimeline.entries), first);
    assert.equal(next.rows, first.rows, "the agent's words are not the parent's: none of its rows moves");
  });
});

describe("a drill-in holds its disclosure sets only while their members stay the same", () => {
  it("expanding one group in place of another re-derives the rows", () => {
    // Two activity groups, one per turn, each opened by a thought of the agent's.
    const items: ThreadItem[] = [
      message("reasoning", "Looking", { id: "th0", agentId: "a1", turnId: "t0", createdAt: stamp(1) }),
      activity(
        "tool.completed",
        { itemType: "command_execution", toolUseId: "call-0", title: "ls", command: "ls", status: "completed" },
        { id: "ls", agentId: "a1", turnId: "t0", createdAt: stamp(2) }
      ),
      message("reasoning", "Building", { id: "th1", agentId: "a1", turnId: "t1", createdAt: stamp(3) }),
      activity(
        "tool.completed",
        { itemType: "command_execution", toolUseId: "call-1", title: "make", command: "make", status: "completed" },
        { id: "make", agentId: "a1", turnId: "t1", createdAt: stamp(4) }
      )
    ];
    const expandedGroups = (projection: AgentDrillInProjection): string[] =>
      projection.stable.result.flatMap((row) => (row.kind === "activity-group" && row.expanded ? [row.groupId] : []));
    const project = (previous: AgentDrillInProjection, expandedGroupIds: string[]): AgentDrillInProjection =>
      projectAgentDrillIn(previous, {
        items,
        agentId: "a1",
        messageStreaming: NOTHING_STREAMS,
        disclosures: { expandedGroupIds, expandedTurnIds: [] }
      });

    const first = project(EMPTY_AGENT_DRILL_IN, ["activity-group:th0"]);
    assert.deepEqual(expandedGroups(first), ["activity-group:th0"]);
    const swapped = project(first, ["activity-group:th1"]);
    assert.deepEqual(expandedGroups(swapped), ["activity-group:th1"], "as many groups open, but another one");
  });
});
