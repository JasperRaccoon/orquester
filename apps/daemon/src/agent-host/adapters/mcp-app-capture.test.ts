/**
 * MCP Apps' shared capture (spec 2026-10-14 §3): the frame hold that keeps a
 * captured call's row in its place, and the read → prepare → store step.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MCP_APP_MAX_HTML_BYTES } from "@orquester/api/agent-chat";

import {
  captureMcpApp,
  McpAppFrameHold,
  McpAppSessionCache,
  McpAppSnapshotStore,
  type McpAppCaptureInput
} from "./mcp-app-capture.ts";

const STORED_ID = "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("McpAppFrameHold", () => {
  it("frames wait behind a capture and replay in arrival order after its completion", async () => {
    const hold = new McpAppFrameHold();
    const log: string[] = [];
    const capture = deferred<string>();
    hold.hold(
      () => capture.promise,
      (value) => log.push(`completion:${value}`)
    );
    for (const name of ["a", "b"]) {
      assert.equal(
        hold.offer(() => log.push(name)),
        true
      );
    }
    assert.equal(hold.canCapture, false);
    capture.resolve("app");
    await tick();
    assert.deepEqual(log, ["completion:app", "a", "b"]);
    assert.equal(hold.offer(() => log.push("c")), false, "nothing waits once released");
  });

  it("a replayed frame that starts a capture keeps the rest waiting, still ahead of later frames", async () => {
    const hold = new McpAppFrameHold();
    const log: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    hold.hold(
      () => first.promise,
      () => log.push("first")
    );
    hold.offer(() => {
      log.push("second-call");
      hold.hold(
        () => second.promise,
        () => log.push("second")
      );
    });
    hold.offer(() => log.push("x"));
    first.resolve("1");
    await tick();
    assert.deepEqual(log, ["first", "second-call"]);
    hold.offer(() => log.push("y"));
    second.resolve("2");
    await tick();
    assert.deepEqual(log, ["first", "second-call", "second", "x", "y"]);
  });

  it("a failed capture completes without a value; close lets go at once and refuses new holds", async () => {
    const hold = new McpAppFrameHold();
    const values: Array<string | undefined> = [];
    hold.hold<string>(
      () => Promise.reject(new Error("read failed")),
      (value) => values.push(value)
    );
    await tick();
    // Not `deepEqual`: its assertion signature would narrow `values` to `undefined[]`.
    assert.equal(values.length, 1);
    assert.equal(values[0], undefined);

    const hang = deferred<string>();
    let signal: AbortSignal | undefined;
    hold.hold<string>(
      (abort) => {
        signal = abort;
        return hang.promise;
      },
      (value) => values.push(value ?? "plain")
    );
    const replayed: string[] = [];
    hold.offer(() => replayed.push("held"));
    hold.close();
    assert.deepEqual(values, [undefined, "plain"], "synchronously, before the teardown's own rows");
    assert.deepEqual(replayed, ["held"]);
    assert.equal(signal?.aborted, true);
    assert.equal(hold.canCapture, false);
    hang.resolve("late");
    await tick();
    assert.deepEqual(values, [undefined, "plain"], "a late value is ignored");
  });

  it("a server request waits too, and answers once replayed", async () => {
    const hold = new McpAppFrameHold();
    const capture = deferred<string>();
    hold.hold(
      () => capture.promise,
      () => undefined
    );
    let answered = false;
    const answer = hold.offerAsync(async () => {
      answered = true;
      return 42;
    });
    await tick();
    assert.equal(answered, false);
    capture.resolve("x");
    assert.equal(await answer, 42);
  });

  it("a replay that throws is reported and never stops the others", async () => {
    const errors: unknown[] = [];
    const hold = new McpAppFrameHold((error) => errors.push(error));
    const capture = deferred<string>();
    const log: string[] = [];
    hold.hold(
      () => capture.promise,
      () => log.push("done")
    );
    hold.offer(() => {
      throw new Error("bad frame");
    });
    hold.offer(() => log.push("after"));
    capture.resolve("x");
    await tick();
    assert.deepEqual(log, ["done", "after"]);
    assert.equal(errors.length, 1);
  });
});

describe("captureMcpApp", () => {
  const input = (overrides: Partial<McpAppCaptureInput> = {}): McpAppCaptureInput => {
    const warnings: string[] = [];
    return {
      context: {
        storeAttachment: async () => STORED_ID,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (message) => warnings.push(message),
          error: () => undefined
        }
      },
      threadId: "thread-1",
      server: "apps",
      tool: "show_widget",
      resourceUri: "ui://apps/widget.html",
      read: async () => [{ uri: "ui://apps/widget.html", mimeType: "text/html;profile=mcp-app", text: "<h1>x</h1>" }],
      signal: new AbortController().signal,
      ...overrides
    };
  };

  it("stores the prepared document and answers the reference", async () => {
    let stored = "";
    const reference = await captureMcpApp(
      input({
        context: {
          storeAttachment: async (_threadId, file) => {
            stored = file.bytes;
            return STORED_ID;
          },
          logger: { debug() {}, info() {}, warn() {}, error() {} }
        }
      })
    );
    assert.deepEqual(reference, {
      attachmentId: STORED_ID,
      server: "apps",
      tool: "show_widget",
      resourceUri: "ui://apps/widget.html"
    });
    assert.match(stored, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  });

  it("answers nothing for a read that fails or times out, a non-app or oversized document, a failed store, no store", async () => {
    assert.equal(await captureMcpApp(input({ read: async () => Promise.reject(new Error("down")) })), undefined);
    assert.equal(await captureMcpApp(input({ read: () => new Promise(() => undefined), timeoutMs: 5 })), undefined);
    assert.equal(await captureMcpApp(input({ read: async () => [{ mimeType: "text/html", text: "<p>" }] })), undefined);
    assert.equal(
      await captureMcpApp(
        input({ read: async () => [{ mimeType: "text/html;profile=mcp-app", text: "x".repeat(MCP_APP_MAX_HTML_BYTES + 1) }] })
      ),
      undefined
    );
    const failing = input();
    assert.equal(
      await captureMcpApp({
        ...failing,
        context: { ...failing.context, storeAttachment: async () => Promise.reject(new Error("disk full")) }
      }),
      undefined
    );
    assert.equal(await captureMcpApp({ ...failing, context: { logger: failing.context.logger } }), undefined);
    // A store that answers an id of another shape is never framed.
    assert.equal(
      await captureMcpApp({ ...failing, context: { ...failing.context, storeAttachment: async () => "thread_1-x.txt" } }),
      undefined
    );
  });

  it("stores nothing once the session closed during the read", async () => {
    const controller = new AbortController();
    let stores = 0;
    const read = deferred<unknown>();
    const capture = captureMcpApp(
      input({
        signal: controller.signal,
        read: () => read.promise,
        context: {
          storeAttachment: async () => {
            stores += 1;
            return STORED_ID;
          },
          logger: { debug() {}, info() {}, warn() {}, error() {} }
        }
      })
    );
    controller.abort();
    read.resolve([{ mimeType: "text/html;profile=mcp-app", text: "<h1>x</h1>" }]);
    assert.equal(await capture, undefined);
    assert.equal(stores, 0);
  });
});

describe("McpAppSnapshotStore", () => {
  it("stores an unchanged document once per thread + server + URI, while the thread still has it", async () => {
    const snapshots = new McpAppSnapshotStore();
    const stored: string[] = [];
    const live = new Set<string>();
    let next = 0;
    const context = {
      storeAttachment: async (threadId: string) => {
        const id = `${threadId}-snap-${++next}`;
        stored.push(id);
        live.add(id);
        return id;
      },
      resolveAttachmentPath: async (_threadId: string, id: string) => {
        if (!live.has(id)) throw new Error("gone");
        return `/a/${id}`;
      }
    };
    const input = { threadId: "t1", server: "apps", resourceUri: "ui://apps/w", name: "w.html", html: "<h1>a</h1>" };
    const first = await snapshots.store(context, input);
    assert.equal(await snapshots.store(context, input), first, "same bytes: the same attachment");
    assert.notEqual(await snapshots.store(context, { ...input, html: "<h1>b</h1>" }), first, "changed bytes: a new one");
    assert.notEqual(await snapshots.store(context, { ...input, threadId: "t2" }), first, "another thread: its own");
    assert.notEqual(await snapshots.store(context, { ...input, server: "other" }), first, "another server: its own");
    live.delete(first);
    const again = await snapshots.store(context, input);
    assert.notEqual(again, first, "a swept snapshot is stored afresh");
    assert.equal(await snapshots.store(context, input), again);
    assert.equal(stored.length, 5);
  });

  it("capture goes through it when given one", async () => {
    const snapshots = new McpAppSnapshotStore();
    let stores = 0;
    const base: McpAppCaptureInput = {
      context: {
        storeAttachment: async () => {
          stores += 1;
          return STORED_ID;
        },
        resolveAttachmentPath: async () => "/a",
        logger: { debug() {}, info() {}, warn() {}, error() {} }
      },
      snapshots,
      threadId: "t1",
      server: "apps",
      tool: "w",
      resourceUri: "ui://apps/w",
      read: async () => [{ mimeType: "text/html;profile=mcp-app", text: "<h1>x</h1>" }],
      signal: new AbortController().signal
    };
    assert.equal((await captureMcpApp(base))?.attachmentId, STORED_ID);
    assert.equal((await captureMcpApp(base))?.attachmentId, STORED_ID);
    assert.equal(stores, 1);
  });
});

describe("McpAppSessionCache", () => {
  it("answers within its time-to-live, forgets after it or on clear, and stays bounded", () => {
    let now = 0;
    const cache = new McpAppSessionCache<string>(100, () => now, 2);
    cache.set("a", "1");
    now = 99;
    assert.equal(cache.get("a"), "1");
    now = 100;
    assert.equal(cache.get("a"), undefined);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    assert.equal(cache.get("a"), undefined, "the oldest went past the bound");
    assert.equal(cache.get("c"), "3");
    cache.clear();
    assert.equal(cache.get("c"), undefined);
  });
});
