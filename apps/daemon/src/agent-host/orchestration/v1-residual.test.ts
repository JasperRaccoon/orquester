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
  RuntimeEvent,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type { StartSessionInput } from "../adapter.ts";
import type { AppendableDomainEvent } from "../services.ts";

import { projectDirFor } from "../adapters/opencode/index.ts";
import { isAgentChatCommandError } from "./errors.ts";
import { stampHistoryTimes } from "./orchestrator.ts";
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
    // The real key function, not a restatement of it: this is what the pool
    // hashes, and it took the `cwd` fallback for the whole fix wave.
    assert.equal(projectDirFor(input), "/work/project");
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
// S1-5 — the host-wide sweep has a scheduler
// ---------------------------------------------------------------------------

describe("S1-5: the host-wide housekeeping sweep actually runs", () => {
  it("sweeps at boot and on the interval, argument-less, and stops with the host", async () => {
    const host = createTestHost();
    await host.settle();
    // The argument-less form is the ONLY one that reaches the cross-thread
    // raw-log ceiling; a per-thread call does not.
    const hostWide = (): number => host.store.pruneCalls.filter((call) => call === undefined).length;
    assert.equal(hostWide(), 1, "the gate opening sweeps once");

    host.timers.runDue(60 * 60_000);
    await host.settle();
    assert.equal(hostWide(), 2, "and again on the interval");

    await host.stop();
    const afterStop = hostWide();
    host.timers.runDue(24 * 60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hostWide(), afterStop, "a stopped host sweeps nothing further");
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
        isAgentChatCommandError(error) &&
        error.code === "INVALID_COMMAND" &&
        /permission selector/.test(error.message)
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

function historyEvents(threadId: string, snapshot: ThreadSnapshot): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const raw = { source: HISTORICAL_RAW_SOURCE, payload: null };
  for (const turn of snapshot.turns) {
    out.push({
      eventId: `h-${turn.id}-start`,
      threadId,
      // Stamped "now", as every adapter did at first — the host is what must
      // push these behind the thread's own rows.
      createdAt: new Date(1_700_000_000_000).toISOString(),
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
        createdAt: new Date(1_700_000_000_000).toISOString(),
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
      createdAt: new Date(1_700_000_000_000).toISOString(),
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
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot)
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
    await host.stop();
  });

  it("orders the old conversation ABOVE the new prompt", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      history: RESUMED,
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot)
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
      Date.parse(rows[0]!.occurredAt) < Date.parse(created),
      "history is stamped before the thread was created, so a time sort agrees with the log"
    );
    await host.stop();
  });
});

describe("stampHistoryTimes: history never claims to have happened just now", () => {
  const anchor = "2026-09-01T12:00:00.000Z";

  it("pushes a `now`-stamped row behind the thread's creation, in order", () => {
    const stamped = stampHistoryTimes(
      [{ createdAt: "2026-09-01T12:00:05.000Z" }, { createdAt: "2026-09-01T12:00:06.000Z" }],
      anchor
    );
    const times = stamped.map((row) => Date.parse(row.createdAt));
    assert.ok(times[0]! < Date.parse(anchor));
    assert.ok(times[1]! < Date.parse(anchor));
    assert.ok(times[0]! < times[1]!, "the adapter's order survives");
  });

  it("keeps a real transcript timestamp exactly as the adapter read it", () => {
    const real = "2026-08-30T09:15:00.000Z";
    const stamped = stampHistoryTimes([{ createdAt: real }], anchor);
    assert.equal(stamped[0]?.createdAt, real);
  });

  it("treats an unparseable stamp as missing rather than dropping the row", () => {
    const stamped = stampHistoryTimes([{ createdAt: "not a date" }], anchor);
    assert.equal(stamped.length, 1);
    assert.ok(Date.parse(stamped[0]!.createdAt!) < Date.parse(anchor));
  });
});
