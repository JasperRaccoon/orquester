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
  type ThreadActivityItem,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { countingIds, fixedClock, replayClaudeFixture } from "../adapters/claude/fixtures.ts";
import { ClaudeNormalizer } from "../adapters/claude/normalize.ts";
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

describe("a Claude subagent's calls, from the normaliser through the real fold", () => {
  /** Every tool row of each call, keyed by `payload.toolUseId`. */
  function callRows(state: ReturnType<typeof fold>): Map<string, ThreadActivityItem[]> {
    const calls = new Map<string, ThreadActivityItem[]>();
    for (const row of activities(state)) {
      if (!row.activityKind.startsWith("tool.")) continue;
      const callId = (row.payload as { toolUseId?: unknown } | null)?.toolUseId;
      if (typeof callId !== "string") continue;
      calls.set(callId, [...(calls.get(callId) ?? []), row]);
    }
    return calls;
  }

  const LIFECYCLE = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);

  it("07: every output row of an agent-owned call carries the call's agentId", async () => {
    const { ingestion, sink } = harness();
    for (const event of replayClaudeFixture("07-subagent-task.ndjson").events) {
      await ingestion.ingest({ ...event, threadId: THREAD_ID });
    }
    await ingestion.drain();

    let checked = 0;
    for (const [callId, rows] of callRows(fold(sink.events()))) {
      const owner = rows.find((row) => LIFECYCLE.has(row.activityKind) && row.agentId)?.agentId;
      if (owner === undefined) continue;
      for (const row of rows.filter((entry) => entry.activityKind === "tool.output")) {
        assert.equal(row.agentId, owner, `${callId}'s output is its agent's, not the parent's`);
        checked += 1;
      }
    }
    assert.equal(checked, 1, "the capture's one subagent Bash result");
  });

  it("a background agent's call keeps one turn and one owner past the parent's result, and its words settle", async () => {
    const normalizer = new ClaudeNormalizer({
      threadId: THREAD_ID,
      clock: fixedClock(),
      ids: countingIds()
    });
    const events = [...normalizer.beginTurn({ turnId: "turn-1" })];
    const feed = (frame: Record<string, unknown>): void => {
      events.push(...normalizer.handleMessage({ uuid: "u", session_id: "s", ...frame } as unknown as SDKMessage));
    };
    const nested = (content: unknown[], type: "assistant" | "user" = "assistant") =>
      feed({
        type,
        parent_tool_use_id: "toolu_A",
        message: { role: type, ...(type === "assistant" ? { model: "claude-sonnet-5" } : {}), content }
      });
    // The parent launches a BACKGROUND agent (CLI 2.1.280's default): its
    // Agent call answers at once, and the agent works on after the result.
    feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "bg", prompt: "p" } }
      }
    });
    feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-A",
      tool_use_id: "toolu_A",
      description: "bg",
      task_type: "local_agent",
      is_backgrounded: true
    });
    feed({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "Async agent launched." }] }
    });
    nested([{ type: "tool_use", id: "toolu_X", name: "Bash", input: { command: "sleep 5; echo x" } }]);
    feed({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      stop_reason: "end_turn",
      num_turns: 1,
      usage: {},
      modelUsage: {},
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      permission_denials: []
    });
    // Everything below lands between parent turns.
    nested([{ type: "tool_result", tool_use_id: "toolu_X", content: "x\n" }], "user");
    nested([{ type: "tool_use", id: "toolu_Y", name: "Bash", input: { command: "ls" } }]);
    nested([{ type: "tool_result", tool_use_id: "toolu_Y", content: "a.txt\nb.txt\n" }], "user");
    nested([{ type: "thinking", thinking: "Both files are there." }]);
    nested([{ type: "text", text: "Found a.txt and b.txt." }]);
    feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-A",
      tool_use_id: "toolu_A",
      status: "completed",
      output_file: "",
      summary: "Found both."
    });

    const { ingestion, sink } = harness();
    for (const event of events) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
    const state = fold(sink.events());
    const calls = callRows(state);

    for (const [callId, turnId] of [
      ["toolu_X", "turn-1"],
      ["toolu_Y", null]
    ] as const) {
      const rows = calls.get(callId) ?? [];
      assert.deepEqual(
        rows.map((row) => row.activityKind),
        ["tool.started", "tool.updated", "tool.output", "tool.completed"],
        `${callId}: started, its result, its output, its end — once each`
      );
      assert.deepEqual(
        [...new Set(rows.map((row) => `${row.turnId}|${row.agentId}`))],
        [`${turnId}|task-A`],
        `${callId}: one call, one turn key, one owner`
      );
      const completed = rows.at(-1)!;
      assert.equal(completed.status, "completed", `${callId} finished for real`);
      assert.ok(
        (completed.payload as { data?: { result?: unknown } }).data?.result !== undefined,
        `${callId}'s completion carries its real result`
      );
    }

    const agentMessages = messages(state).filter((message) => message.agentId === "task-A");
    assert.deepEqual(
      agentMessages.map((message) => [message.role, message.text, message.turnId, message.streaming]),
      [
        ["reasoning", "Both files are there.", null, false],
        ["assistant", "Found a.txt and b.txt.", null, false]
      ],
      "a background agent's words settle between parent turns"
    );
  });

  it("a woken parent's call rides its synthetic turn, so a rewind to before that turn removes it", async () => {
    const normalizer = new ClaudeNormalizer({
      threadId: THREAD_ID,
      clock: fixedClock(),
      ids: countingIds()
    });
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      stop_reason: "end_turn",
      num_turns: 1,
      usage: {},
      modelUsage: {},
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      permission_denials: []
    };
    const events = [...normalizer.beginTurn({ turnId: "turn-1" })];
    const feed = (frame: Record<string, unknown>): void => {
      events.push(...normalizer.handleMessage({ uuid: "u", session_id: "s", ...frame } as unknown as SDKMessage));
    };
    feed(result);
    // Woken between prompts, the parent streams a tool_use BEFORE the complete
    // frame that opens its synthetic turn.
    feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "msg_wake", role: "assistant", content: [], usage: {} } }
    });
    feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_P", name: "Bash", input: { command: "cat out.txt" } }
      }
    });
    feed({
      type: "assistant",
      uuid: "u-wake",
      parent_tool_use_id: null,
      message: {
        id: "msg_wake",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "toolu_P", name: "Bash", input: { command: "cat out.txt" } }]
      }
    });
    feed({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_P", content: "done\n" }] }
    });
    feed(result);

    const { ingestion, sink } = harness();
    for (const event of events) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
    const state = fold(sink.events());
    const synthetic = state.turns.find((turn) => turn.turnId !== "turn-1");
    assert.ok(synthetic?.turnId, "the woken parent's answer is a turn of its own");
    const rowsOf = (folded: ReturnType<typeof fold>) =>
      (callRows(folded).get("toolu_P") ?? []).map((row) => [row.activityKind, row.turnId]);
    assert.deepEqual(rowsOf(state), [
      ["tool.started", null],
      ["tool.updated", synthetic.turnId],
      ["tool.output", synthetic.turnId],
      ["tool.completed", synthetic.turnId]
    ]);

    // Rewind to turn 1: the synthetic turn goes, and the call with it. Its
    // start row went out before the turn existed and stays, as it always has.
    const reverted = applyDomainEvent(state, {
      seq: state.seq + 1,
      eventId: "revert",
      threadId: THREAD_ID,
      occurredAt: "2026-09-21T10:05:00.000Z",
      commandId: null,
      causationEventId: null,
      metadata: {},
      type: "thread.reverted",
      payload: { turnCount: 1 }
    });
    assert.deepEqual(rowsOf(reverted), [["tool.started", null]]);
  });
});
