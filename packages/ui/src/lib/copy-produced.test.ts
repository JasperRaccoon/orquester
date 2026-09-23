import test from "node:test";
import assert from "node:assert/strict";

import { copyProduced, type CopyClipboard } from "./copy-produced.ts";

/** A stand-in for `ClipboardItem`: keeps the data it was built with. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

/**
 * A stand-in for `navigator.clipboard`. Each call is logged the moment it is
 * made. `write` copies only once every item's data has resolved, and a data
 * promise that rejects fails the whole write with nothing copied, as the
 * Async Clipboard API does.
 */
function fakeClipboard(options: { write?: boolean } = {}) {
  const log = { writeTextCalls: [] as string[], writeCalls: 0, types: [] as string[], copied: [] as string[] };
  const clipboard: CopyClipboard<FakeClipboardItem> = {
    writeText: async (text) => {
      log.writeTextCalls.push(text);
      log.copied.push(text);
    }
  };
  if (options.write !== false) {
    clipboard.write = async (items) => {
      log.writeCalls += 1;
      const texts: string[] = [];
      for (const item of items) {
        for (const [type, data] of Object.entries(item.data)) {
          const blob = await data;
          log.types.push(`${type} ${blob.type}`);
          texts.push(await blob.text());
        }
      }
      log.copied.push(...texts);
    };
  }
  return { clipboard, log };
}

/** A read still in flight: the whole plan being fetched back. */
function pendingRead(): {
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("a string is written with writeText at once, inside the click", async () => {
  const { clipboard, log } = fakeClipboard();
  const copying = copyProduced("fix the tests", clipboard, FakeClipboardItem);
  // Checked before anything is awaited: the write began within the call.
  assert.deepEqual(log.writeTextCalls, ["fix the tests"]);
  assert.equal(log.writeCalls, 0, "a string never needs a ClipboardItem");
  await copying;
  assert.deepEqual(log.copied, ["fix the tests"]);
});

test("a text still being read starts write() inside the click, and copies it once read", async () => {
  // WebKit refuses a clipboard write that begins after an await, so the write
  // must begin within the call and wait for the text inside it.
  const { clipboard, log } = fakeClipboard();
  const read = pendingRead();
  const copying = copyProduced(read.promise, clipboard, FakeClipboardItem);
  assert.equal(log.writeCalls, 1, "write() began within the call, before any await");
  assert.deepEqual(log.copied, [], "nothing is copied before the text exists");
  read.resolve("# Ship it\n\nevery step");
  await copying;
  assert.deepEqual(log.copied, ["# Ship it\n\nevery step"]);
  assert.deepEqual(log.types, ["text/plain text/plain"]);
  assert.deepEqual(log.writeTextCalls, [], "writeText is not the path when write() exists");
});

test("without ClipboardItem, or without write(), a text being read falls back to writeText once read", async () => {
  for (const [label, withWrite, Ctor] of [
    ["no ClipboardItem", true, undefined],
    ["no write()", false, FakeClipboardItem]
  ] as const) {
    const { clipboard, log } = fakeClipboard({ write: withWrite });
    const read = pendingRead();
    const copying = copyProduced(read.promise, clipboard, Ctor);
    assert.deepEqual(log.writeTextCalls, [], `${label}: there is no text to write yet`);
    read.resolve("# Ship it");
    await copying;
    assert.deepEqual(log.writeTextCalls, ["# Ship it"], `${label}: written after the await`);
    assert.equal(log.writeCalls, 0, label);
  }
});

test("a read that fails copies nothing down either path, and never the cut text", async () => {
  for (const Ctor of [FakeClipboardItem, undefined]) {
    const { clipboard, log } = fakeClipboard();
    const failed = Promise.reject(new Error("The full plan could not be loaded."));
    await assert.rejects(copyProduced(failed, clipboard, Ctor), /could not be loaded/);
    assert.deepEqual(log.copied, [], "nothing reached the clipboard");
    assert.deepEqual(log.writeTextCalls, []);
  }
});

test("a write refused without reading its item leaves nothing unhandled when the read fails too", async () => {
  // Chromium refuses write() on an unfocused document at once, and never
  // reads the item it was handed. Nothing then listens to the Blob promise in
  // that item, so a read that fails as well would reject it unobserved.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const built: FakeClipboardItem[] = [];
    class RecordedClipboardItem extends FakeClipboardItem {
      constructor(data: Record<string, Promise<Blob>>) {
        super(data);
        built.push(this);
      }
    }
    const clipboard: CopyClipboard<FakeClipboardItem> = {
      writeText: async () => undefined,
      write: () => Promise.reject(new Error("Document is not focused."))
    };
    const read = pendingRead();
    await assert.rejects(copyProduced(read.promise, clipboard, RecordedClipboardItem), /not focused/);
    read.reject(new Error("The full plan could not be loaded."));
    await assert.rejects(read.promise, /could not be loaded/);
    // Node reports an unhandled rejection only once the microtask queue has
    // drained, so awaiting the promises alone would check too early and pass
    // even with the bug. One turn of the loop, not a duration: by then any
    // rejection left unhandled has been reported.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "no rejection was left unhandled");
    // The promise handed to the item still rejects, for an engine that reads
    // it. Read only after the check, because reading it marks it handled.
    assert.equal(built.length, 1);
    await assert.rejects(built[0]!.data["text/plain"]!, /could not be loaded/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("with no async clipboard at all (an insecure origin) nothing is copied, and a failing read is still observed", async () => {
  await assert.rejects(copyProduced("fix the tests", undefined, FakeClipboardItem));
  // Left unobserved, this read's failure would be an unhandled rejection.
  const failed = Promise.reject(new Error("The full plan could not be loaded."));
  await assert.rejects(copyProduced(failed, undefined, FakeClipboardItem), /could not be loaded/);
});
