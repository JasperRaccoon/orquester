
import { isolatedPage } from "./testing/isolated-page";
let page: Awaited<ReturnType<typeof isolatedPage>>;
async function loadPage(): Promise<void> {
  await page?.dispose();
  page = await isolatedPage();
  ({ createThreadStore, releaseThreadStore, retainThreadStore, THREAD_STORE_DISPOSE_GRACE_MS, updateThreadDraft } = page.store);
  ({ AgentChatCommandError } = page.transport);
  ({ registerComposerHandle } = page.bridge);
}
beforeEach(loadPage);
afterEach(async () => { await page.dispose(); });
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  foldSubagentActivities,
  type AgentChatCommandName,
  type AgentChatStreamFrame,
  type AttachmentRef,
  type Turn
} from "@orquester/api/agent-chat";

let registerComposerHandle: typeof import("../../components/agent-chat/composer/composer-bridge")["registerComposerHandle"];
import type { AgentChatThreadState, ThreadStore } from "./store";
let createThreadStore: typeof import("./store")["createThreadStore"];
let releaseThreadStore: typeof import("./store")["releaseThreadStore"];
let retainThreadStore: typeof import("./store")["retainThreadStore"];
let THREAD_STORE_DISPOSE_GRACE_MS: typeof import("./store")["THREAD_STORE_DISPOSE_GRACE_MS"];
let updateThreadDraft: typeof import("./store")["updateThreadDraft"];
import type { AgentChatTransport } from "./transport";
let AgentChatCommandError: typeof import("./transport")["AgentChatCommandError"];
import type { AgentChatTimelineRow } from "./contracts";
import { activity, CLAUDE_WORKFLOW_ID, claudeWorkflow, ev, foldTurn, head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

interface Posted {
  /** `"account"` is the daemon-owned §3.4 route, not a §6.2 command name. */
  name: AgentChatCommandName | "account";
  body: Record<string, unknown>;
}

function fakeTransport(): {
  transport: AgentChatTransport;
  posted: Posted[];
  attempts: Posted[];
  push(frame: AgentChatStreamFrame): void;
  fail(error: unknown, times?: number): void;
  /** Runs inside `command`, after the post is recorded and before it answers. */
  beforeAnswer(run: (() => void) | null): void;
} {
  const posted: Posted[] = [];
  const attempts: Posted[] = [];
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  let failures: { error: unknown; times: number } | null = null;
  let beforeAnswer: (() => void) | null = null;

  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command(_sessionId, name, body) {
      attempts.push({ name, body: body as unknown as Record<string, unknown> });
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      beforeAnswer?.();
      return { seq: posted.length };
    },
    // §3.4's account switch: a daemon-owned route, recorded under its own name
    // so a test can assert it never travels as a §6.2 command.
    async switchAccount(_sessionId, body) {
      attempts.push({ name: "account", body: body as unknown as Record<string, unknown> });
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name: "account", body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    async read() {
      return { kind: "snapshot", thread: snapshot() };
    },
    async readItem() {
      throw new Error("unused");
    },
    async readHistory() {
      throw new Error("unused");
    },
    async search() {
      throw new Error("unused");
    },
    async turnDiff() {
      throw new Error("unused");
    },
    async providers() {
      return { providers: [], hostInstanceId: "h1" };
    },
    async refreshProvider() {
      throw new Error("unused");
    },
    async upload() {
      return { type: "file", id: "/a/b", name: "b", sizeBytes: 1 };
    },
    async fetchAttachment() {
      return new ArrayBuffer(0);
    }
  };

  return {
    transport,
    posted,
    attempts,
    push: (frame) => onFrame?.(frame),
    fail: (error, times = 1) => {
      failures = { error, times };
    },
    beforeAnswer: (run) => {
      beforeAnswer = run;
    }
  };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

/** Let every queued microtask run — a command's whole await chain settles. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function store(sessionId = "s1"): Promise<{
  api: ReturnType<typeof createThreadStore>;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const api = createThreadStore(sessionId, {
    transport: fake.transport
  });
  await flush();
  return { api, fake, state: () => api.getState() };
}

beforeEach(() => {
  resetBuilders();
});

describe("the per-thread slice", () => {

  it("never counts a live loop or goal as background work — the host treats both as inert", async () => {
    const row = (id: string, kind: "loop" | "goal" | "subagent") => ({
      id,
      kind,
      agentKind: "background" as const,
      title: id,
      role: null,
      model: null,
      effort: null,
      status: "running" as const,
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: null,
      error: null,
      outputFile: null,
      exitCode: null,
      isBackgrounded: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      firstSeenAt: stamp(1),
      startedAt: null,
      completedAt: null,
      updatedAt: stamp(1)
    });
    const { fake, state } = await store();
    // A loop between its fires and a goal pursued in the thread's turns are
    // no work of their own: the host's registry (INERT_TASK_TYPES), the tab
    // strip, the Attention Center, pushes and the account-switch gate all
    // read the thread as idle, and the open tab must agree.
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, roster: [row("loop-1", "loop"), row("goal:g1", "goal")] }) });
    assert.equal(state().slice.backgroundLiveness, null);
    // A shell beside them is live work as ever.
    fake.push({
      kind: "snapshot",
      thread: snapshot({ seq: 2, roster: [row("loop-1", "loop"), row("goal:g1", "goal"), row("shell-1", "subagent")] })
    });
    assert.equal(state().slice.backgroundLiveness, "monitoring");
  });

  it("drops a Claude log's re-emitted copy and leaves another provider's repeat alone", async () => {
    // Older hosts wrote a CLI-started Claude turn's opening paragraph twice
    // (live thread 19976137, seq 38664/38963); only a Claude thread asks for
    // the repair, because Codex narration may legitimately repeat itself.
    for (const adapter of ["claude", "codex"] as const) {
      const { fake, state } = await store();
      fake.push({
        kind: "snapshot",
        thread: snapshot({
          head: head({ adapter }),
          seq: 2,
          items: [
            message("assistant", "Running the tests again.", { turnId: "t1", id: "m-a" }),
            message("assistant", "Running the tests again.", { turnId: "t1", id: "m-b" })
          ]
        })
      });
      const rows = state().rows;
      const shown = rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
      const folded = rows.some((row) => row.kind === "turn-fold");
      if (adapter === "claude") {
        assert.deepEqual(shown, ["m-a"], "the copy is gone");
        assert.equal(folded, false, "and with it the only thing there was to fold");
      } else {
        // Both are real: the settled turn folds the first behind the second.
        assert.deepEqual(shown, ["m-b"]);
        assert.equal(folded, true);
      }
    }
  });

  it("reads a message's liveness through the rule: a stuck answer is settled, the running turn's streams", async () => {
    const { fake, state } = await store();
    type MessageRow = Extract<AgentChatTimelineRow, { kind: "message" }>;
    const answer = (id: string): MessageRow | undefined =>
      state().rows.find((row): row is MessageRow => row.kind === "message" && row.id === id);
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        head: head({ session: { status: "running", activeTurnId: "t2" } }),
        items: [
          message("user", "first", { id: "u1", createdAt: stamp(1) }),
          activity(
            "tool.completed",
            { itemType: "command_execution", toolUseId: "call-1", title: "ls", command: "ls", status: "completed" },
            { id: "x1", turnId: "t1", createdAt: stamp(2) }
          ),
          // The host streaming it was killed; the log still says `streaming: true`.
          message("assistant", "Half an answer", { id: "a1", turnId: "t1", streaming: true, createdAt: stamp(3) }),
          message("user", "second", { id: "u2", createdAt: stamp(4) }),
          message("assistant", "Now answer", { id: "a2", turnId: "t2", streaming: true, createdAt: stamp(5) })
        ],
        turns: [
          foldTurn("t1", "u1"),
          { ...foldTurn("t2", "u2"), state: "running", completedAt: null }
        ],
        seq: 5
      })
    });
    assert.equal(answer("a1")?.streaming, undefined, "the dead host's answer reads settled");
    assert.ok(
      state().rows.some((row) => row.kind === "turn-fold" && row.turnId === "t1"),
      "and no longer holds its turn's fold open"
    );
    assert.equal(answer("a2")?.streaming, true, "the running turn's answer streams");
    const stored = state().slice.entries.find((item) => item.id === "a1");
    assert.ok(stored?.kind === "message" && stored.streaming, "the fold keeps the flag as the log wrote it");

    fake.push({
      kind: "event",
      seq: 6,
      event: ev("thread.session-set", { session: { status: "stopped", activeTurnId: null } }, { seq: 6 })
    });
    assert.equal(answer("a2")?.streaming, undefined, "no process is left to finish it");
  });
});

describe("the thread's goal (goals §8.1)", () => {
  it("is on the slice the hooks read — the snapshot's, then every live goal row", async () => {
    const { fake, state } = await store();
    assert.equal(state().slice.goal, null, "a thread with no snapshot yet has none");

    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 2,
        goal: { objective: "Make CI green", status: "active", rounds: 1, updatedAt: stamp(2) }
      })
    });
    assert.equal(state().slice.goal?.objective, "Make CI green");

    fake.push({
      kind: "event",
      seq: 3,
      event: ev(
        "thread.activity-appended",
        {
          activity: activity(
            "goal.updated",
            { goal: { objective: "Make CI green", status: "active", rounds: 2 }, change: "checked" },
            { tone: "info", summary: "Goal check 2: not met", turnId: "t1" }
          )
        },
        { seq: 3 }
      )
    });
    assert.equal(state().slice.goal?.rounds, 2);
    assert.ok(
      state().rows.some((row) => row.kind === "goal-marker"),
      "and the same row is the timeline's marker"
    );

    fake.push({
      kind: "event",
      seq: 4,
      event: ev(
        "thread.activity-appended",
        {
          activity: activity(
            "goal.updated",
            { goal: { objective: "Make CI green", status: "active", rounds: 2, phase: "executing" }, change: "progress" },
            { tone: "info", summary: "Goal progress", turnId: "t1" }
          )
        },
        { seq: 4 }
      )
    });
    assert.equal(state().slice.goal?.phase, "executing", "progress moves the goal…");
    assert.equal(
      state().rows.filter((row) => row.kind === "goal-marker").length,
      1,
      "…and adds no row"
    );
  });
});

describe("commands", () => {
  it("mints a commandId per command and sends no optimistic row", async () => {
    const { api, fake, state } = await store();
    await api.getState().actions.sendTurn({ text: "go" });
    assert.equal(fake.posted[0]?.name, "turn");
    const firstId = fake.posted[0]?.body.commandId;
    assert.equal(typeof firstId, "string");
    assert.ok(firstId);
    await api.getState().actions.sendTurn({ text: "next command" });
    assert.notEqual(fake.posted[1]?.body.commandId, firstId);
    assert.equal(state().slice.entries.length, 0, "the message appears when its event arrives");
  });

  it("setAccount posts the daemon-owned route with a minted commandId (§3.4)", async () => {
    const { api, fake, state } = await store();
    await api.getState().actions.setAccount({ accountId: "acc-2" });
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]?.name, "account", "never a §6.2 command");
    assert.equal(fake.posted[0]?.body.accountId, "acc-2");
    assert.equal(typeof fake.posted[0]?.body.commandId, "string");
    assert.ok(fake.posted[0]?.body.commandId);
    // Applied on the next message: nothing optimistic, no row, no head edit.
    assert.equal(state().slice.entries.length, 0);
    assert.equal(state().slice.errorBanner, null);
  });

  it("setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const retrying = await store();
    retrying.fake.fail(new AgentChatCommandError(503, "HOST_UNAVAILABLE", "restarting"), 2);
    const changing = retrying.api.getState().actions.setAccount({ accountId: "acc-2" });
    await settle();
    t.mock.timers.tick(250);
    await settle();
    t.mock.timers.tick(500);
    await changing;
    assert.equal(retrying.fake.posted.length, 1);
    assert.equal(retrying.fake.attempts.length, 3);
    assert.equal(new Set(retrying.fake.attempts.map((attempt) => attempt.body.commandId)).size, 1);

    const refused = await store();
    refused.fake.fail(
      new AgentChatCommandError(409, "COMMAND_REJECTED", "Wait for the agent to finish."),
      99
    );
    await assert.rejects(() => refused.api.getState().actions.setAccount({ accountId: "acc-2" }));
    assert.equal(refused.state().slice.errorBanner, "Wait for the agent to finish.");
  });

  it("holds `reverting` for the length of the revert and clears it even on failure", async () => {
    // §7.5's ONE reason the composer goes inert. It used to be hard-coded
    // `false` in the view with nothing to set it, so a turn could be typed and
    // sent into the middle of the host rewriting the thread.
    const { api, state } = await store();
    assert.equal(state().reverting, false);
    const inFlight = api.getState().actions.revert({ targetTurnCount: 1 });
    assert.equal(state().reverting, true, "inert while the command is out");
    await inFlight;
    assert.equal(state().reverting, false);

    const failing = await store();
    failing.fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);
    await assert.rejects(() => failing.api.getState().actions.revert({ targetTurnCount: 1 }));
    assert.equal(failing.state().reverting, false, "a refusal must not leave it inert forever");
  });

  it("locks the row while a decision is in flight and clears it in a finally", async () => {
    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "stale"), 99);
    const answering = api.getState().actions.respondApproval({ requestId: "r1", decision: "accept" });
    assert.deepEqual(state().slice.respondingRequestIds, ["r1"]);
    await assert.rejects(answering);
    assert.deepEqual(state().slice.respondingRequestIds, [], "cleared even on failure");
  });

  it("omits turnId unless the session is running", async () => {
    const { api, fake } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ head: head({ session: { status: "ready", activeTurnId: "old-turn" } }), seq: 1 }) });
    await api.getState().actions.interrupt();
    assert.equal(fake.posted[0]?.name, "interrupt");
    assert.equal("turnId" in fake.posted[0]!.body, false);

    fake.push({ kind: "snapshot", thread: snapshot({ head: head({ session: { status: "running", activeTurnId: "current-turn" } }), seq: 2 }) });
    await api.getState().actions.interrupt();
    assert.equal(fake.posted[1]?.body.turnId, "current-turn");
  });
});

/**
 * "Rewind to here" end to end (§5.5, §7.5): the host answers `/revert` with a
 * `{seq}` long before it has rewritten anything, so the store waits for the
 * thread itself to say how it went — the message truncated away, or a new
 * `checkpoint.revert.failed` row — and only then hands the message back.
 */
describe("rewindTo", () => {
  const attachment = { type: "file" as const, id: "/att/notes", name: "notes.txt", sizeBytes: 12 };
  const chip = { kind: "file", label: "src/a.ts", ref: "/w/p/src/a.ts" };
  const REWOUND_TEXT = "second — try it the other way";

  const turn = (turnId: string, userMessageId: string): Turn => ({
    turnId,
    state: "completed",
    turnCount: null,
    requestedAt: stamp(0),
    startedAt: stamp(0),
    completedAt: stamp(0),
    assistantMessageId: null,
    userMessageId
  });

  /** Two turns; the second prompt carries an attachment and a context chip. */
  const conversation = () => {
    const kept = [
      message("user", "first", { id: "u1", createdAt: stamp(1) }),
      message("assistant", "one", { id: "a1", turnId: "t1", createdAt: stamp(2) })
    ];
    const rewound = [
      message("user", REWOUND_TEXT, {
        id: "u2",
        createdAt: stamp(3),
        attachments: [attachment],
        context: [chip]
      }),
      message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(4) })
    ];
    return { kept, rewound };
  };

  /** A store holding the two-turn thread, plus the snapshot the host sends once it has rewound. */
  async function rewindable(extraItems: ReturnType<typeof activity>[] = []) {
    const opened = await store();
    const { kept, rewound } = conversation();
    opened.fake.push({
      kind: "snapshot",
      thread: snapshot({
        items: [...kept, ...rewound, ...extraItems],
        turns: [turn("t1", "u1"), turn("t2", "u2")],
        seq: 5
      })
    });
    const truncated: AgentChatStreamFrame = {
      kind: "snapshot",
      thread: snapshot({ items: [...kept, ...extraItems], turns: [turn("t1", "u1")], seq: 7 })
    };
    return { ...opened, truncated };
  }

  it("posts `revert`, stays inert until the truncation lands, then hands the message back", async () => {
    const { api, fake, state, truncated } = await rewindable();

    const rewinding = api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    assert.equal(state().reverting, true, "inert from the first moment");
    await settle();
    assert.deepEqual(
      fake.posted.map((posted) => [posted.name, posted.body.targetTurnCount]),
      [["revert", 1]]
    );
    assert.equal(
      state().reverting,
      true,
      "the command answering proves nothing — the host has not rewound yet"
    );
    assert.equal(state().draft.text, "", "nothing comes back before the thread says so");

    fake.push(truncated);
    await rewinding;
    assert.equal(state().reverting, false);
    assert.equal(state().draft.text, REWOUND_TEXT, "back in the composer for editing");
    assert.deepEqual(state().draft.attachments, [attachment], "its attachment chip too");
    assert.deepEqual(state().draft.context, [chip]);
  });

  it("settles at once when the truncation was folded before the command answered", async () => {
    const { api, fake, state, truncated } = await rewindable();
    // The stream can beat the HTTP response: the waiter reads the thread
    // before it subscribes, or it would wait for a frame that already came.
    fake.beforeAnswer(() => fake.push(truncated));

    await api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    assert.equal(state().reverting, false);
    assert.equal(state().draft.text, REWOUND_TEXT);
  });

  it("rejects with the reason of a NEW rewind failure, and clears `reverting`", async () => {
    const earlier = activity(
      "checkpoint.revert.failed",
      { detail: "an older rewind's failure", turnCount: 0 },
      { tone: "error", summary: "Rewind failed", createdAt: stamp(5) }
    );
    const { api, fake, state } = await rewindable([earlier]);

    const rewinding = api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    const rejected = assert.rejects(rewinding, {
      message: "Cannot rewind past a compaction; start a new thread."
    });
    await settle();
    assert.equal(state().reverting, true, "a failure already on the thread is not this rewind's answer");

    fake.push({
      kind: "event",
      seq: 6,
      event: ev(
        "thread.activity-appended",
        {
          activity: activity(
            "checkpoint.revert.failed",
            { detail: "Cannot rewind past a compaction; start a new thread.", turnCount: 1 },
            { tone: "error", summary: "Rewind failed", createdAt: stamp(6) }
          )
        },
        { seq: 6 }
      )
    });
    await rejected;
    assert.equal(state().reverting, false, "a refusal must not leave the composer inert");
    assert.equal(state().draft.text, "", "the message never left the thread, so nothing comes back");
  });

  it("falls back to the failure row's summary when it carries no detail", async () => {
    const { api, fake } = await rewindable();
    const rejected = assert.rejects(
      api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 }),
      { message: "Rewind failed" }
    );
    await settle();
    fake.push({
      kind: "event",
      seq: 6,
      event: ev(
        "thread.activity-appended",
        {
          activity: activity("checkpoint.revert.failed", {}, {
            tone: "error",
            summary: "Rewind failed",
            createdAt: stamp(6)
          })
        },
        { seq: 6 }
      )
    });
    await rejected;
  });

  it("rejects a message it cannot find — or one that is not the user's — without posting", async () => {
    const { api, fake, state } = await rewindable();
    await assert.rejects(api.getState().actions.rewindTo({ messageId: "nope", targetTurnCount: 0 }));
    await assert.rejects(api.getState().actions.rewindTo({ messageId: "a1", targetTurnCount: 0 }));
    assert.equal(fake.posted.length, 0);
    assert.equal(state().reverting, false);
  });

  it("refuses a second rewind while one is in flight — one `/revert`, one message back", async () => {
    const { api, fake, state, truncated } = await rewindable();
    const first = api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    await assert.rejects(api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 }));
    await settle();
    fake.push(truncated);
    await first;
    assert.equal(fake.posted.length, 1);
    assert.equal(state().draft.text, REWOUND_TEXT, "handed back once, not twice");
  });

  it("unlocks the composer after two minutes without claiming the rewind completed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { api, fake, state } = await rewindable();
      const rejected = assert.rejects(
        api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 })
      );
      await settle();
      assert.equal(fake.posted.length, 1);

      mock.timers.tick(119_999);
      await settle();
      assert.equal(state().reverting, true, "still waiting a millisecond before the deadline");

      mock.timers.tick(1);
      await rejected;
      assert.equal(state().reverting, false);
      assert.equal(state().draft.text, "", "no answer is not a rewind");
    } finally {
      mock.timers.reset();
    }
  });

  it("settles when its store is destroyed mid-wait, handing the message back to the persisted draft", async () => {
    const backing: Record<string, string> = {};
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: (key: string) => {
        delete backing[key];
      }
    };
    try {
      const { api, state } = await rewindable();
      const rewinding = api.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
      await settle();

      // No frame can reach a destroyed generation; the wait ends with it rather
      // than at its timeout. The user asked for this message back, and losing
      // it would be unrecoverable if the host goes on to rewind. It goes to the
      // thread's persisted draft — no slice of it is open — never into the
      // destroyed slice's own copy, which nothing will show again.
      (api as ThreadStore & { destroy?: () => void }).destroy?.();
      await rewinding;
      assert.equal(state().reverting, false);
      const stored = JSON.parse(backing["orquester:agent-chat-drafts"] ?? "{}") as Record<
        string,
        { text: string }
      >;
      assert.equal(stored.s1?.text, REWOUND_TEXT);
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("the queued-message model", () => {
  const draft = (text: string) => ({
    text,
    attachments: [],
    context: [],
    interactionMode: "default" as const,
    queuedAfterToolActivityId: null,
    holdUntilUserAction: false
  });

  it("returns every queued message to the composer on interrupt", async () => {
    const { api, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    await api.getState().actions.interrupt();
    assert.equal(state().slice.queue.length, 0);
    assert.equal(state().draft.text, "one\n\ntwo");
  });

  it("holds a failed send at the FRONT so nothing overtakes it", async () => {
    const { api, fake, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    const headId = state().slice.queue[0]!.id;
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);

    await assert.rejects(() => api.getState().actions.sendQueuedNow(headId));
    assert.equal(state().slice.queue[0]?.id, headId);
    assert.equal(state().slice.queue[0]?.holdUntilUserAction, true);
    assert.equal(state().slice.queue.length, 2);
  });

  it("returns one queued message to the composer", async () => {
    const { api, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.returnQueuedToComposer(state().slice.queue[0]!.id);
    assert.equal(state().slice.queue.length, 0);
    assert.equal(state().draft.text, "one");
  });
});

describe("client-local view state", () => {

  it("remembers a dismissal per (thread, message) — a DIFFERENT error still shows", async () => {

    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "same"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    api.getState().actions.dismissErrorBanner();

    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "same"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    assert.equal(state().slice.errorBanner, null, "the closed banner stays closed");

    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "different"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    assert.equal(state().slice.errorBanner, "different");
  });

  it("retries a lost response with the SAME commandId", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { api, fake } = await store();
    // A transport-level throw: the response never arrived (§6.6).
    fake.fail(new Error("socket hang up"), 1);
    const stopping = api.getState().actions.stopSession();
    await settle();
    t.mock.timers.tick(250);
    await stopping;
    assert.equal(fake.attempts.length, 2);
    assert.equal(fake.attempts[1]?.body.commandId, fake.attempts[0]?.body.commandId);
  });

  it("writes the scroll/disclosure LRU and mirrors follow from atEnd", async () => {
    const { api, state } = await store();
    api.getState().actions.rememberScroll({ rowId: "r9", scrollOffset: 120, atEnd: false });
    assert.equal(state().slice.scroll?.rowId, "r9");
    assert.equal(state().slice.scroll?.scrollOffset, 120);
    assert.equal(state().slice.follow, false);

    api.getState().actions.rememberScroll({ atEnd: true });
    assert.equal(state().slice.follow, true);
    assert.equal(state().slice.scroll?.rowId, "r9", "unspecified fields are kept");
  });
});

/**
 * The composer's unsent draft lives here, not in the component (§7.4).
 *
 * The composer mounts, loads this, and writes back on every change — so the
 * two halves that have to hold are "a save reaches `localStorage` under this
 * thread's id" and "a store built from nothing finds it again", which is
 * exactly the shape of a reload.
 */
describe("the persisted composer draft", () => {
  const DRAFTS_KEY = "orquester:agent-chat-drafts";
  let backing: Record<string, string> = {};

  const attachment = {
    type: "file" as const,
    id: "a1",
    name: "notes.txt",
    sizeBytes: 12
  };

  beforeEach(() => {
    backing = {};
    const stub = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: (key: string) => {
        delete backing[key];
      },
      clear: () => {
        backing = {};
      },
      key: (index: number) => Object.keys(backing)[index] ?? null,
      get length() {
        return Object.keys(backing).length;
      }
    };
    (globalThis as unknown as { localStorage: unknown }).localStorage = stub;
  });

  after(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const persisted = (): Record<string, { text: string; attachments: { id: string }[] }> =>
    JSON.parse(backing[DRAFTS_KEY] ?? "{}");

  it("writes a saved draft straight through to storage, under its own thread id", async () => {
    const { api, state } = await store("draft-1");
    api.getState().actions.saveDraft({
      text: "half a thought",
      attachments: [attachment],
      context: []
    });
    assert.equal(state().draft.text, "half a thought");
    assert.equal(persisted()["draft-1"]?.text, "half a thought");
    assert.deepEqual(persisted()["draft-1"]?.attachments.map((ref) => ref.id), ["a1"]);
  });

  it("seeds a fresh store from storage — which is what a reload is", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      "draft-2": { text: "typed, never sent", attachments: [attachment], context: [] }
    });
    const { state } = await store("draft-2");
    assert.equal(state().draft.text, "typed, never sent");
    assert.deepEqual(
      state().draft.attachments.map((ref) => ref.id),
      ["a1"],
      "an uploaded attachment comes back as a reference the composer can re-stage"
    );
  });

  it("drops the entry when the draft is cleared, so a sent message never returns", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      "draft-3": { text: "about to be sent", attachments: [], context: [] }
    });
    const { api, state } = await store("draft-3");
    assert.equal(state().draft.text, "about to be sent");

    api.getState().actions.saveDraft({ text: "", attachments: [], context: [] });
    assert.equal(state().draft.text, "");
    assert.equal(persisted()["draft-3"], undefined);
  });

  it("leaves another thread's draft alone", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      other: { text: "someone else's", attachments: [], context: [] }
    });
    const { api } = await store("draft-4");
    api.getState().actions.saveDraft({ text: "mine", attachments: [], context: [] });
    assert.equal(persisted().other?.text, "someone else's");
    assert.equal(persisted()["draft-4"]?.text, "mine");
  });

  /**
   * `updateThreadDraft` rewrites ONE thread's draft from outside its composer:
   * a failed send whose composer no longer shows the thread it left from
   * (§7.4). The draft it reads and the one it writes must be the one the next
   * composer mount of that thread loads.
   */
  describe("rewritten from outside the composer", () => {
    it("with no slice open, lands in storage, where the thread's next slice seeds from, and moves no other thread's draft", async () => {
      backing[DRAFTS_KEY] = JSON.stringify({
        A: { text: "typed since", attachments: [attachment], context: [] },
        B: { text: "b's own", attachments: [], context: [] }
      });

      updateThreadDraft("A", (draft) => ({ ...draft, text: `sent, and failed\n\n${draft.text}` }));

      assert.equal(persisted().A?.text, "sent, and failed\n\ntyped since");
      assert.deepEqual(persisted().A?.attachments.map((ref) => ref.id), ["a1"], "what it held stays");
      assert.equal(persisted().B?.text, "b's own");
      const { state } = await store("A");
      assert.equal(state().draft.text, "sent, and failed\n\ntyped since");
    });

    it("with a slice open, goes through that slice, whose draft the next composer mount loads", () => {
      const deps = { transport: fakeTransport().transport };
      // A slice keeps its own copy of the draft in memory, seeded from storage.
      const live = retainThreadStore("A", deps);
      live.getState().actions.saveDraft({ text: "typed since", attachments: [], context: [] });
      const other = retainThreadStore("B", deps);
      other.getState().actions.saveDraft({ text: "b's own", attachments: [], context: [] });

      updateThreadDraft("A", (draft) => ({ ...draft, text: `sent, and failed\n\n${draft.text}` }));

      assert.equal(live.getState().draft.text, "sent, and failed\n\ntyped since");
      assert.equal(persisted().A?.text, "sent, and failed\n\ntyped since");
      assert.equal(other.getState().draft.text, "b's own");
      assert.equal(persisted().B?.text, "b's own");
    });

  });
});

/**
 * A send outlives the store generation that posted it (§7.4). A project
 * switch lets go of the thread's slice, which is destroyed 2 s later while its
 * post keeps retrying; the user may be back on the thread by the time it
 * settles. Whatever it settles to lands in the thread as the user now sees it
 * — never lost in the destroyed generation, never locking the new one — and
 * no attempt can keep a thread "Sending" forever.
 */
describe("a send outlives its store generation", () => {
  const DRAFTS_KEY = "orquester:agent-chat-drafts";
  let backing: Record<string, string> = {};
  const persisted = (): Record<string, { text: string; attachments: AttachmentRef[] }> =>
    JSON.parse(backing[DRAFTS_KEY] ?? "{}");

  interface Attempt {
    name: string;
    body: Record<string, unknown>;
    signal: AbortSignal | undefined;
    answer(): void;
    fail(error: unknown): void;
  }

  /** A transport whose every command attempt answers only when the test says so. */
  function gatedTransport(): {
    transport: AgentChatTransport;
    attempts: Attempt[];
    push(frame: AgentChatStreamFrame): void;
  } {
    const attempts: Attempt[] = [];
    const base = fakeTransport();
    const transport: AgentChatTransport = {
      ...base.transport,
      command(_sessionId, name, body, signal) {
        return new Promise((resolve, reject) => {
          attempts.push({
            name,
            body: body as unknown as Record<string, unknown>,
            signal,
            answer: () => resolve({ seq: attempts.length }),
            fail: reject
          });
        });
      }
    };
    return { transport, attempts, push: base.push };
  }

  const restarting = () => new AgentChatCommandError(503, "HOST_UNAVAILABLE", "The agent host is restarting.");
  const file = (id: string): AttachmentRef => ({ type: "file", id, name: `${id}.txt`, sizeBytes: 12 });
  const eight = (prefix: string): AttachmentRef[] =>
    Array.from({ length: 8 }, (_, index) => file(`${prefix}${index + 1}`));
  const queued = (text: string, attachments: AttachmentRef[] = []) => ({
    text,
    attachments,
    context: [],
    interactionMode: "default" as const,
    queuedAfterToolActivityId: null,
    holdUntilUserAction: false
  });

  /** What a project switch does to a thread's slice: let go of it, and let the grace pass. */
  function tearDown(sessionId: string): void {
    releaseThreadStore(sessionId);
    mock.timers.tick(THREAD_STORE_DISPOSE_GRACE_MS);
  }

  beforeEach(() => {
    backing = {};
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: (key: string) => {
        delete backing[key];
      }
    };
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {

    // A post a test left out still holds its thread's queue: in-memory, like a reload.

    mock.timers.reset();
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it("a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId", async () => {
    // A lost response of either may be one the host already accepted: giving
    // up turned it into a "failed" send the user resent as a duplicate. The
    // receipt makes the retry free.
    const { transport, attempts } = gatedTransport();
    const store = createThreadStore("A", { transport });
    await flush();
    const sending = store.getState().actions.sendTurn({ text: "deploy the fix" });
    const answering = store.getState().actions.answerQuestion({ requestId: "r1", answers: { q: "yes" } });
    await settle();
    (store as ThreadStore & { destroy?: () => void }).destroy?.();

    attempts[0]!.fail(restarting());
    attempts[1]!.fail(restarting());
    await settle();
    mock.timers.tick(250);
    await settle();
    const posts = (name: string) => attempts.filter((attempt) => attempt.name === name);
    assert.equal(posts("turn").length, 2);
    assert.equal(posts("answer").length, 2);
    assert.equal(posts("turn")[1]!.body.commandId, posts("turn")[0]!.body.commandId);
    assert.equal(posts("answer")[1]!.body.commandId, posts("answer")[0]!.body.commandId);
    assert.notEqual(posts("turn")[0]!.body.commandId, posts("answer")[0]!.body.commandId);
    posts("turn")[1]!.answer();
    posts("answer")[1]!.answer();
    await sending;
    await answering;

    // Anything else stops with its generation, as it always did.
    const other = gatedTransport();
    const gone = createThreadStore("B", { transport: other.transport });
    await flush();
    const compacting = gone.getState().actions.compact();
    await settle();
    (gone as ThreadStore & { destroy?: () => void }).destroy?.();
    other.attempts[0]!.fail(restarting());
    await assert.rejects(compacting);
    assert.equal(other.attempts.length, 1);
  });

  it("an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever", async () => {
    // Past the daemon's own 20 s host timeout, which answers a hung host with
    // a 503 first: this bounds what the daemon cannot, a half-open connection.
    const { transport, attempts } = gatedTransport();
    const store = createThreadStore("A", { transport });
    await flush();
    const sending = store.getState().actions.sendTurn({ text: "deploy the fix" });
    await settle();
    assert.equal(attempts.length, 1);

    mock.timers.tick(24_999);
    await settle();
    assert.equal(attempts.length, 1, "not before its deadline");
    mock.timers.tick(1);
    await settle();
    assert.equal(attempts[0]!.signal?.aborted, true, "the stuck request is aborted, not left open");
    mock.timers.tick(250);
    await settle();
    assert.equal(attempts.length, 2, "a timed-out attempt is a lost response: retried");
    assert.equal(attempts[1]!.body.commandId, attempts[0]!.body.commandId);
    attempts[1]!.answer();
    await sending;

    // One that never answers at all fails once its retries are spent: the
    // composer's "Sending" is bounded by the retry budget.
    const silent = gatedTransport();
    const stuck = createThreadStore("B", { transport: silent.transport });
    await flush();
    const failing = assert.rejects(stuck.getState().actions.sendTurn({ text: "again" }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await settle();
      mock.timers.tick(25_000);
      await settle();
      if (attempt < 3) mock.timers.tick(250 * 2 ** attempt);
    }
    await failing;
    assert.equal(silent.attempts.length, 4);
    assert.equal(new Set(silent.attempts.map((attempt) => attempt.body.commandId)).size, 1);
  });

  it("a queued send that fails after its generation was destroyed is held at the front of the thread's live generation", async () => {
    const { transport, attempts } = gatedTransport();
    const deps = { transport };
    const first = retainThreadStore("Q", deps);
    await flush();
    first.getState().actions.queueMessage(queued("queued follow-up", [file("f1")]));
    const sending = first.getState().actions.sendQueuedNow(first.getState().slice.queue[0]!.id);
    await settle();
    assert.equal(attempts.length, 1);

    tearDown("Q");
    const second = retainThreadStore("Q", deps);
    assert.equal(second.getState().slice.queue.length, 0, "the message had left the queue before the teardown");

    attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await assert.rejects(sending);
    assert.deepEqual(
      second.getState().slice.queue.map((message) => [
        message.text,
        message.holdUntilUserAction,
        message.attachments.map((attachment) => attachment.id)
      ]),
      [["queued follow-up", true, ["f1"]]],
      "held at the front of the queue the user sees, not of the destroyed one"
    );
    assert.equal(
      second.getState().slice.errorBanner,
      "no",
      "and its reason with it: a held row with no banner never says why it waits"
    );
  });

  /** Two queued messages on a thread whose turn just ended: the first leaves, the second waits behind it. */
  async function firstQueuedSendInFlight(sessionId: string) {
    const gated = gatedTransport();
    const deps = { transport: gated.transport };
    const first = retainThreadStore(sessionId, deps);
    await flush();
    gated.push({
      kind: "snapshot",
      thread: snapshot({ seq: 1, head: head({ session: { status: "running", activeTurnId: "t1" } }) })
    });
    first.getState().actions.queueMessage(queued("first queued"));
    first.getState().actions.queueMessage(queued("second queued"));
    const ended: AgentChatStreamFrame = {
      kind: "snapshot",
      thread: snapshot({ seq: 2, head: head({ session: { status: "ready", activeTurnId: null } }) })
    };
    gated.push(ended);
    await settle();
    assert.deepEqual(gated.attempts.map((attempt) => attempt.body.input), ["first queued"]);
    return { ...gated, deps, ended };
  }

  it("the live generation waits for the torn-down one's queued send in flight before sending the next", async () => {
    const { attempts, push, deps, ended } = await firstQueuedSendInFlight("Q");

    tearDown("Q");
    const second = retainThreadStore("Q", deps);
    await flush();
    assert.deepEqual(second.getState().slice.queue.map((message) => message.text), ["second queued"]);
    // The next boundary reaches the live generation while the first send is still out.
    push({ ...ended, thread: { ...ended.thread, seq: 3 } });
    await settle();
    assert.deepEqual(
      attempts.map((attempt) => attempt.body.input),
      ["first queued"],
      "the second waits: sent now it could land before the first, or overtake it if the first fails"
    );

    attempts[0]!.answer();
    await settle();
    assert.deepEqual(attempts.map((attempt) => attempt.body.input), ["first queued", "second queued"]);
    attempts[1]!.answer();
    await settle();
  });

  it("when the torn-down generation's queued send fails, it is held at the front and the next one still waits", async () => {
    const { attempts, push, deps, ended } = await firstQueuedSendInFlight("Q");

    tearDown("Q");
    const second = retainThreadStore("Q", deps);
    await flush();
    push({ ...ended, thread: { ...ended.thread, seq: 3 } });
    attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();

    assert.deepEqual(
      second.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["first queued", true],
        ["second queued", false]
      ]
    );
    assert.equal(attempts.length, 1, "nothing overtook the held message");
  });

  it("with no live generation, a queued send that fails after the teardown goes back to the persisted draft", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({ Q: { text: "typed since", attachments: [], context: [] } });
    const { transport, attempts } = gatedTransport();
    const deps = { transport };
    const first = retainThreadStore("Q", deps);
    await flush();
    first.getState().actions.queueMessage(queued("queued follow-up", [file("f1")]));
    const sending = first.getState().actions.sendQueuedNow(first.getState().slice.queue[0]!.id);
    await settle();

    tearDown("Q");
    attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await assert.rejects(sending);
    assert.equal(persisted().Q?.text, "typed since\n\nqueued follow-up");
    assert.deepEqual(persisted().Q?.attachments.map((attachment) => attachment.id), ["f1"]);
  });

  it("a rewind torn down before the host answered merges into the thread's live slice, never over its newer draft", async () => {
    const { transport, attempts, push } = gatedTransport();
    const deps = { transport };
    const first = retainThreadStore("W", deps);
    await flush();
    push({
      kind: "snapshot",
      thread: snapshot({
        items: [
          message("user", "first", { id: "u1", createdAt: stamp(1) }),
          message("user", "try it the other way", { id: "u2", createdAt: stamp(2) })
        ],
        seq: 3
      })
    });
    const rewinding = first.getState().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    await settle();
    assert.equal(attempts[0]?.name, "revert");

    // The project switch lands while the `/revert` is still out, and the user
    // is back — typing — before the host answers it.
    tearDown("W");
    const second = retainThreadStore("W", deps);
    second.getState().actions.saveDraft({ text: "typed since", attachments: [], context: [] });

    attempts[0]!.answer();
    await rewinding;
    const expected = "typed since\n\ntry it the other way";
    assert.equal(second.getState().draft.text, expected, "the draft the user sees now");
    assert.equal(persisted().W?.text, expected, "and the one the thread's next slice seeds from");
  });

  it("an answer in flight across a teardown never locks the next generation's card", async () => {
    const { transport, attempts } = gatedTransport();
    const deps = { transport };
    const first = retainThreadStore("R", deps);
    await flush();
    const answering = first.getState().actions.answerQuestion({ requestId: "r1", answers: { q: "yes" } });
    await settle();
    assert.deepEqual(first.getState().slice.respondingRequestIds, ["r1"]);

    tearDown("R");
    const second = retainThreadStore("R", deps);
    assert.deepEqual(
      second.getState().slice.respondingRequestIds,
      [],
      "an answer in flight belongs to the generation that posted it"
    );
    attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "stale"));
    await assert.rejects(answering);
    assert.deepEqual(second.getState().slice.respondingRequestIds, []);
  });

  it("with no composer mounted, a Stop returning two full queued messages keeps all sixteen files for the next mount", async () => {
    const { api } = await store("Q");
    api.getState().actions.queueMessage(queued("first", eight("s")));
    api.getState().actions.queueMessage(queued("second", eight("m")));
    await api.getState().actions.interrupt();

    const stored = persisted().Q!;
    assert.equal(stored.text, "first\n\nsecond");
    assert.equal(stored.attachments.length, 16);
  });

  function mountComposer(sessionId: string, refused: AttachmentRef[] = []) {
    const inserted: string[] = [];
    const returned: { text: string; attachments: readonly AttachmentRef[] }[] = [];
    const unregister = registerComposerHandle(sessionId, {
      insertText: (text) => void inserted.push(text),
      // A NEW pick into a full tray is refused; a returned file never comes this way.
      stageAttachment: () => false,
      returnMessage: (message) => {
        returned.push(message);
        return refused;
      },
      focusAtEnd: () => {},
      openControl: () => {},
      sendText: () => false,
      submitText: () => ({ ok: false, reason: "not in this test" }),
      restoreFailedSend: () => false
    });
    return { returned, inserted, unregister };
  }

  it("with a composer mounted, the returned message reaches it without a hidden persisted copy", async () => {
    const { api, state } = await store("R");
    const composer = mountComposer("R");
    try {
      api.getState().actions.queueMessage(queued("queued", eight("q")));
      api.getState().actions.returnQueuedToComposer(state().slice.queue[0]!.id);

      assert.deepEqual(composer.returned.map((message) => ({
        text: message.text,
        files: message.attachments.map((attachment) => attachment.id)
      })), [{ text: "queued", files: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] }]);
      assert.deepEqual(composer.inserted, [], "nothing refused, so nothing written as a path");
      assert.deepEqual(state().draft.attachments, [], "nothing parked where the composer's next save drops it");
      assert.equal(state().draft.text, "");
    } finally {
      composer.unregister();
    }
  });

  it("a file the composer still refuses is written into its draft as its path, never parked behind it", async () => {
    const { api, state } = await store("R");
    const vector: AttachmentRef = {
      type: "image",
      id: "vector",
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 12,
      path: "/w/p/.att/diagram.svg"
    };
    const composer = mountComposer("R", [vector]);
    try {
      api.getState().actions.queueMessage(queued("see [Image #1]", [vector]));
      api.getState().actions.returnQueuedToComposer(state().slice.queue[0]!.id);

      assert.deepEqual(composer.inserted, ["/w/p/.att/diagram.svg"], "the bridge's fallback: a path the user can see");
      assert.deepEqual(state().draft.attachments, []);
      assert.equal(state().draft.text, "");
    } finally {
      composer.unregister();
    }
  });
});

describe("stopping one task (/task/stop)", () => {
  /** A thread whose roster holds one live Claude workflow run. */
  async function withLiveWorkflow() {
    const harness = await store();
    const items = [activity("task.started", claudeWorkflow.coordinator())];
    harness.fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, items, roster: foldSubagentActivities(items) }) });
    return harness;
  }
  const settledFrame = (seq: number, activityKind: string, payload: unknown): AgentChatStreamFrame => ({
    kind: "event",
    seq,
    event: ev("thread.activity-appended", { activity: activity(activityKind, payload, { createdAt: stamp(seq) }) }, { seq })
  });

  it("posts the task's id and holds its Stop pending until the row settles", async () => {
    const { api, fake, state } = await withLiveWorkflow();
    await api.getState().actions.stopTask({ taskId: CLAUDE_WORKFLOW_ID });
    const posted = fake.posted.at(-1);
    assert.equal(posted?.name, "task/stop");
    assert.equal(posted?.body.taskId, CLAUDE_WORKFLOW_ID);
    assert.equal(typeof posted?.body.commandId, "string");
    assert.deepEqual(state().stoppingTaskIds, [CLAUDE_WORKFLOW_ID], "an accepted stop is not yet a stopped task");

    fake.push(settledFrame(2, "task.progress", claudeWorkflow.coordinator({ status: "running", summary: "still going" })));
    assert.deepEqual(state().stoppingTaskIds, [CLAUDE_WORKFLOW_ID]);
    fake.push(settledFrame(3, "task.completed", claudeWorkflow.coordinator({ status: "stopped" })));
    assert.deepEqual(state().stoppingTaskIds, [], "the row settled");
  });

  it("lets the Stop go at once when the host refuses it, and says why on the banner", async () => {
    const { api, fake, state } = await withLiveWorkflow();
    const reason = "A workflow's agents cannot be stopped one by one. Stop the whole workflow instead.";
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", reason), 1);
    await assert.rejects(() => api.getState().actions.stopTask({ taskId: CLAUDE_WORKFLOW_ID }));
    assert.deepEqual(state().stoppingTaskIds, []);
    assert.equal(state().slice.errorBanner, reason);
  });

  it("offers the Stop again when the provider failed it", async () => {
    const { api, fake, state } = await withLiveWorkflow();
    await api.getState().actions.stopTask({ taskId: CLAUDE_WORKFLOW_ID });
    fake.push(settledFrame(2, "provider.task.stop.failed", { targetTaskId: CLAUDE_WORKFLOW_ID, detail: "timed out" }));
    assert.deepEqual(state().stoppingTaskIds, []);
  });
});
