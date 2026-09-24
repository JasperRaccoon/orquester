/**
 * Ingestion's output, run through W2's REAL fold.
 *
 * Every other test in this package asserts the domain events ingestion
 * produces. This one asserts the thing that actually matters: that folding
 * those events with `@orquester/api/agent-chat`'s `foldThread` yields the
 * thread the user sees. It is the seam where a naming or shape mismatch
 * between the two packages shows up, and nothing else would catch it — the
 * fold reads `activityKind`, the promoted `agentId`/`status` fields, the
 * `payload.usage` / `payload.agentKind` linkage and the streaming-merge rule,
 * all of which ingestion writes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyDomainEvent,
  createEmptyThreadState,
  derivePendingRequests,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  runtimeEvent,
  settle
} from "./test-harness.ts";

const THREAD_ID = "t1";

function harness() {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  return { ingestion, sink, timers };
}

/**
 * An `agentMessage` phase exactly as Codex's live normaliser reports it: in
 * `detail` AND in `data.phase` (`adapters/codex/items.ts`).
 */
function codexPhase(phase: string): { detail: string; data: unknown } {
  return { detail: phase, data: { phase, delivery: null, questions: null } };
}

/**
 * Stamp sequences the way the store does and fold. `thread.created` is the
 * host's, not ingestion's, so it is prepended here — ingestion only ever runs
 * on a thread that already exists.
 */
function fold(events: AppendableDomainEvent[]) {
  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: THREAD_ID,
    occurredAt: "2026-09-21T09:59:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "claude",
      refId: "claude",
      accountId: "acc1",
      home: "system",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    }
  };
  let state = applyDomainEvent(createEmptyThreadState(), created);
  let seq = 1;
  for (const event of events) {
    seq += 1;
    state = applyDomainEvent(state, { ...event, seq } as DomainEvent);
  }
  return state;
}

function messages(state: ReturnType<typeof fold>): ThreadMessageItem[] {
  return state.items.filter((item): item is ThreadMessageItem => item.kind === "message");
}

function activities(state: ReturnType<typeof fold>): ThreadActivityItem[] {
  return state.items.filter((item): item is ThreadActivityItem => item.kind === "activity");
}

describe("ingestion output folded by the real fold (§5.1)", () => {
  it("streamed deltas concatenate into one settled assistant message", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    for (const delta of ["Hello ", "there.\n\n", "Second para.\n\n", "Third."]) {
      await ingestion.ingest(
        runtimeEvent("content.delta", { streamKind: "assistant_text", delta }, turn)
      );
      timers.advance(300);
      await settle();
    }
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    await ingestion.drain();

    const state = fold(sink.events());
    const assistant = messages(state).filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 1, "the delta/complete merge must produce ONE message");
    assert.equal(assistant[0]!.text, "Hello there.\n\nSecond para.\n\nThird.");
    assert.equal(assistant[0]!.streaming, false);
    assert.equal(assistant[0]!.turnId, "turn-1");
  });

  it("reasoning folds as a sibling message, never into the assistant one", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_summary_text", delta: "hmm" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "answer" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    await ingestion.drain();

    const state = fold(sink.events());
    assert.deepEqual(
      messages(state).map((message) => `${message.role}:${message.text}`),
      ["reasoning:hmm", "assistant:answer"]
    );
  });

  it("the turn settles from session status, and the head tracks the session", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("thread.started", { providerThreadId: "prov-9" }));
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "x" }, {
        turnId: "turn-1",
        itemId: "item-1"
      })
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    await ingestion.drain();

    const state = fold(sink.events());
    assert.equal(state.head?.session.status, "ready");
    assert.equal(state.head?.session.activeTurnId, null);
    assert.equal(state.head?.session.providerThreadId, "prov-9");
    const turn = state.turns.find((entry) => entry.turnId === "turn-1");
    assert.ok(turn, "the turn must exist after folding");
    assert.equal(turn.state, "completed");
  });

  it("an interrupted session settles the turn as interrupted", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent("turn.aborted", { reason: "user" }, { turnId: "turn-1" })
    );
    await ingestion.drain();
    const state = fold(sink.events());
    assert.equal(state.head?.session.status, "stopped");
    assert.equal(state.turns.find((entry) => entry.turnId === "turn-1")?.state, "interrupted");
  });

  it("an approval opens and closes in the pending set the fold derives", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, turn));
    await ingestion.ingest(
      runtimeEvent(
        "request.opened",
        {
          requestType: "command_execution_approval",
          dismissible: false,
          detail: "rm -rf build",
          options: [
            { decision: "accept", label: "Approve" },
            { decision: "decline", label: "Decline" }
          ]
        },
        { ...turn, requestId: "req-1" }
      )
    );
    await ingestion.drain();

    const open = fold(sink.events());
    assert.equal(open.pending.approvals.length, 1);
    assert.equal(open.pending.approvals[0]!.requestId, "req-1");
    assert.equal(open.pending.approvals[0]!.requestKind, "command");
    assert.equal(open.pending.approvals[0]!.detail, "rm -rf build");
    assert.equal(open.pending.approvals[0]!.options?.length, 2);

    await ingestion.ingest(
      runtimeEvent(
        "request.resolved",
        { requestType: "command_execution_approval", decision: "accept" },
        { ...turn, requestId: "req-1" }
      )
    );
    await ingestion.drain();
    const closed = fold(sink.events());
    assert.equal(closed.pending.approvals.length, 0);
    // And the same derivation off the raw activity list agrees.
    assert.equal(derivePendingRequests(activities(closed)).approvals.length, 0);
  });

  it("a tool_user_input request never reaches the pending set", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "request.opened",
        { requestType: "tool_user_input", dismissible: true },
        { turnId: "turn-1", requestId: "req-q" }
      )
    );
    await ingestion.drain();
    const state = fold(sink.events());
    assert.equal(state.pending.approvals.length, 0);
    assert.equal(state.pending.userInputs.length, 0);
  });

  it("a question opens as a pending user input and a resolution closes it", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(
      runtimeEvent(
        "user-input.requested",
        {
          dismissible: false,
          questions: [
            {
              id: "Which database?",
              header: "Database",
              question: "Which database?",
              options: [
                { label: "Postgres", description: "" },
                { label: "SQLite", description: "" }
              ]
            }
          ]
        },
        { ...turn, requestId: "q-1" }
      )
    );
    await ingestion.drain();
    const open = fold(sink.events());
    assert.equal(open.pending.userInputs.length, 1);
    assert.equal(open.pending.userInputs[0]!.questions[0]?.id, "Which database?");

    await ingestion.ingest(
      runtimeEvent("user-input.resolved", { answers: { "Which database?": "SQLite" } }, {
        ...turn,
        requestId: "q-1"
      })
    );
    await ingestion.drain();
    assert.equal(fold(sink.events()).pending.userInputs.length, 0);
  });

  it("the roster rebuilds from the linkage ingestion stamps on EVERY task row", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, turn));
    await ingestion.ingest(
      runtimeEvent(
        "task.started",
        {
          taskId: "task-1",
          taskType: "subagent",
          agentId: "agent-1",
          description: "Audit the fold",
          model: "opus"
        },
        turn
      )
    );
    await ingestion.ingest(
      runtimeEvent(
        "task.progress",
        {
          taskId: "task-1",
          taskType: "subagent",
          agentId: "agent-1",
          description: "Reading files",
          lastToolName: "Read",
          usage: { totalTokens: 1234 }
        },
        turn
      )
    );
    await ingestion.drain();

    const state = fold(sink.events());
    // The roster is keyed by taskId, not agentId.
    const agent = state.roster.find((row) => row.id === "task-1");
    assert.ok(agent, `roster had ${JSON.stringify(state.roster.map((row) => row.id))}`);
    assert.equal(agent.agentKind, "agent");
    assert.equal(agent.model, "opus");
    assert.equal(agent.usage?.totalTokens, 1234);
  });

  it("a background shell folds as background, not as a subagent", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("task.started", {
        taskId: "task-2",
        taskType: "shell",
        agentId: "shell-1",
        description: "tail -f log"
      })
    );
    await ingestion.drain();
    const agent = fold(sink.events()).roster.find((row) => row.id === "task-2");
    assert.ok(agent);
    assert.equal(agent.agentKind, "background");
  });

  it("a task stopped by a dying session folds to interrupted", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("task.started", {
        taskId: "task-1",
        taskType: "subagent",
        agentId: "agent-1",
        description: "Work"
      })
    );
    await ingestion.ingest(
      runtimeEvent("task.completed", {
        taskId: "task-1",
        taskType: "subagent",
        agentId: "agent-1",
        status: "stopped"
      })
    );
    await ingestion.drain();
    const agent = fold(sink.events()).roster.find((row) => row.id === "task-1");
    assert.equal(agent?.status, "interrupted");
  });

  it("the tool lifecycle folds into rows the timeline can group", async () => {
    const { ingestion, sink } = harness();
    const item = { turnId: "turn-1", itemId: "call-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "command_execution", status: "inProgress", title: "Bash" },
        item
      )
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        {
          itemType: "command_execution",
          status: "completed",
          title: "Bash",
          data: { item: { command: "ls -1", aggregatedOutput: "a\nb\n" } }
        },
        item
      )
    );
    await ingestion.drain();

    const rows = activities(fold(sink.events())).filter((row) =>
      row.activityKind.startsWith("tool.")
    );
    assert.deepEqual(
      rows.map((row) => row.activityKind),
      ["tool.started", "tool.completed"]
    );
    for (const row of rows) {
      assert.equal(
        (row.payload as { toolUseId?: string }).toolUseId,
        "call-1",
        "the fold must see one stable id across the lifecycle"
      );
      assert.equal(row.turnId, "turn-1");
    }
    assert.equal(rows[1]!.status, "completed");
  });

  it("a task.progress row replaces the previous one instead of piling up", async () => {
    const { ingestion, sink } = harness();
    for (const description of ["Reading", "Editing", "Testing"]) {
      await ingestion.ingest(
        runtimeEvent("task.progress", {
          taskId: "task-1",
          taskType: "subagent",
          agentId: "agent-1",
          description
        })
      );
    }
    await ingestion.drain();
    const rows = activities(fold(sink.events())).filter(
      (row) => row.activityKind === "task.progress"
    );
    assert.equal(rows.length, 1, "the stable per-task id must collapse the ticks");
    assert.equal(rows[0]!.summary, "Testing");
  });

  it("the compaction marker keeps its token counts through the fold", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("thread.state.changed", {
        state: "compacted",
        beforeTokens: 120_000,
        afterTokens: 18_000
      })
    );
    await ingestion.drain();
    const row = activities(fold(sink.events())).find(
      (entry) => entry.activityKind === "context-compaction"
    );
    assert.ok(row);
    assert.deepEqual(
      {
        before: (row.payload as { beforeTokens?: number }).beforeTokens,
        after: (row.payload as { afterTokens?: number }).afterTokens
      },
      { before: 120_000, after: 18_000 }
    );
  });

  it("the §7.3 badge fields survive the fold onto the message item", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, turn));
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_summary_text", delta: "hmm" }, {
        ...turn,
        itemId: "item-0"
      })
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "assistant_message", ...codexPhase("commentary") },
        { ...turn, itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "I'll look." }, {
        ...turn,
        itemId: "item-1"
      })
    );
    // The commentary item closes; only then does the next item open its own
    // message — a segment stays open until a completion, a pause or another
    // assistant item's `item.started` (same turn and owner, D4) closes it.
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", ...codexPhase("commentary") },
        { ...turn, itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "The answer." }, {
        ...turn,
        itemId: "item-2"
      })
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, turn)
    );
    await ingestion.drain();

    const state = fold(sink.events());
    const byId = new Map(messages(state).map((message) => [message.id, message]));
    assert.equal(byId.get("reasoning:summary:item-0")?.reasoningKind, "summary");
    assert.equal(byId.get("assistant:item-1")?.messageKind, "commentary");
    assert.equal(byId.get("assistant:item-2")?.messageKind, "answer");
  });

  it("a later delta that omits the fields never strips them", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "assistant_message", ...codexPhase("commentary") },
        turn
      )
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "one\n\n" }, turn)
    );
    await ingestion.drain();
    // Replay the folded events, then apply a hand-built delta with no fields —
    // the shape an older adapter would produce.
    const events = [...sink.events()];
    let state = fold(events);
    assert.equal(messages(state)[0]?.messageKind, "commentary");
    state = applyDomainEvent(state, {
      seq: state.seq + 1,
      eventId: "legacy",
      threadId: THREAD_ID,
      occurredAt: "2026-09-21T10:00:05.000Z",
      commandId: null,
      causationEventId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        messageId: "assistant:item-1",
        role: "assistant",
        text: "two",
        streaming: true,
        turnId: "turn-1"
      }
    });
    assert.equal(messages(state)[0]?.messageKind, "commentary");
    assert.equal(messages(state)[0]?.text, "one\n\ntwo");
  });

  // E3 confirmed R5 #2 in the running system: an Escape-interrupted Codex turn
  // rendered "Worked for 9.7s" as completed. All four adapters end an
  // interrupt through one of these two frames, so both are covered end to end.
  const interruptCases: [
    "turn.completed" | "turn.aborted",
    "interrupted" | "cancelled" | undefined
  ][] = [
    ["turn.completed", "interrupted"],
    ["turn.completed", "cancelled"],
    ["turn.aborted", undefined]
  ];
  for (const [type, turnState] of interruptCases) {
    const label = turnState === undefined ? type : `${type} {state:"${turnState}"}`;
    it(`E3/R5 #2: a user Stop via ${label} settles the turn INTERRUPTED`, async () => {
      const { ingestion, sink } = harness();
      await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
      await ingestion.ingest(
        runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "half a" }, {
          turnId: "turn-1",
          itemId: "item-1"
        })
      );
      await ingestion.ingest(
        type === "turn.aborted"
          ? runtimeEvent("turn.aborted", { reason: "user" }, { turnId: "turn-1" })
          : runtimeEvent("turn.completed", { state: turnState! }, { turnId: "turn-1" })
      );
      await ingestion.drain();

      const state = fold(sink.events());
      const turn = state.turns.find((entry) => entry.turnId === "turn-1");
      assert.ok(turn);
      assert.equal(turn.state, "interrupted", "a Stop is never a completed turn");
      assert.equal(state.head?.session.status, "stopped");
      assert.equal(state.head?.session.lastError, undefined, "a Stop is not an error");
    });
  }

  it("E10: turn.completed's tokenUsage and cost reach Turn", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent(
        "turn.completed",
        {
          state: "completed",
          totalCostUsd: 0.0412,
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 28_784,
            outputTokens: 64,
            cachedInputTokens: 19_200,
            hasSubagents: false
          }
        },
        { turnId: "turn-1" }
      )
    );
    await ingestion.drain();

    const turn = fold(sink.events()).turns.find((entry) => entry.turnId === "turn-1");
    assert.ok(turn);
    assert.equal(turn.state, "completed");
    assert.equal(turn.tokenUsage?.usageStatus, "complete");
    assert.equal(turn.tokenUsage?.inputTokens, 28_784);
    assert.equal(turn.tokenUsage?.outputTokens, 64);
    assert.equal(turn.totalCostUsd, 0.0412);
  });

  it("E10: an interrupted turn keeps the usage it managed to report", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent(
        "turn.aborted",
        {
          reason: "user",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            inputTokens: 120,
            hasSubagents: false
          }
        },
        { turnId: "turn-1" }
      )
    );
    await ingestion.drain();
    const turn = fold(sink.events()).turns.find((entry) => entry.turnId === "turn-1");
    assert.equal(turn?.state, "interrupted");
    assert.equal(turn?.tokenUsage?.usageStatus, "partial");
    assert.equal(turn?.tokenUsage?.inputTokens, 120);
  });

  it("E10: a replayed terminal event never rewrites a settled turn's numbers", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent(
        "turn.completed",
        {
          state: "completed",
          totalCostUsd: 1,
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 10,
            outputTokens: 1,
            hasSubagents: false
          }
        },
        { turnId: "turn-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent(
        "turn.completed",
        {
          state: "completed",
          totalCostUsd: 999,
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 999,
            outputTokens: 999,
            hasSubagents: false
          }
        },
        { turnId: "turn-1" }
      )
    );
    await ingestion.drain();
    const turn = fold(sink.events()).turns.find((entry) => entry.turnId === "turn-1");
    assert.equal(turn?.totalCostUsd, 1);
    assert.equal(turn?.tokenUsage?.inputTokens, 10);
  });

  it("the provider's title reaches the head", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("thread.metadata.updated", { name: "Audit the ingestion hop" })
    );
    await ingestion.drain();
    assert.equal(fold(sink.events()).head?.title, "Audit the ingestion hop");
  });
});

/**
 * The relaunch contract every agent-surfacing adapter keeps (AGENTS.md, "Agent
 * rows must survive resumes and retention", rule 1), in the shapes OpenCode and
 * Codex write: an agent's first start carries a launch id, a re-engagement
 * starts it again under a NEW one before any row of the new run, and the run
 * ends with the adapter's usual end row. The fold did not change for it; these
 * pin that its rules read those rows as a new run, and why only a start will do.
 */
describe("a re-engaged subagent folds as a new run (the relaunch contract)", () => {
  const CHILD = "child-1";
  const turn = { turnId: "turn-1" };

  type TaskRowType = "task.started" | "task.progress" | "task.updated" | "task.completed";
  type TaskRowPayload = Extract<RuntimeEvent, { type: TaskRowType }>["payload"];

  /** A task row stamped with the agent's own id, as OpenCode and Codex write every one. */
  function task(type: TaskRowType, payload: Record<string, unknown>): RuntimeEvent {
    const linked = { taskId: CHILD, taskType: "subagent", agentId: CHILD, title: "explorer" };
    return runtimeEvent(
      type,
      { ...linked, ...payload } as unknown as TaskRowPayload,
      { ...turn, agentId: CHILD }
    );
  }

  /** One tool call the agent makes: two rows of its own window. */
  function toolCall(index: number): RuntimeEvent[] {
    const item = { ...turn, itemId: `call-${index}`, agentId: CHILD };
    const payload = {
      itemType: "command_execution",
      title: `ls ${index}`,
      agentId: CHILD
    } as const;
    return [
      runtimeEvent("item.started", { ...payload, status: "inProgress" }, item),
      runtimeEvent("item.completed", { ...payload, status: "completed" }, item)
    ];
  }

  const toolCalls = (count: number): RuntimeEvent[] =>
    Array.from({ length: count }, (_, index) => toolCall(index)).flat();

  interface Shape {
    adapter: string;
    /** The first run's launch id, then the relaunch's. */
    launches: [string, string];
    /** A run's rows from its start. */
    run: (toolUseId: string) => RuntimeEvent[];
    /** A run's end, as the adapter writes it. */
    end: (toolUseId: string, result: string) => RuntimeEvent[];
    /** What the relaunched run's end folds to. */
    settled: { status: string; result: string | null };
  }

  const shapes: Shape[] = [
    {
      adapter: "OpenCode",
      launches: ["call_first", "call_resume"],
      // The parent's running `task` part starts it; the child's busy status.
      run: (toolUseId) => [
        task("task.started", { toolUseId, description: "list files" }),
        task("task.progress", { toolUseId, description: "list files", status: "running" }),
        task("task.updated", { toolUseId, status: "running" })
      ],
      // The child's idle status, then its end — carrying the `task` part's
      // output when the part settled first.
      end: (toolUseId, result) => [
        task("task.updated", { toolUseId, status: "idle" }),
        task("task.completed", { toolUseId, status: "completed", summary: result })
      ],
      settled: { status: "completed", result: "second result" }
    },
    {
      adapter: "Codex",
      launches: ["codex-launch:sub-1", "codex-run:child-turn-2"],
      // The launch record, or the child's own turn, starts it; the turn is a
      // progress row — ONE row, replaced in place at its first position.
      run: (toolUseId) => [
        task("task.started", { toolUseId, description: "explorer", agentPath: "/root/explorer" }),
        task("task.progress", { description: `agent ${CHILD}`, status: "running" })
      ],
      // The child's `turn/completed` (a resumable child rests `idle`), then the
      // parent's `subAgentActivity completed`, which carries no result.
      end: () => [
        task("task.updated", { status: "idle" }),
        task("task.completed", { status: "completed" })
      ],
      settled: { status: "completed", result: null }
    }
  ];

  async function ingestAll(
    ingestion: ReturnType<typeof harness>["ingestion"],
    events: readonly RuntimeEvent[]
  ): Promise<void> {
    for (const event of events) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
  }

  function child(state: ReturnType<typeof fold>) {
    const agent = state.roster.find((row) => row.id === CHILD);
    assert.ok(agent, `roster had ${JSON.stringify(state.roster.map((row) => row.id))}`);
    return agent;
  }

  for (const shape of shapes) {
    const [first, relaunch] = shape.launches;

    it(`${shape.adapter}: a relaunch reads running (run 2), then its new result`, async () => {
      const { ingestion, sink } = harness();
      await ingestAll(ingestion, [
        runtimeEvent("turn.started", {}, turn),
        ...shape.run(first),
        ...shape.end(first, "first result")
      ]);
      assert.equal(fold(sink.events()).head?.session.status, "running", "a live session");
      assert.equal(child(fold(sink.events())).status, "completed");

      // The START reopens it — the one row of the run retention never drops.
      const [start, ...rest] = shape.run(relaunch);
      assert.ok(start);
      await ingestAll(ingestion, [start]);
      const live = child(fold(sink.events()));
      assert.equal(live.status, "running");
      assert.equal(live.activationCount, 2);
      assert.equal(live.result, null, "the previous run's result is cleared");

      await ingestAll(ingestion, rest);
      assert.equal(child(fold(sink.events())).status, "running");
      await ingestAll(ingestion, shape.end(relaunch, "second result"));
      const settled = child(fold(sink.events()));
      assert.equal(settled.status, shape.settled.status);
      assert.equal(settled.result, shape.settled.result);
      assert.equal(settled.activationCount, 2);
    });

    it(`${shape.adapter}: a relaunched run survives 300 agent-owned tool calls`, async () => {
      const { ingestion, sink } = harness();
      await ingestAll(ingestion, [
        runtimeEvent("turn.started", {}, turn),
        ...shape.run(first),
        ...shape.end(first, "first result"),
        ...shape.run(relaunch),
        ...toolCalls(300)
      ]);
      const state = fold(sink.events());
      assert.equal(state.evicted?.activities, true, "the agent's window was trimmed");
      assert.ok(
        !state.activities.some((row) => row.activityKind === "task.updated"),
        "every status row of both runs is gone"
      );
      // The launches and the first run's end are anchors retention never drops.
      const agent = child(state);
      assert.equal(agent.status, "running");
      assert.equal(agent.activationCount, 2);
    });
  }

  it("a status-only reopen does NOT survive retention: why adapters start again", async () => {
    // An appended status row reopens a settled agent too — it is all an agent
    // launched before the contract gets, since its first start names no call
    // — but it is an ordinary row of the agent's window: once retention drops
    // it, the old end reads again while the agent works.
    const [opencode] = shapes;
    assert.ok(opencode);
    const { ingestion, sink } = harness();
    await ingestAll(ingestion, [
      runtimeEvent("turn.started", {}, turn),
      ...opencode.run("call_first"),
      ...opencode.end("call_first", "first result"),
      task("task.updated", { toolUseId: "call_resume", status: "running" })
    ]);
    const reopened = child(fold(sink.events()));
    assert.equal(reopened.status, "running");
    assert.equal(reopened.activationCount, 2);

    await ingestAll(ingestion, toolCalls(300));
    const evicted = child(fold(sink.events()));
    assert.equal(evicted.status, "completed", "the old end reads again, mid-run");
    assert.equal(evicted.activationCount, 1);
    assert.equal(evicted.result, "first result");
  });
});
