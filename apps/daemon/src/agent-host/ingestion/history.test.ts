/** Historical runtime events rebuild the timeline without changing live work. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HISTORICAL_RAW_SOURCE,
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";
import { createLivenessRegistry } from "../orchestration/liveness.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  RecordingSink,
  counterIdGen,
  runtimeEvent
} from "./test-harness.ts";

const THREAD_ID = "t1";

function harness() {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const liveness = createLivenessRegistry();
  const checkpointCalls: string[] = [];
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen(),
    placeholderCheckpoint: ({ turnId }) => {
      checkpointCalls.push(turnId);
      return { turnCount: 1 };
    }
  });
  return { ingestion, sink, liveness, checkpointCalls };
}

async function replay(events: readonly RuntimeEvent[]) {
  const h = harness();
  for (const event of events) {
    await h.ingestion.ingest(event);
  }
  await h.ingestion.drain();
  return h;
}

function fold(events: AppendableDomainEvent[]) {
  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: THREAD_ID,
    occurredAt: "2026-09-21T09:00:00.000Z",
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

function messages(events: AppendableDomainEvent[]): ThreadMessageItem[] {
  return fold(events).items.filter(
    (item): item is ThreadMessageItem => item.kind === "message"
  );
}

function roleText(events: AppendableDomainEvent[]): string[] {
  return messages(events).map((message) => `${message.role}:${message.text}`);
}

// ---------------------------------------------------------------------------
// The invariants a replayed row owes, whatever produced it
// ---------------------------------------------------------------------------

let historicalCounter = 0;

/**
 * One replayed event. Built here rather than delegating to `runtimeEvent`, so
 * the payload keeps its own arm's type instead of collapsing to `never` when
 * the generic is re-forwarded.
 */
function historical<TType extends RuntimeEvent["type"]>(
  type: TType,
  payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<RuntimeEvent, "type" | "payload">> = {}
): RuntimeEvent {
  return {
    eventId: `he${++historicalCounter}`,
    threadId: THREAD_ID,
    createdAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
    raw: { source: HISTORICAL_RAW_SOURCE, payload: null },
    type,
    payload
  } as RuntimeEvent;
}

describe("E6: a replayed row never looks live", () => {
  it("a historical turn settles WITHOUT touching session status", async () => {
    const { sink } = await replay([
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "do it" },
        { turnId: "turn-1", itemId: "u1" }
      ),
      historical(
        "item.completed",
        { itemType: "assistant_message", status: "completed", detail: "done" },
        { turnId: "turn-1", itemId: "a1" }
      ),
      historical(
        "turn.completed",
        {
          state: "completed",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "unavailable",
            hasSubagents: false
          }
        },
        { turnId: "turn-1" }
      )
    ]);

    assert.equal(
      sink.ofType("thread.session-set").length,
      0,
      "history must not move the live session"
    );
    const state = fold(sink.events());
    assert.equal(state.head?.session.status, "idle");
    const turn = state.turns.find((entry) => entry.turnId === "turn-1");
    assert.ok(turn, "the replayed turn produced no row");
    assert.equal(turn.state, "completed");
    assert.equal(turn.tokenUsage?.usageStatus, "unavailable");
    assert.equal(turn.completedAt, "2026-09-21T10:00:00.000Z");
    assert.equal(turn.assistantMessageId, "assistant:a1");
  });

  it("a half-replayed transcript leaves NO running turn", async () => {
    const { sink } = await replay([historical("turn.started", {}, { turnId: "turn-1" })]);
    assert.equal(fold(sink.events()).turns.length, 0);
  });

  it("an interrupted historical turn replays as interrupted, not completed", async () => {
    const { sink } = await replay([
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical("turn.completed", { state: "interrupted" }, { turnId: "turn-1" })
    ]);
    assert.equal(fold(sink.events()).turns[0]?.state, "interrupted");
  });

  it("history feeds neither liveness nor the checkpoint service", async () => {
    const { liveness, sink, checkpointCalls } = await replay([
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical("task.started", { taskId: "task-1", taskType: "subagent" }, {
        turnId: "turn-1"
      }),
      historical("turn.diff.updated", { unifiedDiff: "d" }, { turnId: "turn-1" }),
      historical("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    assert.equal(liveness.liveAgentCount(THREAD_ID), 0, "a replayed task is not live work");
    assert.deepEqual(checkpointCalls, [], "history never invokes checkpoint creation");
    assert.equal(sink.ofType("thread.turn-diff-completed").length, 0);
  });

  it("a replayed provider name never retitles the thread", async () => {
    const { sink } = await replay([
      historical("thread.metadata.updated", { name: "An old name" })
    ]);
    assert.equal(sink.ofType("thread.meta-updated").length, 0);
  });

  it("replayed messages are complete, never streaming", async () => {
    const { sink } = await replay([
      historical(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "hi" },
        { turnId: "turn-1", itemId: "u1" }
      ),
      historical(
        "item.completed",
        { itemType: "reasoning", status: "completed", detail: "thinking" },
        { turnId: "turn-1", itemId: "r1" }
      )
    ]);
    assert.deepEqual(roleText(sink.events()), ["user:hi", "reasoning:thinking"]);
    for (const message of sink.messages()) {
      assert.equal(message.payload.streaming, false);
    }
    for (const message of messages(sink.events())) {
      assert.equal(message.streaming, false);
      assert.equal(message.attachments, undefined, "the bytes are long gone");
      assert.equal(message.context, undefined, "composer chips were never in the transcript");
    }
  });

  it("the FULL text wins over an elided detail", async () => {
    // Claude puts the row label in `detail` and the whole message in
    // `data.text`; reading `detail` would replay a truncated conversation.
    const { sink } = await replay([
      historical(
        "item.completed",
        {
          itemType: "user_message",
          status: "completed",
          detail: "the beginning…",
          data: { text: "the beginning, the middle and the end" }
        },
        { turnId: "turn-1", itemId: "u1" }
      )
    ]);
    assert.deepEqual(roleText(sink.events()), [
      "user:the beginning, the middle and the end"
    ]);
  });

  it("one user message per replayed turn, however many items echo it", async () => {
    const { sink } = await replay([
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "once" },
        { turnId: "turn-1", itemId: "u1" }
      ),
      historical(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "twice" },
        { turnId: "turn-1", itemId: "u2" }
      ),
      historical("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    assert.deepEqual(roleText(sink.events()), ["user:once"]);
  });

  it("a replayed tool call is still an activity row", async () => {
    const { sink } = await replay([
      historical(
        "item.completed",
        { itemType: "command_execution", status: "completed", title: "Bash", detail: "ls" },
        { turnId: "turn-1", itemId: "call-1" }
      )
    ]);
    assert.deepEqual(sink.activityKinds(), ["tool.completed"]);
    assert.equal(
      (sink.activities()[0]!.payload.activity.payload as { toolUseId: string }).toolUseId,
      "call-1"
    );
  });

  it("replaying the same transcript twice rewrites the rows, never duplicates them", async () => {
    const events = [
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "hi" },
        { turnId: "turn-1", itemId: "u1" }
      )
    ];
    const first = await replay(events);
    const second = await replay(events);
    // Ids are derived from the provider's own item ids, so the fold upserts.
    assert.deepEqual(
      messages(first.sink.events()).map((message) => message.id),
      messages(second.sink.events()).map((message) => message.id)
    );
    assert.equal(messages([...first.sink.events(), ...second.sink.events()]).length, 1);
  });
});

describe("E6: a LIVE user_message is never a row", () => {
  it("the provider echoing the prompt does not duplicate what /turn appended", async () => {
    // Codex echoes the prompt back as an item; `/turn` already appended the
    // user's message, so ingestion must stay silent.
    const { sink } = await replay([
      runtimeEvent("turn.started", {}, { turnId: "turn-1" }),
      runtimeEvent(
        "item.completed",
        { itemType: "user_message", status: "completed", detail: "the prompt" },
        { turnId: "turn-1", itemId: "u1" }
      )
    ]);
    assert.deepEqual(sink.messages(), []);
  });
});
