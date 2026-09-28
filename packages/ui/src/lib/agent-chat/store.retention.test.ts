
import { isolatedPage } from "./testing/isolated-page";
let page: Awaited<ReturnType<typeof isolatedPage>>;
async function loadPage(): Promise<void> {
  await page?.dispose();
  page = await isolatedPage();
  ({ createThreadStore } = page.store);
  ({ AgentChatCommandError } = page.transport);
}
beforeEach(loadPage);
afterEach(async () => { await page.dispose(); });
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

import type { AgentChatThreadState, ThreadStore } from "./store";
let createThreadStore: typeof import("./store")["createThreadStore"];
import type { AgentChatStreamOptions, AgentChatTransport } from "./transport";
let AgentChatCommandError: typeof import("./transport")["AgentChatCommandError"];
import { head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

type Destroyable = ThreadStore & { destroy?: () => void };

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
    // §3.4's account switch rides its own daemon-owned route.
    async switchAccount() {
      return { seq: 0 };
    },
    async read() {
      counters.reads += 1;
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
    transport: fake.transport
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
});

describe("the retained thread snapshot", () => {
  it("paints the retained state on remount and resumes with after=<seq>", async () => {
    const first = await open();
    synchronize(first.fake);
    assert.equal(first.state().slice.connection, "synchronized");
    assert.deepEqual(first.state().rows.flatMap((row) => row.kind === "message" ? [row.message.text] : []), ["hello", "hi"]);

    first.store.destroy?.();

    const second = await open();
    // The very first paint — before any frame and before the stream even
    // opened — already carries the folded thread.
    assert.deepEqual(
      second.state().rows.flatMap((row) => row.kind === "message" ? [row.message.text] : []),
      ["hello", "hi"]
    );
    // Never "Connecting…" over a retained, synchronized thread.
    assert.equal(second.state().slice.connection, "synchronized");
    assert.equal(second.state().slice.seq, 5);
    // And the stream catches up on deltas instead of re-downloading the body.
    assert.deepEqual(second.fake.opened, [{ after: 5, hostInstanceId: "host-1" }]);
    assert.equal(second.fake.reads, 0, "no full snapshot was fetched");

    second.store.destroy?.();
  });

  it("does a full load once the idle TTL has elapsed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const first = await open();
      synchronize(first.fake);
      first.store.destroy?.();
      mock.timers.tick(300_001);

      const second = await open();
      assert.equal(second.state().rows.length, 0, "nothing retained, nothing painted");
      assert.equal(second.state().slice.connection, "idle");
      assert.deepEqual(second.fake.opened, [{}], "a cold stream asks for a snapshot");
      second.store.destroy?.();
    } finally {
      mock.timers.reset();
    }
  });

  it("refuses a write from a generation a newer store has replaced", async () => {
    const stale = await open();
    synchronize(stale.fake);

    const fresh = await open();
    fresh.fake.push({
      kind: "snapshot",
      thread: snapshot({ items: [message("user", "newer generation")], seq: 9 })
    });
    fresh.fake.push({ kind: "synchronized", hostInstanceId: "host-1" });
    fresh.store.destroy?.();
    stale.store.destroy?.();
    const remounted = await open();
    assert.deepEqual(
      remounted.state().rows.flatMap((row) => row.kind === "message" ? [row.message.text] : []),
      ["newer generation"]
    );
    assert.deepEqual(remounted.fake.opened, [{ after: 9, hostInstanceId: "host-1" }]);
    remounted.store.destroy?.();
  });

  it("keeps the held queue and disclosure state on remount", async () => {
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
    assert.deepEqual(second.state().slice.queue.map((message) => [message.text, message.holdUntilUserAction]), [["later", true]]);
    second.store.destroy?.();
  });

  it("never paints a retained error banner", async () => {
    const first = await open();
    synchronize(first.fake);
    first.fake.transport.command = async () => {
      throw new AgentChatCommandError(409, "COMMAND_REJECTED", "old generation failed");
    };
    await assert.rejects(first.state().actions.compact());
    assert.equal(first.state().slice.errorBanner, "old generation failed");
    first.store.destroy?.();

    const second = await open();
    assert.equal(second.state().slice.errorBanner, null);
    second.store.destroy?.();
  });
});
