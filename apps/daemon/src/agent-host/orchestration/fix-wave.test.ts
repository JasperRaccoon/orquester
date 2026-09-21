/**
 * Regression tests for the fix wave. Each one fails against the code as it was
 * before its fix; the finding id is named so the pairing stays legible.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { DomainEvent, RuntimeEvent, ThreadActivityItem } from "@orquester/api/agent-chat";
import { SLIM_MAX_STRING_BYTES } from "@orquester/api/agent-chat";

import { createTestHost, createScriptedAdapter, type TestHost } from "./testing/index.ts";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "./orchestrator.ts";

let seq = 0;
const cmd = (): string => `fw-${(seq += 1)}`;

function activities(host: TestHost, threadId = "thread-1"): ThreadActivityItem[] {
  return (host.store.logs.get(threadId) ?? [])
    .filter(
      (event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
        event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

async function pushActivity(
  host: TestHost,
  threadId: string,
  activity: Partial<ThreadActivityItem> & { id: string; activityKind: string }
): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `ing-${activity.id}`,
      threadId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          tone: "info",
          summary: activity.activityKind,
          payload: {},
          turnId: null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso(),
          ...activity
        } as ThreadActivityItem
      },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

describe("Q1-1: one runtime per thread under concurrent first-touches", () => {
  it("a subscription taken while the thread is cold still receives events", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({ threadId: "cold-1" });
    // Drop the loaded runtime so the next touch is genuinely cold, and make the
    // log read take a turn of the loop the way a real disk read does.
    await host.orchestrator.stop();

    const next = createTestHost({ store: host.store });
    const originalReadAll = next.store.readAll.bind(next.store);
    next.store.readAll = async (id: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      return originalReadAll(id);
    };

    const seen: DomainEvent[] = [];
    // The tab-open flow: the read and the subscribe are issued together.
    const [, unsubscribe] = await Promise.all([
      next.orchestrator.readThread(threadId),
      next.orchestrator.subscribe(threadId, {
        onEvents: (events) => seen.push(...events)
      })
    ]);

    await next.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      runtimeMode: "auto"
    });
    await next.settle();

    assert.deepEqual(
      seen.map((event) => event.type),
      ["thread.runtime-mode-set"],
      "the subscriber must be on the runtime the command publishes into"
    );
    unsubscribe();
    await next.stop();
  });
});

describe("Q1-8: a failed sendTurn settles the session instead of leaving it starting", () => {
  it("persists error, so /session/stop and /revert can still recover the thread", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    host.adapter.failNext("failSendTurn", new Error("provider refused the turn"));

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    const head = host.store.heads.get(threadId);
    assert.equal(head?.session.status, "error");
    assert.equal(head?.session.activeTurnId, null);
    assert.match(String(head?.session.lastError), /provider refused the turn/);
    assert.ok(
      activities(host).some((row) => row.activityKind === "provider.turn.start.failed"),
      "and the failure is still a timeline row"
    );
    await host.stop();
  });
});

describe("Q1-9 / Q1-25: deleting a thread frees what the host held for it", () => {
  it("detaches subscribers and tells ingestion to forget the thread", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const forgotten: string[] = [];
    host.ingestion.forget = (id: string) => {
      forgotten.push(id);
    };
    const seen: DomainEvent[] = [];
    await host.orchestrator.subscribe(threadId, {
      onEvents: (events) => seen.push(...events)
    });

    await host.orchestrator.deleteThread(threadId);
    assert.ok(
      seen.some((event) => event.type === "thread.deleted"),
      "the last frame still reaches the open stream"
    );
    assert.deepEqual(forgotten, [threadId]);
    await host.stop();
  });
});

describe("Q1-10: a continuation arms the turn watchdog", () => {
  it("the resumed turn has a liveness bound like any other", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long" });
    await first.settle();
    await first.stop();

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();

    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);

    // The watchdog only arms once the protocol shows observable progress, so
    // drive it: without `watchdogFor` on the continuation path `runtime.watchdog`
    // is null and `consume` observes nothing at all, so no timer ever arms and
    // the resumed turn has no liveness bound.
    const consumed = next.orchestrator.consume(next.adapter);
    const base = { threadId, createdAt: next.clock.nowIso() };
    next.adapter.emit({
      ...base,
      eventId: "t",
      type: "turn.started",
      turnId: "turn-1",
      payload: {}
    } as unknown as RuntimeEvent);
    next.adapter.emit({
      ...base,
      eventId: "d",
      type: "content.delta",
      turnId: "turn-1",
      payload: { streamKind: "assistant_text", delta: "hi" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      next.timers.pending > 0,
      "a turn resumed from a cursor is the case most likely to wedge"
    );
    next.adapter.close();
    await consumed;
    await next.stop();
  });
});

describe("R5-1: activity payloads are slimmed on the way out, not on disk", () => {
  it("the snapshot caps a huge tool payload and stamps truncated", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const huge = "x".repeat(SLIM_MAX_STRING_BYTES * 2);
    await pushActivity(host, threadId, {
      id: "tool-1",
      activityKind: "tool.completed",
      tone: "tool",
      payload: { itemType: "command_execution", data: { output: huge } }
    });
    await host.settle();

    const read = await host.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    const item =
      read.kind === "snapshot"
        ? read.thread.items.find((entry) => entry.id === "tool-1")
        : undefined;
    assert.ok(item && item.kind === "activity");
    const wire = JSON.stringify(item.payload);
    assert.ok(
      wire.length < huge.length,
      "a multi-MB tool result must not reach the wire in full"
    );
    assert.equal((item.payload as { truncated?: boolean }).truncated, true);

    // …and the full payload is still readable for "load full output".
    const full = await host.orchestrator.readItem(threadId, "tool-1");
    assert.ok(full && full.kind === "activity");
    assert.equal(
      ((full.payload as { data?: { output?: string } }).data?.output ?? "").length,
      huge.length
    );
    await host.stop();
  });
});

describe("R5-5: the client's title seed is not a manual rename", () => {
  it("a seed leaves the provider free to retitle; a user rename does not", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();

    await host.orchestrator.updateThread(threadId, { title: "First prompt…", seed: true });
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, false);

    await host.orchestrator.updateThread(threadId, { title: "Mine" });
    assert.equal(host.orchestrator.threadContext(threadId)?.titleManual, true);
    await host.stop();
  });
});

describe("R5-6: the pre-turn baseline is captured before the provider is asked", () => {
  it("captureBaseline runs ahead of startSession and sendTurn", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    assert.deepEqual(host.checkpoints.baselines[0], threadId);
    const firstProviderCall = host.adapter.calls[0]?.kind;
    assert.equal(firstProviderCall, "startSession");
    // The capture is recorded before any provider call could have written.
    assert.ok(host.checkpoints.baselines.length >= 1);
    await host.stop();
  });
});

describe("R1-6: a pending turn cannot pin a thread busy forever", () => {
  it("the reconcile settles a turn start whose effect never ran", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // A `/turn` that committed its rows and then lost the host: block the
    // effect so only the command's events land.
    host.adapter.failNext("failStartSession", new Error("host died before the send"));
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    const stalled = createTestHost({ store: host.store });
    // Older than the grace window.
    stalled.clock.set(host.clock.now().getTime() + 10 * 60_000);
    await stalled.orchestrator.reconcile();
    await stalled.settle();

    const turns = (await stalled.orchestrator.readThread(threadId, undefined)) as {
      kind: "snapshot";
      thread: { turns: Array<{ state: string }> };
    };
    assert.ok(
      turns.thread.turns.every((turn) => turn.state !== "pending"),
      "a pending turn nothing will ever start must be settled"
    );
    await stalled.stop();
    await host.stop();
  });
});

describe("R6-3: hasActionableProposedPlan means the LATEST plan is unimplemented", () => {
  it("clears once the user sends the implementation turn", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await pushActivity(host, threadId, {
      id: "plan-1",
      activityKind: "turn.proposed.completed",
      payload: { planMarkdown: "# plan" }
    });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.hasActionableProposedPlan, true);

    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# plan`
    });
    await host.settle();
    assert.equal(
      host.orchestrator.summary(threadId)?.hasActionableProposedPlan,
      false,
      "a plan the user already implemented is not actionable"
    );
    await host.stop();
  });
});

describe("R8: an auth.status error reaches the provider snapshot", () => {
  it("routes the message onto the cached snapshot so the toast can fire", async () => {
    const claude = createScriptedAdapter({ id: "claude" });
    const host = createTestHost({ adapters: { claude } });
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
      capabilities: claude.capabilities
    });

    const applied: Array<{ id: string; message?: string }> = [];
    host.snapshots.applyAuthStatus = (adapterId, event) => {
      if (event.type !== "auth.status") return;
      applied.push({ id: adapterId, message: event.payload.error });
    };
    host.orchestrator.onAccountEvent({
      eventId: "auth",
      threadId,
      createdAt: host.clock.nowIso(),
      type: "auth.status",
      payload: { error: "Session expired, run /login" }
    } as unknown as RuntimeEvent);

    assert.deepEqual(applied, [{ id: "claude", message: "Session expired, run /login" }]);
    await host.stop();
  });
});

describe("S1-7: the image cap is re-checked against the stat'd file at dispatch", () => {
  it("refuses a 'small image' that is really a large file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-host-attach-"));
    try {
      const host = createTestHost();
      const threadId = await host.createThread();
      const big = join(dir, "big.png");
      await writeFile(big, Buffer.alloc(11 * 1024 * 1024));
      assert.ok((await stat(big)).size > 10 * 1024 * 1024);
      const ref = await host.store.putAttachment({
        threadId,
        name: "big.png",
        mimeType: "application/octet-stream",
        sourcePath: big
      });

      await host.orchestrator.command(threadId, "turn", {
        commandId: cmd(),
        input: "look",
        // The client claims it is a small image; the file says otherwise.
        attachments: [
          { type: "image", id: ref.id, name: "big.png", mimeType: "image/png", sizeBytes: 1_000 }
        ]
      });
      await host.settle();

      assert.equal(
        host.adapter.calls.filter((call) => call.kind === "sendTurn").length,
        0,
        "the turn must not reach the provider"
      );
      assert.ok(activities(host).some((row) => row.summary === "Attachment rejected"));
      await host.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("R2-6: an empty probe never blanks a non-empty cached list", () => {
  it("keeps each array independently, including on a machine-level probe", async () => {
    const { createProviderSnapshotRegistry } = await import("./provider-snapshots.ts");
    const { createRecordingLogger, createTestClock } = await import("./testing/fakes.ts");
    const dir = await mkdtemp(join(tmpdir(), "snapshots-"));
    try {
      let next = {
        id: "claude" as const,
        refIds: ["claude"],
        installed: true,
        version: "1.0.0",
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "1970-01-01T00:00:00.000Z",
        models: [],
        slashCommands: [{ name: "compact" }],
        skills: [{ name: "review", path: "/s", enabled: true }],
        capabilities: {
          sessionModelSwitch: "in-session" as const,
          showPlanModeToggle: true,
          reportsContextWindow: true,
          compaction: { type: "native" as const }
        }
      };
      const registry = createProviderSnapshotRegistry({
        probes: [{ id: "claude", refresh: async () => next }],
        stateDir: dir,
        logger: createRecordingLogger(),
        clock: createTestClock(0)
      });
      await registry.refresh("claude");
      assert.equal(registry.get("claude")?.skills.length, 1);

      // A transient EACCES on the skills dir recovers to `[]` while the
      // command list is still good.
      next = { ...next, skills: [], slashCommands: [{ name: "compact" }, { name: "review" }] };
      await registry.refresh("claude");
      assert.equal(registry.get("claude")?.skills.length, 1, "skills must survive");
      assert.equal(registry.get("claude")?.slashCommands.length, 2);
      registry.stop();
      await registry.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2: a pending turn row is adopted, never settled", () => {
  it("a `ready` session state while a turn start is in flight does not complete it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });

    // What the adapter reports the moment its session is up, before the
    // provider has minted a turn id — the exact frame the E2E trace saw at
    // seq 4, one step after `thread.turn-start-requested`.
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "ready",
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

    const read = await host.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    const turns = read.kind === "snapshot" ? read.thread.turns : [];
    assert.equal(
      turns.filter((turn) => turn.turnId === null && turn.state === "completed").length,
      0,
      "one user message must not grow a phantom completed turn"
    );
    await host.stop();
  });
});

describe("E8: a capture for a reverted turn never resurrects the head", () => {
  it("drops a turn-diff whose turn count is above the revert target", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    for (const turnCount of [1, 2, 3]) {
      await host.orchestrator.ingestionSink(threadId, [
        {
          eventId: `cp${turnCount}`,
          threadId,
          type: "thread.turn-diff-completed",
          payload: {
            turnCount,
            turnId: `turn-${turnCount}`,
            ref: `refs/orquester/checkpoints/x/turn/${turnCount}`,
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
    }
    await host.settle();
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount: 2 });
    await host.settle();

    const before = (await host.orchestrator.readThread(threadId)) as {
      kind: "snapshot";
      thread: { head: { turnCount: number } };
    };
    assert.equal(before.thread.head.turnCount, 2);

    // The in-flight turn's capture lands after the revert.
    host.checkpoints.turnCount = 3;
    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit({
      eventId: "late",
      threadId,
      createdAt: host.clock.nowIso(),
      type: "turn.completed",
      turnId: "turn-4",
      payload: { state: "completed" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));
    await host.settle();

    const after = (await host.orchestrator.readThread(threadId)) as {
      kind: "snapshot";
      thread: { head: { turnCount: number } };
    };
    assert.equal(after.thread.head.turnCount, 2, "the revert must stay reverted");
    host.adapter.close();
    await consumed;
    await host.stop();
  });
});
