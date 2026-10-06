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

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_TURN_INPUT_CHARS,
  type AccountHome,
  type AgentGoal,
  type GoalUpdatedPayload,
  type RuntimeEvent,
  type RuntimeMode
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  settle
} from "../../ingestion/test-harness.ts";
import { resumeCursorFor } from "../../orchestration/resume.ts";
import { readLeftoverWork } from "../../support/leftover-work.ts";
import { createGrokAdapter } from "./index.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");

interface Rig {
  adapter: Awaited<ReturnType<typeof createGrokAdapter>>;
  events: RuntimeEvent[];
  /** Resolves when an event matching the predicate has been emitted. */
  waitFor(predicate: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent>;
  /** Let the event consumer catch up, so `events` reflects what was emitted. */
  drain(): Promise<void>;
  /** The host's teardown — its abort, then its own `stopAll()` — the rig's files kept. */
  teardown(): Promise<void>;
  /** The teardown, then the rig's directory removed. */
  dispose(): Promise<void>;
  disposed: boolean;
  cwd: string;
  /** `GROK_RIG_MARK` in this rig's launch env: finds its own processes in `/proc`. */
  mark: string;
  /** The thread `t1`'s `leftover-work.json`: what its launches left running for a later user end. */
  leftoverWork: string;
  /** Resolves when the adapter logs a message matching `pattern`, at any level. */
  logged(pattern: RegExp): Promise<void>;
}

/** Always dispose rigs, including when a behavioral assertion fails. */
const openRigs: Rig[] = [];
after(async () => {
  for (const entry of openRigs) {
    if (!entry.disposed) await entry.dispose();
  }
});

async function rig(
  options: {
    scenario?: string;
    version?: string;
    bin?: string | null;
    env?: Record<string, string>;
    /** Share another rig's `leftover-work.json`: a later host of the same thread. */
    leftoverWork?: string;
  } = {}
): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), "grok-lifecycle-"));
  const mark = randomUUID();
  const leftoverWork = options.leftoverWork ?? join(cwd, "threads", "t1", "leftover-work.json");
  // The thread's directory, as the store creates it with the thread: the
  // adapter never creates it (a late record must not raise a deleted thread).
  await mkdir(dirname(leftoverWork), { recursive: true });
  const events: RuntimeEvent[] = [];
  const waiters: Array<{ predicate: (event: RuntimeEvent) => boolean; resolve: (event: RuntimeEvent) => void }> = [];

  const controller = new AbortController();
  let ids = 0;
  const logs: string[] = [];
  const logWaiters: Array<{ pattern: RegExp; resolve: () => void }> = [];
  const log = (message: string): void => {
    logs.push(message);
    for (let index = logWaiters.length - 1; index >= 0; index -= 1) {
      if (logWaiters[index].pattern.test(message)) {
        logWaiters.splice(index, 1)[0].resolve();
      }
    }
  };
  const context: AdapterContext = {
    logger: { debug: log, info: log, warn: log, error: log },
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
      GROK_RIG_MARK: mark,
      // The thread's `leftover-work.json`: `leftover-exit` exits once its work is recorded there.
      GROK_MOCK_LEFTOVER_WORK: leftoverWork,
      ...(options.version === undefined ? {} : { GROK_MOCK_VERSION: options.version }),
      ...options.env
    }),
    resolveBin: async () => await Promise.resolve(options.bin === undefined ? MOCK : options.bin),
    sessionPath: () => process.env["PATH"] ?? "",
    tmpDir: () => cwd,
    leftoverWorkPath: (threadId) => (threadId === "t1" ? leftoverWork : join(cwd, "threads", threadId, "leftover-work.json")),
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

  const built: Rig = {
    adapter,
    events,
    disposed: false,
    drain: async () => {
      // Two macrotasks: one for the async iterator's `next()` to resolve, one
      // for the consumer loop to push into `events`.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
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
    teardown: async () => {
      controller.abort();
      await adapter.stopAll();
    },
    dispose: async () => {
      built.disposed = true;
      await built.teardown();
      // Its HOME, TMPDIR and thread directory: nothing of a test outlives it.
      await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
    },
    cwd,
    mark,
    leftoverWork,
    logged: (pattern) =>
      new Promise<void>((resolve) => {
        if (logs.some((message) => pattern.test(message))) {
          resolve();
          return;
        }
        logWaiters.push({ pattern, resolve });
      })
  };
  openRigs.push(built);
  return built;
}

function home(dir: string): AccountHome {
  // `system` on purpose: a managed home would have the adapter rewrite a
  // config.toml, which belongs in launch.test.ts rather than here.
  return { kind: "system", path: dir };
}

async function start(
  r: Rig,
  overrides: {
    runtimeMode?: RuntimeMode;
    resumeCursor?: unknown;
    threadId?: string;
    knownGoal?: AgentGoal | null;
  } = {}
): Promise<void> {
  await r.adapter.startSession({
    threadId: overrides.threadId ?? "t1",
    cwd: r.cwd,
    home: home(r.cwd),
    modelSelection: { model: "grok-4.6" },
    runtimeMode: overrides.runtimeMode ?? "approval-required",
    ...(overrides.resumeCursor === undefined ? {} : { resumeCursor: overrides.resumeCursor }),
    ...(overrides.knownGoal === undefined ? {} : { knownGoal: overrides.knownGoal })
  });
}

/** Every `thread.goal.updated` payload emitted so far, in order. */
function goalUpdates(r: Rig): GoalUpdatedPayload[] {
  return r.events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "thread.goal.updated" }> =>
        event.type === "thread.goal.updated"
    )
    .map((event) => event.payload);
}

/** The goal the mock's `session/load` replays last (see `testing/mock-grok.mjs`). */
const MOCK_REPLAYED_GOAL: AgentGoal = {
  objective: "Audit every request handler for cross-clinic data access and fix each hole",
  status: "active",
  goalId: "3f6b2c1e-8a4d-4f0b-9c2e-7d5a1b9e0c44",
  phase: "executing",
  rounds: 1,
  lastCheck: "Round one: the handlers were inventoried."
};
const MOCK_SESSION_CURSOR = { schemaVersion: 1, sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0" };

// ---------------------------------------------------------------------------

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

test("a handshake that never answers times out and kills the child", async () => {
  const r = await rig({ scenario: "no-handshake" });
  await assert.rejects(async () => await start(r), /timed out/);
  await r.drain();
  assert.deepEqual(lifecycleRows(r.events), [], "the timeout is the report, never a crash");
  await r.dispose();
});

/**
 * The rows a session reports of its own life. A session that never announced
 * `session.started` has none: the start's rejection is its whole report, and
 * the host writes that — an exit row besides it read as a crash of a session
 * that never ran.
 */
function lifecycleRows(events: readonly RuntimeEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.type.startsWith("session.") ||
        event.type.startsWith("thread.") ||
        event.type === "turn.completed" ||
        event.type === "runtime.error"
    )
    .map((event) => event.type);
}

test("a CLI that dies after its session opened but before it was announced fails the open — never announced ready", async () => {
  const r = await rig({ scenario: "exit-on-set-model" });
  try {
    await assert.rejects(
      async () =>
        await r.adapter.startSession({
          threadId: "t1",
          cwd: r.cwd,
          home: home(r.cwd),
          // Not the CLI's current model: the open's last step, `session/set_model`, is what the CLI dies on.
          modelSelection: { model: "grok-4.7" },
          runtimeMode: "approval-required"
        }),
      /exited with code 3 before its session opened/
    );
    await r.drain();
    assert.equal(r.adapter.hasSession("t1"), false);
    assert.deepEqual(lifecycleRows(r.events), [], "no session.started, no ready — and no crash row beside the rejection");
    assert.deepEqual(
      r.events.filter((event) => event.type === "runtime.warning").map((event) => event.payload.message),
      [],
      "and no model-switch warning from a CLI that is gone"
    );
  } finally {
    await r.dispose();
  }
});

test("a session that fails to open reports nothing of its own: its start's rejection is the report", async () => {
  const cases = [
    { label: "the version gate", rig: { version: "0.9.0" }, cursor: undefined, error: /0\.9\.0 is too old/ },
    {
      label: "a cursor the CLI no longer knows",
      rig: {},
      cursor: { schemaVersion: 1, sessionId: "01a0c19e-0000-7000-8000-000000000000" },
      error: /Path not found/
    }
  ];
  for (const { label, rig: options, cursor, error } of cases) {
    const r = await rig(options);
    try {
      await assert.rejects(async () => await start(r, cursor === undefined ? {} : { resumeCursor: cursor }), error);
      await r.drain();
      assert.deepEqual(lifecycleRows(r.events), [], `${label}: no exit row, no state, no crash`);
      assert.equal(r.adapter.hasSession("t1"), false);
    } finally {
      await r.dispose();
    }
  }
});

test("the happy path: session, turn, usage, and a settled turn", async () => {
  const r = await rig();
  await start(r);
  assert.equal(r.adapter.hasSession("t1"), true);
  const threadStarted = await r.waitFor((event) => event.type === "thread.started", "thread.started");
  assert.equal(
    r.events.filter((event) => event.type === "session.started").length,
    1
  );
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
  await r.drain();
  assert.deepEqual(resolutionsOf(r.events, opened.requestId).map((event) => event.payload), [
    { requestType: "file_change_approval", decision: "accept" }
  ]);
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
  const completed = await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  assert.equal((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "completed");
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
  const completed = await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  assert.equal((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "completed");
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

test("a cursor with the wrong shape means 'no resume', never an error", async () => {
  const r = await rig();
  await start(r, { resumeCursor: { schemaVersion: 99, sessionId: "x" } });
  const started = (await r.waitFor(
    (event) => event.type === "session.started",
    "session.started"
  )) as Extract<RuntimeEvent, { type: "session.started" }>;
  assert.equal(started.payload.resume, undefined);
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

test("listSessions reflects active sessions", async () => {
  const r = await rig();
  await start(r);
  await r.drain();
  const sessions = r.adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].threadId, "t1");
  assert.equal(sessions[0].runtimeMode, "approval-required");
  await r.dispose();
});

test("attachments reach the agent as PATHS, because promptCapabilities.image is false", async () => {
  const r = await rig();
  await start(r);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "look at this",
    attachments: [{ type: "image", id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 }],
    interactionMode: "default"
  });
  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "completed");
  // The mock echoes the prompt text back, so the path line is observable.
  const echoed = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.ok(echoed.includes(r.cwd), "the resolved attachment path reaches the provider");
  assert.match(echoed, /shot\.png/);
  await r.dispose();
});

test("the input guard bounds the typed text, never the Attached files block after it", async () => {
  const r = await rig();
  await start(r);
  const attachments = [{ type: "file" as const, id: "a1", name: "q3.xlsx", sizeBytes: 10 }];
  await assert.rejects(
    r.adapter.sendTurn({
      threadId: "t1",
      input: "x".repeat(MAX_TURN_INPUT_CHARS + 1),
      attachments,
      interactionMode: "default"
    }),
    /exceeds/
  );
  // A full-length message still takes its block on top.
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "x".repeat(MAX_TURN_INPUT_CHARS),
    attachments,
    interactionMode: "default"
  });
  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "completed");
  await r.dispose();
});

test("readThread returns the turns the adapter actually observed", async () => {
  const r = await rig();
  await start(r);
  const first = await r.adapter.sendTurn({
    threadId: "t1",
    input: "one",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");

  const snapshot = await r.adapter.readThread("t1");
  assert.equal(snapshot.threadId, "t1");
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].id, first.turnId);
  const item = snapshot.turns[0].items[0] as Record<string, unknown>;
  assert.equal(item["stopReason"], "end_turn");
  // The provider's OWN prompt id, resolved from `_x.ai/queue/changed`.
  assert.equal(item["providerPromptId"], "prompt-1");
  await r.dispose();
});

test("stopAll stops sessions without ending the event stream", async () => {
  const r = await rig();
  await start(r);
  await r.adapter.stopAll();
  assert.equal(r.adapter.listSessions().length, 0);
  // A host that stopped every session and then started a new one must still
  // have a live consumer.
  await start(r, { threadId: "t2" });
  const started = await r.waitFor(
    (event) => event.type === "thread.started" && event.threadId === "t2",
    "thread.started for t2"
  );
  assert.equal(started.threadId, "t2");
  await r.dispose();
});

test("a session starts from the host's minimal cursor, not just our own", async () => {
  const r = await rig();
  await start(r, {
    resumeCursor: resumeCursorFor("grok", "t1", "01a0c19e-de22-78c0-a72a-7e230ccfbec0")
  });
  const started = (await r.waitFor(
    (event) => event.type === "session.started",
    "session.started"
  )) as Extract<RuntimeEvent, { type: "session.started" }>;
  assert.deepEqual(started.payload.resume, {
    schemaVersion: 1,
    sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0"
  });
  // It really loaded rather than creating: the mock only answers
  // `session/load` for that id, and the replayed rows stay out of the stream.
  assert.equal(
    r.events.some((event) => event.type === "content.delta" && event.payload.delta === "earlier"),
    false
  );
  await r.dispose();
});

test("a steer closes the call its cancel cut, on the turn it steers — the CLI never answers it", async () => {
  const r = await rig({ scenario: "steer-call" });
  try {
    await start(r);
    const first = await r.adapter.sendTurn({ threadId: "t1", input: "run it", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "item.started" && event.itemId === "call-steer-cut-0", "the call in flight");
    await r.adapter.sendTurn({ threadId: "t1", input: "no, say DONE", attachments: [], interactionMode: "default" });
    const done = await r.waitFor((event) => event.type === "turn.completed", "the steered turn's end");
    const ends = r.events.filter((event) => event.type === "item.completed" && event.itemId === "call-steer-cut-0");
    assert.deepEqual(
      ends.map((event) => [event.turnId, (event.payload as { status?: string }).status, (event.payload as { detail?: string }).detail]),
      [[first.turnId, "failed", "Cancelled: a new message was sent."]]
    );
    assert.ok(r.events.indexOf(ends[0]!) < r.events.indexOf(done), "closed before the turn settles");
  } finally {
    await r.dispose();
  }
});

test("a steer settles the turn from the STEERED prompt, not the cancelled one", async () => {
  // R4 #1 / Q1 #4 (blocker). The old guard was inverted: the cancelled first
  // prompt matched `turn.epoch` and ended the turn, and the steered answer was
  // discarded. The previous steering test could not see it — it asserted only
  // the turn id and a `turn.started` count, both of which held with the bug.
  const r = await rig({ scenario: "steer" });
  await start(r);
  const first = await r.adapter.sendTurn({
    threadId: "t1",
    input: "count to twenty",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor(
    (event) => event.type === "content.delta" && event.payload.delta === "one",
    "the first prompt streaming"
  );
  const second = await r.adapter.sendTurn({
    threadId: "t1",
    input: "stop and say DONE",
    attachments: [],
    interactionMode: "default"
  });
  assert.equal(second.turnId, first.turnId, "a steer reuses the turn id");

  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "completed", "the STEERED prompt settles the turn");
  assert.equal(completed.payload.stopReason, "end_turn");
  assert.equal(completed.payload.tokenUsage?.usageStatus, "complete");
  assert.equal(completed.turnId, first.turnId);

  // The steered answer really reached the timeline.
  const text = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.match(text, /DONE/, "the steered prompt's output is not dropped");
  assert.equal(
    r.events.filter((event) => event.type === "turn.completed").length,
    1,
    "exactly one terminal row"
  );
  assert.equal(r.events.filter((event) => event.type === "turn.started").length, 1);
  await r.dispose();
});

test("a steer closes the cancelled prompt's bubble: the steered reply is a new assistant item", async () => {
  // ACP's `agent_message_chunk` names no message, so the normaliser's segment
  // is the only thing that tells two prompts' text apart. A steer re-opened
  // the stream without closing that segment, so the steered reply streamed
  // into the bubble the cancelled prompt was writing — one "oneDONE" message,
  // which keeps its first position and so rendered ABOVE the user's steer.
  // T3 closes the active segment on every prompt dispatch
  // (`AcpSessionRuntime.ts:1033-1034`).
  const r = await rig({ scenario: "steer" });
  await start(r);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "count to twenty",
    attachments: [],
    interactionMode: "default"
  });
  const before = (await r.waitFor(
    (event) => event.type === "content.delta" && event.payload.delta === "one",
    "the first prompt streaming"
  )) as Extract<RuntimeEvent, { type: "content.delta" }>;
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "stop and say DONE",
    attachments: [],
    interactionMode: "default"
  });
  const after = (await r.waitFor(
    (event) => event.type === "content.delta" && event.payload.delta === "DONE",
    "the steered prompt streaming"
  )) as Extract<RuntimeEvent, { type: "content.delta" }>;
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  await r.drain();

  assert.ok(before.itemId !== undefined && after.itemId !== undefined, "both deltas name their item");
  assert.notEqual(after.itemId, before.itemId, "the steered reply opens a new assistant segment");
  const closedAt = r.events.findIndex(
    (event) =>
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      event.itemId === before.itemId
  );
  assert.ok(closedAt !== -1, "the cancelled prompt's bubble is completed");
  assert.ok(
    closedAt < r.events.indexOf(after),
    "the cancelled prompt's bubble is completed BEFORE the steered reply streams"
  );

  // Through ingestion: two messages in arrival order, never one "oneDONE".
  const clock = new FakeClock("2026-09-24T12:00:00.000Z");
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen("d")
  });
  for (const event of r.events) {
    clock.advance(30);
    await ingestion.ingest(event);
  }
  await ingestion.drain();
  await settle();
  const texts = new Map<string, string>();
  for (const event of sink.messages()) {
    if (event.payload.role !== "assistant") continue;
    texts.set(event.payload.messageId, `${texts.get(event.payload.messageId) ?? ""}${event.payload.text}`);
  }
  assert.deepEqual(
    [...texts.values()],
    ["one", "DONE"],
    "the steered reply is its own message, after the cancelled prompt's"
  );
  await r.dispose();
});

test("a chunk the cancelled prompt sends after the steer stays in ITS bubble, never the steered reply's", async () => {
  // The cancelled prompt may flush a last chunk after `session/cancel`, and
  // on an unchanged model and mode nothing waits between the cancel and the
  // steered prompt's dispatch, so no dispatch-time boundary can keep it out
  // of the next bubble. Its `_meta.promptId` can: every chunk carries the
  // prompt that produced it (fixtures README 19; 08 shows two distinct ids).
  const r = await rig({ scenario: "steer-tail" });
  await start(r);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "count to twenty",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor(
    (event) => event.type === "content.delta" && event.payload.delta === "one",
    "the first prompt streaming"
  );
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "stop and say DONE",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  await r.drain();

  const textByItem = new Map<string, string>();
  for (const event of r.events) {
    if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
      const key = event.itemId ?? "";
      textByItem.set(key, `${textByItem.get(key) ?? ""}${event.payload.delta}`);
    }
  }
  assert.deepEqual(
    [...textByItem.values()],
    ["one two", "DONE"],
    "the tail joins the cancelled prompt's bubble; the steered reply is its own"
  );
  await r.dispose();
});

test("Stop with NO active turn is session-scoped: live background work is closed", async () => {
  // R6 #1 / §6.2. The turn settles while a background shell keeps running, so
  // §7.6 still shows Stop and the client posts an interrupt with no turnId.
  // An early return here leaves the work running and the client's `stopping`
  // flag stuck, because `backgroundLiveness` never drops to null.
  const r = await rig({ scenario: "background" });
  await start(r);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "start a background job",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "task.started", "task.started");
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  assert.equal(
    r.events.some((event) => event.type === "task.completed"),
    false,
    "nothing reported the background task's end: no snapshot or poll said so"
  );

  await r.adapter.interruptTurn("t1");

  const stopped = (await r.waitFor(
    (event) => event.type === "task.completed",
    "task.completed"
  )) as Extract<RuntimeEvent, { type: "task.completed" }>;
  assert.equal(stopped.payload.status, "stopped");
  assert.equal(stopped.payload.taskId, "task-bg-1");
  // The session itself stays up: the user pressed Stop, not Close.
  assert.equal(r.adapter.hasSession("t1"), true);
  await r.dispose();
});

/** `[type, id]` of the item and task ends, in emission order. */
function ends(events: readonly RuntimeEvent[]): Array<[string, string | undefined]> {
  return events
    .filter((event) => event.type === "item.completed" || event.type === "task.completed")
    .map((event) => [event.type, event.itemId ?? (event.payload as { taskId?: string }).taskId]);
}

const OPEN_WORK_ENDS: Array<[string, string]> = [
  ["item.completed", "call-open-1"],
  ["task.completed", "task-bg-1"]
];

test("Stop with no turn closes the open call BEFORE the background task", async () => {
  // Every adapter's teardown closes calls before tasks (AGENTS.md, "A running
  // state never outlives its process"): a background shell's call closes
  // before its task.
  const r = await rig({ scenario: "open-work" });
  await start(r);
  await r.adapter.sendTurn({ threadId: "t1", input: "work", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  const before = r.events.length;
  await r.adapter.interruptTurn("t1");
  await r.waitFor((event) => event.type === "task.completed", "task.completed");
  await r.drain();
  assert.deepEqual(ends(r.events.slice(before)), OPEN_WORK_ENDS);
  await r.dispose();
});

test("stopSession closes the open call BEFORE the background task", async () => {
  const r = await rig({ scenario: "open-work" });
  await start(r);
  await r.adapter.sendTurn({ threadId: "t1", input: "work", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  const before = r.events.length;
  await r.adapter.stopSession("t1");
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  assert.deepEqual(ends(r.events.slice(before)), OPEN_WORK_ENDS);
  await r.dispose();
});

test("an exit closes the open call BEFORE the background task, both before session.exited", async () => {
  const r = await rig({ scenario: "open-work-exit" });
  await start(r);
  await r.adapter.sendTurn({ threadId: "t1", input: "work", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  const before = r.events.length;
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const after = r.events.slice(before);
  assert.deepEqual(ends(after), OPEN_WORK_ENDS);
  assert.equal(after.at(-1)?.type, "session.exited");
  await r.dispose();
});

test("the CLI's own prompt after a turn is a turn of its own; a message during it steers it", async () => {
  const r = await rig({ scenario: "wake-steer" });
  await start(r);
  await r.adapter.sendTurn({ threadId: "t1", input: "hello", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn 1");
  const wake = await r.waitFor(
    (event) => event.type === "turn.started" && r.events.filter((e) => e.type === "turn.started").indexOf(event) === 1,
    "the woken turn"
  );
  await r.waitFor(
    (event) => event.type === "content.delta" && event.turnId === wake.turnId,
    "the woken reply"
  );
  const steered = await r.adapter.sendTurn({ threadId: "t1", input: "go on", attachments: [], interactionMode: "default" });
  assert.equal(steered.turnId, wake.turnId, "a steer of the woken turn, not a turn of its own");
  const done = (await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId === wake.turnId,
    "the steered turn's end"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(done.payload.state, "completed", "settled by the steered prompt, never by the cancelled wake");
  assert.equal(done.payload.tokenUsage?.inputTokens, 40);
  await r.drain();
  const text = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.turnId === wake.turnId && event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.equal(text, "The subagent finishedsteered");
  assert.equal(r.events.filter((event) => event.type === "turn.completed").length, 2, "one end per turn");
  await r.dispose();
});

test("a Stop while the CLI's own prompt waits for its turn opens no turn for it — what it streamed joins ours", async () => {
  const r = await rig({ scenario: "wake-pending-stop" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "watch", attachments: [], interactionMode: "default" });
  await r.waitFor(READ_MARKER, "the CLI's own prompt announced, and its hook read");
  await r.adapter.interruptTurn("t1", turnId);
  await r.waitFor((event) => event.type === "turn.completed", "the stopped turn");
  await r.waitFor(
    (event) => event.type === "session.state.changed" && (event.payload as { state: string }).state === "ready",
    "ready after the Stop"
  );
  await r.drain();
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"], "no empty turn for the prompt the Stop ended");
  const hooks = r.events.filter((event) => event.type === "hook.started");
  assert.equal(hooks.length, 1, "what that prompt streamed before the cancel is kept");
  assert.equal(hooks[0]!.turnId, turnId, "on the turn the Stop settled");
  await r.dispose();
});

/** `turn.started` / `turn.completed` in order, each marked ours or another turn's. */
function turnMarks(events: readonly RuntimeEvent[], ours: string): string[] {
  return events
    .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
    .map((event) => `${event.type}:${event.turnId === ours ? "ours" : "other"}`);
}

/** The assistant text a turn streamed, in order. */
function turnText(events: readonly RuntimeEvent[], turnId: string | undefined): string {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.turnId === turnId && event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
}

/**
 * The assistant bubbles a turn streamed — one per item, its text — in the
 * order they opened: a prompt's chunks share one, and a chunk naming another
 * prompt opens the next (`segments.ts`).
 */
function turnBubbles(events: readonly RuntimeEvent[], turnId: string | undefined): string[] {
  const bubbles = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "content.delta" || event.turnId !== turnId || event.payload.streamKind !== "assistant_text") {
      continue;
    }
    bubbles.set(event.itemId ?? "", (bubbles.get(event.itemId ?? "") ?? "") + event.payload.delta);
  }
  return [...bubbles.values()];
}

/** The mock's wake text: `w1;w2;…` */
function wakeChunks(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index + 1};`).join("");
}

const READ_MARKER = (event: RuntimeEvent): boolean =>
  event.type === "runtime.warning" &&
  (event.payload as { detail?: { name?: unknown } }).detail?.name === "read-marker";

test("a waiting wake that outgrows the hold loses nothing: all 300 chunks join the open turn, in order", async () => {
  const r = await rig({ scenario: "wake-held", env: { GROK_MOCK_WAKE_CHUNKS: "300" } });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "our turn's end");
  await r.drain();
  assert.equal(turnText(r.events, turnId), `ours;${wakeChunks(300)}`, "every chunk, in the order the CLI streamed it");
  assert.deepEqual(
    turnBubbles(r.events, turnId),
    ["ours;", wakeChunks(300)],
    "a bubble per prompt: the wake's chunks name its prompt, so the first closes ours and opens its own"
  );
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"], "no turn for a wake that ended merged");
  await r.dispose();
});

test("a waiting wake within the hold gets its own turn with every chunk", async () => {
  const r = await rig({ scenario: "wake-held", env: { GROK_MOCK_WAKE_CHUNKS: "100" } });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const woken = await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId !== turnId,
    "the wake's own turn's end"
  );
  await r.drain();
  assert.equal(turnText(r.events, turnId), "ours;");
  assert.equal(turnText(r.events, woken.turnId), wakeChunks(100));
  assert.deepEqual(turnMarks(r.events, turnId), [
    "turn.started:ours",
    "turn.completed:ours",
    "turn.started:other",
    "turn.completed:other"
  ]);
  await r.dispose();
});

test("a Stop after the waiting wake finished keeps its reply, on a turn of its own", async () => {
  const r = await rig({ scenario: "wake-finished-stop", env: { GROK_MOCK_WAKE_CHUNKS: "50" } });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor(READ_MARKER, "every frame of the finished wake read");
  await r.adapter.interruptTurn("t1", turnId);
  const woken = (await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId !== turnId,
    "the wake's own turn's end"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  await r.drain();
  assert.equal(turnText(r.events, turnId), "ours;");
  assert.equal(turnText(r.events, woken.turnId), wakeChunks(50), "the cancel ended nothing: the wake had finished");
  assert.equal(woken.payload.state, "completed");
  await r.dispose();
});

test("a steer after the waiting wake finished keeps its reply: it joins the turn the steer continues, before ours", async () => {
  const r = await rig({ scenario: "wake-finished-steer", env: { GROK_MOCK_WAKE_CHUNKS: "50" } });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor(READ_MARKER, "every frame of the finished wake read");
  const steered = await r.adapter.sendTurn({ threadId: "t1", input: "go on", attachments: [], interactionMode: "default" });
  assert.equal(steered.turnId, turnId);
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "the steered turn's end");
  await r.drain();
  assert.equal(turnText(r.events, turnId), `ours;${wakeChunks(50)}steered;`, "nothing the wake said is lost");
  assert.deepEqual(
    turnBubbles(r.events, turnId),
    ["ours;", wakeChunks(50), "steered;"],
    "a bubble per prompt: ours, the wake's that joined the turn, the steered prompt's"
  );
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"]);
  await r.dispose();
});

test("a steer while the CLI has its own prompt queued keeps that prompt's reply, in the order the CLI ran it", async () => {
  const r = await rig({ scenario: "wake-queued-steer" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "hi", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "content.delta" && event.turnId === turnId, "the first prompt's words");
  const steered = await r.adapter.sendTurn({ threadId: "t1", input: "go on", attachments: [], interactionMode: "default" });
  assert.equal(steered.turnId, turnId);
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "the steered turn's end");
  await r.drain();
  assert.equal(
    turnText(r.events, turnId),
    "one;woke;steered;",
    "the wake ran between the cancelled prompt and ours, so its reply sits between them, in the turn ours continues"
  );
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"]);
  await r.dispose();
});

test("stopSession with frames waiting for a wake's turn keeps them: they join the open turn", async () => {
  const r = await rig({ scenario: "wake-pending-hold" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor(READ_MARKER, "the wake's frames read");
  await r.adapter.stopSession("t1");
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  assert.equal(turnText(r.events, turnId), "ours;w1;w2;");
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"]);
  await r.dispose();
});

test("an exit with frames waiting for a wake's turn keeps them: they join the open turn", async () => {
  const r = await rig({ scenario: "wake-pending-exit" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  assert.equal(turnText(r.events, turnId), "ours;w1;w2;");
  assert.deepEqual(turnMarks(r.events, turnId), ["turn.started:ours", "turn.completed:ours"]);
  await r.dispose();
});

test("a question the CLI's own prompt asks while our turn settles rides no turn — our turn's end cannot sweep it", async () => {
  const r = await rig({ scenario: "wake-question" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the wake's question");
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "our turn's end");
  assert.equal(asked.turnId, undefined, "never our turn: the host dismisses a turn's questions when it ends, and the CLI would wait on");
  await r.adapter.respondToUserInput("t1", asked.requestId!, { "alpha or beta?": ["alpha"] });
  const woken = await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId !== turnId,
    "the wake's own turn's end"
  );
  await r.drain();
  const resolved = r.events.find((event) => event.type === "user-input.resolved");
  assert.equal(resolved?.turnId, undefined, "its resolution rides no turn either");
  assert.equal(
    turnText(r.events, woken.turnId),
    'answered:{"alpha or beta?":["alpha"]};',
    "the answer reached the CLI, and the wake went on in its own turn"
  );
  await r.dispose();
});

test("a subagent's child session's question rides no turn, as Codex's does", async () => {
  const r = await rig({ scenario: "child-question" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the child's question");
  assert.equal(asked.turnId, undefined);
  await r.adapter.respondToUserInput("t1", asked.requestId!, { "alpha or beta?": ["beta"] });
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "our turn's end");
  await r.drain();
  assert.equal(turnText(r.events, turnId), "one;two;");
  assert.equal(r.events.find((event) => event.type === "user-input.resolved")?.turnId, undefined);
  await r.dispose();
});

test("the host's cancel of a question reaches the CLI as `cancelled`, never as an empty answer", async () => {
  // A Stop, the session's stop and a closed tab settle a pending question with
  // the host's cancel (`settlePendingRequests`): `answers` is then `{}`, and
  // sent as `{outcome: "accepted", answers: {}}` it told the CLI the user had
  // answered — nothing at all.
  const r = await rig({ scenario: "question" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the question");
  await r.adapter.respondToUserInput("t1", asked.requestId!, {}, { cancel: true });
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "our turn's end");
  await r.drain();
  assert.equal(turnText(r.events, turnId), 'one;reply:{"outcome":"cancelled"};');
  const resolved = r.events.filter((event) => event.type === "user-input.resolved");
  assert.equal(resolved.length, 1, "one resolution row");
  assert.equal(
    (resolved[0].payload as { withdrawn?: boolean }).withdrawn,
    true,
    "nobody answered: the host's own cancelled row, which repeats the Stop's"
  );
  await r.dispose();
});

test("a user's empty answer to a question stays an answer", async () => {
  // A skip is the user's word, not a cancel: only the host's cancel flag reads
  // as `cancelled`, whatever the answers hold.
  const r = await rig({ scenario: "question" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the question");
  await r.adapter.respondToUserInput("t1", asked.requestId!, {});
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "our turn's end");
  await r.drain();
  assert.equal(turnText(r.events, turnId), 'one;reply:{"outcome":"accepted","answers":{}};');
  const resolved = r.events.filter((event) => event.type === "user-input.resolved");
  assert.equal(resolved.length, 1);
  assert.equal((resolved[0].payload as { withdrawn?: boolean }).withdrawn, undefined);
  await r.dispose();
});

test("a request answered without a card leaves a waiting wake's frames waiting for its own turn", async () => {
  const r = await rig({ scenario: "wake-auto-permission" });
  await start(r, { runtimeMode: "full-access" });
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const woken = await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId !== turnId,
    "the wake's own turn's end"
  );
  await r.drain();
  assert.equal(turnText(r.events, turnId), "ours;");
  assert.equal(turnText(r.events, woken.turnId), "w1;w2;", "no card, so nothing to put the wake's frames in order before");
  assert.equal(r.events.some((event) => event.type === "request.opened"), false);
  await r.dispose();
});

test("a woken parent's spawn is one agent, launched by its call: its subagent_spawned waits behind it", async () => {
  const r = await rig({ scenario: "wake-spawn-reorder" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const woken = await r.waitFor(
    (event) => event.type === "turn.completed" && event.turnId !== turnId,
    "the wake's own turn's end"
  );
  await r.drain();
  const agents = r.events.filter(
    (event): event is Extract<RuntimeEvent, { type: "task.started" }> =>
      event.type === "task.started" && event.payload.taskType === "subagent"
  );
  assert.deepEqual(
    agents.map((event) => [event.payload.taskId, event.turnId]),
    [["call-a00d2553-adc5-48f4-9181-4a66616fc94f-0", woken.turnId]],
    "one agent, under its launching call, on the wake's turn — no phantom under the subagent's id"
  );
  await r.dispose();
});

test("a model the CLI refuses warns once per session, not at every turn", async () => {
  // An outdated CLI and a chat created on the pending catalogue: the thread's
  // selection names a model this CLI does not know, and every turn carries it.
  const r = await rig({ scenario: "happy" });
  await r.adapter.startSession({
    threadId: "t1",
    cwd: r.cwd,
    home: home(r.cwd),
    modelSelection: { model: "nope" },
    runtimeMode: "approval-required"
  });
  for (const input of ["one", "two"]) {
    await r.adapter.sendTurn({
      threadId: "t1",
      input,
      attachments: [],
      modelSelection: { model: "nope" },
      interactionMode: "default"
    });
    await r.waitFor(
      (event) => event.type === "turn.completed" && r.events.filter((e) => e.type === "turn.completed").length === (input === "one" ? 1 : 2),
      `turn ${input}`
    );
  }
  await r.drain();
  const refusals = r.events.filter(
    (event) =>
      event.type === "runtime.warning" &&
      (event.payload as { message?: string }).message === "grok: could not switch model to nope"
  );
  assert.equal(refusals.length, 1, "the CLI's refusal is remembered for the session");
  await r.dispose();
});

function advisories(events: readonly RuntimeEvent[]): number {
  return events.filter(
    (event) => event.type === "runtime.warning" && /support_permission/.test(event.payload.message)
  ).length;
}

test("full-access: a CLI resolving its own interactions is what was asked for — no advisory", async () => {
  const r = await rig({ scenario: "self-resolve" });
  await start(r, { runtimeMode: "full-access" });
  await r.adapter.sendTurn({ threadId: "t1", input: "one", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn 1");
  await r.adapter.sendTurn({ threadId: "t1", input: "two", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed" && r.events.filter((e) => e.type === "turn.completed").length === 2, "turn 2");
  await r.drain();
  assert.equal(advisories(r.events), 0);
  await r.dispose();
});

test("supervised: a CLI resolving its own interactions is told ONCE, not at every turn end", async () => {
  const r = await rig({ scenario: "self-resolve" });
  await start(r);
  await r.adapter.sendTurn({ threadId: "t1", input: "one", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn 1");
  await r.adapter.sendTurn({ threadId: "t1", input: "two", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed" && r.events.filter((e) => e.type === "turn.completed").length === 2, "turn 2");
  await r.drain();
  assert.equal(advisories(r.events), 1);
  await r.dispose();
});

test("a session that dies on its own is removed from the adapter's map", async () => {
  // Q1 #30: a stale entry keeps winning `hasSession` and is reported to the
  // §3.3 reconcile as live.
  const r = await rig({ scenario: "exit-mid-turn" });
  await start(r);
  assert.equal(r.adapter.hasSession("t1"), true);
  void r.adapter.sendTurn({ threadId: "t1", input: "count", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  assert.equal(r.adapter.hasSession("t1"), false);
  assert.equal(r.adapter.listSessions().length, 0);
  await r.dispose();
});

test("a host-initiated stop emits no runtime.error after session.exited", async () => {
  // Q1 #22: the parked `session/prompt` rejects when the child is killed, and
  // the rejection handler used to emit an error row after the exit.
  const r = await rig({ scenario: "slow" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "long", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.started", "turn.started");
  await r.adapter.stopSession("t1");
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const order = r.events.map((event) => event.type);
  const exitedAt = order.indexOf("session.exited");
  assert.equal(
    order.slice(exitedAt).includes("runtime.error"),
    false,
    "everything is settled before session.exited"
  );
  await r.dispose();
});

test("sendTurn refuses /always-approve with INVALID_COMMAND / 400", async () => {
  const r = await rig();
  await start(r);
  const error = (await r.adapter
    .sendTurn({ threadId: "t1", input: "/always-approve off", attachments: [], interactionMode: "default" })
    .then(
      () => null,
      (reason: unknown) => reason
    )) as (Error & { code?: string; status?: number }) | null;
  assert.ok(error !== null);
  assert.equal(error.code, "INVALID_COMMAND");
  assert.equal(error.status, 400);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "/always-approve-ish",
    attachments: [],
    interactionMode: "default"
  });
  await r.dispose();
});

// ---------------------------------------------------------------------------
// What the CLI leaves behind (AGENTS.md, "What a Grok CLI starts outlives it";
// Grok fixtures README observations 48 and 55)
// ---------------------------------------------------------------------------
//
// The real CLI starts its MCP servers and background shells in sessions of
// their own, so a stop's group signal reaches the CLI alone and they outlive
// it, reparented to init. The mock's `leftover` scenarios do the same: a
// helper (`sleep 301`, an MCP server's stand-in) before `session/new`
// answers, and during the turn a shell (`sh -c 'sleep 302 & …'`) whose
// member `sleep 302` stays in its session while `sleep 303` daemonizes into
// one of its own. They are found by the launch marker they inherited and the
// sessions recorded while the CLI lived — never by the parent chain they lost.

/** Whether `pid` is a live (non-zombie) process. */
function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** Every live process whose environment carries `name=value`. */
function processesWith(name: string, value: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${name}=${value}`) && isRunning(pid)) {
        found.push(pid);
      }
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

/** What the rig's launch left running, by role: the helper, the shell, its member, the daemon. */
function leftovers(r: Rig): { helper: number[]; shell: number[]; member: number[]; daemon: number[] } {
  const found = { helper: [] as number[], shell: [] as number[], member: [] as number[], daemon: [] as number[] };
  for (const pid of processesWith("GROK_RIG_MARK", r.mark)) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const line = argv.join(" ");
    if (line === "sleep 301") found.helper.push(pid);
    else if (line === "sleep 302") found.member.push(pid);
    else if (line === "sleep 303") found.daemon.push(pid);
    else if (argv[0] === "sh" && line.includes("sleep 302 &")) found.shell.push(pid);
  }
  return found;
}

/** Kill what a test left alive, so nothing outlives the suite. */
function reap(r: Rig): void {
  for (const pid of processesWith("GROK_RIG_MARK", r.mark)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The launch marker the mock saw, off its `launch:<id>;` chunk. */
function launchOf(events: readonly RuntimeEvent[], turnId: string): string {
  const match = /launch:([^;]+);/.exec(turnText(events, turnId));
  assert.ok(match, "the mock names its launch");
  return match[1]!;
}

async function turnWithLeftovers(r: Rig, threadId = "t1"): Promise<string> {
  const { turnId } = await r.adapter.sendTurn({ threadId, input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed" && event.turnId === turnId, "the turn's end");
  await r.drain();
  return turnId;
}

test("a session's end stops its helpers — and never what daemonized into a session of its own", { skip: process.platform !== "linux" }, async () => {
  const r = await rig({ scenario: "leftover" });
  try {
    await start(r);
    const turnId = await turnWithLeftovers(r);
    assert.notEqual(launchOf(r.events, turnId), "none", "the launch env carries the marker");
    const before = leftovers(r);
    assert.equal(before.helper.length, 1);
    assert.equal(before.daemon.length, 1);
    await r.adapter.stopSession("t1");
    const after = leftovers(r);
    assert.deepEqual(after.helper, [], "no group signal reached it; its recorded session did");
    assert.deepEqual(after.daemon, before.daemon, "it left the shell's session: a host-wide helper, never ours to stop");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("the host's teardown and a restart stop a Grok session's helpers — never its running work", { skip: process.platform !== "linux" }, async () => {
  // A drain-restart, and an account, permission-mode or cwd restart of a
  // thread that goes on: the drain rule — a deploy must not kill running
  // work — holds for the dev server a Grok chat started.
  for (const end of ["teardown", "restart"] as const) {
    const r = await rig({ scenario: "leftover" });
    try {
      await start(r);
      await turnWithLeftovers(r);
      const before = leftovers(r);
      assert.equal(before.shell.length, 1);
      assert.equal(before.member.length, 1);
      if (end === "teardown") {
        await r.adapter.stopAll();
      } else {
        await r.adapter.stopSession("t1");
      }
      const after = leftovers(r);
      assert.deepEqual(after.helper, [], `${end}: its MCP servers are per-session helpers, swept at every end`);
      assert.deepEqual(after.shell, before.shell, `${end}: the shell runs on, a marked orphan`);
      assert.deepEqual(after.member, before.member, `${end}: and so does what it started`);
      assert.deepEqual(after.daemon, before.daemon);
      // Its row says so — never a silent "stopped" for work that runs on.
      assert.deepEqual(shellEnds(r), [["stopped", true]]);
      const remembered = await readLeftoverWork(r.leftoverWork);
      assert.equal(remembered.length, 1, `${end}: the launch's work is remembered for a later user end`);
      assert.ok(remembered[0]!.sessions.length >= 1);
    } finally {
      reap(r);
      await r.dispose();
    }
  }
});

test("the host's teardown resolves only once every session's stop is done: the second stopAll() waits for the first's", { skip: process.platform !== "linux" }, async () => {
  // The host calls `stopAll()` twice: its abort fires this adapter's own
  // listener, which takes the sessions and starts their stops, and then the
  // host awaits `stopAll()` itself. The second call used to find no session
  // and return at once, the helper sweep not begun and the rows not written.
  const r = await rig({ scenario: "leftover" });
  try {
    await start(r);
    await turnWithLeftovers(r);
    assert.equal(leftovers(r).helper.length, 1);
    await r.teardown();
    // The moment it resolves, before anything else is awaited:
    assert.deepEqual(leftovers(r).helper, [], "the helper is swept before the host's own call resolves");
    await r.drain();
    assert.deepEqual(shellEnds(r), [["stopped", true]]);
    assert.ok(r.events.some((event) => event.type === "session.exited"), "and the session's exit row");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("at the host's teardown a helper that ignores SIGTERM is killed after a 1 s grace, not spawn.ts's 2 s", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const r = await rig({ scenario: "leftover", env: { GROK_MOCK_HELPER_IGNORES_TERM: "1" } });
  try {
    await start(r);
    await turnWithLeftovers(r);
    const helpers = leftovers(r).helper;
    assert.equal(helpers.length, 1);
    const helper = helpers[0]!;
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });

    type Wake = { delay: number } | { done: true };
    const wakes: Wake[] = [];
    let receive: ((wake: Wake) => void) | undefined;
    const offer = (wake: Wake): void => {
      if (receive !== undefined) {
        const resolve = receive;
        receive = undefined;
        resolve(wake);
      } else wakes.push(wake);
    };
    const nextWake = (): Promise<Wake> => {
      const wake = wakes.shift();
      return wake === undefined ? new Promise((resolve) => { receive = resolve; }) : Promise.resolve(wake);
    };
    let termAt: number | undefined;
    let killAt: number | undefined;
    const sendSignal = process.kill.bind(process);
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      const result = sendSignal(pid, signal);
      if (pid === helper && signal === "SIGTERM") termAt = Date.now();
      if (pid === helper && signal === "SIGKILL") killAt = Date.now();
      return result;
    });
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timer = schedule(...args);
      const delay = Number(args[1] ?? 0);
      // ACP's unrelated 2 s stdout-close watchdog can arrive after SIGTERM.
      // Advancing it here would move the sweep's clock before its grace starts.
      if (termAt !== undefined && delay <= 1_000) offer({ delay });
      return timer;
    }) as typeof setTimeout);

    const teardown = r.teardown();
    void teardown.then(() => offer({ done: true }), () => offer({ done: true }));
    for (;;) {
      const wake = await nextWake();
      if ("done" in wake) break;
      t.mock.timers.tick(wake.delay);
    }
    await teardown;
    assert.notEqual(termAt, undefined, "the real helper received SIGTERM first");
    assert.equal(killAt! - termAt!, 1_000, "SIGKILL follows the documented teardown grace");
    assert.deepEqual(leftovers(r).helper, [], "the actual helper is gone before teardown resolves");
  } finally {
    t.mock.reset();
    reap(r);
    await r.dispose();
  }
});

test("the user ending the session stops its running work too — never what daemonized away", { skip: process.platform !== "linux" }, async () => {
  const r = await rig({ scenario: "leftover" });
  try {
    await start(r);
    await turnWithLeftovers(r);
    const before = leftovers(r);
    await r.adapter.stopSession("t1", { endedByUser: true });
    const after = leftovers(r);
    assert.deepEqual(shellEnds(r), [["stopped", false]], "a user end leaves no running-work marker");
    assert.deepEqual(after.helper, []);
    assert.deepEqual(after.shell, [], "the session stop command or a closed tab: the agent's work goes with it");
    assert.deepEqual(after.member, []);
    assert.deepEqual(after.daemon, before.daemon, "a host-wide helper it started is never the session's");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("the user's stop sweeps the running work even when the CLI exits in the middle of it", { skip: process.platform !== "linux" }, async () => {
  // The stop answers the open card first (the host's cancel), and this CLI
  // exits on that answer: its exit lands inside the stop. A sweep it started
  // must not be the one the stop reuses, without the user's work in it.
  const r = await rig({ scenario: "leftover-question-exit" });
  try {
    await start(r);
    await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "user-input.requested", "the open card");
    await r.waitFor((event) => event.type === "task.started", "the shell's task");
    const before = leftovers(r);
    assert.equal(before.shell.length, 1);
    assert.equal(before.member.length, 1);
    await r.adapter.stopSession("t1", { endedByUser: true });
    const after = leftovers(r);
    assert.deepEqual(after.helper, []);
    assert.deepEqual(after.shell, [], "the user ended the session: its work goes with it");
    assert.deepEqual(after.member, []);
    assert.deepEqual(after.daemon, before.daemon, "never what daemonized away");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("the user's end is prepared before its card is answered: a CLI that exits on the cancel before any stop still has its work stopped, and says so", { skip: process.platform !== "linux" }, async () => {
  // The orchestrator's order (`stopSessionInternal`): `prepareUserEnd`, then
  // the cards' cancels — which this CLI exits on — and, its session gone
  // before `stopSession` could run, no stop at all: only the thread's
  // `sweepEndedSession`. Unprepared, the exit read as a crash — "Left running
  // when the agent process exited" — although the user was ending the session.
  const r = await rig({ scenario: "leftover-question-exit" });
  try {
    await start(r);
    await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
    const asked = await r.waitFor((event) => event.type === "user-input.requested", "the open card");
    await r.waitFor((event) => event.type === "task.started", "the shell's task");
    const before = leftovers(r);
    assert.equal(before.shell.length, 1);
    await r.adapter.prepareUserEnd?.("t1");
    await r.adapter.respondToUserInput("t1", asked.requestId!, {}, { cancel: true });
    await r.waitFor((event) => event.type === "session.exited", "the CLI's exit on the cancel");
    await r.drain();
    assert.equal(r.adapter.hasSession("t1"), false, "gone before any stop could reach it");
    assert.deepEqual(shellEnds(r), [["stopped", false]], "a prepared user end leaves no running-work marker");
    await r.adapter.sweepEndedSession!("t1");
    const after = leftovers(r);
    assert.deepEqual(after.shell, [], "the user ended the session: its work goes with it");
    assert.deepEqual(after.member, []);
    assert.deepEqual(after.daemon, before.daemon, "never what daemonized away");
  } finally {
    reap(r);
    await r.dispose();
  }
});

/** The leftover shell's completion state and whether its work was left running. */
function shellEnds(r: Rig): Array<[string | undefined, boolean]> {
  return r.events
    .filter((event) => event.type === "task.completed" && (event.payload as { taskId?: string }).taskId === "task-bg-1")
    .map((event) => {
      const payload = event.payload as { status?: string; leftRunning?: boolean };
      return [payload.status, payload.leftRunning === true];
    });
}

test("a deploy leaves the dev server running and says so; closing the tab under the next host stops it", { skip: process.platform !== "linux" }, async () => {
  const r = await rig({ scenario: "leftover" });
  let next: Rig | undefined;
  try {
    await start(r);
    await turnWithLeftovers(r);
    const before = leftovers(r);
    await r.adapter.stopAll();
    assert.deepEqual(leftovers(r).shell, before.shell, "the deploy never kills running work");
    assert.deepEqual(leftovers(r).member, before.member);
    // The next host: no session of the thread is live when its tab closes.
    next = await rig({ leftoverWork: r.leftoverWork });
    assert.equal(next.adapter.hasSession("t1"), false);
    await next.adapter.sweepEndedSession!("t1");
    const after = leftovers(r);
    assert.deepEqual(after.shell, [], "the user's end reaches what the earlier host's launch left");
    assert.deepEqual(after.member, []);
    assert.deepEqual(after.daemon, before.daemon, "never what daemonized away");
    assert.equal(existsSync(r.leftoverWork), false, "and the thread remembers none of it any more");
  } finally {
    reap(r);
    await r.dispose();
    await next?.dispose();
  }
});

test("a CLI that exits on its own takes its helpers with it", { skip: process.platform !== "linux" }, async () => {
  const r = await rig({ scenario: "leftover-exit" });
  try {
    await start(r);
    const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
    // The mock exits only once `leftover-work.json` records its task's session,
    // so a host that stops recording times out HERE, not at the assertion below.
    await r.waitFor(
      (event) => event.type === "session.exited",
      "session.exited (the mock exits once its task's session is recorded)"
    );
    await r.drain();
    assert.notEqual(launchOf(r.events, turnId), "none");
    // `stopAll` is the host's teardown: it waits for a sweep still in flight.
    await r.adapter.stopAll();
    const after = leftovers(r);
    assert.deepEqual(after.helper, []);
    assert.equal(after.shell.length, 1, "a crash is no user's end: the running work stays, a marked orphan");
    assert.equal(after.member.length, 1);
    assert.equal(after.daemon.length, 1);
    assert.deepEqual(shellEnds(r), [["stopped", true]]);
    // Recorded when the CLI reported it, while it lived: nothing can be read
    // off a CLI that is gone. The user ending the session later sweeps it.
    assert.equal((await readLeftoverWork(r.leftoverWork)).length, 1);
    await r.adapter.sweepEndedSession!("t1");
    const swept = leftovers(r);
    assert.deepEqual(swept.shell, [], "the user's end reaches what the crashed launch left");
    assert.deepEqual(swept.member, []);
    assert.deepEqual(swept.daemon, after.daemon, "never what daemonized away");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("a session's end sweeps its own launch's sessions — another launch's processes are never touched", { skip: process.platform !== "linux" }, async () => {
  const one = await rig({ scenario: "leftover" });
  const two = await rig({ scenario: "leftover" });
  try {
    await start(one);
    await start(two);
    const first = await turnWithLeftovers(one);
    const second = await turnWithLeftovers(two);
    assert.notEqual(launchOf(one.events, first), launchOf(two.events, second), "one marker value per launch");
    await one.adapter.stopSession("t1");
    assert.deepEqual(leftovers(one).helper, []);
    assert.equal(leftovers(two).helper.length, 1, "another launch's helper is not this session's to stop");
    await two.adapter.stopSession("t1");
    assert.deepEqual(leftovers(two).helper, []);
  } finally {
    reap(one);
    reap(two);
    await one.dispose();
    await two.dispose();
  }
});

test("a session that fails to open stops everything its CLI started", { skip: process.platform !== "linux" }, async () => {
  const r = await rig({ scenario: "leftover" });
  try {
    // `session/load` of a session the CLI does not know answers an error
    // (fixture 13) — after the mock started its helper, as the real CLI's
    // MCP servers start with the session.
    await assert.rejects(
      async () => await start(r, { resumeCursor: { schemaVersion: 1, sessionId: "01a0c19e-0000-7000-8000-000000000000" } }),
      /Path not found/
    );
    assert.deepEqual(processesWith("GROK_RIG_MARK", r.mark), [], "nothing of the launch is left running");
  } finally {
    reap(r);
    await r.dispose();
  }
});

/** Resolve when `promise` settles or `ms` has passed, whichever is first; the timer never outlives it. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    })
  ]);
  clearTimeout(timer);
}

test("a host teardown while the session opens sweeps the CLI's helpers — never remembered as the user's work", { skip: process.platform !== "linux" }, async () => {
  // `session/new` never answers: its MCP servers are up, the session is not
  // announced, and nothing of the user's can have run — every child is a
  // helper, the failed-open rule. Recorded as work, a deploy during the open
  // left the helper running and remembered it for the user's next end.
  const r = await rig({ scenario: "leftover-open-hang" });
  try {
    const opening = start(r);
    opening.catch(() => undefined);
    await r.waitFor(
      (event) =>
        event.type === "runtime.warning" &&
        String((event.payload as { message?: unknown }).message).includes("helper started"),
      "the helper's start"
    );
    assert.equal(leftovers(r).helper.length, 1, "the helper runs");
    // The host's teardown: its abort, then its own `stopAll()`.
    await r.teardown();
    await assert.rejects(opening);
    assert.deepEqual(leftovers(r).helper, [], "swept as the helper it is");
    assert.deepEqual(await readLeftoverWork(r.leftoverWork), [], "and never remembered as the user's work");
    assert.deepEqual(lifecycleRows(r.events), [], "a session that never opened reports no life of its own");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("a CLI that dies while its session opens takes the helpers it booted with it", { skip: process.platform !== "linux" }, async () => {
  // The CLI reports its MCP servers booting before `session/new` answers
  // (fixture 31), and dies before it answers: only a recording made off that
  // report, while it lived, ties the helper to it.
  const r = await rig({ scenario: "leftover-open-crash" });
  try {
    const opening = start(r);
    opening.catch(() => undefined);
    // Bounded, so a host that never records them fails on the assertions
    // below rather than on a timeout.
    await within(r.logged(/recorded the agent's helpers/), 3_000);
    assert.equal(leftovers(r).helper.length, 1, "the helper runs");
    const cli = processesWith("GROK_RIG_MARK", r.mark).filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("mock-grok.mjs");
      } catch {
        return false;
      }
    });
    assert.equal(cli.length, 1, "the CLI runs");
    process.kill(cli[0]!, "SIGKILL");
    await assert.rejects(opening);
    assert.deepEqual(leftovers(r).helper, [], "its exit swept the helper it booted");
    assert.deepEqual(lifecycleRows(r.events), [], "the open's rejection is its whole report");
  } finally {
    reap(r);
    await r.dispose();
  }
});

test("goals: live goal frames on every private-channel spelling become goal rows, never warnings", async () => {
  // Goals §6.3 item 1, through the real peer: the mock sends the goal's
  // frames on `_x.ai/session_notification`, bare `x.ai/session_notification`
  // and — live, not a replay — `_x.ai/session/update`.
  const r = await rig({ scenario: "goal" });
  await start(r);
  const { turnId } = await r.adapter.sendTurn({
    threadId: "t1",
    input: "/goal Audit every request handler for cross-clinic data access and fix each hole",
    attachments: [],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");

  assert.deepEqual(
    goalUpdates(r).map((payload) => [payload.change, payload.goal?.status, payload.goal?.rounds]),
    [
      ["set", "active", 0],
      ["progress", "active", 1],
      ["achieved", "complete", 1]
    ]
  );
  const rows = r.events.filter((event) => event.type === "thread.goal.updated");
  assert.equal(
    rows.every((event) => event.turnId === turnId),
    true,
    "the goal runs inside the turn that set it"
  );
  assert.equal(
    r.events.some(
      (event) => event.type === "runtime.warning" && /unmapped|goal/i.test(event.payload.message)
    ),
    false,
    "goal_updated — and the rest of a goal run's private traffic — is recognised, never a warning"
  );
  // The goal engine's planner is an agent on the roster (fixtures README
  // observation 58), and the retry is a heartbeat, not a row.
  assert.deepEqual(
    r.events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "task.started" | "task.completed" }> =>
          event.type === "task.started" || event.type === "task.completed"
      )
      .map((event) => [event.type, event.payload.taskId, event.payload.taskType, event.payload.title]),
    [
      ["task.started", "01a05789-0cc0-7563-9e4f-4b4b576928cc", "subagent", "goal plan writer"],
      ["task.completed", "01a05789-0cc0-7563-9e4f-4b4b576928cc", "subagent", "goal plan writer"]
    ]
  );
  assert.equal(
    r.events.filter(
      (event) =>
        event.type === "session.state.changed" && event.payload.reason === "retry_state:1/15"
    ).length,
    1
  );
  await r.dispose();
});

test("goals: a load replays the goal silently, then restores it once, after the session is up", async () => {
  const r = await rig({ scenario: "goal" });
  await start(r, { resumeCursor: MOCK_SESSION_CURSOR, knownGoal: null });
  await r.waitFor((event) => event.type === "thread.goal.updated", "the restored goal");
  await r.drain();

  const updates = goalUpdates(r);
  assert.equal(updates.length, 1, "at most one update after a load");
  assert.equal(updates[0].change, "restored");
  assert.deepEqual(
    { ...updates[0].goal, tokensUsed: undefined, elapsedMs: undefined, setAt: undefined },
    { ...MOCK_REPLAYED_GOAL, tokensUsed: undefined, elapsedMs: undefined, setAt: undefined }
  );
  const order = r.events.map((event) => event.type);
  assert.ok(
    order.indexOf("thread.goal.updated") > order.indexOf("thread.started"),
    "compared once the load has completed, never while it replays"
  );
  // The replayed goal reminder never reaches the live stream.
  assert.equal(
    r.events.some((event) => JSON.stringify(event).includes("A goal has been set")),
    false
  );
  await r.dispose();
});

test("goals: a fresh session (session/new) clears the unfinished goal the thread still shows", async () => {
  // A brand-new Grok session has no goal by definition — unlike a load, whose
  // replay may simply not carry goal rows.
  const r = await rig({ scenario: "happy" });
  await start(r, { knownGoal: MOCK_REPLAYED_GOAL });
  await r.waitFor((event) => event.type === "thread.goal.updated", "the cleared goal");
  await r.drain();
  assert.deepEqual(goalUpdates(r), [{ goal: null, change: "cleared", previous: MOCK_REPLAYED_GOAL }]);
  const order = r.events.map((event) => event.type);
  assert.ok(order.indexOf("thread.goal.updated") > order.indexOf("thread.started"));
  await r.dispose();
});

// ---------------------------------------------------------------------------
// A card nobody answered is settled ONCE (final fix wave, item 2)
// ---------------------------------------------------------------------------
//
// Every teardown path resolved the parked card's deferred AND emitted its
// resolution, and the handler awaiting that deferred then emitted another:
// two closing rows for one card, the second of an exit landing after
// `session.exited`. One emitter per card now, at the moment it is settled;
// a card nobody answered is marked `withdrawn`, which ingestion writes as the
// host's own "Request cancelled" / "Question cancelled".

/** Every resolution the adapter emitted for one card. */
function resolutionsOf(events: readonly RuntimeEvent[], requestId: string | undefined): RuntimeEvent[] {
  return events.filter(
    (event) =>
      (event.type === "request.resolved" || event.type === "user-input.resolved") &&
      event.requestId === requestId
  );
}

test("stopSession with a parked approval settles it once, as nobody's answer", async () => {
  const r = await rig({ scenario: "permission" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  const opened = await r.waitFor((event) => event.type === "request.opened", "request.opened");
  await r.adapter.stopSession("t1");
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const resolutions = resolutionsOf(r.events, opened.requestId);
  assert.equal(resolutions.length, 1, "one closing row");
  assert.deepEqual(resolutions[0]!.payload, {
    requestType: "file_change_approval",
    decision: "cancel",
    withdrawn: true
  });
  await r.dispose();
});

test("stopSession with a parked question settles it once, as nobody's answer, on the stamp it was asked with", async () => {
  const r = await rig({ scenario: "child-question" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the child's question");
  await r.adapter.stopSession("t1");
  await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const resolutions = resolutionsOf(r.events, asked.requestId);
  assert.equal(resolutions.length, 1, "one closing row");
  assert.deepEqual(resolutions[0]!.payload, { answers: {}, withdrawn: true });
  assert.equal(resolutions[0]!.turnId, undefined, "turnless, as the child's question was asked");
  await r.dispose();
});

test("an exit with a parked approval settles it once, before session.exited", async () => {
  const r = await rig({ scenario: "permission-exit" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "write", attachments: [], interactionMode: "default" });
  const opened = await r.waitFor((event) => event.type === "request.opened", "request.opened");
  const exited = await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const resolutions = resolutionsOf(r.events, opened.requestId);
  assert.equal(resolutions.length, 1, "one closing row, none after the exit");
  assert.equal((resolutions[0]!.payload as { withdrawn?: boolean }).withdrawn, true);
  assert.ok(r.events.indexOf(resolutions[0]!) < r.events.indexOf(exited), "a running state never outlives its process");
  await r.dispose();
});

test("an exit with a parked question settles it once, before session.exited", async () => {
  const r = await rig({ scenario: "child-question-exit" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  const asked = await r.waitFor((event) => event.type === "user-input.requested", "the child's question");
  const exited = await r.waitFor((event) => event.type === "session.exited", "session.exited");
  await r.drain();
  const resolutions = resolutionsOf(r.events, asked.requestId);
  assert.equal(resolutions.length, 1, "one closing row, none after the exit");
  assert.deepEqual(resolutions[0]!.payload, { answers: {}, withdrawn: true });
  assert.ok(r.events.indexOf(resolutions[0]!) < r.events.indexOf(exited));
  await r.dispose();
});

// ---------------------------------------------------------------------------
// Account failures carry a structured reason (workflows §5.4)
// ---------------------------------------------------------------------------

function runtimeErrors(events: readonly RuntimeEvent[]): Array<Extract<RuntimeEvent, { type: "runtime.error" }>> {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: "runtime.error" }> => event.type === "runtime.error"
  );
}

test("a rate_limit stop is a usage limit, named by its reason — with no reset time to give", async () => {
  const r = await rig({ scenario: "rate-limit" });
  await start(r);
  void r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  await r.drain();
  const errors = runtimeErrors(r.events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.payload.reason, "usage_limit");
  assert.equal(errors[0]!.payload.resetsAt, undefined, "the frame names no reset");
  await r.dispose();
});

for (const noPromptComplete of [false, true]) {
  test(`an authentication_failed stop is a refused login, named by its reason${noPromptComplete ? " (no prompt_complete)" : ""}`, async () => {
    const r = await rig({ scenario: "stop-failure", env: { GROK_MOCK_STOP_REASON: "authentication_failed", ...(noPromptComplete ? { GROK_MOCK_NO_PROMPT_COMPLETE: "1" } : {}) } });
    await start(r);
    void r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
    await r.drain();
    const errors = runtimeErrors(r.events);
    assert.equal(errors.length, 1, "reported once");
    assert.equal(errors[0]!.payload.reason, "auth");
    await r.dispose();
  });
}

for (const [message, reason] of [
  ["You are not authenticated.", "auth"],
  ["xai: 429 grok-usage-exhausted", "usage_limit"],
  ["model returned an empty response", undefined]
] as const) {
  test(`a prompt the CLI answers with "${message}" (-32603) names ${reason ?? "no account failure"}`, async () => {
    const r = await rig({ scenario: "prompt-error", env: { GROK_MOCK_PROMPT_ERROR_MESSAGE: message } });
    await start(r);
    void r.adapter.sendTurn({ threadId: "t1", input: "go", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "runtime.error", "runtime.error");
    await r.drain();
    const errors = runtimeErrors(r.events);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.payload.reason, reason);
    await r.dispose();
  });
}
