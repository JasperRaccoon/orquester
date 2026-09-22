/**
 * The §6.5/§7.2 retained-snapshot behaviour of the thread store.
 *
 * `store.test.ts` owns the slice's own rules; this file owns the *split*: a
 * value-only retained snapshot with a 5-minute idle TTL beside a live
 * subscription that is released as soon as its last consumer leaves.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { AgentChatStreamFrame } from "@orquester/api/agent-chat";

import {
  createThreadStore,
  resetThreadRetention,
  retainedThreadCount,
  THREAD_SNAPSHOT_IDLE_TTL_MS,
  type AgentChatThreadState,
  type ThreadStore
} from "./store";
import type { AgentChatStreamOptions, AgentChatTransport } from "./transport";
import { head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

type Destroyable = ThreadStore & { destroy?: (options?: { retain?: boolean }) => void };

function fakeTransport(): {
  transport: AgentChatTransport;
  push(frame: AgentChatStreamFrame): void;
  opened: AgentChatStreamOptions[];
  reads: number;
} {
  const opened: AgentChatStreamOptions[] = [];
  const counters = { reads: 0 };
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;

  const transport: AgentChatTransport = {
    stream(_sessionId, options, handlers) {
      opened.push(options);
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command() {
      return { seq: 1 };
    },
    async read() {
      counters.reads += 1;
      return { kind: "snapshot", thread: snapshot() };
    },
    async readItem() {
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
    }
  };

  return {
    transport,
    push: (frame) => onFrame?.(frame),
    opened,
    get reads() {
      return counters.reads;
    }
  };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

async function open(sessionId = "s1"): Promise<{
  store: Destroyable;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const store = createThreadStore(sessionId, {
    transport: fake.transport,
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    now: () => stamp(1),
    delay: async () => {}
  }) as Destroyable;
  await flush();
  return { store, fake, state: () => store.getState() };
}

/** Bring a thread to "synchronized with two rows at seq 5". */
function synchronize(fake: ReturnType<typeof fakeTransport>): void {
  fake.push({
    kind: "snapshot",
    thread: snapshot({
      head: head({ seq: 5 }),
      items: [
        message("user", "hello", { createdAt: stamp(1) }),
        message("assistant", "hi", { createdAt: stamp(2) })
      ],
      seq: 5
    })
  });
  fake.push({ kind: "synchronized", hostInstanceId: "host-1" });
}

beforeEach(() => {
  resetBuilders();
  resetThreadRetention();
});

afterEach(() => {
  resetThreadRetention();
});

describe("the retained thread snapshot", () => {
  it("paints the retained state on remount and resumes with after=<seq>", async () => {
    const first = await open();
    synchronize(first.fake);
    assert.equal(first.state().slice.connection, "synchronized");
    assert.equal(first.state().rows.filter((row) => row.kind === "message").length, 2);

    first.store.destroy?.();
    assert.equal(retainedThreadCount(), 1);

    const second = await open();
    // The very first paint — before any frame and before the stream even
    // opened — already carries the folded thread.
    assert.equal(
      second.state().rows.filter((row) => row.kind === "message").length,
      2,
      "the remount painted the retained rows"
    );
    assert.equal(second.state().slice.entries.length, 2);
    // Never "Connecting…" over a retained, synchronized thread.
    assert.equal(second.state().slice.connection, "synchronized");
    assert.equal(second.state().slice.seq, 5);
    // And the stream catches up on deltas instead of re-downloading the body.
    assert.deepEqual(second.fake.opened, [{ after: 5, hostInstanceId: "host-1" }]);
    assert.equal(second.fake.reads, 0, "no full snapshot was fetched");

    second.store.destroy?.();
  });

  it("applies the catch-up events the resumed stream replays", async () => {
    const first = await open();
    synchronize(first.fake);
    first.store.destroy?.();

    const second = await open();
    second.fake.push({
      kind: "snapshot",
      thread: snapshot({
        head: head({ seq: 6 }),
        items: [
          message("user", "hello", { createdAt: stamp(1) }),
          message("assistant", "hi", { createdAt: stamp(2) }),
          message("user", "more", { createdAt: stamp(3) })
        ],
        seq: 6
      })
    });
    assert.equal(second.state().slice.entries.length, 3);
    second.store.destroy?.();
  });

  it("does a full load once the idle TTL has elapsed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const first = await open();
      synchronize(first.fake);
      first.store.destroy?.();
      assert.equal(retainedThreadCount(), 1);

      mock.timers.tick(THREAD_SNAPSHOT_IDLE_TTL_MS + 1);
      assert.equal(retainedThreadCount(), 0, "the retained snapshot expired");

      const second = await open();
      assert.equal(second.state().rows.length, 0, "nothing retained, nothing painted");
      assert.equal(second.state().slice.connection, "idle");
      assert.deepEqual(second.fake.opened, [{}], "a cold stream asks for a snapshot");
      second.store.destroy?.({ retain: false });
    } finally {
      mock.timers.reset();
    }
  });

  it("refuses a write from a generation a newer store has replaced", async () => {
    const stale = await open();
    synchronize(stale.fake);

    // A second generation for the SAME thread claims the key while the first
    // is still alive — then the first tears down.
    const fresh = await open();
    stale.store.destroy?.();
    assert.equal(retainedThreadCount(), 0, "the stale generation could not write");

    fresh.store.destroy?.();
    assert.equal(retainedThreadCount(), 1, "the owning generation could");
  });

  it("drops an in-flight command's flags but keeps the queue and the view state", async () => {
    const first = await open();
    synchronize(first.fake);
    first.state().actions.setDisclosure({ expandedTurnIds: ["t1"] });
    first.state().actions.queueMessage({
      text: "later",
      attachments: [],
      context: [],
      interactionMode: first.state().slice.interactionMode,
      queuedAfterToolActivityId: null,
      holdUntilUserAction: true
    });
    first.store.destroy?.();

    const second = await open();
    assert.deepEqual(second.state().slice.disclosures.expandedTurnIds, ["t1"]);
    assert.equal(second.state().slice.queue.length, 1);
    assert.equal(second.state().reverting, false);
    assert.equal(second.state().stopping, false);
    second.store.destroy?.();
  });

  it("never paints a retained error banner", async () => {
    const first = await open();
    synchronize(first.fake);
    // Reach past the actions: the banner is set by a failed command, and this
    // test is about what a REMOUNT shows, not about how it got there.
    first.state().actions.dismissErrorBanner();
    first.store.destroy?.();

    const second = await open();
    assert.equal(second.state().slice.errorBanner, null);
    second.store.destroy?.();
  });
});
