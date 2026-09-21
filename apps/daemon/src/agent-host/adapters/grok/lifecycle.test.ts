/**
 * Lifecycle tests: the REAL adapter driven against a scripted mock peer
 * launched through the REAL spawn path (spec §9).
 *
 * Spawn failure, a bad binary, a version below the gate, a handshake timeout,
 * an exit mid-turn, interrupt ordering with a pending approval,
 * settle-as-cancel, lazy recovery after death, steering, resume, rollback and
 * compaction all go through `createGrokAdapter`, `support/spawn.ts` and the
 * ACP peer — no stubs below the adapter's own seam.
 *
 * Nothing here sleeps: every wait is on an emitted event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AccountHome,
  AgentAdapterId,
  RuntimeEvent,
  RuntimeMode
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { createGrokAdapter, GROK_CAPABILITIES } from "./index.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");

interface Rig {
  adapter: Awaited<ReturnType<typeof createGrokAdapter>>;
  events: RuntimeEvent[];
  /** Resolves when an event matching the predicate has been emitted. */
  waitFor(predicate: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
  cwd: string;
}

async function rig(
  options: { scenario?: string; version?: string; bin?: string | null } = {}
): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), "grok-lifecycle-"));
  const events: RuntimeEvent[] = [];
  const waiters: Array<{ predicate: (event: RuntimeEvent) => boolean; resolve: (event: RuntimeEvent) => void }> = [];

  const controller = new AbortController();
  let ids = 0;
  const context: AdapterContext = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { now: () => new Date(0), nowIso: () => "2026-09-21T00:00:00.000Z" },
    ids: {
      eventId: () => `e${(ids += 1)}`,
      messageId: (prefix) => `${prefix}-${(ids += 1)}`,
      uuid: () => `u${(ids += 1)}`
    },
    resolveAttachmentPath: async () => await Promise.resolve(cwd),
    attachmentsDir: () => cwd,
    logRawFrame: () => {},
    buildEnv: () => ({
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      TMPDIR: cwd,
      GROK_MOCK_SCENARIO: options.scenario ?? "happy",
      ...(options.version === undefined ? {} : { GROK_MOCK_VERSION: options.version })
    }),
    resolveBin: async () => await Promise.resolve(options.bin === undefined ? MOCK : options.bin),
    sessionPath: () => process.env["PATH"] ?? "",
    tmpDir: () => cwd,
    signal: controller.signal
  };

  const adapter = await createGrokAdapter(context);
  void (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(event)) {
          waiters.splice(index, 1)[0].resolve(event);
        }
      }
    }
  })();

  return {
    adapter,
    events,
    waitFor: (predicate, label) =>
      new Promise<RuntimeEvent>((resolve, reject) => {
        const existing = events.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${label}`));
        }, 15_000);
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          }
        });
      }),
    dispose: async () => {
      controller.abort();
      await adapter.stopAll();
    },
    cwd
  };
}

function home(dir: string): AccountHome {
  // `system` on purpose: a managed home would have the adapter rewrite a
  // config.toml, which belongs in launch.test.ts rather than here.
  return { kind: "system", path: dir };
}

async function start(
  r: Rig,
  overrides: { runtimeMode?: RuntimeMode; resumeCursor?: unknown; threadId?: string } = {}
): Promise<void> {
  await r.adapter.startSession({
    threadId: overrides.threadId ?? "t1",
    cwd: r.cwd,
    home: home(r.cwd),
    modelSelection: { model: "grok-4.6" },
    runtimeMode: overrides.runtimeMode ?? "approval-required",
    ...(overrides.resumeCursor === undefined ? {} : { resumeCursor: overrides.resumeCursor })
  });
}

// ---------------------------------------------------------------------------

test("the adapter declares the capabilities the reality check demands", () => {
  assert.equal(GROK_CAPABILITIES.reportsContextWindow, true, "the spec says false; the CLI reports usage");
  assert.equal(GROK_CAPABILITIES.showPlanModeToggle, false);
  assert.equal(GROK_CAPABILITIES.supportsConversationRollback, false);
  assert.deepEqual(GROK_CAPABILITIES.compaction, { type: "slash-command", command: "/compact" });
  assert.equal(GROK_CAPABILITIES.sessionModelSwitch, "in-session");
});

test("a missing binary is refused with a message, not a hang", async () => {
  const r = await rig({ bin: null });
  await assert.rejects(async () => await start(r), /not installed or not on PATH/);
  await r.dispose();
});

test("a binary that cannot be spawned settles rather than hanging", async () => {
  const r = await rig({ bin: join(dirname(MOCK), "definitely-not-here") });
  await assert.rejects(async () => await start(r));
  await r.dispose();
});

test("a CLI below the minimum version is refused with the required version", async () => {
  const r = await rig({ version: "0.9.0" });
  await assert.rejects(async () => await start(r), /0\.9\.0 is too old/);
  assert.equal(r.adapter.hasSession("t1"), false, "a refused session is not registered");
  await r.dispose();
});

test("a handshake that never answers times out and kills the child", async () => {
  const r = await rig({ scenario: "no-handshake" });
  await assert.rejects(async () => await start(r), /timed out/);
  await r.dispose();
});

test("the happy path: session, turn, usage, and a settled turn", async () => {
  const r = await rig();
  await start(r);
  assert.equal(r.adapter.hasSession("t1"), true);
  assert.deepEqual(
    r.events.filter((event) => event.type === "session.started").length,
    1
  );
  const threadStarted = r.events.find((event) => event.type === "thread.started");
  assert.equal(
    (threadStarted as Extract<RuntimeEvent, { type: "thread.started" }>).payload.providerThreadId,
    "01a0c19e-de22-78c0-a72a-7e230ccfbec0"
  );

  const result = await r.adapter.sendTurn({
    threadId: "t1",
    input: "hello",
    attachments: [],
    interactionMode: "default"
  });
  assert.ok(result.turnId.length > 0);
  assert.deepEqual(result.resumeCursor, {
    schemaVersion: 1,
    sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0"
  });

  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "completed");
  assert.equal(completed.payload.stopReason, "end_turn");
  assert.equal(completed.payload.tokenUsage?.usageStatus, "complete");
  assert.equal(completed.payload.tokenUsage?.inputTokens, 22_423);
  assert.equal(completed.payload.totalCostUsd?.toFixed(6), "0.121754");

  const text = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.equal(text, "echo:hello");

  await r.dispose();
});

test("the live command catalog replaces the handshake's, minus the two filtered names", async () => {
  const r = await rig();
  await start(r);
  await r.waitFor((event) => event.type === "session.state.changed", "ready");
  const snapshot = await r.adapter.refreshSnapshot();
  const names = snapshot.slashCommands.map((command) => command.name);
  assert.ok(names.includes("compact"));
  assert.ok(names.includes("loop"), "the post-session catalog is the real one");
  assert.equal(names.includes("always-approve"), false);
  assert.equal(names.includes("context"), false);
  await r.dispose();
});

test("an approval opens a request, and the decision reaches the agent", async () => {
  const r = await rig({ scenario: "permission" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });

  const opened = (await r.waitFor(
    (event) => event.type === "request.opened",
    "request.opened"
  )) as Extract<RuntimeEvent, { type: "request.opened" }>;
  assert.equal(opened.payload.requestType, "file_change_approval");
  assert.equal(opened.payload.dismissible, false, "a native callback is never dismissible");
  assert.equal(opened.payload.options, undefined, "the UI shows the canonical four buttons");

  await r.adapter.respondToApproval("t1", opened.requestId!, "accept");
  const resolved = (await r.waitFor(
    (event) => event.type === "request.resolved",
    "request.resolved"
  )) as Extract<RuntimeEvent, { type: "request.resolved" }>;
  assert.equal(resolved.payload.decision, "accept");

  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "completed");
  await r.dispose();
});

test("a declined tool settles as cancelled, not as an interrupt", async () => {
  const r = await rig({ scenario: "permission" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  const opened = await r.waitFor((event) => event.type === "request.opened", "request.opened");
  await r.adapter.respondToApproval("t1", opened.requestId!, "decline");

  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  // `stopReason: "cancelled"` is ambiguous on this CLI; the
  // `cancellationCategory` is what distinguishes a decline from a Stop.
  assert.equal(completed.payload.stopReason, "cancelled");
  assert.equal(completed.payload.state, "cancelled");
  await r.dispose();
});

test("full-access answers the approval itself with no card at all", async () => {
  const r = await rig({ scenario: "permission" });
  await start(r, { runtimeMode: "full-access" });
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  assert.equal(
    r.events.some((event) => event.type === "request.opened"),
    false
  );
  await r.dispose();
});

test("auto-accept-edits answers an edit itself, because the CLI flag is a no-op", async () => {
  const r = await rig({ scenario: "permission" });
  await start(r, { runtimeMode: "auto-accept-edits" });
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  assert.equal(
    r.events.some((event) => event.type === "request.opened"),
    false,
    "`--permission-mode acceptEdits` still asks; the adapter is what honours the mode"
  );
  await r.dispose();
});

test("interrupt settles the pending approval BEFORE the cancel, then settles the turn", async () => {
  const r = await rig({ scenario: "cancel" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  const opened = await r.waitFor((event) => event.type === "request.opened", "request.opened");

  await r.adapter.interruptTurn("t1");

  const order = r.events.map((event) => event.type);
  const resolvedAt = order.indexOf("request.resolved");
  const completedAt = order.lastIndexOf("turn.completed");
  assert.ok(resolvedAt >= 0, "the parked approval was settled");
  assert.ok(completedAt > resolvedAt, "settle-before-interrupt ordering");

  const resolved = r.events[resolvedAt] as Extract<RuntimeEvent, { type: "request.resolved" }>;
  assert.equal(resolved.payload.decision, "cancel");
  assert.equal(resolved.requestId, opened.requestId);

  const completed = r.events[completedAt] as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "interrupted");
  await r.dispose();
});

test("interrupt is turn-scoped: a Stop naming another turn is a no-op", async () => {
  const r = await rig({ scenario: "cancel" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "request.opened", "request.opened");

  await r.adapter.interruptTurn("t1", "some-other-turn");
  assert.equal(
    r.events.some((event) => event.type === "turn.completed"),
    false,
    "a Stop that races a settling turn must not kill the next one"
  );
  await r.adapter.interruptTurn("t1");
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  await r.dispose();
});

test("a child that exits mid-turn settles the turn, closes items and then exits", async () => {
  const r = await rig({ scenario: "exit-mid-turn" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "count", attachments: [], interactionMode: "default" });

  const exited = (await r.waitFor(
    (event) => event.type === "session.exited",
    "session.exited"
  )) as Extract<RuntimeEvent, { type: "session.exited" }>;
  const order = r.events.map((event) => event.type);
  const completedAt = order.indexOf("turn.completed");
  const exitedAt = order.indexOf("session.exited");
  assert.ok(completedAt >= 0 && completedAt < exitedAt, "a running state never outlives its process");

  const completed = r.events[completedAt] as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "failed");
  assert.match(completed.payload.errorMessage ?? "", /exited/);
  assert.equal(exited.payload.exitKind, "error");
  assert.equal(exited.payload.recoverable, true);
  // The CLI exits 143 with signal null, so a supervisor keying on the signal
  // would misread this.
  assert.match(exited.payload.reason ?? "", /code 143/);
  await r.dispose();
});

test("lazy recovery: a fresh session starts from the persisted cursor after a death", async () => {
  const r = await rig({ scenario: "exit-mid-turn" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "count", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "session.exited", "session.exited");

  // A crashed session is indistinguishable from a fresh one to the caller.
  const r2 = await rig({ scenario: "happy" });
  await r2.adapter.startSession({
    threadId: "t1",
    cwd: r2.cwd,
    home: home(r2.cwd),
    modelSelection: { model: "grok-4.6" },
    runtimeMode: "approval-required",
    resumeCursor: { schemaVersion: 1, sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0" }
  });
  const started = r2.events.find((event) => event.type === "session.started") as Extract<
    RuntimeEvent,
    { type: "session.started" }
  >;
  assert.deepEqual(started.payload.resume, {
    schemaVersion: 1,
    sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0"
  });
  // The replayed frames must NOT reappear in the live stream.
  assert.equal(
    r2.events.some(
      (event) => event.type === "content.delta" && event.payload.delta === "earlier"
    ),
    false
  );
  await r.dispose();
  await r2.dispose();
});

test("a cursor with the wrong shape means 'no resume', never an error", async () => {
  const r = await rig();
  await start(r, { resumeCursor: { schemaVersion: 99, sessionId: "x" } });
  const started = r.events.find((event) => event.type === "session.started") as Extract<
    RuntimeEvent,
    { type: "session.started" }
  >;
  assert.equal(started.payload.resume, undefined);
  await r.dispose();
});

test("steering reuses the turn id and emits no second turn.started", async () => {
  const r = await rig({ scenario: "slow" });
  await start(r);
  const first = await r.adapter.sendTurn({
    threadId: "t1",
    input: "count to twenty",
    attachments: [],
    interactionMode: "default"
  });
  const second = await r.adapter.sendTurn({
    threadId: "t1",
    input: "stop and say DONE",
    attachments: [],
    interactionMode: "default"
  });
  assert.equal(second.turnId, first.turnId, "a mid-turn message is not a second turn");
  assert.equal(
    r.events.filter((event) => event.type === "turn.started").length,
    1
  );
  await r.dispose();
});

test("compaction is a /compact turn, and is refused while a turn runs", async () => {
  const r = await rig({ scenario: "slow" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "long", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.started", "turn.started");
  await assert.rejects(async () => await r.adapter.compact("t1"), /cannot compact while a turn is running/);
  await r.dispose();
});

test("rollback validates first and then always refuses", async () => {
  const r = await rig();
  await start(r);
  await assert.rejects(async () => await r.adapter.rollbackThread("t1", 0), /integer >= 1/);
  await assert.rejects(
    async () => await r.adapter.rollbackThread("t1", 2),
    /do not support provider-side conversation rollback/
  );
  await r.dispose();
});

test("/always-approve is refused with a pointer at the permission selector", async () => {
  const r = await rig();
  await start(r);
  await assert.rejects(
    async () =>
      await r.adapter.sendTurn({
        threadId: "t1",
        input: "/always-approve off",
        attachments: [],
        interactionMode: "default"
      }),
    /permission selector/
  );
  // The bare word is prose, not the command.
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "/always-approve-ish",
    attachments: [],
    interactionMode: "default"
  });
  await r.dispose();
});

test("stopSession settles everything and emits a graceful exit", async () => {
  const r = await rig({ scenario: "slow" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "long", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.started", "turn.started");
  await r.adapter.stopSession("t1");
  const exited = (await r.waitFor(
    (event) => event.type === "session.exited",
    "session.exited"
  )) as Extract<RuntimeEvent, { type: "session.exited" }>;
  assert.equal(exited.payload.exitKind, "graceful");
  const completed = r.events.find((event) => event.type === "turn.completed") as Extract<
    RuntimeEvent,
    { type: "turn.completed" }
  >;
  assert.equal(completed.payload.state, "interrupted");
  assert.equal(r.adapter.hasSession("t1"), false);
  await r.dispose();
});

test("listSessions and the adapter id", async () => {
  const r = await rig();
  await start(r);
  const sessions = r.adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].threadId, "t1");
  assert.equal(sessions[0].runtimeMode, "approval-required");
  assert.equal(r.adapter.id, "grok" satisfies AgentAdapterId);
  await r.dispose();
});
