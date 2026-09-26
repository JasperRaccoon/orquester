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

import {
  MAX_TURN_INPUT_CHARS,
  type AccountHome,
  type AgentAdapterId,
  type RuntimeEvent,
  type RuntimeMode
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { resumeCursorFor } from "../../orchestration/resume.ts";
import { createGrokAdapter, GROK_CAPABILITIES, isBlockedGrokCommand } from "./index.ts";
import { parseGrokResumeCursor } from "./session.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");

interface Rig {
  adapter: Awaited<ReturnType<typeof createGrokAdapter>>;
  events: RuntimeEvent[];
  /** Resolves when an event matching the predicate has been emitted. */
  waitFor(predicate: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent>;
  /** Let the event consumer catch up, so `events` reflects what was emitted. */
  drain(): Promise<void>;
  dispose(): Promise<void>;
  disposed: boolean;
  cwd: string;
}

/**
 * Every rig, so the teardown test can prove no provider child outlived the
 * suite. A test that fails before its own `dispose()` would otherwise leak a
 * live `grok` child and hang the runner.
 */
const openRigs: Rig[] = [];

async function rig(
  options: { scenario?: string; version?: string; bin?: string | null; env?: Record<string, string> } = {}
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
      ...(options.version === undefined ? {} : { GROK_MOCK_VERSION: options.version }),
      ...options.env
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
    dispose: async () => {
      built.disposed = true;
      controller.abort();
      await adapter.stopAll();
    },
    cwd
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
  const started = (await r2.waitFor(
    (event) => event.type === "session.started",
    "session.started"
  )) as Extract<RuntimeEvent, { type: "session.started" }>;
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
  const started = (await r.waitFor(
    (event) => event.type === "session.started",
    "session.started"
  )) as Extract<RuntimeEvent, { type: "session.started" }>;
  assert.equal(started.payload.resume, undefined);
  await r.dispose();
});

test("steering reuses the turn id and emits no second turn.started (see the steer test for the settlement)", async () => {
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
  await r.drain();
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
  await r.drain();
  const sessions = r.adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].threadId, "t1");
  assert.equal(sessions[0].runtimeMode, "approval-required");
  assert.equal(r.adapter.id, "grok" satisfies AgentAdapterId);
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
  assert.match(echoed, /Attached files:/);
  assert.match(echoed, /shot\.png/);
  await r.dispose();
});

test("a path the text already names is not repeated in the Attached files block", async () => {
  const r = await rig();
  await start(r);
  // The rig resolves every attachment to its cwd, so that is the path the
  // composer would have inserted at the caret on upload (§7.4).
  const typed = `open ${r.cwd} and tell me`;
  await r.adapter.sendTurn({
    threadId: "t1",
    input: typed,
    attachments: [{ type: "file", id: "a1", name: "q3.xlsx", sizeBytes: 10 }],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  const echoed = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.doesNotMatch(echoed, /Attached files:/);
  assert.ok(echoed.includes(typed), `expected the typed text verbatim in ${JSON.stringify(echoed)}`);
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


test("the host's create-time cursor is accepted verbatim", () => {
  // §6.1: a thread created from the resume picker has only a conversation id,
  // so the HOST builds the minimal cursor. Pinning it against the host's own
  // builder means a change on either side breaks the build rather than
  // silently degrading resume to a fresh session.
  const minimal = resumeCursorFor("grok", "t1", "01a0c19e-de22-78c0-a72a-7e230ccfbec0");
  assert.deepEqual(minimal, { schemaVersion: 1, sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0" });
  assert.deepEqual(parseGrokResumeCursor(minimal), {
    schemaVersion: 1,
    sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0"
  });
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

test("the adapter runs no watchdog of its own — the host owns it", async () => {
  const r = await rig({ scenario: "slow" });
  await start(r, { runtimeMode: "approval-required" });
  void r.adapter.sendTurn({ threadId: "t1", input: "long", attachments: [], interactionMode: "default" });
  await r.waitFor((event) => event.type === "turn.started", "turn.started");
  await r.drain();
  // A second watchdog on the same windows would race the host's and settle the
  // turn twice; the adapter settles only on `interruptTurn`, an exit, or a
  // provider result.
  assert.equal(
    r.events.some((event) => event.type === "turn.completed"),
    false
  );
  await r.adapter.interruptTurn("t1");
  const completed = (await r.waitFor(
    (event) => event.type === "turn.completed",
    "turn.completed"
  )) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  assert.equal(completed.payload.state, "interrupted");
  assert.equal(
    r.events.filter((event) => event.type === "turn.completed").length,
    1,
    "exactly one terminal row"
  );
  await r.dispose();
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

test("the /always-approve refusal is a typed 400 with a pointer at the chip", () => {
  // R2 #7: it must be a validation refusal, not a failed-turn activity.
  assert.equal(isBlockedGrokCommand("/always-approve off"), true);
  assert.equal(isBlockedGrokCommand("  /always-approve  "), true);
  assert.equal(isBlockedGrokCommand("/always-approve-ish"), false);
  assert.equal(isBlockedGrokCommand("tell me about /always-approve"), false);
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
  assert.match(error.message, /permission selector/);
  await r.dispose();
});


test("teardown: no provider child outlives the suite", async () => {
  const leaked = openRigs.filter((entry) => !entry.disposed);
  for (const entry of leaked) {
    await entry.dispose();
  }
  assert.deepEqual(
    leaked.length,
    0,
    "a test returned without stopping its session; the child would keep the host alive"
  );
});
