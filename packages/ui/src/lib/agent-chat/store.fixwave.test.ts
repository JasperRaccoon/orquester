/**
 * Fix-wave regressions for the per-thread store.
 *
 * Each block fails without the matching fix; the finding id is in the title.
 * Kept beside `store.test.ts` rather than inside it so the reviewer's
 * reproduction and the pre-existing coverage stay legible apart.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AgentChatStreamFrame, AttachmentRef } from "@orquester/api/agent-chat";

import { registerComposerHandle } from "../../components/agent-chat/composer/composer-bridge";
import { createThreadStore, resetDismissedErrorBanners, type AgentChatThreadState } from "./store";
import { AgentChatCommandError, type AgentChatTransport } from "./transport";
import { activity, ev, head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

interface Posted {
  name: string;
  body: Record<string, unknown>;
}

function fakeTransport(): {
  transport: AgentChatTransport;
  posted: Posted[];
  push(frame: AgentChatStreamFrame): void;
  fail(error: unknown, times?: number): void;
} {
  const posted: Posted[] = [];
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  let failures: { error: unknown; times: number } | null = null;

  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command(_sessionId, name, body) {
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    // §3.4's account switch rides its own daemon-owned route.
    async switchAccount() {
      return { seq: 0 };
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
    push: (frame) => onFrame?.(frame),
    fail: (error, times = 1) => {
      failures = { error, times };
    }
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  }
};

async function store(): Promise<{
  api: ReturnType<typeof createThreadStore>;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  let n = 0;
  const api = createThreadStore("s1", {
    transport: fake.transport,
    newId: () => `id${++n}`,
    now: () => stamp(1),
    delay: async () => {}
  });
  await flush();
  return { api, fake, state: () => api.getState() };
}

const running = () => head({ session: { status: "running", activeTurnId: "t1" } });
const ready = () => head({ session: { status: "ready", activeTurnId: null } });

const draft = (text: string) => ({
  text,
  attachments: [],
  context: [],
  interactionMode: "default" as const,
  queuedAfterToolActivityId: null,
  holdUntilUserAction: false
});

beforeEach(() => {
  resetBuilders();
  resetDismissedErrorBanners();
});

describe("R7-1 — the client queue actually flushes", () => {
  it("sends exactly one queued message per tool-call boundary", async () => {
    const { api, fake, state } = await store();
    const first = activity("tool.completed", { itemType: "command_execution", command: "a" });
    fake.push({
      kind: "snapshot",
      thread: snapshot({ items: [first], seq: 1, head: running() })
    });

    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    await flush();
    assert.equal(fake.posted.length, 0, "anchored on the boundary that was current when queued");
    assert.equal(state().slice.queue.length, 2);

    const second = activity("tool.completed", { itemType: "command_execution", command: "b" });
    fake.push({
      kind: "snapshot",
      thread: snapshot({ items: [first, second], seq: 2, head: running() })
    });
    await flush();

    assert.equal(fake.posted.length, 1, "exactly one leaves per boundary, not the whole queue");
    assert.equal(fake.posted[0]?.body.input, "one");
    assert.equal(state().slice.queue.length, 1);
    assert.equal(
      state().slice.queue[0]?.queuedAfterToolActivityId,
      second.id,
      "the remainder re-anchors to the new boundary"
    );
  });

  it("sends at turn end", async () => {
    const { api, fake, state } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, head: running() }) });
    api.getState().actions.queueMessage(draft("later"));
    await flush();
    assert.equal(fake.posted.length, 0);

    fake.push({ kind: "snapshot", thread: snapshot({ seq: 2, head: ready() }) });
    await flush();
    assert.equal(fake.posted.length, 1);
    assert.equal(state().slice.queue.length, 0);
  });

  it("never flushes while an approval is pending", async () => {
    const { api, fake } = await store();
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 1,
        head: ready(),
        pending: {
          approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(1) }],
          userInputs: []
        }
      })
    });
    api.getState().actions.queueMessage(draft("blocked"));
    await flush();
    assert.equal(fake.posted.length, 0);
  });

  it("does not re-drive a message held at the front after a failed send", async () => {
    const { api, fake, state } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, head: ready() }) });
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);
    api.getState().actions.queueMessage(draft("doomed"));
    await flush();
    assert.equal(state().slice.queue[0]?.holdUntilUserAction, true);

    const sent = fake.posted.length;
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 2, head: ready() }) });
    await flush();
    assert.equal(fake.posted.length, sent, "a held message waits for Send now");
  });
});

describe("Q2-4 — the layer-2 row memo is reachable", () => {
  /**
   * **Assert at layer 2, not layer 3.** V1 caught the first version of this
   * suite testing `state.rows` — the *stable* rows — which restores object
   * identity from its own `byId` map whether or not layer 2 ran, so it stayed
   * green with the memo permanently dead. The only observation that separates
   * the two is `rowsProjection.rows`: `deriveTimelineRows` allocates every row
   * object afresh, so identity there can only come from
   * `replaceStreamingMessageRows` taking its fast path.
   */
  const layer2 = (api: { getState(): AgentChatThreadState }): readonly unknown[] =>
    (api.getState() as unknown as { rowsProjection: { rows: readonly unknown[] } }).rowsProjection
      .rows;

  it("takes the fast path — layer-2 rows are reused, before layer 3 can restore them", async () => {
    const { fake, api } = await store();
    const user = message("user", "hi", { createdAt: stamp(1) });
    fake.push({ kind: "snapshot", thread: snapshot({ items: [user], seq: 1 }) });

    fake.push({
      kind: "event",
      seq: 2,
      event: ev(
        "thread.message-sent",
        { messageId: "a1", role: "assistant", text: "par", streaming: true, turnId: null },
        { seq: 2 }
      )
    });
    const before = layer2(api);

    fake.push({
      kind: "event",
      seq: 3,
      event: ev(
        "thread.message-sent",
        { messageId: "a1", role: "assistant", text: "tial", streaming: true, turnId: null },
        { seq: 3 }
      )
    });
    const after = layer2(api);

    assert.equal(
      after[0],
      before[0],
      "layer 2 reused the untouched row; a rebuild would have allocated a new object"
    );
    assert.notEqual(after[1], before[1], "and rebuilt exactly the row the token changed");
  });

  it("keeps untouched row objects across consecutive streamed tokens", async () => {
    const { fake, api } = await store();
    const user = message("user", "hi", { createdAt: stamp(1) });
    fake.push({ kind: "snapshot", thread: snapshot({ items: [user], seq: 1 }) });
    const first = api.getState().rows;

    fake.push({
      kind: "event",
      seq: 2,
      event: ev(
        "thread.message-sent",
        { messageId: "a1", role: "assistant", text: "par", streaming: true, turnId: null },
        { seq: 2 }
      )
    });
    const second = api.getState().rows;
    assert.equal(second[0], first[0]);

    // The real proof: a SECOND delta with no other state change must still
    // reuse the untouched row. Rebuilding the `Set`-valued row inputs on every
    // projection made `shallowEqualInput` permanently false and defeated this.
    fake.push({
      kind: "event",
      seq: 3,
      event: ev(
        "thread.message-sent",
        { messageId: "a1", role: "assistant", text: "tial", streaming: true, turnId: null },
        { seq: 3 }
      )
    });
    const third = api.getState().rows;
    assert.equal(third[0], second[0], "the user row survives a second token");
    assert.notEqual(third[1], second[1], "the streaming row is the one that changed");
  });
});

describe("R8-M2 — the composer goes inert while a revert runs", () => {
  it("sets and clears `reverting` around the command", async () => {
    const { api, state } = await store();
    assert.equal(state().reverting, false);
    const pending = api.getState().actions.revert({ targetTurnCount: 1 });
    assert.equal(state().reverting, true);
    await pending;
    assert.equal(state().reverting, false);
  });

  it("clears it when the revert is rejected", async () => {
    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "past turnCount"), 99);
    await assert.rejects(() => api.getState().actions.revert({ targetTurnCount: 99 }));
    assert.equal(state().reverting, false);
  });
});

describe("R8-B1 — the actionable plan proposal reaches the view", () => {
  it("is exposed, and retired by the turn that implements it", async () => {
    const { fake, api } = await store();
    const proposal = activity(
      "turn.proposed.completed",
      { planMarkdown: "# Ship it" },
      { createdAt: stamp(1) }
    );
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, items: [proposal] }) });
    assert.equal(api.getState().actionableProposedPlan?.planMarkdown, "# Ship it");

    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 2,
        items: [
          proposal,
          message("user", "PLEASE IMPLEMENT THIS PLAN:\n# Ship it", { createdAt: stamp(2) })
        ]
      })
    });
    assert.equal(api.getState().actionableProposedPlan, null);
  });
});

describe("Q2-7 — a snapshot invalidates the cached projections", () => {
  it("rebuilds rows from the replacing snapshot rather than merging", async () => {
    const { fake, api } = await store();
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 1,
        items: [message("user", "one", { createdAt: stamp(1) }), message("user", "two", { createdAt: stamp(2) })]
      })
    });
    assert.equal(api.getState().rows.filter((row) => row.kind === "message").length, 2);

    // A revert truncated the thread: the replacing snapshot has fewer rows.
    fake.push({
      kind: "snapshot",
      thread: snapshot({ seq: 9, items: [message("user", "one", { createdAt: stamp(1) })] })
    });
    assert.equal(api.getState().rows.filter((row) => row.kind === "message").length, 1);
  });
});

describe("R7-5 — a returned queued message gives its attachments back as chips", () => {
  /**
   * A mounted composer OWNS the draft: it loads the persisted one on mount and
   * writes its own back on every change. So parking a returned attachment
   * there while a composer is already mounted shows the user nothing until its
   * next mount — the user hits Stop, the message comes back, and the thing
   * they attached is simply not in the tray. Only what the composer refuses
   * may fall back, where the next mount finds it.
   */
  const attachment = (id: string): AttachmentRef => ({
    type: "file",
    id,
    name: `${id}.txt`,
    sizeBytes: 10
  });

  function mountComposer(sessionId: string, refuse: string[] = []): {
    staged: string[];
    inserted: string[];
    unregister: () => void;
  } {
    const staged: string[] = [];
    const inserted: string[] = [];
    const unregister = registerComposerHandle(sessionId, {
      insertText: (text) => inserted.push(text),
      stageAttachment: (ref) => {
        if (refuse.includes(ref.id)) {
          return false;
        }
        staged.push(ref.id);
        return true;
      },
      focusAtEnd: () => {},
      openControl: () => {}
    });
    return { staged, inserted, unregister };
  }

  it("stages every accepted attachment as a chip and leaves the draft alone", async () => {
    const { api, fake, state } = await store();
    const composer = mountComposer("s1");
    try {
      fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, head: running() }) });
      api.getState().actions.queueMessage({
        ...draft("with a file"),
        attachments: [attachment("a1"), attachment("a2")]
      });
      await flush();
      const queued = state().slice.queue[0]!;

      api.getState().actions.returnQueuedToComposer(queued.id);
      assert.deepEqual(composer.staged, ["a1", "a2"], "both went back as chips");
      assert.deepEqual(composer.inserted, ["with a file"], "and the text went to the composer");
      assert.deepEqual(state().draft.attachments, [], "nothing was parked in the fallback draft");
      assert.equal(state().draft.text, "", "the composer owns the visible draft");
    } finally {
      composer.unregister();
    }
  });

  it("falls back to the draft for exactly the attachments the composer refuses", async () => {
    const { api, fake, state } = await store();
    const composer = mountComposer("s1", ["a2"]);
    try {
      fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, head: running() }) });
      api.getState().actions.queueMessage({
        ...draft("over the budget"),
        attachments: [attachment("a1"), attachment("a2")]
      });
      await flush();
      const queued = state().slice.queue[0]!;

      api.getState().actions.returnQueuedToComposer(queued.id);
      assert.deepEqual(composer.staged, ["a1"]);
      assert.deepEqual(
        state().draft.attachments.map((ref) => ref.id),
        ["a2"],
        "a refused file is visible in the fallback, never dropped"
      );
    } finally {
      composer.unregister();
    }
  });

  it("puts everything in the fallback draft when no composer is mounted", async () => {
    const { api, fake, state } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, head: running() }) });
    api.getState().actions.queueMessage({
      ...draft("tab not open"),
      attachments: [attachment("a1")]
    });
    await flush();
    const queued = state().slice.queue[0]!;

    api.getState().actions.returnQueuedToComposer(queued.id);
    assert.equal(state().draft.text, "tab not open");
    assert.deepEqual(
      state().draft.attachments.map((ref) => ref.id),
      ["a1"]
    );
  });
});
