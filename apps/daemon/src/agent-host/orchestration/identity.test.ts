/**
 * Switching a thread's managed account (spec §3.4 "account changed").
 *
 * The rule the whole feature rests on: the switch writes `launch.json` and the
 * head, and starts NOTHING. The provider child is replaced by the ordinary
 * ensure-session step on the next `/turn`, carrying the resume cursor — which
 * is also the only reason the conversation survives the change.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";
import {
  GOAL_CONTINUING_SWITCH_REFUSAL,
  GOAL_HELD_SWITCH_REFUSAL,
  identitySwitchRefusal,
  type IdentitySwitchState
} from "./session-policy.ts";

let commandSeq = 0;
const cmd = (): string => `id-${(commandSeq += 1)}`;

const startCalls = (host: TestHost): number =>
  host.adapter.calls.filter((call) => call.kind === "startSession").length;

const activityKinds = (host: TestHost, threadId = "thread-1"): string[] =>
  (host.store.logs.get(threadId) ?? [])
    .filter((event) => event.type === "thread.activity-appended")
    .map((event) => (event.payload as { activity: { activityKind: string } }).activity.activityKind);

/**
 * Settle the thread's turn the way ingestion does when the provider finishes:
 * a `thread.session-set` leaving `running` settles every unsettled turn. The
 * provider child stays live, which is the state a switch has to handle.
 */
async function completeTurn(host: TestHost, threadId = "thread-1"): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `turn-end-${threadId}`,
      threadId,
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
  await host.settle();
}

/** A thread that ran and finished one turn, so it has a cursor and is idle. */
async function idleThreadWithACursor(): Promise<{ host: TestHost; threadId: string }> {
  const host = createTestHost();
  void host.orchestrator.consume(host.adapter);
  const threadId = await host.createThread({
    accountId: "acc1",
    home: "account",
    homePath: "/homes/acc1",
    launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc1" }
  });
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
  await host.settle();
  await completeTurn(host, threadId);
  return { host, threadId };
}

const switchToAcc2 = {
  accountId: "acc2",
  home: "account" as const,
  homePath: "/homes/acc2",
  launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc2" }
};

describe("switching a thread's account (§3.4)", () => {
  it("records the new identity, rewrites launch.json and starts NOTHING", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    const before = startCalls(host);

    const receipt = await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      ...switchToAcc2
    });
    await host.settle();

    assert.ok(receipt.seq > 0, "the switch answers a receipt sequence");
    assert.equal(startCalls(host), before, "no provider child was started by the switch");
    assert.equal(
      host.launchConfigs.entries.get(threadId)?.homePath,
      "/homes/acc2",
      "launch.json carries the new home"
    );
    assert.equal(
      host.orchestrator.launchConfig(threadId)?.launchEnv?.CLAUDE_CONFIG_DIR,
      "/homes/acc2",
      "the in-memory launch config main.ts reads was refreshed too"
    );
    const head = host.store.heads.get(threadId);
    assert.equal(head?.accountId, "acc2");
    assert.equal(head?.home, "account");
    assert.ok(
      activityKinds(host).includes("session.identity-changed"),
      "the timeline records where the identity changed"
    );
    await host.stop();
  });

  it("the NEXT turn restarts the provider under the new home, carrying the cursor", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    const cursorBefore = host.store.bindings.get(threadId)?.resumeCursor;
    assert.ok(cursorBefore, "the first turn learned a cursor");

    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...switchToAcc2 });
    await host.settle();
    const stopsBefore = host.adapter.calls.filter((call) => call.kind === "stopSession").length;

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();

    assert.equal(
      host.adapter.calls.filter((call) => call.kind === "stopSession").length,
      stopsBefore + 1,
      "the old session was stopped before the restart"
    );
    assert.equal(host.adapter.lastStart?.home.path, "/homes/acc2");
    assert.equal(
      (host.adapter.lastStart?.home as { accountId?: string }).accountId,
      "acc2",
      "resolveHome was asked for the NEW account"
    );
    assert.deepEqual(
      host.adapter.lastStart?.resumeCursor,
      cursorBefore,
      "the conversation is kept: the restart carries the resume cursor"
    );
    assert.equal(
      host.store.bindings.get(threadId)?.providerInstanceId,
      "account:acc2",
      "the binding names the identity the live session actually runs under"
    );
    await host.stop();
  });

  it("a thread with no live session simply starts under the new identity", async () => {
    const host = createTestHost();
    void host.orchestrator.consume(host.adapter);
    const threadId = await host.createThread({
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });

    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...switchToAcc2 });
    await host.settle();
    assert.equal(startCalls(host), 0, "a switch is not a reason to boot a provider child");

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    assert.equal(startCalls(host), 1);
    assert.equal(host.adapter.lastStart?.home.path, "/homes/acc2");
    assert.equal(host.store.bindings.get(threadId)?.providerInstanceId, "account:acc2");
    await host.stop();
  });

  it("an unchanged identity is a no-op receipt: no event, no activity", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    const eventsBefore = (host.store.logs.get(threadId) ?? []).length;

    const receipt = await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });
    await host.settle();

    assert.equal((host.store.logs.get(threadId) ?? []).length, eventsBefore);
    assert.equal(receipt.seq, eventsBefore, "it answers the sequence the thread is already at");
    assert.ok(!activityKinds(host).includes("session.identity-changed"));
    await host.stop();
  });

  it("replays the same receipt for a retried commandId rather than switching twice", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    const commandId = cmd();
    const first = await host.orchestrator.setIdentity(threadId, {
      commandId,
      ...switchToAcc2
    });
    await host.settle();
    const second = await host.orchestrator.setIdentity(threadId, {
      commandId,
      accountId: "acc3",
      home: "account",
      homePath: "/homes/acc3"
    });
    assert.equal(second.seq, first.seq);
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc2", "the retry changed nothing");
    assert.equal(host.launchConfigs.entries.get(threadId)?.homePath, "/homes/acc2");
    await host.stop();
  });

  it("refuses while a turn is running, and the thread keeps its account", async () => {
    const host = createTestHost();
    void host.orchestrator.consume(host.adapter);
    const threadId = await host.createThread({ accountId: "acc1", homePath: "/homes/acc1" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();

    await assert.rejects(
      () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...switchToAcc2 }),
      (error: { code?: string }) => error.code === "COMMAND_REJECTED"
    );
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc1");
    assert.equal(host.launchConfigs.entries.get(threadId)?.homePath, "/homes/acc1");
    await host.stop();
  });

  it("refuses while a request is parked", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "ingest-approval",
        threadId,
        type: "thread.activity-appended",
        payload: {
          activity: {
            kind: "activity",
            id: "approval:a1",
            tone: "approval",
            activityKind: "approval.requested",
            summary: "Run a command?",
            payload: { requestId: "a1", requestKind: "command" },
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
    await host.settle();

    await assert.rejects(
      () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...switchToAcc2 }),
      (error: { code?: string; message?: string }) =>
        error.code === "COMMAND_REJECTED" && /open request/i.test(error.message ?? "")
    );
    await host.stop();
  });

  it("a thread whose session is in ERROR may still switch — that is the escape hatch", async () => {
    // A stale login is exactly when the user wants another account, and the
    // switch starts nothing, so §6.2's "409 for any command in error" carve-out
    // covers it the way `/session/stop` and `/revert` are covered.
    const { host, threadId } = await idleThreadWithACursor();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "ingest-error",
        threadId,
        type: "thread.session-set",
        payload: {
          session: { status: "error", activeTurnId: null, lastError: "session expired" }
        },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.settle();

    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...switchToAcc2 });
    await host.settle();
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
    await host.stop();
  });

  it("refuses an OpenCode thread outright — its server owns the identity", async () => {
    const opencode = createScriptedAdapter({ id: "opencode" });
    const host = createTestHost({ adapters: { opencode } });
    const threadId = await host.createThread({ refId: "opencode", home: "system", accountId: "" });

    await assert.rejects(
      () =>
        host.orchestrator.setIdentity(threadId, {
          commandId: cmd(),
          accountId: "acc2",
          home: "account"
        }),
      (error: { code?: string }) => error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });

  it("refuses to cross the cliproxy boundary in either direction", async () => {
    const { host, threadId } = await idleThreadWithACursor();
    await assert.rejects(
      () =>
        host.orchestrator.setIdentity(threadId, {
          commandId: cmd(),
          accountId: "acc2",
          home: "cliproxy",
          proxyRefId: "claudex"
        }),
      (error: { code?: string }) => error.code === "INVALID_COMMAND"
    );

    const proxyHost = createTestHost();
    const proxyThread = await proxyHost.createThread({
      threadId: "thread-proxy",
      refId: "claudex",
      home: "cliproxy",
      proxyRefId: "claudex"
    });
    await assert.rejects(
      () =>
        proxyHost.orchestrator.setIdentity(proxyThread, {
          commandId: cmd(),
          accountId: "acc2",
          home: "account"
        }),
      (error: { code?: string }) => error.code === "INVALID_COMMAND"
    );
    await host.stop();
    await proxyHost.stop();
  });
});

describe("the identity gate (§3.4, mirrored by the composer chip §7.4)", () => {
  const idle: IdentitySwitchState = {
    status: "idle",
    activeTurnId: null,
    hasUnsettledTurn: false,
    pendingRequestCount: 0,
    queuedTurnCount: 0,
    compacting: false,
    backgroundLive: false,
    goalContinuing: false,
    goalHeldForUpdate: false
  };

  it("passes only when nothing is in flight", () => {
    assert.equal(identitySwitchRefusal(idle), null);
    assert.equal(identitySwitchRefusal({ ...idle, status: "ready" }), null);
    assert.equal(identitySwitchRefusal({ ...idle, status: "stopped" }), null);
  });

  it("refuses every in-flight shape", () => {
    for (const state of [
      { ...idle, activeTurnId: "turn-1" },
      { ...idle, hasUnsettledTurn: true },
      { ...idle, status: "starting" as const },
      { ...idle, status: "running" as const },
      { ...idle, pendingRequestCount: 1 },
      { ...idle, queuedTurnCount: 1 },
      { ...idle, compacting: true },
      { ...idle, backgroundLive: true },
      { ...idle, goalContinuing: true },
      { ...idle, goalContinuing: true, goalHeldForUpdate: true }
    ]) {
      assert.ok(identitySwitchRefusal(state), `refused: ${JSON.stringify(state)}`);
    }
  });

  it("names the compaction first — it is the phase the user can act on", () => {
    assert.match(
      identitySwitchRefusal({ ...idle, compacting: true, status: "running" }) ?? "",
      /compaction/i
    );
  });

  it("refuses a continuing goal in the words the composer mirror shows (goals §5.5)", () => {
    assert.equal(
      identitySwitchRefusal({ ...idle, goalContinuing: true }),
      "Pause the goal before switching accounts."
    );
    // Between a continuing goal's turns idle never comes, so the goal's reason
    // outranks the running turn; a compaction must still finish first, because
    // a goal command waits for it too.
    assert.equal(
      identitySwitchRefusal({ ...idle, goalContinuing: true, status: "running", activeTurnId: "t" }),
      "Pause the goal before switching accounts."
    );
    assert.match(
      identitySwitchRefusal({ ...idle, goalContinuing: true, compacting: true }) ?? "",
      /compaction/i
    );
    assert.equal(GOAL_CONTINUING_SWITCH_REFUSAL, "Pause the goal before switching accounts.");
  });

  it("names a goal held for an Orquester update in words of its own, in the continuing goal's slot (goals §5.7)", () => {
    // It is paused already, and the next host sets it going again by itself:
    // "pause the goal" would be advice it has had. The composer mirror
    // (`account-switch.ts`) pins the same words.
    assert.equal(
      GOAL_HELD_SWITCH_REFUSAL,
      "The goal is paused for an Orquester update and resumes by itself once the agent host has restarted. Send /goal pause to keep it paused, then switch accounts."
    );
    const held = { ...idle, goalContinuing: true, goalHeldForUpdate: true };
    assert.equal(identitySwitchRefusal(held), GOAL_HELD_SWITCH_REFUSAL);
    // Its final turn may still run: the hold's words still come first — once
    // the user has taken the goal back, the turn check speaks for itself.
    assert.equal(
      identitySwitchRefusal({ ...held, status: "running", activeTurnId: "t" }),
      GOAL_HELD_SWITCH_REFUSAL
    );
    assert.equal(
      identitySwitchRefusal({ ...held, pendingRequestCount: 1, backgroundLive: true }),
      GOAL_HELD_SWITCH_REFUSAL
    );
    // Behind a running compaction, as the continuing goal is.
    assert.match(identitySwitchRefusal({ ...held, compacting: true }) ?? "", /compaction/i);
    // Taken back by the user's `/goal pause`: neither held nor continuing.
    assert.equal(identitySwitchRefusal({ ...held, goalContinuing: false, goalHeldForUpdate: false }), null);
  });
});
