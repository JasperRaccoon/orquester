/**
 * A search hit's reveal (design 2026-09-23 "Client": "a hit opens the tab
 * and reveals the turn"). The palette is not the chat view, so it must drive
 * the SAME registry slice the tab mounts — and let go of it once done, or a
 * thread nobody looks at keeps its stream open forever.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { AgentChatStreamFrame } from "@orquester/api/agent-chat";

import {
  peekThreadStore,
  resetThreadStores,
  THREAD_STORE_DISPOSE_GRACE_MS
} from "../../lib/agent-chat/store";
import type { AgentChatTransport } from "../../lib/agent-chat/transport";
import { foldTurn, message, snapshot, stamp } from "../../lib/agent-chat/test-helpers";
import { revealConversationTurn } from "./reveal-turn";

function fakeTransport() {
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command() {
      return { seq: 1 };
    },
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
  return { transport, push: (frame: AgentChatStreamFrame) => onFrame?.(frame) };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  mock.timers.reset();
  resetThreadStores();
});

describe("revealConversationTurn", () => {
  it("reveals on the thread's registry slice, then lets go of it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeTransport();

    const revealing = revealConversationTurn(fake.transport, "s1", "t2");
    await settle();
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        items: [
          message("user", "second", { id: "u2", createdAt: stamp(20) }),
          message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(21) })
        ],
        turns: [foldTurn("t1", "u1"), foldTurn("t2", "u2")],
        seq: 3
      })
    });
    fake.push({ kind: "synchronized", hostInstanceId: "h1" });

    assert.equal(await revealing, true);
    assert.equal(
      peekThreadStore("s1")?.getState().reveal?.rowId,
      "u2",
      "the slice the tab's view mounts is the one holding the request"
    );

    mock.timers.tick(THREAD_STORE_DISPOSE_GRACE_MS + 1);
    assert.equal(peekThreadStore("s1"), null, "released: nothing keeps an unwatched stream open");
  });
});
