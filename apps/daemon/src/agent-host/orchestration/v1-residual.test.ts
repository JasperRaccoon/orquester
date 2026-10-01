/**
 * V1 verification residuals owned by W1, plus E2E round 2's R2-2.
 *
 * Every case here pins a behaviour the fix wave *claimed* and the verification
 * found missing, so each one must fail against the pre-fix code — not merely
 * exercise the neighbourhood of the fix (FIX-WAVE §2).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORICAL_RAW_SOURCE } from "@orquester/api/agent-chat";
import type {
  DomainEvent,
  HistoryImportProgress,
  RuntimeEvent,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type { StartSessionInput } from "../adapter.ts";
import type { AppendableDomainEvent } from "../services.ts";

import { isAgentChatCommandError } from "./errors.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";

let seq = 0;
const cmd = (): string => `v1-${(seq += 1)}`;

function startInput(host: TestHost, adapterId = "claude"): StartSessionInput {
  const adapter = host.adapters.get(adapterId as never) ?? host.adapter;
  const call = adapter.calls.find((entry) => entry.kind === "startSession");
  assert.ok(call, "the adapter was never asked to start a session");
  return call.detail as StartSessionInput;
}

/** Messages in log order, as the timeline renders them. */
function messages(host: TestHost, threadId: string): Array<{ role: string; text: string }> {
  return (host.store.logs.get(threadId) ?? [])
    .filter(
      (event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent"
    )
    .map((event) => ({ role: event.payload.role, text: event.payload.text }));
}

// ---------------------------------------------------------------------------
// R4-6 — the OpenCode pool key
// ---------------------------------------------------------------------------

describe("R4-6: the production start passes the PROJECT, not just the cwd", () => {
  it("hands the project root to the adapter, so the pool keys on it", async () => {
    const host = createTestHost();
    // A thread opened on a SUBDIRECTORY — the case that spawns a second
    // `opencode serve` for one checkout when the pool falls back to `cwd`.
    const threadId = await host.createThread({ cwd: "/work/project/packages/ui" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    const input = startInput(host);
    assert.equal(input.projectPath, "/work/project");
    assert.equal(input.cwd, "/work/project/packages/ui");
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// R5-1 — §6.3 replay is a read, so it slims
// ---------------------------------------------------------------------------

const HUGE = "x".repeat(32_768);

/** One oversized tool row, as ingestion would persist it: full payload on disk. */
function translateBigToolRow(event: RuntimeEvent): AppendableDomainEvent[] {
  if (event.type !== "item.completed") return [];
  return [
    {
      eventId: `d-${event.eventId}`,
      threadId: event.threadId,
      occurredAt: event.createdAt,
      commandId: null,
      causationEventId: event.eventId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          id: "act-big",
          tone: "tool",
          activityKind: "tool.completed",
          summary: "a big command",
          payload: { itemType: "command_execution", status: "completed", output: HUGE },
          turnId: event.turnId ?? null,
          createdAt: event.createdAt,
          updatedAt: event.createdAt
        }
      }
    } as unknown as AppendableDomainEvent
  ];
}

describe("R5-1: a reconnect replay is slimmed like every other read", () => {
  it("does not ship the full persisted tool payload on the replay branch", async () => {
    const host = createTestHost();
    host.ingestion.translate = translateBigToolRow;
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const before = (host.store.logs.get(threadId) ?? []).length;

    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit({
      eventId: "big-1",
      threadId,
      createdAt: host.clock.nowIso(),
      turnId: host.adapter.turnIds[0],
      itemId: "item-big",
      type: "item.completed",
      payload: { itemType: "command_execution", status: "completed", output: HUGE }
    } as unknown as RuntimeEvent);
    host.adapter.close();
    await consumed;
    await host.settle();

    const appended = (host.store.logs.get(threadId) ?? []).filter(
      (event) => event.seq > before && event.type === "thread.activity-appended"
    );
    assert.equal(appended.length, 1, "the oversized row is on disk in full");
    assert.ok(JSON.stringify(appended).length > 32_768);

    // The §6.3 replay branch — what a reconnecting stream and `GET …/thread?
    // after=` both take. It shipped the row verbatim, `truncated` unset, so the
    // client could never offer "load full output" for it.
    const read = await host.orchestrator.readThread(threadId, before);
    assert.equal(read.kind, "events", "the range is small enough to replay");
    const wire = JSON.stringify(read.events).length;
    assert.ok(
      wire < 32_768,
      `a 32 KiB payload must not ship whole on a reconnect (got ${wire} bytes)`
    );
    const replayed = read.kind === "events" ? read.events : [];
    const activity = replayed.find((event) => event.type === "thread.activity-appended");
    assert.ok(activity, "the row is still replayed — slimmed, not dropped");
    const slimmed = (activity.payload as { activity: { payload: { truncated?: boolean } } })
      .activity.payload;
    assert.equal(slimmed.truncated, true, "and it says so, so the UI can offer the full read");
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// R2-7 — the refusal must precede the commit
// ---------------------------------------------------------------------------

describe("R2-7: a blocked provider command is refused before it is committed", () => {
  it("refuses Grok's /always-approve with 400 and appends nothing", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const threadId = await host.createThread({ refId: "grok" });
    const before = (host.store.logs.get(threadId) ?? []).length;

    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "turn", {
          commandId: cmd(),
          input: "/always-approve"
        }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    await host.settle();

    assert.equal(
      (host.store.logs.get(threadId) ?? []).length,
      before,
      "the user's message must not be on disk — the whole point of refusing early"
    );
    assert.equal(
      messages(host, threadId).length,
      0,
      "nothing rendered, so there is no bubble the user cannot take back"
    );
    // An ordinary turn on the same thread still works.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    assert.equal(messages(host, threadId).length, 1);
    await host.stop();
  });

  it("leaves the same text alone on another provider", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/always-approve"
    });
    await host.settle();
    assert.equal(messages(host, threadId).length, 1, "only Grok blocks it (§4.6.5(c))");
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// E2E round 2, R2-2 — history lands eagerly, and in the right order
// ---------------------------------------------------------------------------

const RESUMED: ThreadSnapshot = {
  threadId: "thread-1",
  turns: [
    {
      id: "old-1",
      items: [
        { role: "user", text: "Remember this token: KIWI-3355" },
        { role: "assistant", text: "OK" }
      ]
    }
  ]
};

function historyEvents(threadId: string, snapshot: ThreadSnapshot, createdAt = "not a date"): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const raw = { source: HISTORICAL_RAW_SOURCE, payload: null };
  for (const turn of snapshot.turns) {
    out.push({
      eventId: `h-${turn.id}-start`,
      threadId,
      // Missing/bad adapter timestamps are placed before this thread's own rows.
      createdAt,
      turnId: turn.id,
      type: "turn.started",
      payload: {},
      raw
    } as unknown as RuntimeEvent);
    for (const [index, item] of turn.items.entries()) {
      const { role, text } = item as { role: string; text: string };
      out.push({
        eventId: `h-${turn.id}-${index}`,
        threadId,
        createdAt,
        turnId: turn.id,
        itemId: `h-${turn.id}-${index}`,
        type: "item.completed",
        payload: {
          itemType: role === "user" ? "user_message" : "assistant_message",
          status: "completed",
          title: text,
          detail: text
        },
        raw
      } as unknown as RuntimeEvent);
    }
    out.push({
      eventId: `h-${turn.id}-end`,
      threadId,
      createdAt,
      turnId: turn.id,
      type: "turn.completed",
      payload: { state: "completed", tokenUsage: { usageStatus: "unavailable" } },
      raw
    } as unknown as RuntimeEvent);
  }
  return out;
}

/**
 * Ingestion is faked in this harness, so a projected `item.completed` only
 * reaches the log if the test says what it becomes. This mirrors what the real
 * ingestion does with a historical message item, and nothing more.
 */
function translateHistoryMessages(event: RuntimeEvent): AppendableDomainEvent[] {
  if (event.type !== "item.completed") return [];
  const payload = event.payload as { itemType?: string; detail?: string };
  if (payload.itemType !== "user_message" && payload.itemType !== "assistant_message") {
    return [];
  }
  return [
    {
      eventId: `d-${event.eventId}`,
      threadId: event.threadId,
      occurredAt: event.createdAt,
      commandId: null,
      causationEventId: event.eventId,
      type: "thread.message-sent",
      payload: {
        messageId: event.itemId ?? event.eventId,
        role: payload.itemType === "user_message" ? "user" : "assistant",
        text: payload.detail ?? "",
        streaming: false,
        turnId: event.turnId ?? null
      }
    } as unknown as AppendableDomainEvent
  ];
}

describe("E2E R2-2: a resumed tab fills itself, above the new prompt", () => {
  it("projects history on CREATE, without waiting for a turn", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      history: RESUMED,
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot, "2000-01-01T00:00:00.000Z")
    });
    const host = createTestHost({ adapters: { claude } });
    host.ingestion.translate = translateHistoryMessages;
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-1" }
    });
    // No `/turn`: this is a tab that was opened and not typed into. Before the
    // fix, `projectHistoryIfEmpty` ran from the lazy `ensureSession`, so this
    // read nothing at all and the tab stayed blank until the user typed.
    await host.settle();

    assert.deepEqual(
      messages(host, threadId).map((row) => row.text),
      ["Remember this token: KIWI-3355", "OK"],
      "the tab is not blank before the user types"
    );
    const historical = (host.store.logs.get(threadId) ?? []).filter((event) => event.type === "thread.message-sent");
    assert.ok(historical.every((event) => event.occurredAt === "2000-01-01T00:00:00.000Z"));
    await host.stop();
  });

  it("orders the old conversation ABOVE the new prompt", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      history: RESUMED,
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot).map((event, index) =>
        index === 2 ? { ...event, createdAt: "2099-01-01T00:00:00.000Z" } : event
      )
    });
    const host = createTestHost({ adapters: { claude } });
    host.ingestion.translate = translateHistoryMessages;
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-2" }
    });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "What was the token?"
    });
    await host.settle();

    assert.deepEqual(
      messages(host, threadId).map((row) => `${row.role}: ${row.text}`),
      ["user: Remember this token: KIWI-3355", "assistant: OK", "user: What was the token?"],
      "old prompt, old answer, new prompt — not new prompt first"
    );
    // …and the replayed rows do not claim to have happened after it.
    const rows = (host.store.logs.get(threadId) ?? []).filter(
      (event) => event.type === "thread.message-sent"
    );
    const created = host.store.heads.get(threadId)?.createdAt;
    assert.ok(created !== undefined);
    assert.ok(
      rows.slice(0, 2).every((event) => Date.parse(event.occurredAt) < Date.parse(created)),
      "history is stamped before the thread was created, so a time sort agrees with the log"
    );
    await host.stop();
  });

  it("commits a long history in chunks and tells the tab how far it is", async () => {
    const turns = Array.from({ length: 300 }, (_, index) => ({
      id: `long-${index}`,
      items: [
        { role: "user", text: `question ${index}` },
        { role: "assistant", text: `answer ${index}` }
      ]
    }));
    const claude = createScriptedAdapter({
      id: "claude",
      history: { threadId: "thread-1", turns },
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot)
    });
    // Held until the test is subscribed, so it sees the whole replay.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readThread = claude.readThread.bind(claude);
    claude.readThread = async (threadId) => {
      await gate;
      return readThread(threadId);
    };
    const host = createTestHost({ adapters: { claude } });
    host.ingestion.translate = translateHistoryMessages;
    const appendSizes: number[] = [];
    const append = host.store.append.bind(host.store);
    host.store.append = async (input) => {
      if (input.events.some((event) => event.type === "thread.message-sent")) {
        appendSizes.push(input.events.length);
      }
      return append(input);
    };
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-long" }
    });
    const progress: HistoryImportProgress[] = [];
    await host.orchestrator.subscribe(threadId, {
      onEvents: () => undefined,
      onHistoryImport: (step) => {
        progress.push(step);
      }
    });
    release();
    await host.settle();

    assert.equal(messages(host, threadId).length, 600, "every message landed, in order");
    assert.equal(messages(host, threadId)[599]?.text, "answer 299");
    assert.deepEqual(appendSizes, [500, 100], "500 events per commit, not one commit per event");
    const start = claude.calls.find((call) => call.kind === "startSession")?.detail as
      | StartSessionInput
      | undefined;
    assert.equal(start?.prefetchHistory, true, "the adapter may read the history while it starts");

    assert.equal(progress[0]?.phase, "reading", "the screen is up before the history is read");
    const importing = progress.filter((step) => step.phase === "importing");
    assert.ok(importing.length > 1, "progress moves during the import");
    assert.ok(importing.every((step) => step.total === 1200));
    assert.deepEqual(progress.at(-1), { phase: "done", done: 1200, total: 1200 });
    await host.stop();
  });
});
