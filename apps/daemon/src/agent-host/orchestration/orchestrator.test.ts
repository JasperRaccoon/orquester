import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent, RuntimeEvent, ThreadActivityItem } from "@orquester/api/agent-chat";

import { isAgentChatCommandError } from "./errors.ts";
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
  options: { dismissible: boolean },
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

describe("orchestrator — revert (§5.5)", () => {
  it("refuses a target above the current turn count", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await assert.rejects(
      () =>
        host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 3 }),
      (error: unknown) => isAgentChatCommandError(error) && error.code === "COMMAND_REJECTED"
    );
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

  it("checks rollback support before touching disk, and lands the failure as a row", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const threadId = await host.createThread({ refId: "grok" });
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "cp",
        threadId,
        type: "thread.turn-diff-completed",
        payload: {
          turnCount: 1,
          turnId: "turn-1",
          ref: "refs/orquester/checkpoints/x/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: host.clock.nowIso()
        },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 0 });
    await host.settle();

    assert.equal(grok.calls.filter((call) => call.kind === "rollbackThread").length, 0);
    assert.equal(host.checkpoints.pruned.length, 0, "nothing on disk was touched");
    const failure = activityEvents(host).find(
      (row) => row.activityKind === "checkpoint.revert.failed"
    );
    assert.ok(failure);
    assert.equal(failure?.tone, "error");
    await host.stop();
  });

  it("rolls back, prunes and appends thread.reverted", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "cp1",
        threadId,
        type: "thread.turn-diff-completed",
        payload: {
          turnCount: 2,
          turnId: "turn-2",
          ref: "refs/orquester/checkpoints/x/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: host.clock.nowIso()
        },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 1 });
    await host.settle();

    const rollback = host.adapter.calls.find((call) => call.kind === "rollbackThread");
    assert.equal(rollback?.detail, 1);
    assert.deepEqual(host.checkpoints.pruned, [{ threadId, targetTurnCount: 1 }]);
    assert.ok(typesOf(host).includes("thread.reverted"));
    await host.stop();
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
    assert.equal((turns.at(-1)?.detail as { input: string }).input, "main");
    const log = host.store.logs.get(threadId) ?? [];
    const message = log.find(
      (event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" && event.payload.text === "main"
    );
    assert.ok(message, "the answer is a user message row");
    const resolved = activityEvents(host).find(
      (row) => row.activityKind === "user-input.resolved" && row.id === "async-answer:codex-async:t:1"
    );
    assert.ok(resolved, "the card closes through the same activity a dismissal writes");
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
});
