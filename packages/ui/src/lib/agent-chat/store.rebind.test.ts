import { isolatedPage } from "./testing/isolated-page";
let page: Awaited<ReturnType<typeof isolatedPage>>;
beforeEach(async () => {
  await page?.dispose();
  page = await isolatedPage();
});
afterEach(async () => {
  await page.dispose();
});
/**
 * A thread store follows the client's transport (auth review C): a sign-in after a revocation
 * rebuilds the API client with the new token, and an open chat tab's slice must move onto it —
 * its stream reopened from where it got to, its commands sent with the new bearer — instead of
 * retrying the revoked token forever.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentChatStreamOptions, AgentChatTransport } from "./transport";

interface FakeStream {
  options: AgentChatStreamOptions;
  closed: boolean;
}

function fakeTransport(name: string, cursor: { lastSeq: number; hostInstanceId: string | null }) {
  const streams: FakeStream[] = [];
  const uploads: string[] = [];
  const transport = {
    stream(_sessionId: string, options: AgentChatStreamOptions) {
      const entry: FakeStream = { options, closed: false };
      streams.push(entry);
      return {
        get lastSeq() {
          return cursor.lastSeq;
        },
        get hostInstanceId() {
          return cursor.hostInstanceId;
        },
        resetCursor: () => {},
        retry: () => {},
        close: () => {
          entry.closed = true;
        }
      };
    },
    async upload() {
      uploads.push(name);
      return { type: "file", id: "/a/b", name: "b", sizeBytes: 1 };
    }
  } as unknown as AgentChatTransport;
  return { transport, streams, uploads };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe("a thread store and its transport", () => {
  it("moves an open slice onto a new transport: the stream resumes there, commands go there", async () => {
    const cursor = { lastSeq: 0, hostInstanceId: null as string | null };
    const before = fakeTransport("old", cursor);
    const after = fakeTransport("new", cursor);
    const { retainThreadStore, ensureThreadStore } = page.store;

    const store = retainThreadStore("A", { transport: before.transport });
    await flush();
    assert.equal(before.streams.length, 1);
    cursor.lastSeq = 7;
    cursor.hostInstanceId = "h1";

    ensureThreadStore("A", { transport: after.transport });
    assert.equal(before.streams[0]!.closed, true, "the stream on the revoked token is closed");
    assert.equal(after.streams.length, 1);
    assert.deepEqual(after.streams[0]!.options, { after: 7, hostInstanceId: "h1" }, "resumed by cursor");

    await store.getState().actions.uploadAttachment(new Blob(["x"]) as File, { name: "b" } as never);
    assert.deepEqual([...before.uploads, ...after.uploads], ["new"]);

    // The same transport again (a re-render) changes nothing.
    ensureThreadStore("A", { transport: after.transport });
    assert.equal(after.streams.length, 1);
    assert.equal(after.streams[0]!.closed, false);
  });

  it("a slice whose stream has not opened yet opens it on the new transport", async () => {
    const cursor = { lastSeq: 0, hostInstanceId: null };
    const before = fakeTransport("old", cursor);
    const after = fakeTransport("new", cursor);
    const { ensureThreadStore } = page.store;
    ensureThreadStore("B", { transport: before.transport });
    ensureThreadStore("B", { transport: after.transport });
    await flush();
    assert.equal(before.streams.length, 0);
    assert.equal(after.streams.length, 1);
    assert.deepEqual(after.streams[0]!.options, {});
  });
});
