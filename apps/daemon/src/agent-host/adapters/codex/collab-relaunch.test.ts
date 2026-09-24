/**
 * Codex adapter — a collab child re-engaged after it settled launches again
 * (AGENTS.md, "Agent rows must survive resumes and retention", rule 1).
 *
 * The roster fold reopens a terminal agent only on a `task.started` naming a
 * DIFFERENT launch id than the previous start did, and an `idle` one on any
 * start; a `task.progress` row is replaced in place at its first position and
 * can reopen nothing. So the child's first start must carry a launch id, and a
 * settled child that works again must start again, under a new one.
 *
 * No capture spawns a child (fixtures README observation 19), so these drive
 * the normaliser with frames typed against the generated
 * `_generated/protocol/v2/` shapes. They pin OUR contract, not Codex's timing:
 * which calls raise `interacted`, and when `completed` fires, are unverified.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  foldSubagentActivities,
  type RuntimeEvent,
  type RuntimeSubagent
} from "@orquester/api/agent-chat";

import { runtimeEventToActivities } from "../../ingestion/activities.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import type { CodexProtocol } from "./_generated/index.ts";
import { CodexNormaliser, type RuntimeEventDraft } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

const PARENT = "parent-thread";
const CHILD = "child-thread";
const CHILD_PATH = "/root/explorer";
const LAUNCH_ITEM = "sub-launch";

function make(): CodexNormaliser {
  return new CodexNormaliser({ usage: new CodexUsageTracker(), ownThreadId: () => PARENT });
}

function turn(id: string, status: CodexProtocol.v2.TurnStatus): CodexProtocol.v2.Turn {
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null
  };
}

/** The parent's own `subAgentActivity` record about the child. */
function activity(
  normaliser: CodexNormaliser,
  kind: CodexProtocol.v2.SubAgentActivityKind,
  itemId: string
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ItemCompletedNotification = {
    item: {
      type: "subAgentActivity",
      id: itemId,
      kind,
      agentThreadId: CHILD,
      agentPath: CHILD_PATH
    },
    threadId: PARENT,
    turnId: "parent-turn",
    completedAtMs: 0
  };
  return normaliser.notification("item/completed", params);
}

function launch(normaliser: CodexNormaliser): RuntimeEventDraft[] {
  return activity(normaliser, "started", LAUNCH_ITEM);
}

/** A turn of `threadId` — the child's own when it is {@link CHILD}. */
function turnStarted(
  normaliser: CodexNormaliser,
  turnId: string,
  threadId = CHILD
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.TurnStartedNotification = {
    threadId,
    turn: turn(turnId, "inProgress")
  };
  return normaliser.notification("turn/started", params);
}

function turnCompleted(
  normaliser: CodexNormaliser,
  turnId: string,
  status: CodexProtocol.v2.TurnStatus = "completed",
  threadId = CHILD
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.TurnCompletedNotification = {
    threadId,
    turn: turn(turnId, status)
  };
  return normaliser.notification("turn/completed", params);
}

function childThreadClosed(normaliser: CodexNormaliser): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ThreadClosedNotification = { threadId: CHILD };
  return normaliser.notification("thread/closed", params);
}

/** The task rows among `drafts`, as `type:status` (status only where set). */
function taskRows(drafts: readonly RuntimeEventDraft[]): string[] {
  return drafts
    .filter((draft) => draft.type.startsWith("task."))
    .map((draft) => {
      const status = (draft.payload as { status?: string }).status;
      return status === undefined ? draft.type : `${draft.type}:${status}`;
    });
}

type TaskStartedDraft = Extract<RuntimeEventDraft, { type: "task.started" }>;

function startOf(drafts: readonly RuntimeEventDraft[]): TaskStartedDraft {
  const start = drafts.find((draft): draft is TaskStartedDraft => draft.type === "task.started");
  assert.ok(start !== undefined, `no task.started in ${JSON.stringify(taskRows(drafts))}`);
  return start;
}

let seq = 0;

/** Drafts as the session emits them: with an id, a thread and a time. */
function stamp(drafts: readonly RuntimeEventDraft[]): RuntimeEvent[] {
  return drafts.map(
    (draft) =>
      ({
        ...draft,
        eventId: `e${(seq += 1)}`,
        threadId: "thread-1",
        createdAt: "2026-09-24T00:00:00.000Z"
      }) as RuntimeEvent
  );
}

/** The child's roster row, folded by ingestion's translation and the real roster fold. */
function rosterRow(drafts: readonly RuntimeEventDraft[]): RuntimeSubagent {
  const activities = stamp(drafts).flatMap((event) => runtimeEventToActivities(event));
  const row = foldSubagentActivities(activities).find((agent) => agent.id === CHILD);
  assert.ok(row !== undefined);
  return row;
}

describe("a collab child's launch record carries a launch id (I1)", () => {
  it("subAgentActivity started starts the task under codex-launch:<item id>", () => {
    const start = startOf(launch(make()));
    assert.equal(start.payload.taskId, CHILD);
    assert.equal(start.payload.toolUseId, `codex-launch:${LAUNCH_ITEM}`);
  });

  it("the launch's own first turn is not a second start", () => {
    const normaliser = make();
    launch(normaliser);
    assert.deepEqual(taskRows(turnStarted(normaliser, "child-turn-1")), ["task.progress:running"]);
  });
});

describe("a settled child's own turn launches it again (I2)", () => {
  // Every way a child's run can settle, each after the launch's first turn.
  const settles: [string, (normaliser: CodexNormaliser) => void][] = [
    ["its own turn/completed", (n) => turnCompleted(n, "child-turn-1")],
    [
      "subAgentActivity completed",
      (n) => {
        turnCompleted(n, "child-turn-1");
        activity(n, "completed", "sub-completed");
      }
    ],
    [
      "subAgentActivity interrupted",
      (n) => {
        turnCompleted(n, "child-turn-1", "interrupted");
        activity(n, "interrupted", "sub-interrupted");
      }
    ],
    ["its thread/closed", (n) => childThreadClosed(n)]
  ];

  for (const [label, settle] of settles) {
    it(`after ${label}: a start under a new id, before the run's progress row`, () => {
      const normaliser = make();
      const launched = startOf(launch(normaliser));
      turnStarted(normaliser, "child-turn-1");
      settle(normaliser);

      const events = turnStarted(normaliser, "child-turn-2");
      assert.deepEqual(taskRows(events), ["task.started", "task.progress:running"]);
      const relaunch = startOf(events);
      assert.equal(relaunch.payload.taskId, CHILD);
      assert.equal(relaunch.payload.toolUseId, "codex-run:child-turn-2");
      assert.notEqual(relaunch.payload.toolUseId, launched.payload.toolUseId);
      assert.equal(relaunch.agentId, CHILD);
      // The launch record's linkage, so the start reads like the first one.
      assert.equal(relaunch.payload.agentPath, CHILD_PATH);
      assert.equal(relaunch.payload.title, "explorer");
      assert.equal(relaunch.payload.description, "explorer");
    });
  }

  // A Stop closes every live task `stopped` and then forgets the fleet
  // (`CodexSession.stopBackgroundWork` → `forgetAgents`); no end of the child's
  // own may follow — a launch whose turn had not begun has none to end, and an
  // interrupt that never lands sends none.
  const stopped: [string, (normaliser: CodexNormaliser) => void][] = [
    ["a launch whose turn had not begun", () => undefined],
    ["a child mid-turn", (n) => turnStarted(n, "child-turn-1")]
  ];
  for (const [label, before] of stopped) {
    it(`after a Stop closed ${label}: its next turn is a new run`, () => {
      const normaliser = make();
      launch(normaliser);
      before(normaliser);
      normaliser.forgetAgents();

      const events = turnStarted(normaliser, "child-turn-2");
      assert.deepEqual(taskRows(events), ["task.started", "task.progress:running"]);
      assert.equal(startOf(events).payload.toolUseId, "codex-run:child-turn-2");
    });
  }

  // An end record settles a run on its own, with no turn of the child's seen.
  for (const kind of ["completed", "interrupted"] as const) {
    it(`subAgentActivity ${kind} before the child's first turn: that turn is new`, () => {
      const normaliser = make();
      launch(normaliser);
      activity(normaliser, kind, `sub-${kind}`);

      const events = turnStarted(normaliser, "child-turn-1");
      assert.deepEqual(taskRows(events), ["task.started", "task.progress:running"]);
      assert.equal(startOf(events).payload.toolUseId, "codex-run:child-turn-1");
    });
  }

  it("a turn before the launch record: two starts in ONE run, the second only metadata", () => {
    // The order of `subAgentActivity started` against the child's own
    // notifications is unverified (fixtures README observation 19). A child
    // whose turn comes first is one this session never saw launched, so its
    // turn starts it; the launch record then starts it again. The fold finds
    // the agent running at that second start and only fills its metadata.
    const normaliser = make();
    const events = [...turnStarted(normaliser, "child-turn-1"), ...launch(normaliser)];
    assert.deepEqual(taskRows(events), ["task.started", "task.progress:running", "task.started"]);

    const row = rosterRow(events);
    assert.equal(row.status, "running");
    assert.equal(row.activationCount, 1, "one run, not two");
    assert.equal(row.title, "explorer", "the launch record's name fills in the metadata");
  });

  it("a child launched before this session (a host restart) starts on its turn", () => {
    const normaliser = make();
    const events = turnStarted(normaliser, "child-turn-9");
    assert.deepEqual(taskRows(events), ["task.started", "task.progress:running"]);
    assert.equal(startOf(events).payload.toolUseId, "codex-run:child-turn-9");
  });

  it("the parent turn that re-engages a settled child reports subagents", () => {
    const normaliser = make();
    turnStarted(normaliser, "parent-turn-1", PARENT);
    launch(normaliser);
    turnStarted(normaliser, "child-turn-1");
    turnCompleted(normaliser, "child-turn-1");
    turnCompleted(normaliser, "parent-turn-1", "completed", PARENT);

    turnStarted(normaliser, "parent-turn-2", PARENT);
    activity(normaliser, "interacted", "sub-interacted");
    turnStarted(normaliser, "child-turn-2");
    const settled = turnCompleted(normaliser, "parent-turn-2", "completed", PARENT).find(
      (draft) => draft.type === "turn.completed"
    );
    assert.equal(
      (settled?.payload as { tokenUsage?: { hasSubagents?: boolean } } | undefined)?.tokenUsage
        ?.hasSubagents,
      true
    );
  });
});

describe("an end record never ends a run a relaunch opened (I4)", () => {
  // How `subAgentActivity` records are ordered against the child's own
  // notifications is unverified (fixtures README observation 19). A
  // `completed`/`interrupted` record that arrives while a turn a relaunch
  // opened is in progress is about the run before: it writes no end — which
  // would settle the NEW run — and the run ends at its own `turn/completed`.
  const cases = [
    {
      kind: "completed",
      turn: "completed",
      runEnd: "task.updated:idle",
      end: "task.completed:completed"
    },
    {
      kind: "interrupted",
      turn: "interrupted",
      runEnd: "task.updated:interrupted",
      end: "task.completed:stopped"
    }
  ] as const;

  /** Launched, one run settled by its own turn, and the child's next turn: a relaunch. */
  function relaunched(): CodexNormaliser {
    const normaliser = make();
    launch(normaliser);
    turnStarted(normaliser, "child-turn-1");
    turnCompleted(normaliser, "child-turn-1");
    const relaunch = startOf(turnStarted(normaliser, "child-turn-2"));
    assert.equal(relaunch.payload.toolUseId, "codex-run:child-turn-2");
    return normaliser;
  }

  for (const { kind, turn: status, runEnd, end } of cases) {
    it(`subAgentActivity ${kind} DURING the relaunched turn writes no end; the turn's does`, () => {
      const normaliser = relaunched();
      assert.deepEqual(taskRows(activity(normaliser, kind, `sub-${kind}`)), []);
      assert.deepEqual(taskRows(turnCompleted(normaliser, "child-turn-2", status)), [runEnd]);
      // Settled all the same: its next turn launches it again.
      assert.deepEqual(taskRows(turnStarted(normaliser, "child-turn-3")), [
        "task.started",
        "task.progress:running"
      ]);
    });

    it(`subAgentActivity ${kind} AFTER the relaunched turn's own end is the run's end`, () => {
      const normaliser = relaunched();
      turnCompleted(normaliser, "child-turn-2", status);
      assert.deepEqual(taskRows(activity(normaliser, kind, `sub-${kind}`)), [end]);
    });

    it(`subAgentActivity ${kind} during the LAUNCH's first turn still ends that run`, () => {
      const normaliser = make();
      launch(normaliser);
      turnStarted(normaliser, "child-turn-1");
      assert.deepEqual(taskRows(activity(normaliser, kind, `sub-${kind}`)), [end]);
    });
  }
});

describe("interacted is no evidence of a run", () => {
  it("interacted alone does not make a settled agent live; its own turn does", () => {
    // `send_message` "does not trigger a new turn": an interaction that is not
    // followed by one left the thread reading "working" with nothing to end it.
    const normaliser = make();
    const registry = createLivenessRegistry();
    const observe = (drafts: readonly RuntimeEventDraft[]): void => {
      for (const event of stamp(drafts)) registry.observe(event);
    };
    observe(launch(normaliser));
    observe(turnStarted(normaliser, "child-turn-1"));
    observe(turnCompleted(normaliser, "child-turn-1"));
    observe(activity(normaliser, "completed", "sub-completed"));
    assert.equal(registry.liveness("thread-1"), null);

    observe(activity(normaliser, "interacted", "sub-interacted"));
    assert.equal(registry.liveness("thread-1"), null, "an interaction starts no run");

    observe(turnStarted(normaliser, "child-turn-2"));
    assert.equal(registry.liveness("thread-1"), "working");
    observe(turnCompleted(normaliser, "child-turn-2"));
    assert.equal(registry.liveness("thread-1"), null);
  });
});
