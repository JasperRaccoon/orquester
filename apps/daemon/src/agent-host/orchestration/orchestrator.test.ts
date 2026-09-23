import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  applyDomainEvent,
  createEmptyThreadState,
  decodeHistoryCursor,
  encodeHistoryCursor,
  foldThread,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadHistoryPage,
  type ThreadItem
} from "@orquester/api/agent-chat";

import { appendAttachmentPathLines } from "../adapters/attachment-lines.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { isAgentChatCommandError } from "./errors.ts";
import { applyEventsChunked, FOLD_CHUNK_SIZE } from "./fold-ops.ts";
import { createFakeThreadIndex } from "./testing/fake-index.ts";
import {
  FOLD_SNAPSHOT_EVENT_INTERVAL,
  FOLD_SNAPSHOT_MIN_INTERVAL_MS,
  HISTORY_PAGE_ACTIVITIES
} from "./orchestrator.ts";
import { createTestHost, createScriptedAdapter, type TestHost } from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `cmd-${(commandSeq += 1)}`;

function activityEvents(host: TestHost, threadId = "thread-1"): ThreadActivityItem[] {
  return (host.store.logs.get(threadId) ?? [])
    .filter((event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
      event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

function typesOf(host: TestHost, threadId = "thread-1"): string[] {
  return (host.store.logs.get(threadId) ?? []).map((event) => event.type);
}

/** Push an approval request into the thread the way ingestion would. */
async function openApproval(
  host: TestHost,
  requestId: string,
  threadId = "thread-1"
): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `ingest-${requestId}`,
      threadId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          id: `approval:${requestId}`,
          tone: "approval",
          activityKind: "approval.requested",
          summary: "Run a command?",
          payload: { requestId, requestKind: "command" },
          turnId: null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

async function openQuestion(
  host: TestHost,
  requestId: string,
  options: { dismissible: boolean; turnId?: string | null },
  threadId = "thread-1"
): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `ingest-q-${requestId}`,
      threadId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          id: `question:${requestId}`,
          tone: "approval",
          activityKind: "user-input.requested",
          summary: "Which branch?",
          payload: {
            requestId,
            questions: [{ id: "Which branch?", header: "Branch", question: "Which branch?", options: [] }],
            ...(options.dismissible ? { responseMode: "message" } : {}),
            dismissible: options.dismissible
          },
          turnId: options.turnId ?? null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

describe("orchestrator — commands", () => {
  it("a turn persists the user message, opens a pending turn and sends it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const receipt = await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "hello"
    });
    await host.settle();

    assert.ok(receipt.seq > 0);
    assert.deepEqual(typesOf(host).slice(1), [
      "thread.message-sent",
      "thread.turn-start-requested",
      "thread.session-set", // startSession
      "thread.session-set" // cursor persisted on the turn
    ]);
    assert.equal(host.adapter.lastTurn?.input, "hello");
    assert.equal(host.adapter.calls.filter((call) => call.kind === "startSession").length, 1);
    await host.stop();
  });

  it("never rewrites the turn text of a slash invocation (§4.6.9)", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/review src/index.ts"
    });
    await host.settle();
    assert.equal(host.adapter.lastTurn?.input, "/review src/index.ts");
    await host.stop();
  });

  it("rejects an empty turn and an over-long one", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () => host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "   " }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.code === "INVALID_COMMAND" && error.status === 400
    );
    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "turn", {
          commandId: cmd(),
          input: "x".repeat(120_001)
        }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });

  it("rejects an unknown approval decision", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "approval", {
          commandId: cmd(),
          requestId: "r1",
          decision: "maybe"
        }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });

  it("answers THREAD_NOT_FOUND for an unknown thread", async () => {
    const host = createTestHost();
    await assert.rejects(
      () => host.orchestrator.command("nope", "turn", { commandId: cmd(), input: "hi" }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.code === "THREAD_NOT_FOUND" && error.status === 404
    );
    await host.stop();
  });

  it("steering reuses the active turn and opens no second turn row", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "steer" });
    await host.settle();

    const starts = (host.store.logs.get(threadId) ?? []).filter(
      (event) => event.type === "thread.turn-start-requested"
    );
    assert.equal(starts.length, 1, "steering does not open a second turn");
    const sends = host.adapter.calls.filter((call) => call.kind === "sendTurn");
    assert.equal(sends.length, 2);
    assert.equal(host.adapter.calls.filter((call) => call.kind === "startSession").length, 1);
    await host.stop();
  });

  it("dismiss closes a dismissible question and refuses a native one", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await openQuestion(host, "q-async", { dismissible: true });
    await openQuestion(host, "q-native", { dismissible: false });

    await host.orchestrator.command(threadId, "dismiss", {
      commandId: cmd(),
      requestId: "q-async"
    });
    await host.settle();
    const dismissal = activityEvents(host).find((row) => row.id === "async-dismiss:q-async");
    assert.ok(dismissal, "the deterministic dismissal row is appended");
    assert.equal(dismissal?.summary, "User input dismissed");
    assert.equal(dismissal?.tone, "info");
    assert.equal(dismissal?.activityKind, "user-input.resolved");
    // The agent is not messaged.
    assert.equal(
      host.adapter.calls.filter((call) => call.kind === "respondToUserInput").length,
      0
    );

    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "dismiss", {
          commandId: cmd(),
          requestId: "q-native"
        }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_REJECTED" &&
        /needs an answer/.test(error.message)
    );
    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "dismiss", {
          commandId: cmd(),
          requestId: "q-async"
        }),
      (error: unknown) =>
        isAgentChatCommandError(error) && /already been answered/.test(error.message)
    );
    await host.stop();
  });
});

describe("orchestrator — receipts (§6.2)", () => {
  it("replays the recorded sequence for a repeated commandId", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const commandId = cmd();
    const first = await host.orchestrator.command(threadId, "turn", {
      commandId,
      input: "hello"
    });
    await host.settle();
    const second = await host.orchestrator.command(threadId, "turn", {
      commandId,
      input: "hello"
    });
    await host.settle();
    assert.equal(second.seq, first.seq);
    assert.equal(host.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await host.stop();
  });

  it("a commandId recorded against another thread is COMMAND_ID_CONFLICT", async () => {
    const host = createTestHost();
    await host.createThread({ threadId: "thread-1" });
    await host.createThread({ threadId: "thread-2" });
    const commandId = cmd();
    await host.orchestrator.command("thread-1", "turn", { commandId, input: "hello" });
    await host.settle();
    await assert.rejects(
      () => host.orchestrator.command("thread-2", "turn", { commandId, input: "hello" }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_ID_CONFLICT" &&
        error.status === 409
    );
    await host.stop();
  });

  it("a rejected commandId replays the rejection instead of retrying", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const commandId = cmd();
    await assert.rejects(
      () => host.orchestrator.command(threadId, "turn", { commandId, input: "" }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    // The retry must not turn a validation failure into a second attempt.
    await assert.rejects(
      () => host.orchestrator.command(threadId, "turn", { commandId, input: "now valid" }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    assert.equal(host.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    await host.stop();
  });

  it("requires a commandId", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () => host.orchestrator.command(threadId, "turn", { input: "hi" }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });
});

describe("orchestrator — approvals", () => {
  it("two clients racing one approval resolve deterministically", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openApproval(host, "req-1");
    await host.settle();

    host.adapter.failNext("failApproval", new Error("request already resolved"));
    const [a, b] = await Promise.all([
      host.orchestrator.command(threadId, "approval", {
        commandId: cmd(),
        requestId: "req-1",
        decision: "accept"
      }),
      host.orchestrator.command(threadId, "approval", {
        commandId: cmd(),
        requestId: "req-1",
        decision: "decline"
      })
    ]);
    await host.settle();

    // Both are accepted and ordered; the loser's provider call becomes a row.
    assert.notEqual(a.seq, b.seq);
    assert.ok(a.seq < b.seq);
    const failures = activityEvents(host).filter(
      (row) => row.activityKind === "provider.approval.respond.failed"
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.tone, "error");
    await host.stop();
  });

  it("an approval with no live session appends a failure row, not an HTTP error", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const result = await host.orchestrator.command(threadId, "approval", {
      commandId: cmd(),
      requestId: "req-x",
      decision: "accept"
    });
    await host.settle();
    assert.ok(result.seq > 0);
    const failures = activityEvents(host).filter(
      (row) => row.activityKind === "provider.approval.respond.failed"
    );
    assert.equal(failures.length, 1);
    await host.stop();
  });
});

describe("orchestrator — interrupt (§4.1, §6.2)", () => {
  it("settles every pending request as cancel BEFORE interrupting", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openApproval(host, "req-1");
    await openQuestion(host, "q-1", { dismissible: false });
    await host.settle();

    await host.orchestrator.command(threadId, "interrupt", {
      commandId: cmd(),
      turnId: host.adapter.turnIds[0]
    });
    await host.settle();

    const order = host.adapter.calls.map((call) => call.kind);
    const cancelIndex = order.indexOf("respondToApproval");
    const answerIndex = order.indexOf("respondToUserInput");
    const interruptIndex = order.indexOf("interruptTurn");
    assert.ok(cancelIndex >= 0 && answerIndex >= 0 && interruptIndex >= 0);
    assert.ok(cancelIndex < interruptIndex, "approval cancelled before the interrupt");
    assert.ok(answerIndex < interruptIndex, "question cancelled before the interrupt");
    const cancelCall = host.adapter.calls[cancelIndex];
    assert.deepEqual(cancelCall?.detail, { requestId: "req-1", decision: "cancel" });
    // …and the resolutions are on the wire as resolved rows.
    const resolved = activityEvents(host).filter((row) =>
      row.id.startsWith("settle-cancel:")
    );
    assert.equal(resolved.length, 2);
    await host.stop();
  });

  it("is valid with no running turn and stops background work", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
    await host.settle();
    const interrupt = host.adapter.calls.find((call) => call.kind === "interruptTurn");
    assert.ok(interrupt);
    assert.equal(interrupt?.detail, null, "no turnId is sent when the session is not running");
    await host.stop();
  });

  it("drops a stale interrupt so it cannot kill the next turn", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "one" });
    await host.settle();
    // The client is still looking at the previous turn.
    await host.orchestrator.command(threadId, "interrupt", {
      commandId: cmd(),
      turnId: "turn-0"
    });
    await host.settle();
    assert.equal(
      host.adapter.calls.filter((call) => call.kind === "interruptTurn").length,
      0,
      "a Stop aimed at a settled turn is a no-op"
    );
    // The current turn is still live and interruptible.
    await host.orchestrator.command(threadId, "interrupt", {
      commandId: cmd(),
      turnId: "turn-1"
    });
    await host.settle();
    assert.equal(host.adapter.calls.filter((call) => call.kind === "interruptTurn").length, 1);
    await host.stop();
  });

  it("appends provider.turn.interrupt.failed when no session is bound", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const result = await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
    await host.settle();
    assert.ok(result.seq > 0, "the command still answers with a sequence");
    const failures = activityEvents(host).filter(
      (row) => row.activityKind === "provider.turn.interrupt.failed"
    );
    assert.equal(failures.length, 1);
    await host.stop();
  });
});

describe("orchestrator — compaction (§3.4)", () => {
  it("refuses while a turn is running and queues a turn sent during compaction", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();

    // A turn is running: /compact refuses.
    await assert.rejects(
      () => host.orchestrator.command(threadId, "compact", { commandId: cmd() }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMPACTION_UNAVAILABLE" &&
        error.status === 409
    );
    await host.stop();
  });

  it("a /turn during compaction is queued and replayed in order, reusing its message id", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // Give the thread a conversation so compaction is allowed.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    // Settle the turn so /compact is allowed.
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "settle",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);

    // Hold the compaction open so the next /turn genuinely lands during it.
    let releaseCompact: () => void = () => undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = () => resolve();
    });
    const originalCompact = host.adapter.compact.bind(host.adapter);
    host.adapter.compact = async (id: string) => {
      await compactGate;
      return originalCompact(id);
    };

    await host.orchestrator.command(threadId, "compact", { commandId: cmd() });
    // The compact effect is now parked inside the adapter call.
    await new Promise((resolve) => setImmediate(resolve));
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "queued" });
    await new Promise((resolve) => setImmediate(resolve));

    const sendsBefore = host.adapter.calls.filter((call) => call.kind === "sendTurn").length;
    assert.equal(sendsBefore, 1, "the queued turn has not been sent yet");

    releaseCompact();
    await host.settle();

    const sendsAfter = host.adapter.calls.filter((call) => call.kind === "sendTurn");
    assert.equal(sendsAfter.length, 2);
    assert.equal((sendsAfter[1]?.detail as { input: string }).input, "queued");
    // One user bubble per message, not two.
    const messages = (host.store.logs.get(threadId) ?? []).filter(
      (event) => event.type === "thread.message-sent"
    );
    assert.equal(messages.length, 3); // first, /compact, queued
    await host.stop();
  });

  it("a failed compaction cancels the queue with the exact copy", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "settle",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);

    let releaseCompact: () => void = () => undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = () => resolve();
    });
    host.adapter.compact = async () => {
      await compactGate;
      throw new Error("compaction blew up");
    };

    await host.orchestrator.command(threadId, "compact", { commandId: cmd() });
    await new Promise((resolve) => setImmediate(resolve));
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "queued" });
    await new Promise((resolve) => setImmediate(resolve));
    releaseCompact();
    await host.settle();

    const rows = activityEvents(host);
    assert.ok(rows.some((row) => row.summary === "Context compaction failed"));
    const dropped = rows.find((row) => row.summary === "Queued message was not sent");
    assert.ok(dropped, "the queued message is never silently dropped");
    assert.equal(
      (dropped?.payload as { detail: string }).detail,
      "Context compaction failed. Send this message again to continue."
    );
    await host.stop();
  });

  it("a /turn that is exactly /compact takes the host-native path", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "settle",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: " /Compact " });
    await host.settle();

    assert.equal(host.adapter.calls.filter((call) => call.kind === "compact").length, 1);
    const messages = (host.store.logs.get(threadId) ?? []).filter(
      (event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent"
    );
    // Persisted verbatim, never as a turn.
    assert.equal(messages.at(-1)?.payload.text, "/Compact");
    assert.equal(host.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await host.stop();
  });

  it("refuses compaction on an empty conversation", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () => host.orchestrator.command(threadId, "compact", { commandId: cmd() }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_REJECTED" &&
        /existing conversation/.test(error.message)
    );
    await host.stop();
  });
});

describe("orchestrator — session restart policy (§3.4)", () => {
  it("a runtime-mode change restarts the session carrying the cursor", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    await host.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      runtimeMode: "full-access"
    });
    await host.settle();

    const starts = host.adapter.calls.filter((call) => call.kind === "startSession");
    assert.equal(starts.length, 2);
    assert.equal(host.adapter.lastStart?.runtimeMode, "full-access");
    assert.deepEqual(host.adapter.lastStart?.resumeCursor, { cursor: "turn-1" });
    await host.stop();
  });

  it("an in-session model change does not restart", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await host.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    // Claude compares the whole selection object, so this adapter is codex.
    const starts = host.adapter.calls.filter((call) => call.kind === "startSession");
    assert.equal(starts.length, 2, "claude restarts on any model-selection change");
    await host.stop();
  });

  it("codex applies a model change live", async () => {
    const codex = createScriptedAdapter({ id: "codex" });
    const host = createTestHost({ adapters: { codex } });
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await host.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    assert.equal(codex.calls.filter((call) => call.kind === "startSession").length, 1);
    await host.stop();
  });

  it("a mode change on a thread with no session starts nothing", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      runtimeMode: "auto"
    });
    await host.settle();
    assert.equal(host.adapter.calls.filter((call) => call.kind === "startSession").length, 0);
    await host.stop();
  });

  it("lazy recovery: a turn after the session died starts a fresh one from the cursor", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "one" });
    await host.settle();
    // The child dies: the adapter forgets the session.
    await host.adapter.stopSession(threadId);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "two" });
    await host.settle();
    const starts = host.adapter.calls.filter((call) => call.kind === "startSession");
    assert.equal(starts.length, 2);
    assert.deepEqual(host.adapter.lastStart?.resumeCursor, { cursor: "turn-1" });
    await host.stop();
  });

  it("refuses to start a CLI below the minimum version", async () => {
    const opencode = createScriptedAdapter({ id: "opencode" });
    const host = createTestHost({ adapters: { opencode } });
    host.snapshots.set({
      id: "opencode",
      refIds: ["opencode"],
      installed: true,
      version: "1.14.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: host.clock.nowIso(),
      models: [],
      slashCommands: [],
      skills: [],
      capabilities: opencode.capabilities
    });
    const threadId = await host.createThread({ refId: "opencode" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.equal(opencode.calls.filter((call) => call.kind === "startSession").length, 0);
    const rows = activityEvents(host);
    const failure = rows.find((row) => row.activityKind === "provider.turn.start.failed");
    assert.ok(failure);
    assert.match(String((failure?.payload as { detail: string }).detail), /1\.14\.19/);
    await host.stop();
  });
});

/** An event as ingestion hands it to the sink. */
function sinkEvent<TType extends AppendableDomainEvent["type"]>(
  host: TestHost,
  threadId: string,
  eventId: string,
  type: TType,
  payload: Extract<AppendableDomainEvent, { type: TType }>["payload"]
): AppendableDomainEvent {
  return {
    eventId,
    threadId,
    type,
    payload,
    occurredAt: host.clock.nowIso(),
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

/**
 * One turn, seeded the way a real thread gets it (§5.1): the user's message
 * and the `/turn` command's pending row, the provider's id adopted by a
 * `running` session, the turn settled by `ready` — each through the sink, in
 * that order. `settle: false` leaves it running; `checkpointTurnCount` adds
 * its completion checkpoint at that count.
 */
async function seedTurn(
  host: TestHost,
  turnId: string,
  options: { checkpointTurnCount?: number; settle?: boolean; threadId?: string } = {}
): Promise<void> {
  const threadId = options.threadId ?? "thread-1";
  const messageId = `user:${turnId}`;
  const events: AppendableDomainEvent[] = [
    sinkEvent(host, threadId, `${turnId}:message`, "thread.message-sent", {
      messageId,
      role: "user",
      text: `prompt for ${turnId}`,
      streaming: false,
      turnId: null
    }),
    sinkEvent(host, threadId, `${turnId}:start`, "thread.turn-start-requested", {
      turnId: null,
      messageId,
      interactionMode: "default"
    }),
    sinkEvent(host, threadId, `${turnId}:running`, "thread.session-set", {
      session: { status: "running", activeTurnId: turnId }
    })
  ];
  if (options.settle !== false) {
    events.push(
      sinkEvent(host, threadId, `${turnId}:ready`, "thread.session-set", {
        session: { status: "ready", activeTurnId: null }
      })
    );
  }
  if (options.checkpointTurnCount !== undefined) {
    events.push(
      sinkEvent(host, threadId, `${turnId}:checkpoint`, "thread.turn-diff-completed", {
        turnCount: options.checkpointTurnCount,
        turnId,
        ref: `refs/orquester/checkpoints/x/turn/${options.checkpointTurnCount}`,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: host.clock.nowIso()
      })
    );
  }
  for (const event of events) {
    await host.orchestrator.ingestionSink(threadId, [event]);
  }
}

function rollbackDetails(host: TestHost): unknown[] {
  return host.adapter.calls
    .filter((call) => call.kind === "rollbackThread")
    .map((call) => call.detail);
}

/** The `turnCount` of every `thread.reverted` in the log, in order. */
function revertedTargets(host: TestHost, threadId = "thread-1"): number[] {
  return (host.store.logs.get(threadId) ?? []).flatMap((event) =>
    event.type === "thread.reverted" ? [event.payload.turnCount] : []
  );
}

/** The counts of the completion checkpoints the log recorded for one turn. */
function capturedCounts(host: TestHost, turnId: string, threadId = "thread-1"): number[] {
  return (host.store.logs.get(threadId) ?? []).flatMap((event) =>
    event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId
      ? [event.payload.turnCount]
      : []
  );
}

async function headTurnCount(host: TestHost, threadId = "thread-1"): Promise<number | null> {
  const read = await host.orchestrator.readThread(threadId);
  return read.kind === "snapshot" ? read.thread.head.turnCount : null;
}

/**
 * Yield to the event loop until `done()` holds: `consume` runs on the
 * adapter's stream, so there is no receipt to wait on. Bounded, and never a
 * timed sleep (§9).
 */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done(), "the runtime event was never consumed");
}

function turnBoundary(
  host: TestHost,
  type: "turn.started" | "turn.completed",
  turnId: string,
  threadId = "thread-1"
): RuntimeEvent {
  return {
    eventId: `${type}:${turnId}`,
    threadId,
    createdAt: host.clock.nowIso(),
    type,
    turnId,
    payload: type === "turn.completed" ? { state: "completed" } : {}
  } as unknown as RuntimeEvent;
}

describe("orchestrator — revert (§5.5)", () => {
  it("counts turns by order: a target above the started turns is refused, naming both", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await seedTurn(host, "p-1");
    // A checkpoint numbered far above the turn count must not widen what a
    // rewind may target: the checkpoint list is no longer the counter.
    await seedTurn(host, "p-2", { checkpointTurnCount: 5 });

    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 3 }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_REJECTED" &&
        /rewind to turn 3\b/.test(error.message) &&
        /\bhas 2 turns\b/.test(error.message)
    );
    await host.settle();
    assert.deepEqual(rollbackDetails(host), []);
    assert.deepEqual(host.checkpoints.pruned, []);
    assert.deepEqual(revertedTargets(host), []);
    await host.stop();
  });

  it("rejects a malformed targetTurnCount with INVALID_COMMAND", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "revert", {
          commandId: cmd(),
          targetTurnCount: "two"
        }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });

  it("refuses while a turn is running", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await seedTurn(host, "p-1");
    await seedTurn(host, "p-2", { settle: false });

    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 1 }),
      (error: unknown) =>
        isAgentChatCommandError(error) && /Stop the current turn/.test(error.message)
    );
    await host.settle();
    assert.deepEqual(rollbackDetails(host), []);
    await host.stop();
  });

  it("checks rollback support before touching disk, and lands the failure as a row", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const threadId = await host.createThread({ refId: "grok" });
    await seedTurn(host, "p-1", { checkpointTurnCount: 1 });
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 0 });
    await host.settle();

    assert.equal(grok.calls.filter((call) => call.kind === "rollbackThread").length, 0);
    assert.equal(host.checkpoints.pruned.length, 0, "nothing on disk was touched");
    const failure = activityEvents(host).find(
      (row) => row.activityKind === "checkpoint.revert.failed"
    );
    assert.ok(failure);
    assert.equal(failure?.tone, "error");
    assert.deepEqual(revertedTargets(host), [], "a refused rewind records no revert");
    await host.stop();
  });

  it("rewinds a thread with ZERO checkpoints, naming the cut to the adapter by turn id", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // A non-git project: three turns, not one checkpoint.
    for (const turnId of ["p-1", "p-2", "p-3"]) {
      await seedTurn(host, turnId);
    }

    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 1 });
    await host.settle();

    assert.deepEqual(rollbackDetails(host), [
      {
        numTurns: 2,
        target: {
          firstRemovedTurnId: "p-2",
          droppedTurnIds: ["p-2", "p-3"],
          retainedTurnIds: ["p-1"]
        }
      }
    ]);
    assert.deepEqual(host.checkpoints.pruned, [
      { threadId, targetTurnCount: 1, droppedTurnCounts: [] }
    ]);
    assert.deepEqual(revertedTargets(host), [1]);
    assert.equal(
      activityEvents(host).filter((row) => row.activityKind === "checkpoint.revert.failed")
        .length,
      0
    );
    await host.stop();
  });

  it("prunes the dropped turns' own checkpoints, even where their counts are dense", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // A resumed thread checkpointed before the counts followed the turns: only
    // its 3rd and 4th turns were captured, as turn/1 and turn/2. The old
    // counter called this thread two turns long and refused this very rewind.
    await seedTurn(host, "p-1");
    await seedTurn(host, "p-2");
    await seedTurn(host, "p-3", { checkpointTurnCount: 1 });
    await seedTurn(host, "p-4", { checkpointTurnCount: 2 });

    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 3 });
    await host.settle();

    assert.deepEqual(rollbackDetails(host), [
      {
        numTurns: 1,
        target: {
          firstRemovedTurnId: "p-4",
          droppedTurnIds: ["p-4"],
          retainedTurnIds: ["p-1", "p-2", "p-3"]
        }
      }
    ]);
    // `> 3` alone would leave the dropped turn's own turn/2 behind.
    assert.deepEqual(host.checkpoints.pruned, [
      { threadId, targetTurnCount: 3, droppedTurnCounts: [2] }
    ]);
    assert.deepEqual(revertedTargets(host), [3]);
    await host.stop();
  });

  it("a target equal to the started turns rolls nothing back and still records the revert", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await seedTurn(host, "p-1", { checkpointTurnCount: 1 });
    await seedTurn(host, "p-2", { checkpointTurnCount: 2 });

    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();

    assert.deepEqual(rollbackDetails(host), [], "nothing to cut, so the provider is not asked");
    assert.deepEqual(host.checkpoints.pruned, [
      { threadId, targetTurnCount: 2, droppedTurnCounts: [] }
    ]);
    assert.deepEqual(revertedTargets(host), [2]);
    await host.stop();
  });

  it("a new turn after a revert captures at target + 1 and moves head.turnCount there", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // Every seeded turn owns its checkpoint, so the kept rows survive the
    // revert in the fold however it truncates.
    for (const [index, turnId] of ["p-1", "p-2", "p-3"].entries()) {
      await seedTurn(host, turnId, { checkpointTurnCount: index + 1 });
    }
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();
    assert.equal(await headTurnCount(host), 2);

    // The next genuine turn: dispatched by the host, started and completed by
    // the provider.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();
    const turnId = host.adapter.turnIds[0];
    assert.ok(turnId);
    assert.deepEqual(
      host.checkpoints.baselineRequests.at(-1),
      { threadId, turnCount: 2 },
      "the dispatch-time baseline is the count of turns started so far"
    );

    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit(turnBoundary(host, "turn.started", turnId));
    host.adapter.emit(turnBoundary(host, "turn.completed", turnId));
    await until(() => host.checkpoints.turnEndRequests.length > 0);
    await host.settle();

    assert.deepEqual(
      host.checkpoints.baselineRequests.at(-1),
      { threadId, turnId, turnCount: 2 },
      "the turn.started backstop names the same baseline"
    );
    assert.deepEqual(host.checkpoints.turnEndRequests, [{ threadId, turnId, turnCount: 3 }]);
    assert.deepEqual(
      capturedCounts(host, turnId),
      [3],
      "a genuinely new turn is not dropped as a reverted one"
    );
    assert.equal(await headTurnCount(host), 3);
    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("a restart re-derives the guard from the log: a turn started after the revert lifts it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    for (const [index, turnId] of ["p-1", "p-2", "p-3"].entries()) {
      await seedTurn(host, turnId, { checkpointTurnCount: index + 1 });
    }
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();
    // A new turn starts after the revert, and the host goes down under it.
    await seedTurn(host, "p-4", { settle: false });
    await host.stop();

    const next = createTestHost({ store: host.store });
    await next.orchestrator.readThread(threadId);
    const consumed = next.orchestrator.consume(next.adapter);
    next.adapter.emit(turnBoundary(next, "turn.completed", "p-4"));
    await until(() => next.checkpoints.turnEndRequests.length > 0);
    await next.settle();

    assert.deepEqual(next.checkpoints.turnEndRequests, [
      { threadId, turnId: "p-4", turnCount: 3 }
    ]);
    assert.deepEqual(capturedCounts(next, "p-4"), [3]);
    assert.equal(await headTurnCount(next), 3);
    next.adapter.close();
    await consumed;
    await next.stop();
  });
});

describe("orchestrator — error state and session stop (§6.2)", () => {
  it("refuses every command except session/stop and revert while the session is in error", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "err",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "error", activeTurnId: null, lastError: "boom" } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await assert.rejects(
      () => host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hi" }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "COMMAND_REJECTED"
    );
    const stop = await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    assert.ok(stop.seq > 0);
    await host.settle();
    await host.stop();
  });

  it("session/stop settles pending requests and stops the child", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openApproval(host, "req-9");
    await host.settle();
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();

    const order = host.adapter.calls.map((call) => call.kind);
    assert.ok(order.indexOf("respondToApproval") < order.lastIndexOf("stopSession"));
    assert.equal(host.adapter.hasSession(threadId), false);
    await host.stop();
  });
});

describe("orchestrator — readiness gate (§3.1)", () => {
  it("queues commands until the gate opens and runs them in arrival order", async () => {
    const host = createTestHost({ openGate: false });
    const order: string[] = [];
    const first = host.orchestrator
      .createThread({
        threadId: "thread-1",
        projectPath: "/work/p",
        cwd: "/work/p",
        title: "t",
        refId: "claude",
        accountId: "acc1",
        home: "account",
        modelSelection: { model: "m" },
        runtimeMode: "approval-required"
      })
      .then(() => order.push("create"));
    const second = host.orchestrator
      .readThread("thread-1")
      .then(() => order.push("read"))
      .catch(() => order.push("read"));

    assert.deepEqual(order, [], "nothing runs before the gate opens");
    host.orchestrator.openGate();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["create", "read"]);
    await host.stop();
  });

  it("a failed gate fails every queued and subsequent command", async () => {
    const host = createTestHost({ openGate: false });
    const queued = host.orchestrator.command("thread-1", "turn", {
      commandId: cmd(),
      input: "hi"
    });
    host.orchestrator.failGate(new Error("startup failed"));
    await assert.rejects(queued, /startup failed/);
    await assert.rejects(
      host.orchestrator.command("thread-1", "turn", { commandId: cmd(), input: "hi" }),
      /startup failed/
    );
  });
});

describe("orchestrator — reads (§6.3)", () => {
  it("answers a snapshot with no cursor and a replay within the budgets", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const snapshot = await host.orchestrator.readThread(threadId);
    assert.equal(snapshot.kind, "snapshot");

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    const replay = await host.orchestrator.readThread(threadId, snapshot.kind === "snapshot" ? snapshot.thread.seq : 0);
    assert.equal(replay.kind, "events");
    await host.stop();
  });

  it("forces a snapshot when the range contains the thread's creation", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const read = await host.orchestrator.readThread(threadId, 0);
    assert.equal(read.kind, "snapshot");
    await host.stop();
  });

  it("forces a snapshot past the row budget without reading the range", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // Grow the log past the 1 000-row replay budget.
    await host.orchestrator.ingestionSink(
      threadId,
      Array.from({ length: 1_200 }, (_unused, index) => ({
        eventId: `bulk-${index}`,
        threadId,
        type: "thread.activity-appended" as const,
        payload: {
          activity: {
            kind: "activity" as const,
            id: `bulk-${index}`,
            tone: "info" as const,
            activityKind: "runtime.warning",
            summary: "noise",
            payload: {},
            turnId: null,
            createdAt: host.clock.nowIso(),
            updatedAt: host.clock.nowIso()
          }
        },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }))
    );
    let reads = 0;
    const originalReadTail = host.store.readTail.bind(host.store);
    host.store.readTail = async (id: string, afterSeq: number) => {
      reads += 1;
      return originalReadTail(id, afterSeq);
    };
    const read = await host.orchestrator.readThread(threadId, 1);
    assert.equal(read.kind, "snapshot");
    assert.equal(reads, 0, "an oversized range is never loaded");
    await host.stop();
  });

  it("forces a snapshot when `after` is above the head", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const read = await host.orchestrator.readThread(threadId, 9_999);
    assert.equal(read.kind, "snapshot");
    await host.stop();
  });

  it("forces a snapshot when the log was truncated at a malformed line", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    host.store.truncateAt(threadId, 2);
    const read = await host.orchestrator.readThread(threadId, 1);
    assert.equal(read.kind, "snapshot");
    await host.stop();
  });

  it("reads one item back with its full payload", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await openApproval(host, "req-1");
    await host.settle();
    const item = await host.orchestrator.readItem(threadId, "approval:req-1");
    assert.equal(item?.kind, "activity");
    await host.stop();
  });

  it("404s a turn diff above the highest checkpoint", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    assert.equal(await host.orchestrator.readTurnDiff(threadId, 4), null);
    await host.stop();
  });
});

describe("orchestrator — queue while the session is down (§3.4)", () => {
  it("persists the user message before any provider work, even when the start fails", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    host.adapter.failNext("failStartSession", new Error("binary not found"));

    const receipt = await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "still mine"
    });
    await host.settle();

    assert.ok(receipt.seq > 0, "the command is accepted, not refused");
    const messages = (host.store.logs.get(threadId) ?? []).filter(
      (event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent"
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.payload.text, "still mine");
    // The message survives; the failure is a timeline row, not a lost turn.
    const failure = activityEvents(host).find(
      (row) => row.activityKind === "provider.turn.start.failed"
    );
    assert.ok(failure);

    // A retry re-adopts the thread: session/stop clears the error state first.
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();
    assert.equal(host.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await host.stop();
  });
});

describe("orchestrator — moving a running command to the background (Ctrl+B)", () => {
  it("hands the tool-use id to a capable adapter and records the request as an activity", async () => {
    const claude = createScriptedAdapter({ id: "claude", capabilities: { supportsBackgroundTasks: true } });
    const host = createTestHost({ adapters: { claude } });
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "run it" });
    await host.settle();

    const receipt = await host.orchestrator.command(threadId, "background", {
      commandId: cmd(),
      toolUseId: "toolu_01"
    });
    await host.settle();
    assert.ok(receipt.seq > 0);
    const call = host.adapter.calls.find((entry) => entry.kind === "backgroundTasks");
    assert.deepEqual(call?.detail, { toolUseId: "toolu_01" });
    const requested = activityEvents(host).find((row) => row.activityKind === "background.requested");
    assert.ok(requested, "the user's request is a timeline activity");
    assert.equal(
      activityEvents(host).some((row) => row.activityKind === "provider.background.failed"),
      false
    );
    await host.stop();
  });

  it("is refused where the provider cannot do it, and when nothing is running", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "run it" });
    await host.settle();
    await assert.rejects(
      host.orchestrator.command(threadId, "background", { commandId: cmd() }),
      /cannot move a running command/
    );

    const claude = createScriptedAdapter({ id: "claude", capabilities: { supportsBackgroundTasks: true } });
    const idle = createTestHost({ adapters: { claude } });
    const idleThread = await idle.createThread();
    await assert.rejects(
      idle.orchestrator.command(idleThread, "background", { commandId: cmd() }),
      /Nothing is running/
    );
    await host.stop();
    await idle.stop();
  });
});

describe("orchestrator — answering a question (§6.2)", () => {
  it("answers a message-mode (Codex async) question as a steered message, never over RPC", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const turnsBefore = host.adapter.calls.filter((call) => call.kind === "sendTurn").length;
    await openQuestion(host, "codex-async:t:1", { dismissible: true });
    await host.settle();

    await host.orchestrator.command(threadId, "answer", {
      commandId: cmd(),
      requestId: "codex-async:t:1",
      answers: { "Which branch?": "main" }
    });
    await host.settle();

    assert.equal(
      host.adapter.calls.some((call) => call.kind === "respondToUserInput"),
      false,
      "the provider parked no request; an RPC reply would fail with 'no pending request'"
    );
    const turns = host.adapter.calls.filter((call) => call.kind === "sendTurn");
    assert.equal(turns.length, turnsBefore + 1, "the answer is delivered as a turn/steer");
    // Every question is ECHOED before its answer (T3 `decider.ts:1642-1660`):
    // the provider parked no request, so the agent receives this as an
    // ordinary user turn and has nothing but the text to tell it what was
    // answered. A bare "main" reads as arriving from nowhere.
    assert.equal((turns.at(-1)?.detail as { input: string }).input, "Which branch?\nmain");
    const log = host.store.logs.get(threadId) ?? [];
    const message = log.find(
      (event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" && event.payload.text === "Which branch?\nmain"
    );
    assert.ok(message, "the answer is a user message row");
    const resolved = activityEvents(host).find(
      (row) => row.activityKind === "user-input.resolved" && row.id === "async-answer:codex-async:t:1"
    );
    assert.ok(resolved, "the card closes through the same activity a dismissal writes");
    await host.stop();
  });

  it("commits the resolution and the message as ONE append — the card cannot close alone", async () => {
    // T3 `decider.ts:1683-1702` commits both with a single
    // `decideCommandSequence([activity.append, turn.start])`. Here that is one
    // `events` array on one decision: they share a commandId and land in the
    // log with no other event between them, so no observer can ever see a
    // closed card with no message (or the reverse).
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await openQuestion(host, "codex-async:t:9", { dismissible: true });
    await host.settle();

    const commandId = cmd();
    await host.orchestrator.command(threadId, "answer", {
      commandId,
      requestId: "codex-async:t:9",
      answers: { "Which branch?": "main" }
    });
    await host.settle();

    const log = host.store.logs.get(threadId) ?? [];
    const resolvedAt = log.findIndex(
      (event) =>
        event.type === "thread.activity-appended" &&
        (event.payload as { activity: { id: string } }).activity.id ===
          "async-answer:codex-async:t:9"
    );
    const messageAt = log.findIndex(
      (event) => event.type === "thread.message-sent" && event.commandId === commandId
    );
    assert.ok(resolvedAt >= 0 && messageAt >= 0, "both rows were written");
    assert.equal(messageAt, resolvedAt + 1, "adjacent: nothing can be interleaved between them");
    assert.equal(
      log[resolvedAt]?.commandId,
      commandId,
      "one command sequence, so one commandId across the pair"
    );
    // Deterministic message id, like the activity's (T3 mints
    // `async-answer:<requestId>` for both).
    assert.equal(
      (log[messageAt]?.payload as { messageId: string }).messageId,
      "async-answer:codex-async:t:9"
    );
    await host.stop();
  });

  it("force-resolves a STRANDED native question when its turn ends — never a message-mode one", async () => {
    // T3 `ProviderRuntimeIngestion.ts:2330-2360`. A terminal turn cannot accept
    // native-callback answers: the provider's request died with the turn, so a
    // card left open would keep the thread `waiting` and the composer blocked
    // forever. A message-mode question may outlive its turn by design and must
    // survive.
    const host = createTestHost();
    const threadId = await host.createThread();
    const consumed = host.orchestrator.consume(host.adapter);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const turnId = host.orchestrator.summary(threadId)?.latestTurn?.turnId ?? null;
    assert.ok(turnId, "the turn row exists to scope the cleanup by");

    await openQuestion(host, "native-strand", { dismissible: false, turnId });
    await openQuestion(host, "async-survivor", { dismissible: true, turnId });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.hasPendingUserInput, true);

    host.adapter.emit({
      eventId: "turn-end-1",
      threadId,
      turnId,
      createdAt: host.clock.nowIso(),
      type: "turn.completed",
      payload: {}
    } as unknown as RuntimeEvent);
    await host.settle();

    const open = new Set(
      (host.orchestrator.summary(threadId)?.pendingRequests ?? []).map((entry) => entry.requestId)
    );
    const dismissed = activityEvents(host).filter(
      (row) => row.activityKind === "user-input.resolved" && row.summary === "User input dismissed"
    );
    assert.deepEqual(
      dismissed.map((row) => (row.payload as { requestId: string }).requestId),
      ["native-strand"],
      "only the blocked native callback is swept"
    );
    assert.equal(open.has("async-survivor"), true, "the async question outlives its turn");

    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("refuses to dismiss a native-callback question, and allows it for a message-mode one", async () => {
    // T3 `decider.ts:1769-1775`: dropping a question silently is legal only
    // for `responseMode: "message"`. A native callback leaves the provider
    // blocked until it gets a reply, so it still needs an answer or an
    // interrupted turn.
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openQuestion(host, "native-1", { dismissible: false });
    await host.settle();
    await assert.rejects(
      host.orchestrator.command(threadId, "dismiss", { commandId: cmd(), requestId: "native-1" }),
      /needs an answer/
    );

    await openQuestion(host, "async-1", { dismissible: true });
    await host.settle();
    const receipt = await host.orchestrator.command(threadId, "dismiss", {
      commandId: cmd(),
      requestId: "async-1"
    });
    assert.ok(receipt.seq > 0);
    await host.stop();
  });

  it("folds attachments into the answer text before the adapter sees it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openQuestion(host, "q-1", { dismissible: false });
    await host.settle();
    const ref = await host.store.putAttachment({
      threadId,
      name: "notes.md",
      sourcePath: "/tmp/notes.md"
    });

    await host.orchestrator.command(threadId, "answer", {
      commandId: cmd(),
      requestId: "q-1",
      answers: { "Which branch?": "main" },
      attachmentsByQuestionId: { "Which branch?": [ref] }
    });
    await host.settle();

    const call = host.adapter.calls.find((entry) => entry.kind === "respondToUserInput");
    const answers = (call?.detail as { answers: Record<string, string> }).answers;
    assert.match(answers["Which branch?"] ?? "", /^main\n\n\/tmp\/notes\.md$/);

    // The question text is persisted so an answered card renders without the
    // original request.
    const persisted = (host.store.logs.get(threadId) ?? []).find(
      (event) => event.type === "thread.user-input-response-requested"
    );
    assert.ok(persisted);
    assert.deepEqual(
      (persisted as Extract<DomainEvent, { type: "thread.user-input-response-requested" }>).payload
        .questionTextById,
      { "Which branch?": "Which branch?" }
    );
    await host.stop();
  });

  it("a message-mode answer names each attachment by PATH, so the adapters' Attached files block has nothing to add", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openQuestion(host, "q-2", { dismissible: true });
    await host.settle();
    const ref = await host.store.putAttachment({
      threadId,
      name: "q3.xlsx",
      sourcePath: "/tmp/q3.xlsx"
    });

    await host.orchestrator.command(threadId, "answer", {
      commandId: cmd(),
      requestId: "q-2",
      answers: { "Which branch?": "this one" },
      attachmentsByQuestionId: { "Which branch?": [ref] }
    });
    await host.settle();

    const sent = (host.store.logs.get(threadId) ?? []).find(
      (event) => event.type === "thread.message-sent" && event.payload.messageId === "async-answer:q-2"
    ) as Extract<DomainEvent, { type: "thread.message-sent" }> | undefined;
    assert.ok(sent);
    const path = await host.store.resolveAttachment(threadId, ref.id);
    assert.equal(sent.payload.text, `Which branch?\nthis one\nAttached file: q3.xlsx (${path})`);
    // The line already names the path, so the shared block appends nothing.
    assert.equal(
      appendAttachmentPathLines(sent.payload.text, [{ name: "q3.xlsx", path }]),
      sent.payload.text
    );
    await host.stop();
  });
});

describe("orchestrator — the §6.4 summary fields", () => {
  it("reports pending approvals, questions and the latest turn", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const initial = host.orchestrator.summary(threadId);
    assert.equal(initial?.hasPendingApprovals, false);
    assert.equal(initial?.hasPendingUserInput, false);
    assert.equal(initial?.hasActionableProposedPlan, false);
    assert.equal(initial?.backgroundLiveness, null);
    assert.equal(initial?.chatSessionStatus, "running");
    assert.equal(initial?.latestTurn?.turnId, "turn-1");
    assert.equal(initial?.latestTurn?.state, "running");
    assert.equal(initial?.latestTurn?.completedAt, null);

    assert.deepEqual(initial?.pendingRequests, []);

    await openApproval(host, "req-1");
    await openQuestion(host, "q-1", { dismissible: true });
    await host.settle();
    const summary = host.orchestrator.summary(threadId);
    assert.equal(summary?.hasPendingApprovals, true);
    assert.equal(summary?.hasPendingUserInput, true);
    // The ids and labels `agentChat.pending` needs (§6.4): a boolean says that
    // something is pending, not which.
    assert.deepEqual(summary?.pendingRequests, [
      { requestId: "req-1", kind: "approval", title: "Run a command" },
      { requestId: "q-1", kind: "question", title: "Branch" }
    ]);
    await host.stop();
  });
});

describe("orchestrator — the ingestion hooks (§5.1, §5.4)", () => {
  it("reports the head's session and whether the title was renamed by hand", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, false);
    assert.equal(host.orchestrator.threadContext(threadId)?.session?.status, "idle");

    await host.orchestrator.updateThread(threadId, { title: "Mine" });
    await host.settle();
    // A manual rename is never overwritten by a provider retitle.
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, true);
    assert.equal(host.orchestrator.threadContext("nope"), null);
    await host.stop();
  });

  it("the client's first-message seed writes the title without marking it manual", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();

    // §7.7: the client seeds every thread's title from its first message
    // through this same route. Treating that as a rename marked EVERY real
    // thread manually-renamed, so a provider's generated name could never land.
    await host.orchestrator.updateThread(threadId, { title: "fix the login bug", seed: true });
    await host.settle();
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, false);

    // …and a rename the user actually typed still locks it, seed or no seed.
    await host.orchestrator.updateThread(threadId, { title: "Mine" });
    await host.settle();
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, true);
    await host.stop();
  });

  it("offers a placeholder turn count only for the running turn, and never without git", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    assert.equal(
      host.orchestrator.placeholderCheckpoint({ threadId, turnId: "turn-1" }),
      null,
      "no running turn, no placeholder"
    );

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.deepEqual(host.orchestrator.placeholderCheckpoint({ threadId, turnId: "turn-1" }), {
      turnCount: 1
    });
    assert.equal(
      host.orchestrator.placeholderCheckpoint({ threadId, turnId: "turn-2" }),
      null,
      "a stale turn id never opens a placeholder"
    );
    await host.stop();
  });

  it("a placeholder takes the running turn's ORDINAL, not the checkpoint counter (§5.5)", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // Two turns and no checkpoint between them — a stretch without git, say.
    await seedTurn(host, "p-1");
    await seedTurn(host, "p-2");
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "third" });
    await host.settle();
    const turnId = host.adapter.turnIds[0];
    assert.ok(turnId);
    assert.deepEqual(host.orchestrator.placeholderCheckpoint({ threadId, turnId }), {
      turnCount: 3
    });
    await host.stop();
  });

  it("a dispatch baseline counts the turns started so far; a steer's names the running turn's own", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await seedTurn(host, "p-1");
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "second" });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "steer" });
    await host.settle();

    // Turn 2's baseline is turn/1. The steer joins turn 2, so it names turn/1
    // again: turn/2 is turn 2's COMPLETION, and capturing it now would freeze
    // a half-finished tree there.
    assert.deepEqual(
      host.checkpoints.baselineRequests.map((request) => request.turnCount),
      [1, 1]
    );
    await host.stop();
  });

  it("routes an account event to the adapter's snapshot", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    host.snapshots.set({
      id: "claude",
      refIds: ["claude"],
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: host.clock.nowIso(),
      models: [],
      slashCommands: [],
      skills: [],
      capabilities: host.adapter.capabilities
    });
    assert.equal(host.orchestrator.adapterForThread(threadId), "claude");
    host.orchestrator.onAccountEvent({
      eventId: "acct",
      threadId,
      createdAt: host.clock.nowIso(),
      type: "account.rate-limits.updated",
      payload: {
        limits: { windows: [{ id: "weekly", kind: "weekly", label: "W", usedPercent: 10 }] }
      }
    } as unknown as RuntimeEvent);
    // The stub registry keeps the object it was given; the real one merges.
    assert.equal(host.orchestrator.adapterForThread("unknown"), null);
    await host.stop();
  });

  it("hands the registry entry's launch args to startSession", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    // The harness declares none, so the field is absent rather than empty.
    assert.equal(host.adapter.lastStart?.launchArgs, undefined);
    await host.stop();
  });
});

describe("orchestrator — the §6.1 launch config (§3.1)", () => {
  it("persists the launcher env at create and hands it back for the child's env", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({
      refId: "claudex",
      home: "cliproxy",
      launchEnv: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_AUTH_TOKEN: "proxy-token"
      },
      unsetEnv: ["ANTHROPIC_API_KEY"],
      homePath: "/var/lib/orquester/daemon/cliproxy/claude-home-claudex",
      proxyRefId: "claudex"
    });

    assert.deepEqual(host.orchestrator.launchConfig(threadId), {
      launchEnv: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_AUTH_TOKEN: "proxy-token"
      },
      unsetEnv: ["ANTHROPIC_API_KEY"],
      homePath: "/var/lib/orquester/daemon/cliproxy/claude-home-claudex",
      proxyRefId: "claudex"
    });
    // Written before the thread exists on the wire, so the very first turn
    // already sees it.
    assert.ok(host.launchConfigs.entries.has(threadId));
    assert.equal(host.orchestrator.launchConfig("unknown"), null);
    await host.stop();
  });

  it("resolves a project's launcher env for OpenCode's shared server", async () => {
    const opencode = createScriptedAdapter({ id: "opencode" });
    const host = createTestHost({ adapters: { opencode } });
    await host.createThread({
      threadId: "thread-1",
      refId: "opencode",
      cwd: "/work/project",
      launchEnv: { OPENCODE_CONFIG_CONTENT: '{"provider":{}}' }
    });

    // The server is per PROJECT and belongs to no single thread (§3.2).
    assert.deepEqual(host.orchestrator.launchConfigForCwd("/work/project")?.launchEnv, {
      OPENCODE_CONFIG_CONTENT: '{"provider":{}}'
    });
    assert.equal(host.orchestrator.launchConfigForCwd("/work/elsewhere"), null);
    await host.stop();
  });

  it("survives a host restart — the daemon sends it once, at create", async () => {
    const first = createTestHost();
    const threadId = await first.createThread({
      refId: "claudex",
      home: "cliproxy",
      launchEnv: { ANTHROPIC_AUTH_TOKEN: "proxy-token" },
      homePath: "/home/proxy"
    });
    await first.stop();

    // A new host over the same store and the same on-disk launch config: the
    // thread is only loaded lazily, by the first command.
    const next = createTestHost({ store: first.store, launchConfigs: first.launchConfigs });
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await next.settle();
    assert.deepEqual(next.orchestrator.launchConfig(threadId)?.launchEnv, {
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    });
    // …and the daemon's resolved home is what reaches `startSession`.
    assert.equal(next.adapter.lastStart?.home.path, "/home/proxy");
    assert.equal(next.adapter.lastStart?.home.kind, "cliproxy");
    // No `proxyRefId` was sent, so the launcher's own refId is the owner.
    assert.equal(next.adapter.lastStart?.home.proxyRefId, "claudex");
    await next.stop();
  });
});

describe("orchestrator — runtime events", () => {
  it("feeds the liveness registry and clears it on session.exited", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    const consumed = host.orchestrator.consume(host.adapter);
    const base = {
      eventId: "e1",
      threadId,
      createdAt: host.clock.nowIso()
    };
    host.adapter.emit({
      ...base,
      type: "task.started",
      payload: { taskId: "t1", taskType: "subagent" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.orchestrator.summary(threadId)?.backgroundLiveness, "working");

    host.adapter.emit({
      ...base,
      eventId: "e2",
      type: "session.exited",
      payload: { recoverable: false, exitKind: "error" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.orchestrator.summary(threadId)?.backgroundLiveness, null);

    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("reports threads with live background work for the drain-restart, and drops them on session.exited", async () => {
    // `GET /health` carries these next to `activeTurnThreadIds`: a subagent
    // fleet that outlives its turn is work a host restart would kill.
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    const consumed = host.orchestrator.consume(host.adapter);
    const base = { eventId: "b1", threadId, createdAt: host.clock.nowIso() };
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), []);

    host.adapter.emit({
      ...base,
      type: "task.started",
      payload: { taskId: "t1", taskType: "subagent" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [threadId]);

    host.adapter.emit({
      ...base,
      eventId: "b2",
      type: "task.completed",
      payload: { taskId: "t1", taskType: "subagent", status: "completed" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [], "a finished fleet frees the drain");

    host.adapter.emit({
      ...base,
      eventId: "b3",
      type: "task.started",
      payload: { taskId: "t2", taskType: "subagent" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [threadId]);

    host.adapter.emit({
      ...base,
      eventId: "b4",
      type: "session.exited",
      payload: { recoverable: false, exitKind: "error" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [], "a dead session has no live work");

    host.adapter.close();
    await consumed;
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// Thread index and lazy boot (design 2026-09-23)
// ---------------------------------------------------------------------------

/** A realistic log: a created thread, three settled turns, some activity rows. */
async function recordedLog(): Promise<DomainEvent[]> {
  const host = createTestHost();
  const threadId = await host.createThread();
  for (const [index, turnId] of ["log-1", "log-2", "log-3"].entries()) {
    await seedTurn(host, turnId, { checkpointTurnCount: index + 1 });
    await openApproval(host, `log-req-${index}`);
  }
  await host.settle();
  const events = [...(host.store.logs.get(threadId) ?? [])];
  await host.stop();
  return events;
}

describe("fold-ops — the chunked fold (design 2026-09-23, invariant 7)", () => {
  it("is exactly the same reduction as a whole-log fold, at any chunk size", async () => {
    const events = await recordedLog();
    assert.ok(events.length > 10);
    const expected = foldThread(events);
    for (const chunkSize of [1, 3, 7, FOLD_CHUNK_SIZE]) {
      const state = await applyEventsChunked(createEmptyThreadState(), events, { chunkSize });
      assert.deepEqual(state, expected, `chunk size ${chunkSize}`);
    }
  });

  it("continues from a state already folded part of the way", async () => {
    const events = await recordedLog();
    const cut = Math.floor(events.length / 2);
    const head = foldThread(events.slice(0, cut));
    const state = await applyEventsChunked(head, events.slice(cut), { chunkSize: 2 });
    assert.deepEqual(state, foldThread(events));
  });

  it("yields to the event loop between chunks, and not before the first", async () => {
    const events = await recordedLog();
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const sawTick: boolean[] = [];
    await applyEventsChunked(createEmptyThreadState(), events.slice(0, 6), {
      chunkSize: 2,
      apply: (state, event) => {
        sawTick.push(ticked);
        return applyDomainEvent(state, event);
      }
    });
    assert.deepEqual(sawTick.slice(0, 2), [false, false], "the first chunk runs straight away");
    assert.equal(sawTick.at(-1), true, "a macrotask queued before the fold ran before it ended");
  });

  it("folds a log that fits in one chunk without a single yield", async () => {
    const events = await recordedLog();
    let applied = 0;
    const pending = applyEventsChunked(createEmptyThreadState(), events, {
      apply: (state, event) => {
        applied += 1;
        return applyDomainEvent(state, event);
      }
    });
    assert.equal(applied, events.length, "every event was applied before the call returned");
    await pending;
  });

  it("treats a chunk size that is not a positive number as the default", async () => {
    const events = await recordedLog();
    for (const chunkSize of [0, -3, Number.NaN]) {
      let applied = 0;
      const pending = applyEventsChunked(createEmptyThreadState(), events, {
        chunkSize,
        apply: (state, event) => {
          applied += 1;
          return applyDomainEvent(state, event);
        }
      });
      assert.equal(applied, events.length, `chunk size ${chunkSize}`);
      await pending;
    }
  });
});

/** `count` parent-visible activity rows for `turnId`, through the sink like ingestion. */
async function bulkActivities(
  host: TestHost,
  turnId: string | null,
  count: number,
  threadId = "thread-1",
  from = 0
): Promise<void> {
  const prefix = turnId ?? "turnless";
  await host.orchestrator.ingestionSink(
    threadId,
    Array.from({ length: count }, (_unused, offset) => from + offset).map((index) =>
      sinkEvent(host, threadId, `${prefix}-bulk-${index}`, "thread.activity-appended", {
        activity: {
          kind: "activity",
          id: `${prefix}-bulk-${index}`,
          tone: "info",
          activityKind: "runtime.warning",
          summary: `row ${index} of ${prefix}`,
          payload: {},
          turnId,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      })
    )
  );
}

/** A settled compaction marker, as ingestion writes the `compact_boundary`. */
async function compactionMarker(host: TestHost, id: string, threadId = "thread-1"): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    sinkEvent(host, threadId, id, "thread.activity-appended", {
      activity: {
        kind: "activity",
        id,
        tone: "info",
        activityKind: "context-compaction",
        summary: "Context compacted",
        payload: { state: "compacted" },
        turnId: null,
        createdAt: host.clock.nowIso(),
        updatedAt: host.clock.nowIso()
      }
    })
  ]);
}

async function snapshotRead(host: TestHost, threadId = "thread-1") {
  const read = await host.orchestrator.readThread(threadId);
  assert.equal(read.kind, "snapshot");
  if (read.kind !== "snapshot") throw new Error("unreachable");
  return read.thread;
}

/** Record every `readEventsFrom` cursor the store is asked for. */
function recordCursorReads(host: TestHost): Array<{ byteOffset: number; afterSeq: number }> {
  const cursors: Array<{ byteOffset: number; afterSeq: number }> = [];
  const readEventsFrom = host.store.readEventsFrom.bind(host.store);
  host.store.readEventsFrom = async (threadId, input) => {
    cursors.push({ ...input });
    return readEventsFrom(threadId, input);
  };
  return cursors;
}

/** Three settled turns with some rows each; returns the store they live in. */
async function threadWithHistory(): Promise<TestHost> {
  const host = createTestHost();
  const threadId = await host.createThread();
  for (const [index, turnId] of ["h-1", "h-2", "h-3"].entries()) {
    host.clock.advance(1_000);
    await seedTurn(host, turnId, { checkpointTurnCount: index + 1 });
    await bulkActivities(host, turnId, 3, threadId);
  }
  await host.settle();
  return host;
}

describe("orchestrator — the fold snapshot (design 2026-09-23, A2)", () => {
  it("folds only the log's tail on top of state.json, and reads the same as a whole-log fold", async () => {
    const first = await threadWithHistory();
    await first.stop();
    const store = first.store;
    const file = store.snapshots.get("thread-1");
    assert.ok(file, "commit wrote a snapshot");
    assert.ok(file.seq > 1);

    const warm = createTestHost({ store });
    const cursors = recordCursorReads(warm);
    const fromSnapshot = await snapshotRead(warm);
    assert.deepEqual(cursors, [{ byteOffset: file.logBytes, afterSeq: file.seq }]);
    await warm.stop();

    // The same thread, cold: the snapshot is a cache, and must change nothing.
    store.snapshots.delete("thread-1");
    const cold = createTestHost({ store });
    const coldCursors = recordCursorReads(cold);
    const fromLog = await snapshotRead(cold);
    assert.deepEqual(coldCursors, [{ byteOffset: 0, afterSeq: 0 }]);
    assert.deepEqual(fromSnapshot, fromLog);
    await cold.stop();
  });

  it("serves what state.json holds when it matches the log", async () => {
    const first = await threadWithHistory();
    await first.stop();
    const file = first.store.snapshots.get("thread-1");
    assert.ok(file?.state.head);
    // A title only the snapshot carries proves the snapshot, not the log, was folded.
    first.store.snapshots.set("thread-1", {
      ...file,
      state: { ...file.state, head: { ...file.state.head, title: "only in state.json" } }
    });
    const next = createTestHost({ store: first.store });
    assert.equal((await snapshotRead(next)).head.title, "only in state.json");
    await next.stop();
  });

  it("discards a snapshot that no longer matches the log and folds the log from the top", async () => {
    for (const plant of [
      // Points at a line that does not carry `seq + 1`.
      (file: NonNullable<ReturnType<FakeSnapshots["get"]>>) => ({ ...file, logBytes: 0 }),
      // Claims more of the log than there is.
      (file: NonNullable<ReturnType<FakeSnapshots["get"]>>) => ({
        ...file,
        logBytes: file.logBytes + 1_000_000
      })
    ]) {
      const first = await threadWithHistory();
      await first.stop();
      const file = first.store.snapshots.get("thread-1");
      assert.ok(file?.state.head);
      first.store.snapshots.set(
        "thread-1",
        plant({ ...file, state: { ...file.state, head: { ...file.state.head, title: "stale" } } })
      );
      const next = createTestHost({ store: first.store });
      const cursors = recordCursorReads(next);
      const thread = await snapshotRead(next);
      assert.equal(thread.head.title, "Test thread", "the log wins");
      assert.deepEqual(cursors.at(-1), { byteOffset: 0, afterSeq: 0 });
      assert.equal(thread.seq, first.store.logs.get("thread-1")!.length);
      await next.stop();
    }
  });

  it("discards a snapshot whose orchestrator extras are missing or malformed", async () => {
    const first = await threadWithHistory();
    await first.stop();
    const file = first.store.snapshots.get("thread-1");
    assert.ok(file?.state.head);
    first.store.snapshots.set("thread-1", {
      ...file,
      extras: { revertedTo: "two", titleManual: true },
      state: { ...file.state, head: { ...file.state.head, title: "stale" } }
    });
    const next = createTestHost({ store: first.store });
    assert.equal((await snapshotRead(next)).head.title, "Test thread");
    await next.stop();
  });

  it("writes state.json on every session transition, and in a long turn only past 200 events AND 30 s", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const saved: number[] = [];
    const save = host.store.saveFoldSnapshot.bind(host.store);
    host.store.saveFoldSnapshot = async (input) => {
      saved.push(input.seq);
      return save(input);
    };
    const logLength = (): number => host.store.logs.get(threadId)!.length;

    await bulkActivities(host, null, 150, threadId);
    await bulkActivities(host, null, 60, threadId);
    assert.deepEqual(saved, [], "210 rows within 30 s of the creation's snapshot write nothing");

    host.clock.advance(FOLD_SNAPSHOT_MIN_INTERVAL_MS);
    await bulkActivities(host, null, 1, threadId);
    assert.deepEqual(saved, [logLength()], "past both gates, one write");

    // A session transition writes at once, however recent the last write.
    await seedTurn(host, "s-1");
    await host.settle();
    const sessionSets = host.store.logs
      .get(threadId)!
      .filter((event, index) => index >= saved[0]! && event.type === "thread.session-set").length;
    assert.equal(saved.length, 1 + sessionSets);
    const file = host.store.snapshots.get(threadId);
    assert.equal(file?.seq, logLength());
    assert.equal(file?.logBytes, await host.store.logLength(threadId));

    // …and the in-turn gate is measured from that write.
    await bulkActivities(host, "s-1", FOLD_SNAPSHOT_EVENT_INTERVAL, threadId);
    assert.equal(saved.length, 1 + sessionSets, "200 events alone are not enough");
    host.clock.advance(FOLD_SNAPSHOT_MIN_INTERVAL_MS);
    await bulkActivities(host, "s-1", 1, threadId);
    assert.equal(saved.at(-1), logLength());
    await host.stop();
  });

  it("a snapshot that cannot be written never fails the command", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    host.store.saveFoldSnapshot = async () => {
      throw new Error("disk is full");
    };
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    assert.ok(typesOf(host).includes("thread.message-sent"));
    assert.ok(host.logger.entries.some((entry) => entry.message.includes("fold snapshot")));
    await host.stop();
  });

  it("carries the manual title and the revert guard as the log derives them", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.updateThread(threadId, { title: "Mine" });
    // Written by the very commit that made the title manual.
    assert.deepEqual(host.store.snapshots.get(threadId)?.extras, {
      revertedTo: null,
      titleManual: true
    });
    for (const [index, turnId] of ["g-1", "g-2", "g-3"].entries()) {
      await seedTurn(host, turnId, { checkpointTurnCount: index + 1 });
    }
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();
    assert.deepEqual(host.store.snapshots.get(threadId)?.extras, {
      revertedTo: 2,
      titleManual: true
    });
    await host.stop();

    // A restart from that snapshot keeps both: a provider retitle does not win,
    // and a late capture for a truncated turn is still dropped.
    const next = createTestHost({ store: host.store });
    const cursors = recordCursorReads(next);
    await next.orchestrator.readThread(threadId);
    assert.notDeepEqual(cursors[0], { byteOffset: 0, afterSeq: 0 }, "loaded from state.json");
    assert.equal(next.orchestrator.threadContext(threadId)?.titleManual, true);
    // The truncated turn has no ordinal any more; its late capture falls back
    // to the service's own counter, which is past the target.
    next.checkpoints.turnCount = 3;
    const consumed = next.orchestrator.consume(next.adapter);
    next.adapter.emit(turnBoundary(next, "turn.completed", "g-3"));
    await until(() => next.checkpoints.turnEndRequests.length > 0);
    await next.settle();
    assert.deepEqual(capturedCounts(next, "g-3"), [3], "only the capture from before the revert");
    assert.ok(
      next.logger.entries.some((entry) => entry.message.includes("reverted turn")),
      "the late capture was dropped by the guard"
    );
    next.adapter.close();
    await consumed;
    await next.stop();
  });

  it("a long cold fold leaves a snapshot behind, so the next load starts from it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await bulkActivities(host, null, 250, threadId);
    await host.settle();
    await host.stop();
    host.store.snapshots.delete(threadId);

    const next = createTestHost({ store: host.store });
    await next.orchestrator.readThread(threadId);
    await next.settle();
    const file = host.store.snapshots.get(threadId);
    assert.equal(file?.seq, host.store.logs.get(threadId)!.length);
    await next.stop();
  });
});

type FakeSnapshots = TestHost["store"]["snapshots"];

function activityIds(items: readonly ThreadItem[]): string[] {
  return items.filter((item) => item.kind === "activity").map((item) => item.id);
}

/** Every page below `before`, following each page's own cursor down. */
async function walkHistory(
  host: TestHost,
  threadId: string,
  before: string | null,
  turns?: number
): Promise<ThreadHistoryPage[]> {
  const pages: ThreadHistoryPage[] = [];
  let cursor = before;
  while (cursor !== null) {
    assert.ok(pages.length < 50, "paging terminates");
    const page = await host.orchestrator.readHistory(threadId, {
      before: cursor,
      ...(turns !== undefined ? { turns } : {})
    });
    pages.push(page);
    cursor = page.page.beforeCursor;
  }
  return pages;
}

/**
 * The pages and the window between them hold every activity the log ever
 * appended, no activity on two pages, and no message on two pages. A page may
 * repeat only the window's OLDEST activities, only at the newest page's newest
 * end, and at most a slack's worth: under batch retention the window holds up
 * to `ACTIVITY_RETENTION_SLACK` rows past its positional boundary between trims
 * (design 2026-09-23 fold performance), and the client renders such a row once.
 */
function assertLossless(
  host: TestHost,
  threadId: string,
  window: readonly ThreadItem[],
  pages: readonly ThreadHistoryPage[]
): void {
  const everyActivity = new Set(
    host.store.logs
      .get(threadId)!
      .flatMap((event) =>
        event.type === "thread.activity-appended" ? [event.payload.activity.id] : []
      )
  );
  const windowActivities = activityIds(window);
  const paged = pages.flatMap((page) => activityIds(page.items));
  assert.equal(new Set(paged).size, paged.length, "no activity on two pages");
  const inWindow = new Set(windowActivities);
  const repeated = paged.filter((id) => inWindow.has(id));
  assert.ok(repeated.length <= ACTIVITY_RETENTION_SLACK, "a page repeats at most a slack's worth of the window");
  assert.deepEqual(repeated, windowActivities.slice(0, repeated.length), "only the window's oldest rows");
  const newest = pages.length > 0 ? activityIds(pages[0]!.items) : [];
  assert.deepEqual(
    newest.slice(newest.length - repeated.length),
    repeated,
    "…and only at the newest page's newest end"
  );
  assert.deepEqual(new Set([...paged, ...windowActivities]), everyActivity, "nothing is lost");
  const pagedMessages = pages.flatMap((page) =>
    page.items.filter((item) => item.kind === "message").map((item) => item.id)
  );
  assert.equal(new Set(pagedMessages).size, pagedMessages.length, "no message on two pages");
}

/**
 * Every page names the row it ends at: the first page the window's first row
 * (the newest `ACTIVITY_RETENTION_LIMIT` parent rows' oldest), every older
 * page the first row of the page above it — what the client needs to keep the
 * timeline in log order (design 2026-09-23 fold performance, "Client").
 */
function assertPageEnds(window: readonly ThreadItem[], pages: readonly ThreadHistoryPage[]): void {
  const parentRows = window.filter((item) => item.kind === "activity" && item.agentId === undefined);
  const windowFirst = parentRows[parentRows.length - ACTIVITY_RETENTION_LIMIT];
  assert.ok(windowFirst, "the window is full");
  assert.equal(pages[0]?.page.endItemId, windowFirst.id, "the first page ends at the window");
  for (let at = 1; at < pages.length; at += 1) {
    assert.equal(
      pages[at]!.page.endItemId,
      pages[at - 1]!.items[0]?.id,
      `page ${at} ends where page ${at - 1} begins`
    );
  }
}

describe("orchestrator — the thread index (design 2026-09-23, C)", () => {
  it("hands the index every committed event with the store's positions, after the append", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();

    const log = host.store.logs.get(threadId)!;
    const observed = index.observed.filter((batch) => batch.threadId === threadId);
    assert.deepEqual(
      observed.flatMap((batch) => batch.events.map((event) => event.seq)),
      log.map((event) => event.seq)
    );
    const read = await host.store.readEventsFrom(threadId, { byteOffset: 0, afterSeq: 0 });
    assert.deepEqual(
      observed.flatMap((batch) => batch.positions),
      read.positions,
      "the positions the store wrote each line at"
    );
    for (const batch of observed) {
      assert.equal(batch.events.length, batch.positions.length);
      assert.equal(batch.projectPath, "/work/project");
      assert.equal(batch.title, "Test thread");
    }
    await host.stop();
  });

  it("an index that throws never fails the command whose events landed", async () => {
    const index = createFakeThreadIndex();
    index.observe = () => {
      throw new Error("index is on fire");
    };
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    assert.ok(typesOf(host, threadId).includes("thread.turn-start-requested"));
    await host.stop();
  });

  it("drops a deleted thread's rows", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await host.orchestrator.deleteThread(threadId);
    assert.deepEqual(index.deleted, [threadId]);
    assert.equal(index.totalTurns(threadId), 0);
    await host.stop();
  });

  it("offers older history exactly when the window has evicted an indexed activity", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "f-1");
    // Batch retention (design 2026-09-23 fold performance) lets the window grow
    // past its limit before the first trim. As long as every row is still
    // there, there is nothing older to offer, however many rows it holds.
    const nothingOlder = {
      indexed: true,
      hasOlder: false,
      beforeCursor: null,
      oldestRetainedOrdinal: 1,
      totalTurns: 1
    };
    await bulkActivities(host, "f-1", ACTIVITY_RETENTION_LIMIT, threadId);
    let appended = ACTIVITY_RETENTION_LIMIT;
    let evicted = await snapshotRead(host, threadId);
    while (evicted.items.some((item) => item.id === "f-1-bulk-0")) {
      assert.deepEqual(evicted.history, nothingOlder, `${appended} rows, none evicted`);
      assert.ok(
        appended <= ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK,
        "the first trim comes within the slack"
      );
      await bulkActivities(host, "f-1", 1, threadId, appended);
      appended += 1;
      evicted = await snapshotRead(host, threadId);
    }

    // The first trim: history begins at the window's positional start, the
    // oldest of its newest ACTIVITY_RETENTION_LIMIT parent rows.
    const parentRows = evicted.items.filter(
      (item) => item.kind === "activity" && item.agentId === undefined
    );
    const windowFirst = parentRows[parentRows.length - ACTIVITY_RETENTION_LIMIT];
    const f1 = evicted.turns.find((turn) => turn.turnId === "f-1");
    const windowStart = windowFirst ? index.itemPosition(threadId, windowFirst.id) : null;
    assert.ok(f1 && windowStart);
    assert.deepEqual(evicted.history, {
      indexed: true,
      hasOlder: true,
      beforeCursor: encodeHistoryCursor({
        threadId,
        beforeAnchorAt: f1.requestedAt,
        beforeTurnId: "f-1",
        beforeSeq: windowStart.seq
      }),
      oldestRetainedOrdinal: 1,
      totalTurns: 1
    });
    await host.stop();
  });

  it("stamps an unindexed snapshot `indexed: false`, and refuses history with INDEX_UNAVAILABLE", async () => {
    for (const index of [undefined, createFakeThreadIndex({ available: false })]) {
      const host = createTestHost(index ? { index } : {});
      const threadId = await host.createThread();
      await seedTurn(host, "u-1");
      const thread = await snapshotRead(host, threadId);
      assert.deepEqual(thread.history, {
        indexed: false,
        hasOlder: false,
        beforeCursor: null,
        oldestRetainedOrdinal: null,
        totalTurns: 0
      });
      await assert.rejects(host.orchestrator.readHistory(threadId, {}), (error: unknown) => {
        assert.ok(isAgentChatCommandError(error));
        assert.equal(error.code, "INDEX_UNAVAILABLE");
        assert.equal(error.status, 503);
        return true;
      });
      await host.stop();
    }
  });

  it("walks one monster turn back in blocks of 400 — contiguous, lossless, no row twice", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "m-1", { settle: false });
    await bulkActivities(host, "m-1", 1_500, threadId);
    const thread = await snapshotRead(host, threadId);
    assert.equal(thread.history?.hasOlder, true);

    const pages = await walkHistory(host, threadId, thread.history?.beforeCursor ?? null);
    assert.deepEqual(
      pages.map((page) => activityIds(page.items).length),
      [HISTORY_PAGE_ACTIVITIES, HISTORY_PAGE_ACTIVITIES, 200]
    );
    for (const page of pages) {
      assert.deepEqual(page.turns.map((turn) => turn.turnId), ["m-1"], "turns describe the block");
    }
    assertLossless(host, threadId, thread.items, pages);
    assertPageEnds(thread.items, pages);
    // The oldest block reaches the log's start: the turn's own prompt.
    assert.ok(pages.at(-1)!.items.some((item) => item.id === "user:m-1"));
    assert.equal(pages.at(-1)!.page.beforeCursor, null);

    // A malformed or foreign cursor is a first-page request.
    for (const before of [
      "not a cursor",
      encodeHistoryCursor({ threadId: "other", beforeAnchorAt: "x", beforeTurnId: "y", beforeSeq: 3 })
    ]) {
      assert.deepEqual(await host.orchestrator.readHistory(threadId, { before }), pages[0]);
    }
    assert.deepEqual(await host.orchestrator.readHistory(threadId, {}), pages[0]);
    await host.stop();
  });

  it("delivers a message streamed across a block boundary whole, on exactly one page", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "c-1", { settle: false });
    // 1 000 rows: the window keeps #500..#999, the first block is #100..#499,
    // so its start (#100) falls inside the message streamed around it.
    const chunk = (text: string, streaming = true) =>
      host.orchestrator.ingestionSink(threadId, [
        sinkEvent(host, threadId, `streamed:${text || "close"}`, "thread.message-sent", {
          messageId: "streamed",
          role: "assistant",
          text,
          streaming,
          turnId: "c-1"
        })
      ]);
    await bulkActivities(host, "c-1", 95, threadId);
    await chunk("one ");
    await bulkActivities(host, "c-1", 3, threadId, 95);
    await chunk("two ");
    await bulkActivities(host, "c-1", 5, threadId, 98);
    await chunk("three ");
    await bulkActivities(host, "c-1", 3, threadId, 103);
    await chunk("", false);
    await bulkActivities(host, "c-1", 894, threadId, 106);

    const thread = await snapshotRead(host, threadId);
    const pages = await walkHistory(host, threadId, thread.history?.beforeCursor ?? null);
    const holding = pages.filter((page) => page.items.some((item) => item.id === "streamed"));
    assert.equal(holding.length, 1, "on exactly one page");
    const message = holding[0]!.items.find((item) => item.id === "streamed");
    assert.equal(message?.kind === "message" ? message.text : null, "one two three ");
    // That page grew back to the message's first chunk rather than cut it,
    // and the page below it ends at that chunk.
    assert.equal(activityIds(pages[0]!.items).length, HISTORY_PAGE_ACTIVITIES + 5);
    assert.equal(pages[1]?.page.endItemId, "streamed");
    assertLossless(host, threadId, thread.items, pages);
    assertPageEnds(thread.items, pages);
    await host.stop();
  });

  it("walks back across turn boundaries, and honours the `turns` soft cap", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    for (const turnId of ["t-1", "t-2", "t-3"]) {
      host.clock.advance(1_000);
      await seedTurn(host, turnId, { checkpointTurnCount: Number(turnId.slice(2)) });
      await bulkActivities(host, turnId, 350, threadId);
    }
    const thread = await snapshotRead(host, threadId);
    // The window holds t-2's last 150 rows and all of t-3's.
    assert.equal(thread.history?.oldestRetainedOrdinal, 2);

    const pages = await walkHistory(host, threadId, thread.history?.beforeCursor ?? null);
    assert.deepEqual(
      pages.map((page) => page.turns.map((turn) => [turn.turnId, turn.ordinal])),
      [
        [
          ["t-1", 1],
          ["t-2", 2]
        ],
        [["t-1", 1]]
      ],
      "a block spans the t-1/t-2 boundary"
    );
    assert.deepEqual(pages.map((page) => activityIds(page.items).length), [400, 150]);
    assertLossless(host, threadId, thread.items, pages);
    // The block is exactly the log between its bounds, folded.
    const log = host.store.logs.get(threadId)!;
    const firstIds = new Set(activityIds(pages[0]!.items));
    const seqs = log
      .filter(
        (event) =>
          event.type === "thread.activity-appended" && firstIds.has(event.payload.activity.id)
      )
      .map((event) => event.seq);
    const windowStart = index.itemPosition(threadId, "t-2-bulk-200")!;
    const slice = log.filter(
      (event) => event.seq >= Math.min(...seqs) && event.seq < windowStart.seq
    );
    assert.deepEqual(pages[0]!.items, foldThread(slice).items);
    // Each seeded turn's checkpoint lands ahead of its rows: t-2's inside the
    // first block, t-1's inside the second.
    assert.deepEqual(
      pages.map((page) => page.checkpoints.map((checkpoint) => checkpoint.turnId)),
      [["t-2"], ["t-1"]]
    );

    // One turn per block: the first stops at t-2's opening prompt.
    const capped = await walkHistory(host, threadId, thread.history?.beforeCursor ?? null, 1);
    assert.deepEqual(
      capped.map((page) => page.turns.map((turn) => turn.turnId)),
      [["t-2"], ["t-1"]]
    );
    assert.ok(capped[0]!.items.some((item) => item.id === "user:t-2"));
    assert.deepEqual(capped.map((page) => activityIds(page.items).length), [200, 350]);
    assertLossless(host, threadId, thread.items, capped);
    await host.stop();
  });

  it("leaves a revert's cut out of the block that spans it", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    for (const [position, turnId] of ["v-1", "v-2", "v-3", "v-4"].entries()) {
      host.clock.advance(1_000);
      await seedTurn(host, turnId, { checkpointTurnCount: position + 1 });
      await bulkActivities(host, turnId, 2, threadId);
    }
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();
    for (const turnId of ["n-3", "n-4"]) {
      host.clock.advance(1_000);
      await seedTurn(host, turnId);
      await bulkActivities(host, turnId, 2, threadId);
    }
    const n4 = index.turnById(threadId, "n-4");
    const n4Row = index.itemPosition(threadId, "n-4-bulk-0");
    assert.ok(n4 && n4Row);
    const page = await host.orchestrator.readHistory(threadId, {
      before: encodeHistoryCursor({
        threadId,
        beforeAnchorAt: n4.requestedAt,
        beforeTurnId: "n-4",
        beforeSeq: n4Row.seq
      })
    });
    assert.deepEqual(
      page.turns.map((turn) => [turn.turnId, turn.ordinal]),
      [
        ["v-1", 1],
        ["v-2", 2],
        ["n-3", 3],
        ["n-4", 4]
      ]
    );
    const messages = page.items.filter((item) => item.kind === "message").map((item) => item.id);
    assert.deepEqual(messages, ["user:v-1", "user:v-2", "user:n-3", "user:n-4"]);
    assert.ok(!page.items.some((item) => item.id.startsWith("v-3") || item.id.startsWith("v-4")));
    assert.equal(page.page.beforeCursor, null);
    await host.stop();
  });

  it("an old row retention keeps out of order does not pull the boundary back", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "k-1", { settle: false });
    // A compaction marker is exempt from the window: it outlives the rows
    // around it, and must not become where history begins.
    await compactionMarker(host, "kept-marker", threadId);
    await bulkActivities(host, "k-1", 600, threadId);
    const thread = await snapshotRead(host, threadId);
    assert.ok(thread.items.some((item) => item.id === "kept-marker"));
    assert.ok(!thread.items.some((item) => item.id === "k-1-bulk-0"), "the window has evicted");
    // The window's positional start — its newest 500 parent rows — whatever
    // slack past them it still holds.
    const windowStart = index.itemPosition(threadId, "k-1-bulk-100");
    assert.ok(windowStart);
    assert.equal(decodeHistoryCursor(thread.history!.beforeCursor!, threadId)?.beforeSeq, windowStart.seq);
    const pages = await walkHistory(host, threadId, thread.history?.beforeCursor ?? null);
    assert.deepEqual(pages.map((page) => activityIds(page.items).length), [101]);
    assert.deepEqual(
      pages[0]!.turns.map((turn) => turn.rewindable),
      [false],
      "the compaction lies after the turn's prompt"
    );
    await host.stop();
  });

  it("a cursor whose activity was rewritten since ends the block just past the one below it", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "r-1", { settle: false });
    await bulkActivities(host, "r-1", 10, threadId);
    const r1 = index.turnById(threadId, "r-1");
    const boundary = index.itemPosition(threadId, "r-1-bulk-5");
    assert.ok(r1 && boundary);
    const before = encodeHistoryCursor({
      threadId,
      beforeAnchorAt: r1.requestedAt,
      beforeTurnId: "r-1",
      beforeSeq: boundary.seq
    });
    // The same row, written again: its latest line moves on.
    await bulkActivities(host, "r-1", 1, threadId, 5);
    assert.equal(index.itemPositionBySeq(threadId, boundary.seq), null);
    const page = await host.orchestrator.readHistory(threadId, { before });
    assert.deepEqual(activityIds(page.items), [0, 1, 2, 3, 4].map((n) => `r-1-bulk-${n}`));
    await host.stop();
  });

  it("an empty page when nothing is older", async () => {
    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await seedTurn(host, "o-1");
    await bulkActivities(host, "o-1", 3, threadId);
    for (const query of [{}, { turns: 5 }]) {
      assert.deepEqual(await host.orchestrator.readHistory(threadId, query), {
        threadId,
        turns: [],
        items: [],
        checkpoints: [],
        page: { beforeCursor: null },
        seq: host.store.logs.get(threadId)!.length
      });
    }
    await host.stop();
  });

  it("searches through the index, and answers `indexed: false` without one", async () => {
    const none = createTestHost();
    assert.deepEqual(none.orchestrator.searchThreads({ q: "hello", limit: 5 }), {
      query: "hello",
      hits: [],
      truncated: false,
      indexed: false
    });
    await none.stop();

    const index = createFakeThreadIndex();
    const host = createTestHost({ index });
    const hit = {
      threadId: "thread-1",
      projectPath: "/work/project",
      title: "Test thread",
      turnId: null,
      ordinal: null,
      kind: "message" as const,
      id: "user:1",
      role: "user" as const,
      activityKind: null,
      snippet: "«hello»",
      at: host.clock.nowIso(),
      seq: 2
    };
    index.searchHits = [hit, { ...hit, id: "user:2" }];
    assert.deepEqual(host.orchestrator.searchThreads({ q: "hello", limit: 2, projectPath: "/work/project" }), {
      query: "hello",
      hits: index.searchHits,
      truncated: true,
      indexed: true
    });
    assert.deepEqual(index.searches, [{ q: "hello", limit: 2, projectPath: "/work/project" }]);
    assert.deepEqual(host.orchestrator.searchThreads({ q: "   ", limit: 2 }).hits, []);
    assert.equal(index.searches.length, 1, "a blank query never reaches the index");
    await host.stop();
  });
});
