/**
 * History replay (E6), driven by the FOUR adapters' own `projectHistory`
 * output rather than by hand-built events.
 *
 * A resumed thread replays nothing onto its message stream (§4.5), so its
 * timeline is rebuilt from the provider's native transcript. What this file
 * pins is the half ingestion owns: a replayed transcript becomes messages,
 * activities and settled turns — and touches nothing that is live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HISTORICAL_RAW_SOURCE,
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadMessageItem,
  type ThreadSnapshot
} from "@orquester/api/agent-chat";

import { projectClaudeHistory } from "../adapters/claude/project-history.ts";
import { projectCodexHistory } from "../adapters/codex/history.ts";
import {
  GROK_HISTORY_RAW_METHOD,
  projectGrokHistory
} from "../adapters/grok/history.ts";
import { projectOpenCodeHistory } from "../adapters/opencode/history.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  runtimeEvent
} from "./test-harness.ts";

const THREAD_ID = "t1";

function harness() {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const liveness = new RecordingLiveness();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    slim: (payload) => payload,
    placeholderCheckpoint: () => {
      throw new Error("history must never mint a checkpoint");
    }
  });
  return { ingestion, sink, liveness, timers };
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
// Per-adapter replay, from each adapter's real projection
// ---------------------------------------------------------------------------

describe("E6: a replayed transcript rebuilds the timeline", () => {
  it("claude: the user's own prompts survive the replay", async () => {
    const snapshot: ThreadSnapshot = {
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            {
              type: "user",
              message: { role: "user", content: [{ type: "text", text: "add a test" }] },
              uuid: "u1",
              timestamp: "2026-09-21T10:00:00.000Z"
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Added it." }]
              },
              uuid: "a1",
              timestamp: "2026-09-21T10:00:05.000Z"
            }
          ]
        }
      ]
    };
    const events = projectClaudeHistory(snapshot, {
      ids: counterIdGen("ce"),
      clock: new FakeClock()
    });
    assert.ok(events.length > 0, "the projection produced nothing to ingest");
    for (const event of events) {
      assert.equal(event.raw?.source, HISTORICAL_RAW_SOURCE);
    }

    const { sink } = await replay(events);
    const text = roleText(sink.events());
    assert.ok(
      text.includes("user:add a test"),
      `the user's prompt is missing from ${JSON.stringify(text)}`
    );
    assert.ok(text.some((entry) => entry.startsWith("assistant:")));
  });

  it("codex: user and assistant items both become messages", async () => {
    const snapshot: ThreadSnapshot = {
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
            { type: "agentMessage", id: "a1", text: "hi there" }
          ]
        }
      ]
    };
    const drafts = projectCodexHistory(snapshot);
    assert.ok(drafts.length > 0);
    const events = drafts.map(
      (draft, index) =>
        ({
          eventId: `xe${index}`,
          threadId: THREAD_ID,
          createdAt: "2026-09-21T10:00:00.000Z",
          ...draft
        }) as RuntimeEvent
    );
    for (const event of events) {
      assert.equal(event.raw?.source, HISTORICAL_RAW_SOURCE);
    }

    const { sink } = await replay(events);
    assert.deepEqual(roleText(sink.events()), ["user:hello", "assistant:hi there"]);
  });

  it("opencode: a user text part becomes the user's message", async () => {
    const snapshot: ThreadSnapshot = {
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            { id: "m1", role: "user", time: { created: 1_789_000_000_000 } },
            { id: "m2", role: "assistant", time: { created: 1_789_000_001_000 } },
            { id: "p1", messageID: "m1", type: "text", text: "run the tests" },
            { id: "p2", messageID: "m2", type: "text", text: "All green." }
          ]
        }
      ]
    };
    const events = projectOpenCodeHistory(snapshot, {
      eventId: (() => {
        let n = 0;
        return () => `oe${++n}`;
      })(),
      nowIso: () => "2026-09-21T10:00:00.000Z"
    });
    assert.ok(events.length > 0);
    const { sink } = await replay(events);
    const text = roleText(sink.events());
    assert.ok(text.includes("user:run the tests"), JSON.stringify(text));
    assert.ok(text.includes("assistant:All green."));
  });

  it("grok: its replay marker is recognised even though it keeps its live source", async () => {
    const snapshot: ThreadSnapshot = {
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            { kind: "user_message", text: "what changed?" },
            { kind: "assistant_message", text: "Three files." }
          ]
        }
      ]
    };
    let n = 0;
    const events = projectGrokHistory(snapshot, {
      threadId: THREAD_ID,
      stamp: () => ({ eventId: `ge${++n}`, createdAt: "2026-09-21T10:00:00.000Z" })
    });
    assert.ok(events.length > 0);
    // The compatibility shim this test exists to pin: grok marks the replay on
    // `raw.method`, not `raw.source`. If W9 moves to the shared constant this
    // assertion is what says the shim may go.
    assert.equal(events[0]?.raw?.method, GROK_HISTORY_RAW_METHOD);
    assert.notEqual(events[0]?.raw?.source, HISTORICAL_RAW_SOURCE);

    const { sink, liveness } = await replay(events);
    assert.deepEqual(roleText(sink.events()), ["user:what changed?", "assistant:Three files."]);
    // The real point: it was NOT treated as live.
    assert.equal(sink.ofType("thread.session-set").length, 0);
    assert.deepEqual(liveness.observed, []);
  });
});

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
    const { liveness, sink } = await replay([
      historical("turn.started", {}, { turnId: "turn-1" }),
      historical("task.started", { taskId: "task-1", taskType: "subagent" }, {
        turnId: "turn-1"
      }),
      // The harness's placeholderCheckpoint THROWS; reaching it fails the test.
      historical("turn.diff.updated", { unifiedDiff: "d" }, { turnId: "turn-1" }),
      historical("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    assert.deepEqual(liveness.observed, [], "a replayed task is not live work");
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
