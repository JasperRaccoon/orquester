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
import {
  collapsedTurnsAfter,
  EMPTY_AGENT_DRILL_IN,
  projectAgentDrillIn,
  type AgentDrillInProjection
} from "./drill-in.logic";
import { deriveTimelineEntriesFromItems, EMPTY_TIMELINE_PROJECTION } from "./entries.logic";
import {
  deriveTimelineRows,
  deriveTimelineRowsWithState,
  type TimelineRowsInput,
  type TimelineRowsProjection
} from "./rows.logic";
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
  // The roster already reads the agent idle — its run is over, so its rows
  // fold — while the parent's running turn still carries a thought it writes:
  // the thought streams by its turn (`isMessageStreaming`), and the fold it
  // ends is the one a token can move. A LIVE agent's run never folds (below).
  const writingAfterItsRun = messageStreamingContext({
    head: head({ session: { status: "running", activeTurnId: "t1" } }),
    roster: [{ id: "a1", status: "idle" }]
  });
  const drill = (previous: AgentDrillInProjection, latest: ThreadMessageItem): AgentDrillInProjection =>
    projectAgentDrillIn(previous, { items: items(latest), agentId: "a1", messageStreaming: writingAfterItsRun });
  /** A row of the derivation itself — a rebuild makes every row a new object, the fast path keeps the untouched. */
  const derivedRow = (projection: AgentDrillInProjection, id: string): AgentChatTimelineRow => {
    const row = projection.rows?.rows.find((candidate) => candidate.id === id);
    assert.ok(row, `a row ${id}`);
    return row;
  };
  const noneExpanded = new Set<string>();
  const parentTurns = [
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
  /** The window's input, as `store.ts` builds it while `t1` runs. */
  const parentInput = (timelineEntries: TimelineRowsInput["timelineEntries"]): TimelineRowsInput => ({
    timelineEntries,
    latestTurn: { turnId: "t1", state: "running", startedAt: stamp(10), completedAt: null },
    runningTurnId: "t1",
    expandedTurnIds: noneExpanded,
    expandedWorkGroupIds: noneExpanded,
    isWorking: true,
    activeTurnStartedAt: stamp(10),
    turns: parentTurns,
    supportsConversationRollback: false,
    messageStreaming: working
  });

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

  it("a LIVE agent writing the same thought folds nothing of its run: it is the running response", () => {
    // No launch row and no roster start here: the whole of the agent's rows is its current run.
    const live = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: items(thought),
      agentId: "a1",
      messageStreaming: working
    });
    assert.deepEqual(foldLabels(live.stable.result), [], "unfolded, as the thread's running turn is");
    const group = live.stable.result.find((row) => row.kind === "activity-group");
    assert.equal(group?.kind === "activity-group" && group.active, true, "and its thought is the live group");
  });

  it("the parent's view is unchanged: the agent's tokens leave its rows as they were", () => {
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

  it("a thought of the parent's own streams in its running turn: no fold there, no clock, and its tokens relabel nothing", () => {
    // The running turn is the session's active one, so it is unfolded; the settled one is timed by its turn row.
    const own = message("reasoning", "Waiting on the build", {
      id: "wait",
      turnId: "t1",
      streaming: true,
      createdAt: stamp(13)
    });
    const firstTimeline = deriveTimelineEntriesFromItems([...items(thought), own], EMPTY_TIMELINE_PROJECTION);
    const first = deriveTimelineRowsWithState(parentInput(firstTimeline.entries));
    assert.deepEqual(foldLabels(first.rows), ["Worked for 5.0s"]);
    assert.equal(first.foldClocks.size, 0, "each fold here is timed by its turn: none has a clock");

    const grown = { ...own, text: "Waiting on the build; it passed", updatedAt: stamp(30) };
    const nextTimeline = deriveTimelineEntriesFromItems([...items(thought), grown], firstTimeline);
    const next = deriveTimelineRowsWithState(parentInput(nextTimeline.entries), first);
    const rowOf = (projection: TimelineRowsProjection, id: string) => projection.rows.find((row) => row.id === id);
    assert.ok(rowOf(first, "u0") !== undefined && rowOf(first, "turn-fold:t0") !== undefined);
    assert.equal(
      rowOf(next, "u0"),
      rowOf(first, "u0"),
      "the fast path took the token: a row it did not touch is the same object"
    );
    assert.equal(rowOf(next, "turn-fold:t0"), rowOf(first, "turn-fold:t0"), "and no fold row was relabelled");
    assert.deepEqual(foldLabels(next.rows), ["Worked for 5.0s"], "its running turn is still not folded");
  });
});

describe("a live agent reads live (§7.6): its current run is the running response", () => {
  /** The thread's context with `a1` at work (or `status`), the parent idle between its turns. */
  const contextWith = (status: RuntimeSubagentStatus, session: ThreadSessionState = { status: "ready", activeTurnId: null }) =>
    messageStreamingContext({ head: head({ session }), roster: [{ id: "a1", status }] });
  const command = (toolUseId: string, title: string, status: "inProgress" | "completed") => ({
    itemType: "command_execution",
    toolUseId,
    title,
    command: title,
    status
  });
  const project = (
    items: ThreadItem[],
    status: RuntimeSubagentStatus,
    startedAt: string | null = stamp(1)
  ): AgentChatTimelineRow[] =>
    projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items,
      agentId: "a1",
      messageStreaming: contextWith(status),
      agent: { startedAt }
    }).stable.result;
  const kinds = (rows: readonly AgentChatTimelineRow[]): string[] => rows.map((row) => row.kind);
  const liveRow = (rows: readonly AgentChatTimelineRow[]) =>
    rows.find((row): row is Extract<AgentChatTimelineRow, { kind: "work-live" }> => row.kind === "work-live");

  it("a running call alone is a live row, never a lone 'Worked for' fold (probe 1 A)", () => {
    const rows = project(
      [activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run", agentId: "a1", turnId: "t1", createdAt: stamp(2) })],
      "running"
    );
    assert.ok(!kinds(rows).includes("turn-fold"), kinds(rows).join(", "));
    const live = liveRow(rows);
    assert.ok(live, `the call in flight is a live row: ${kinds(rows).join(", ")}`);
    assert.equal(live.active, true);
    assert.equal(live.entry.toolCallId, "call-1");
  });

  it("a completed call and one still running: the running one is live (probe 1 B)", () => {
    const rows = project(
      [
        activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
        activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run1", agentId: "a1", turnId: "t1", createdAt: stamp(3) })
      ],
      "running"
    );
    assert.equal(liveRow(rows)?.entry.toolCallId, "call-1", kinds(rows).join(", "));
    assert.ok(!kinds(rows).includes("turn-fold"), "its run is unfolded, as main's running turn");
  });

  it("a streamed command's output rides its live row (probe 1 C)", () => {
    const rows = project(
      [
        activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run1", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
        activity(
          "tool.output",
          { toolUseId: "call-1", streamKind: "command_output", delta: "PASS a.test.ts\n" },
          { id: "chunk1", agentId: "a1", turnId: "t1", createdAt: stamp(3) }
        )
      ],
      "running"
    );
    const live = liveRow(rows);
    assert.ok(live, kinds(rows).join(", "));
    assert.equal(live.entry.toolCallId, "call-1", "the live row names the call, never its chunk");
    assert.ok(live.groupedEntries.some((entry) => entry.id === "chunk1"), "and carries its output");
  });

  it("a live agent a call blocked on an approval still shows: an in-progress call on no turn at all", () => {
    // A background agent's calls between the parent's turns ride no turn.
    const rows = project(
      [activity("tool.started", command("call-1", "rm -rf build", "inProgress"), { id: "gated", agentId: "a1", createdAt: stamp(2) })],
      "waiting"
    );
    assert.equal(liveRow(rows)?.entry.toolCallId, "call-1", kinds(rows).join(", "));
  });

  it("with nothing in progress the list ends with the placeholder, timed from the run's start", () => {
    const rows = project(
      [
        activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
        message("assistant", "Listed them.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(3) })
      ],
      "running",
      stamp(1)
    );
    assert.equal(rows.at(-1)?.kind, "thinking", kinds(rows).join(", "));
    const working = rows.find((row) => row.kind === "working");
    assert.ok(working && working.kind === "working", "the run's header is the working row");
    assert.equal(working.createdAt, stamp(1), "timed from the agent's current run start");
    const said = rows.find((row) => row.kind === "message" && row.id === "said");
    assert.equal(said?.kind === "message" ? said.showAssistantMeta : null, false, "a provisional answer shows no meta yet");
  });

  it("a live agent with no rows yet is never an empty timeline", () => {
    assert.deepEqual(kinds(project([], "pending", null)), ["working", "thinking"]);
  });

  it("a streaming thought is an active group, with no fold coming and going (probes 1 D, 5)", () => {
    const rows = project(
      [
        activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
        message("reasoning", "Now the tests", { id: "think", agentId: "a1", turnId: "t1", streaming: true, createdAt: stamp(3) })
      ],
      "running"
    );
    const group = rows.find((row) => row.kind === "activity-group");
    assert.ok(group && group.kind === "activity-group", kinds(rows).join(", "));
    assert.equal(group.active, true, "the shimmer: the agent is thinking");
    assert.ok(!kinds(rows).includes("turn-fold"));
  });

  it("its answer streaming, then closed while a call runs: no fold header either way (probe 5)", () => {
    const writing = project(
      [message("assistant", "Looking", { id: "m1", agentId: "a1", turnId: "t1", streaming: true, createdAt: stamp(2) })],
      "running"
    );
    const calling = project(
      [
        message("assistant", "Looking", { id: "m1", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
        activity("tool.started", command("call-1", "grep", "inProgress"), { id: "c1", agentId: "a1", turnId: "t1", createdAt: stamp(3) })
      ],
      "running"
    );
    assert.ok(!kinds(writing).includes("turn-fold"), kinds(writing).join(", "));
    assert.ok(!kinds(calling).includes("turn-fold"), kinds(calling).join(", "));
    assert.equal(liveRow(calling)?.entry.toolCallId, "call-1", "and the running call is live");
  });

  it("only its CURRENT run unfolds: a run before it keeps its fold", () => {
    const rows = project(
      [
        activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t0", createdAt: stamp(2) }),
        message("assistant", "First run done.", { id: "first", agentId: "a1", turnId: "t0", createdAt: stamp(3) }),
        activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run1", agentId: "a1", turnId: "t1", createdAt: stamp(11) })
      ],
      "running",
      // Relaunched at 10 s: the roster's start is the current run's.
      stamp(10)
    );
    assert.deepEqual(turnFolds(rows), ["t0"], "the earlier run folds, open; the current one does not");
    const at = (kind: string) => kinds(rows).indexOf(kind);
    assert.ok(at("working") > kinds(rows).indexOf("message"), "the working row heads the current run, after the earlier one");
    assert.equal(liveRow(rows)?.entry.toolCallId, "call-1");
  });

  it("a nested agent's live batch is the live spawn row (probe 6)", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [
        activity(
          "task.started",
          { taskId: "a2", agentKind: "agent", taskType: "subagent", toolUseId: "call-spawn", title: "inner" },
          { id: "spawn", agentId: "a1", turnId: "t1", createdAt: stamp(2), tone: "info" }
        )
      ],
      agentId: "a1",
      messageStreaming: messageStreamingContext({
        head: head({ session: { status: "ready", activeTurnId: null } }),
        roster: [
          { id: "a1", status: "running" },
          { id: "a2", status: "running" }
        ]
      }),
      agent: { startedAt: stamp(1) }
    }).stable.result;
    const live = liveRow(rows);
    assert.deepEqual(live?.entry.agentSpawn?.agentTaskIds, ["a2"], kinds(rows).join(", "));
  });

  it("a settled agent renders as before: no placeholder, no live row, its turns folded", () => {
    const items = [
      activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
      activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run1", agentId: "a1", turnId: "t1", createdAt: stamp(3) }),
      message("assistant", "Done.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(4) })
    ];
    for (const status of ["completed", "failed", "interrupted", "idle"] as const) {
      const rows = project(items, status);
      assert.ok(
        !kinds(rows).some((kind) => kind === "working" || kind === "thinking" || kind === "work-live"),
        `${status}: ${kinds(rows).join(", ")}`
      );
      assert.deepEqual(turnFolds(rows), ["t1"], status);
    }
  });

  it("a live session is part of it: an agent the roster still says runs, on a dead session, reads settled", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [activity("tool.started", command("call-1", "npm test", "inProgress"), { id: "run1", agentId: "a1", turnId: "t1", createdAt: stamp(2) })],
      agentId: "a1",
      messageStreaming: contextWith("running", { status: "stopped", activeTurnId: null }),
      agent: { startedAt: stamp(1) }
    }).stable.result;
    assert.ok(!kinds(rows).some((kind) => kind === "working" || kind === "thinking" || kind === "work-live"));
  });

  it("a loop or a goal drives work and does none: its drill-in never reads as working", () => {
    for (const kind of ["loop", "goal"] as const) {
      const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
        items: [],
        agentId: "a1",
        messageStreaming: contextWith("running"),
        agent: { startedAt: stamp(1), kind }
      }).stable.result;
      assert.deepEqual(kinds(rows), [], kind);
    }
  });

  it("each streamed token of a live agent keeps the fast path", () => {
    const thought = message("reasoning", "Now", { id: "think", agentId: "a1", turnId: null, streaming: true, createdAt: stamp(3) });
    const before = [activity("tool.completed", command("call-0", "ls", "completed"), { id: "done0", agentId: "a1", turnId: "t1", createdAt: stamp(2) })];
    const context = contextWith("running");
    const first = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, { items: [...before, thought], agentId: "a1", messageStreaming: context, agent: { startedAt: stamp(1) } });
    const next = projectAgentDrillIn(first, {
      items: [...before, { ...thought, text: "Now the tests", updatedAt: stamp(5) }],
      agentId: "a1",
      messageStreaming: context,
      agent: { startedAt: stamp(1) }
    });
    const rowOf = (projection: AgentDrillInProjection, id: string) => projection.rows?.rows.find((row) => row.id === id);
    assert.ok(rowOf(first, "working-indicator-row"));
    assert.equal(rowOf(next, "working-indicator-row"), rowOf(first, "working-indicator-row"), "a row the token did not touch is the same object");
  });
});

describe("a drill-in's turn folds start open, and a collapse sticks (R4, S11)", () => {
  const items: ThreadItem[] = [
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-0", title: "ls", command: "ls", status: "completed" },
      { id: "ls", agentId: "a1", turnId: "t1", createdAt: stamp(1) }
    ),
    message("assistant", "Listed.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(2) })
  ];
  const settled = messageStreamingContext({
    head: head({ session: { status: "ready", activeTurnId: null } }),
    roster: [{ id: "a1", status: "completed" }]
  });
  const project = (collapsedTurnIds?: readonly string[]) =>
    projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items,
      agentId: "a1",
      messageStreaming: settled,
      disclosures: { expandedGroupIds: [], ...(collapsedTurnIds ? { collapsedTurnIds } : {}) }
    });
  const fold = (projection: AgentDrillInProjection) =>
    projection.stable.result.find((row): row is Extract<AgentChatTimelineRow, { kind: "turn-fold" }> => row.kind === "turn-fold");

  it("starts open: the child's rows are the reason the view was opened", () => {
    const open = project();
    assert.equal(fold(open)?.expanded, true);
    assert.ok(open.stable.result.some((row) => row.id === "ls"), "its work shows");
    assert.deepEqual([...open.openTurnIds], ["t1"], "and the fold's turn is among the open ones");
  });

  it("a turn the user collapsed stays collapsed: its fold closes and its work hides", () => {
    const collapsed = project(["t1"]);
    assert.equal(fold(collapsed)?.expanded, false, "the chevron works");
    assert.ok(!collapsed.stable.result.some((row) => row.id === "ls"), "the fold hides what it holds");
    assert.deepEqual([...collapsed.openTurnIds], []);
  });

  it("a toggle's patch becomes the collapsed list: closing adds the turn, opening removes it", () => {
    // The timeline patches the WHOLE open list; the drill-in keeps what the user closed.
    assert.deepEqual(collapsedTurnsAfter([], ["t1", "t2"], ["t2"]), ["t1"]);
    assert.deepEqual(collapsedTurnsAfter(["t1"], ["t2"], ["t2", "t1"]), []);
    assert.deepEqual(collapsedTurnsAfter(["t1"], ["t2"], []), ["t1", "t2"]);
    assert.deepEqual(collapsedTurnsAfter(["t1"], ["t2"], ["t2"]), ["t1"], "an unrelated patch keeps it");
  });
});

describe("its prompt at the top (§7.6): each launch's prompt heads the run it started", () => {
  const launch = (id: string, at: number, prompt: string, toolUseId: string): ThreadItem =>
    activity(
      "task.started",
      { taskId: "a1", agentKind: "agent", taskType: "subagent", title: "Find callers", toolUseId, prompt },
      { id, turnId: "t1", tone: "info", createdAt: stamp(at) }
    );
  const call = (id: string, at: number, status: "inProgress" | "completed") =>
    activity(
      "tool.started",
      { itemType: "command_execution", toolUseId: `call-${id}`, title: "grep", command: "grep parse", status },
      { id, agentId: "a1", turnId: "t1", createdAt: stamp(at) }
    );
  const context = (status: RuntimeSubagentStatus) =>
    messageStreamingContext({
      head: head({ session: { status: "ready", activeTurnId: null } }),
      roster: [{ id: "a1", status }]
    });
  const kinds = (rows: readonly AgentChatTimelineRow[]) => rows.map((row) => `${row.kind}:${row.id}`);

  it("is the first row, a user turn with no rewind — the parent's launch row found by its task id", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [
        launch("start", 1, "Find every caller of parse().", "call-agent"),
        message("assistant", "Three callers.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(3) })
      ],
      agentId: "a1",
      messageStreaming: context("completed")
    }).stable.result;
    const first = rows[0];
    assert.ok(first && first.kind === "message", kinds(rows).join(", "));
    assert.equal(first.id, "agent-prompt:start");
    assert.equal(first.message.role, "user");
    assert.equal(first.message.text, "Find every caller of parse().");
    assert.equal(first.revertTurnCount, undefined, "a child rolls back nothing");
  });

  it("heads a live agent's run: the working row follows the prompt", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [launch("start", 1, "Find every caller of parse().", "call-agent"), call("c1", 2, "inProgress")],
      agentId: "a1",
      messageStreaming: context("running"),
      agent: { startedAt: stamp(1) }
    }).stable.result;
    assert.deepEqual(kinds(rows).slice(0, 2), ["message:agent-prompt:start", "working:working-indicator-row"]);
    const working = rows[1];
    assert.equal(working?.kind === "working" ? working.createdAt : null, stamp(1), "timed from the launch");
  });

  it("a relaunch's prompt heads the current run; the run before it folds under its own prompt", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [
        launch("first", 1, "First task.", "call-1"),
        activity(
          "tool.completed",
          { itemType: "command_execution", toolUseId: "call-c0", title: "ls", command: "ls", status: "completed" },
          { id: "c0", agentId: "a1", turnId: "t0", createdAt: stamp(2) }
        ),
        message("assistant", "Done once.", { id: "once", agentId: "a1", turnId: "t0", createdAt: stamp(3) }),
        launch("again", 10, "Now the second.", "call-2"),
        call("c1", 11, "inProgress")
      ],
      agentId: "a1",
      messageStreaming: context("running"),
      agent: { startedAt: stamp(10) }
    }).stable.result;
    const ids = kinds(rows);
    const at = (id: string) => ids.indexOf(id);
    assert.ok(at("message:agent-prompt:first") === 0, ids.join(", "));
    assert.ok(at("turn-fold:turn-fold:t0") > at("message:agent-prompt:first"), "the first run's fold, under its prompt");
    assert.equal(at("working:working-indicator-row"), at("message:agent-prompt:again") + 1, "the current run's header");
    assert.ok(at("message:agent-prompt:again") > at("message:once"));
  });

  it("a prompt is never mistaken for the thread's own `/compact`: it renders whatever it says", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [launch("start", 1, "/compact", "call-agent")],
      agentId: "a1",
      messageStreaming: context("completed")
    }).stable.result;
    assert.deepEqual(kinds(rows), ["message:agent-prompt:start"]);
  });

  it("no prompt on the launch, no prompt row: the client never invents one", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [
        activity(
          "task.started",
          { taskId: "a1", agentKind: "agent", taskType: "subagent", title: "Find callers" },
          { id: "start", turnId: "t1", tone: "info", createdAt: stamp(1) }
        ),
        message("assistant", "Three callers.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(3) })
      ],
      agentId: "a1",
      messageStreaming: context("completed")
    }).stable.result;
    assert.ok(!rows.some((row) => row.kind === "message" && row.message.role === "user"), kinds(rows).join(", "));
  });
});

describe("a launch prompt times only the rows right after it (content review I1)", () => {
  /** The launch: a PARENT row on the parent's launch turn, carrying the prompt. */
  const launch = (id: string, at: number, prompt: string, toolUseId: string, turnId: string | null = "t1"): ThreadItem =>
    activity(
      "task.started",
      { taskId: "a1", agentKind: "agent", taskType: "subagent", title: "Survey", toolUseId, prompt },
      { id, turnId, tone: "info", createdAt: stamp(at) }
    );
  const done = (id: string, at: number, turnId: string | null): ThreadItem =>
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: `call-${id}`, title: "ls", command: "ls", status: "completed" },
      { id, agentId: "a1", turnId, createdAt: stamp(at) }
    );
  const said = (id: string, at: number, turnId: string | null): ThreadItem =>
    message("assistant", `Said ${id}.`, { id, agentId: "a1", turnId, createdAt: stamp(at) });
  const settled = messageStreamingContext({
    head: head({ session: { status: "ready", activeTurnId: null } }),
    roster: [{ id: "a1", status: "completed" }]
  });
  const labels = (items: ThreadItem[], messageStreaming = settled, startedAt: number | null = null) =>
    foldLabels(
      projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
        items,
        agentId: "a1",
        messageStreaming,
        ...(startedAt !== null ? { agent: { startedAt: stamp(startedAt) } } : {})
      }).stable.result
    );

  it("a background agent whose first rows rode no turn: a later turn's fold is its own rows' span", () => {
    // Launched at 1 s; the parent's launch turn ended before the agent wrote a row, so its first rows are
    // turnless (5–100 s); a later parent turn carries the rest (1 000–1 010 s).
    const items = [
      launch("start", 1, "Survey the repo.", "call-agent"),
      done("early", 5, null),
      said("early-words", 100, null),
      done("late", 1_000, "t2"),
      said("late-words", 1_010, "t2")
    ];
    assert.deepEqual(labels(items), ["Worked for 10s"], "timed from 1 000 s, never from the launch at 1 s");
  });

  it("a relaunch followed by a turnless row: the next turn's fold is its own rows' span", () => {
    const items = [
      launch("start", 1, "Survey the repo.", "call-agent"),
      done("first", 2, "t1"),
      said("first-words", 3, "t1"),
      launch("again", 100, "Now the tests.", "call-again", "t2"),
      done("between", 150, null),
      done("t3-call", 3_000, "t3"),
      said("t3-words", 3_005, "t3")
    ];
    assert.deepEqual(labels(items), ["Worked for 2.0s", "Worked for 5.0s"]);
  });

  it("and so while the agent is live on a third run: the earlier runs' folds keep their own spans", () => {
    const live = messageStreamingContext({
      head: head({ session: { status: "ready", activeTurnId: null } }),
      roster: [{ id: "a1", status: "running" }]
    });
    const items = [
      launch("start", 1, "Survey the repo.", "call-agent"),
      done("first", 2, "t1"),
      said("first-words", 3, "t1"),
      launch("again", 100, "Now the tests.", "call-again", "t2"),
      done("between", 150, null),
      done("t3-call", 3_000, "t3"),
      said("t3-words", 3_005, "t3"),
      launch("third", 4_000, "Now the docs.", "call-third", "t4"),
      activity(
        "tool.started",
        { itemType: "command_execution", toolUseId: "call-run", title: "grep", command: "grep", status: "inProgress" },
        { id: "run", agentId: "a1", turnId: "t4", createdAt: stamp(4_001) }
      )
    ];
    assert.deepEqual(labels(items, live, 4_000), ["Worked for 2.0s", "Worked for 5.0s"]);
  });

  it("rows right after the prompt, on its launch turn: their fold is timed from the prompt", () => {
    const items = [launch("start", 1, "Survey the repo.", "call-agent"), done("first", 2, "t1"), said("words", 10, "t1")];
    assert.deepEqual(labels(items), ["Worked for 9.0s"]);
  });

  it("the thread's own timeline is unchanged: its prompt still times a turn whose first rows rode none", () => {
    // A woken or synthetic turn can have turnless rows between its prompt and the turn (the thread's `turns`
    // time a settled one; with none, the prompt does).
    const entries = deriveTimelineEntriesFromItems(
      [
        message("user", "Look around", { id: "u1", createdAt: stamp(1) }),
        activity(
          "tool.completed",
          { itemType: "command_execution", toolUseId: "call-x", title: "pwd", command: "pwd", status: "completed" },
          { id: "early", createdAt: stamp(5) }
        ),
        activity(
          "tool.completed",
          { itemType: "command_execution", toolUseId: "call-y", title: "ls", command: "ls", status: "completed" },
          { id: "late", turnId: "t1", createdAt: stamp(1_000) }
        ),
        message("assistant", "Done.", { id: "answer", turnId: "t1", createdAt: stamp(1_010) })
      ],
      EMPTY_TIMELINE_PROJECTION
    ).entries;
    const rows = deriveTimelineRows({
      timelineEntries: entries,
      isWorking: false,
      activeTurnStartedAt: null,
      supportsConversationRollback: false
    });
    assert.deepEqual(foldLabels(rows), ["Worked for 16m 49s"], "from the prompt at 1 s, as before");
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
        disclosures: { expandedGroupIds }
      });

    const first = project(EMPTY_AGENT_DRILL_IN, ["activity-group:th0"]);
    assert.deepEqual(expandedGroups(first), ["activity-group:th0"]);
    const swapped = project(first, ["activity-group:th1"]);
    assert.deepEqual(expandedGroups(swapped), ["activity-group:th1"], "as many groups open, but another one");
  });
});
