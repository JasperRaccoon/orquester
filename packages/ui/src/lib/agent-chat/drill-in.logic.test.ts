import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
messageStreamingContext,
NOTHING_STREAMS,
type RuntimeSubagentStatus,
type ThreadItem,
type ThreadMessageItem,
type ThreadSessionState
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import {
collapsedTurnsAfter,
drillInAgentRow,
EMPTY_AGENT_DRILL_IN,
projectAgentDrillIn,
type AgentDrillInProjection
} from "./drill-in.logic";
import { deriveTimelineEntriesFromItems,EMPTY_TIMELINE_PROJECTION } from "./entries.logic";
import {
deriveTimelineRowsWithState
} from "./rows.logic";
import { activity,head,message,resetBuilders,stamp } from "./test-helpers";

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

function messageRow(rows: readonly AgentChatTimelineRow[], id: string): MessageRow {
  const row = rows.find((candidate): candidate is MessageRow => candidate.kind === "message" && candidate.id === id);
  assert.ok(row, `a message row ${id}: ${rows.map((candidate) => candidate.id).join(", ")}`);
  return row;
}

const turnFolds = (rows: readonly AgentChatTimelineRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "turn-fold" ? [row.turnId] : []));

function elapsedSeconds(label: string): number {
  const parts = [...label.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)\b/g)];
  assert.ok(parts.length > 0, `fold has a readable duration: ${label}`);
  return parts.reduce((seconds, match) => seconds + Number(match[1]) * ({ h: 3600, m: 60, s: 1 }[match[2]!] ?? 0), 0);
}
const foldDurations = (rows: readonly AgentChatTimelineRow[]): number[] =>
  rows.flatMap((row) => (row.kind === "turn-fold" ? [elapsedSeconds(row.label)] : []));

describe("a drill-in's words read as streaming only while something can still write them", () => {

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

  it("keeps only the selected child's rows when the agent selection changes", () => {
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

    const other = projectAgentDrillIn(first, { items, agentId: "a2", messageStreaming: context });
    assert.equal(other.stable.result.length, 0, "another agent's view never reuses this one's rows");
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

  it("once the thought settles, its fold closes on its final duration", () => {
    const streaming = drill(drill(EMPTY_AGENT_DRILL_IN, thought), written("The build passed", 17));
    const closed = drill(streaming, written("The build passed.", 53, false));
    assert.deepEqual(foldDurations(closed.stable.result), [2, 42]);
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
});

describe("a drill-in's turn folds start open, and a collapse sticks (R4, S11)", () => {
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
    const promptAt = (text: string) => rows.findIndex((row) => row.kind === "message" && row.message.role === "user" && row.message.text === text);
    const firstPrompt = promptAt("First task.");
    const secondPrompt = promptAt("Now the second.");
    const foldAt = rows.findIndex((row) => row.kind === "turn-fold");
    assert.equal(firstPrompt, 0);
    assert.ok(foldAt > firstPrompt && foldAt < secondPrompt, "the old run folds between its prompt and the relaunch");
    assert.equal(rows[secondPrompt + 1]?.kind, "working", "the current run's header follows its prompt");
    assert.ok(secondPrompt > rows.findIndex((row) => row.kind === "message" && row.message.text === "Done once."));
  });

  it("a prompt is never mistaken for the thread's own `/compact`: it renders whatever it says", () => {
    const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
      items: [launch("start", 1, "/compact", "call-agent")],
      agentId: "a1",
      messageStreaming: context("completed")
    }).stable.result;
    assert.deepEqual(rows.flatMap((row) => row.kind === "message" ? [[row.message.role, row.message.text]] : []), [["user", "/compact"]]);
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
    foldDurations(
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
    assert.deepEqual(labels(items), [10], "timed from 1 000 s, never from the launch at 1 s");
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
    assert.deepEqual(labels(items, live, 4_000), [2, 5]);
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
    const rows = deriveTimelineRowsWithState({
      timelineEntries: entries,
      isWorking: false,
      activeTurnStartedAt: null,
      supportsConversationRollback: false
    }).rows;
    assert.deepEqual(foldDurations(rows), [1009], "from the prompt at 1 s, as before");
  });
});

describe("a relaunch inside the same parent turn heads a run of its own (content review M1)", () => {
  const launch = (id: string, at: number, prompt: string, toolUseId: string): ThreadItem =>
    activity(
      "task.started",
      { taskId: "a1", agentKind: "agent", taskType: "subagent", title: "Survey", toolUseId, prompt },
      { id, turnId: "t1", tone: "info", createdAt: stamp(at) }
    );
  const done = (id: string, at: number): ThreadItem =>
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: `call-${id}`, title: id, command: id, status: "completed" },
      { id, agentId: "a1", turnId: "t1", createdAt: stamp(at) }
    );
  const said = (id: string, at: number, text: string): ThreadItem =>
    message("assistant", text, { id, agentId: "a1", turnId: "t1", createdAt: stamp(at) });
  // Both runs ride the parent's turn `t1`: a Claude resume or a Codex follow-up can land inside it.
  const items: ThreadItem[] = [
    launch("L1", 1, "First.", "call-1"),
    done("ls", 2),
    said("once", 12, "Done once."),
    launch("L2", 20, "Second.", "call-2"),
    done("cat", 21),
    said("twice", 30, "Done twice.")
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

  it("each run folds and is timed on its own, under its own prompt", () => {
    const rows = project().stable.result;
    const folds = rows.filter((row): row is Extract<AgentChatTimelineRow, { kind: "turn-fold" }> => row.kind === "turn-fold");
    const promptAt = (text: string) => rows.findIndex((row) => row.kind === "message" && row.message.role === "user" && row.message.text === text);
    assert.deepEqual(folds.map((fold) => elapsedSeconds(fold.label)), [11, 10]);
    assert.ok(rows.indexOf(folds[0]!) > promptAt("First.") && rows.indexOf(folds[0]!) < promptAt("Second."), "first run folds between its prompt and the relaunch");
    assert.ok(rows.indexOf(folds[1]!) > promptAt("Second."), "second run folds after its prompt");
  });

  it("the first run's last answer is terminal in its run: its meta shows, and it is no fold's hidden commentary", () => {
    const rows = project().stable.result;
    const once = rows.find((row) => row.kind === "message" && row.id === "once");
    assert.ok(once && once.kind === "message", rows.map((row) => row.id).join(", "));
    assert.equal(once.showAssistantMeta, true);
  });

  it("collapsing one run's fold hides that run's work alone", () => {
    const open = project();
    const [firstRun] = open.openTurnIds;
    assert.ok(firstRun !== undefined && open.openTurnIds.length === 2, `one open fold per run: ${open.openTurnIds.join(", ")}`);
    const collapsed = project([firstRun]).stable.result;
    const ids = collapsed.map((row) => row.id);
    assert.ok(!ids.includes("ls"), "run 1's work is behind its fold");
    assert.ok(ids.includes("cat"), "run 2's work is not");
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
    const expandedThoughts = (projection: AgentDrillInProjection): string[] =>
      projection.stable.result.flatMap((row) => row.kind === "activity-group" && row.expanded
        ? row.entries.flatMap((entry) => entry.sourceActivityKind === "reasoning" ? [entry.detail ?? ""] : [])
        : []);
    const project = (previous: AgentDrillInProjection, expandedGroupIds: string[]): AgentDrillInProjection =>
      projectAgentDrillIn(previous, {
        items,
        agentId: "a1",
        messageStreaming: NOTHING_STREAMS,
        disclosures: { expandedGroupIds }
      });

    const initial = project(EMPTY_AGENT_DRILL_IN, []);
    const groups = initial.stable.result.flatMap((row) => row.kind === "activity-group" ? [row.groupId] : []);
    const first = project(initial, [groups[0]!]);
    assert.deepEqual(expandedThoughts(first), ["Looking"]);
    const swapped = project(first, [groups[1]!]);
    assert.deepEqual(expandedThoughts(swapped), ["Building"], "the other thought opens even though the number of open groups is unchanged");
  });
});

describe("the drill-in's agent row outlives the roster's cap (final review C, M2 and r1 m1)", () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, kind: "subagent", agentKind: "background", title: id, status: "completed", ...overrides }) as never;

  it("the roster's row while it has one — the newer, and current — and the row last seen once the roster drops it", () => {
    const seen = row("sh1", { title: "dev server", status: "running" });
    const now = row("sh1", { title: "dev server", status: "completed" });
    assert.deepEqual(drillInAgentRow({ agentId: "sh1", roster: [now], lastKnown: seen }), {
      row: now,
      remembered: false
    });
    assert.deepEqual(
      drillInAgentRow({ agentId: "sh1", roster: [], lastKnown: seen }),
      { row: seen, remembered: true },
      "evicted: its title and kind keep the header and the shell's one row; remembered, its status is not current"
    );
  });

  it("a remembered row of another agent is none of this one's", () => {
    assert.deepEqual(drillInAgentRow({ agentId: "sh1", roster: [], lastKnown: row("sh2") }), {
      row: null,
      remembered: false
    });
    assert.deepEqual(drillInAgentRow({ agentId: "sh1", roster: [], lastKnown: null }), {
      row: null,
      remembered: false
    });
  });
});
