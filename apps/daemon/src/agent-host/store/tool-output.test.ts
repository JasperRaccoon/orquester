/**
 * A tool call's streamed output, joined from the log (`GET …/items/:itemId/output`): the pure join over a log's
 * events, then the real pipeline — ingestion's `tool.output` rows, appended by the real store, read back by it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  commandOutputText,
  type DomainEvent,
  type ThreadActivityItem
} from "@orquester/api/agent-chat";
import { parseAgentDomainEvent } from "@orquester/config";

import { createIngestion } from "../ingestion/index.ts";
import { FakeClock, RecordingLiveness, counterIdGen, runtimeEvent } from "../ingestion/test-harness.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "./index.ts";
import { createToolOutputCache } from "./tool-output-cache.ts";
import { ToolOutputJoin, joinToolOutput, toolOutputWindow } from "./tool-output.ts";

let seq = 0;
/** One logged event, as the store decodes it back. */
function logged(type: "thread.activity-appended", payload: { activity: ThreadActivityItem }): DomainEvent;
function logged(type: "thread.message-sent", payload: { messageId: string; role: "assistant"; text: string; streaming: boolean; turnId: string | null }): DomainEvent;
function logged(type: string, payload: unknown): DomainEvent {
  seq += 1;
  return { seq, eventId: `ev-${seq}`, threadId: "t1", type, payload, occurredAt: "2026-09-23T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {} } as unknown as DomainEvent;
}

/** A row of the call `toolUseId`, as ingestion writes it. */
function row(id: string, activityKind: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}): DomainEvent {
  return logged("thread.activity-appended", {
    activity: {
      kind: "activity", id, tone: "tool", activityKind, summary: activityKind,
      payload: { ...(toolUseId === undefined ? {} : { toolUseId }), ...extra },
      turnId: "turn-1", createdAt: "2026-09-23T10:00:00.000Z", updatedAt: "2026-09-23T10:00:00.000Z"
    }
  });
}
const chunk = (id: string, toolUseId: string, delta: unknown): DomainEvent => row(id, "tool.output", toolUseId, { streamKind: "command_output", delta });

test("a call that streamed nothing answers an empty output; an item naming no call, a message and an unknown id answer null", () => {
  const events = [
    row("start", "tool.started", "call-1", { itemType: "command_execution" }),
    chunk("empty", "call-1", ""),
    chunk("odd", "call-1", 42),
    row("done", "tool.completed", "call-1", { itemType: "command_execution" }),
    row("warn", "runtime.warning", undefined, { message: "careful" }),
    row("blank", "tool.completed", "", { itemType: "command_execution" }),
    logged("thread.message-sent", { messageId: "assistant:1", role: "assistant", text: "hi", streaming: false, turnId: "turn-1" })
  ];
  assert.deepEqual(joinToolOutput(events, "done"), { toolUseId: "call-1", output: "", complete: true, truncated: false });
  for (const id of ["warn", "blank", "assistant:1", "never-written"]) assert.equal(joinToolOutput(events, id), null, id);
});

test("the item's newest write names the call, as readItem reads it", () => {
  const events = [row("same", "tool.started", "old-call"), chunk("o1", "old-call", "old\n"), chunk("o2", "new-call", "new\n"), row("same", "tool.updated", "new-call")];
  assert.equal(joinToolOutput(events, "same")!.output, "new\n");
});

test("the cap cuts the join in-band, on a character boundary, and the completion after the cut is still reported", () => {
  const prefix = "a".repeat(8 * 1024 * 1024 - 2);
  const events = [chunk("o1", "call-1", prefix), chunk("o2", "call-1", "語tail"), row("done", "tool.completed", "call-1")];
  assert.deepEqual(joinToolOutput(events, "done"), { toolUseId: "call-1", output: prefix, complete: true, truncated: true });
});

test("a lone high surrogate at the join's end reads as U+FFFD, and becomes the 4-byte pair when its low half arrives", () => {
  const join = new ToolOutputJoin("call-1");
  join.push(chunk("o1", "call-1", "a\ud83d"));
  // As Buffer.from(join) reads it at this moment: "a" + U+FFFD.
  assert.deepEqual(join.window({ offset: 0, maxBytes: 10 }), { toolUseId: "call-1", offset: 0, text: "a�", totalBytes: 4, complete: false, truncated: false });
  join.push(chunk("o2", "call-1", "\ude00b"));
  assert.deepEqual(join.window({}), { toolUseId: "call-1", offset: 0, text: "a😀b", totalBytes: 6, complete: false, truncated: false });
  // A lone low surrogate, and a high one another high one follows, stay U+FFFD for good.
  join.push(chunk("o3", "call-1", "\ude00\ud83d\ud83d"));
  join.push(chunk("o4", "call-1", "c"));
  assert.equal(join.window({}).text, "a😀b���c");
});

test("toolOutputWindow windows a whole join: the default and widest sizes, the end, and the flags", () => {
  const joined = { toolUseId: "bgshell:task-1", output: "one\n  two\n", complete: false, truncated: true };
  assert.deepEqual(toolOutputWindow(joined, { offset: 0, maxBytes: 4 }), { toolUseId: "bgshell:task-1", offset: 0, text: "one\n", totalBytes: 10, nextOffset: 4, complete: false, truncated: true });
  assert.deepEqual(toolOutputWindow(joined, { offset: 4, maxBytes: 4 }), { toolUseId: "bgshell:task-1", offset: 4, text: "  tw", totalBytes: 10, nextOffset: 8, complete: false, truncated: true });
  // No query at all: from 0, the default size — here the whole join, so no nextOffset.
  assert.deepEqual(toolOutputWindow(joined, {}), { toolUseId: "bgshell:task-1", offset: 0, text: "one\n  two\n", totalBytes: 10, complete: false, truncated: true });
  // Past the end: at the end, empty, no nextOffset.
  assert.deepEqual(toolOutputWindow(joined, { offset: 99 }), { toolUseId: "bgshell:task-1", offset: 10, text: "", totalBytes: 10, complete: false, truncated: true });
  // maxBytes below 1 is one character; above the widest window it is the widest window.
  assert.equal(toolOutputWindow(joined, { maxBytes: 0 }).text, "o");
  const wide = { ...joined, output: "x".repeat(1_048_576 + 10) };
  assert.equal(toolOutputWindow(wide, { maxBytes: 10 * 1_048_576 }).nextOffset, 1_048_576);
  assert.equal(toolOutputWindow(wide, {}).nextOffset, 65_536);
  // Numbers no query string carries: an unbounded size is the widest, NaN the default, and any offset reads as bytes.
  assert.equal(toolOutputWindow(wide, { maxBytes: Number.POSITIVE_INFINITY }).nextOffset, 1_048_576);
  assert.equal(toolOutputWindow(wide, { maxBytes: Number.NaN }).nextOffset, 65_536);
  assert.deepEqual([toolOutputWindow(joined, { offset: Number.NaN, maxBytes: 3 }).offset, toolOutputWindow(joined, { offset: -5, maxBytes: 3 }).offset, toolOutputWindow(joined, { offset: 1e21 }).offset, toolOutputWindow(joined, { offset: 2.7, maxBytes: 1 }).text], [0, 0, 10, "e"]);
});

// --- the real pipeline -------------------------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orq-tool-output-"));
}

function created(threadId: string): AppendableDomainEvent {
  return {
    eventId: "e-created", threadId, type: "thread.created",
    payload: { projectPath: "/w/p", cwd: "/w/p", title: "New thread", adapter: "claude", refId: "claude", accountId: "acc-1", home: "account", modelSelection: { model: "sonnet" }, runtimeMode: "approval-required" },
    occurredAt: "2026-09-23T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {}
  } as AppendableDomainEvent;
}

test("a background shell's output, as ingestion writes it, is joined back whole by the store — its completion holds none", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = createThreadStore({ rootDir });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [created("t1")] });
  const clock = new FakeClock();
  // The real ingestion, its real slimming, appending through the real store.
  const ingestion = createIngestion({
    sink: async (threadId, events) => { await store.append({ threadId, events }); },
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen()
  });
  // The shell's rows as the Claude normaliser builds them (`openBackgroundShellItem`, `backgroundShellOutput`,
  // `closeBackgroundShellItem`): its own item id, stamped with the task as its agent.
  const itemId = "bgshell:task-1";
  const shell = { threadId: "t1", turnId: "turn-1", itemId, agentId: "task-1" };
  const data = { toolName: "Bash", input: { command: "make -j8", description: "Build" }, background: true };
  await ingestion.ingest(runtimeEvent("item.started", { itemType: "command_execution", status: "inProgress", title: "Background shell", agentId: "task-1", data }, { ...shell, eventId: "shell-start" }));
  const chunks = ["make: entering\n", "  [ 50%] cc a.o\n", "\n  [100%] linked\n"];
  for (const delta of chunks) {
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta }, shell));
    // Another call streams in between: its output never joins the shell's.
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: "noise\n" }, { threadId: "t1", turnId: "turn-1", itemId: "call-2" }));
    await ingestion.drain();
  }
  await ingestion.ingest(runtimeEvent("item.completed", { itemType: "command_execution", status: "completed", title: "Background shell", agentId: "task-1", data: { ...data, exitCode: 0 } }, { ...shell, eventId: "shell-done" }));
  await ingestion.drain();
  await store.drain();

  // The completion is stored whole, and still holds no output: the chunks are the only copy of it.
  const completion = await store.readItem("t1", "shell-done");
  assert.ok(completion?.kind === "activity");
  assert.equal(commandOutputText((completion.payload as { data?: unknown }).data), undefined);

  const whole = { toolUseId: itemId, output: chunks.join(""), complete: true, truncated: false };
  assert.deepEqual(await store.readToolOutput("t1", "shell-done"), whole);
  assert.deepEqual(await store.readToolOutput("t1", "shell-start"), whole);
  assert.equal(await store.readToolOutput("t1", "never-written"), null);
});

// --- the store's cache: windows from the log's tail ----------------------------------------------------------------

let appendedCount = 0;
/** A row of the call `toolUseId`, as ingestion hands it to the store. */
function appendable(threadId: string, id: string, activityKind: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}): AppendableDomainEvent {
  appendedCount += 1;
  return {
    eventId: `e-${appendedCount}`, threadId, type: "thread.activity-appended",
    payload: {
      activity: {
        kind: "activity", id, tone: "tool", activityKind, summary: activityKind,
        payload: { ...(toolUseId === undefined ? {} : { toolUseId }), ...extra },
        turnId: "turn-1", createdAt: "2026-09-23T10:00:00.000Z", updatedAt: "2026-09-23T10:00:00.000Z"
      }
    },
    occurredAt: "2026-09-23T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {}
  } as AppendableDomainEvent;
}
const streamed = (threadId: string, id: string, toolUseId: string, delta: string): AppendableDomainEvent =>
  appendable(threadId, id, "tool.output", toolUseId, { streamKind: "command_output", delta });
const noise = (threadId: string, id: string): AppendableDomainEvent => appendable(threadId, id, "runtime.warning", undefined, { message: `noise ${"·".repeat(200)}` });
function reverted(threadId: string): AppendableDomainEvent {
  return { eventId: `e-revert-${++appendedCount}`, threadId, type: "thread.reverted", payload: { turnCount: 0 }, occurredAt: "2026-09-23T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {} } as AppendableDomainEvent;
}
function messageDelta(threadId: string, messageId: string, text: string, streaming: boolean): AppendableDomainEvent {
  return { eventId: `e-msg-${++appendedCount}`, threadId, type: "thread.message-sent", payload: { messageId, role: "assistant", text, streaming, turnId: null }, occurredAt: "2026-09-23T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {} } as AppendableDomainEvent;
}

type Store = ReturnType<typeof createThreadStore>;
type Window = NonNullable<Awaited<ReturnType<Store["readToolOutputWindow"]>>>;

/** Every window of an item's call, chained from 0 through nextOffset, each checked against the one before it. */
async function pageAll(store: Store, threadId: string, itemId: string, maxBytes: number): Promise<{ bytes: Buffer; windows: Window[] }> {
  const windows: Window[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const window = await store.readToolOutputWindow(threadId, itemId, { offset, maxBytes });
    assert.ok(window !== null, `${itemId} names a call`);
    assert.equal(window.offset, offset, "every window starts where the last one ended");
    const bytes = Buffer.from(window.text, "utf8");
    assert.ok(bytes.length <= maxBytes || [...window.text].length === 1, `a ${bytes.length}-byte window at maxBytes ${maxBytes}`);
    windows.push(window);
    parts.push(bytes);
    if (window.nextOffset === undefined) {
      assert.equal(offset + bytes.length, window.totalBytes, "the last window ends at the end");
      return { bytes: Buffer.concat(parts), windows };
    }
    assert.equal(window.nextOffset, offset + bytes.length, "nextOffset is offset + the window's UTF-8 bytes");
    offset = window.nextOffset;
  }
}

/** A real temporary store, closed and removed after the case. */
async function tempStore(t: { after(fn: () => unknown): void }): Promise<{ store: Store; rootDir: string }> {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir });
  t.after(async () => {
    store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { store, rootDir };
}

const SHELL = "bgshell:task-1";

test("readToolOutputWindow pages a call's join to the byte: the windows are the whole join's bytes, for any window size", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" })] });
  // Multi-byte characters, a surrogate pair split across two chunks, and another call streaming in between.
  const deltas = ["$ make\n", "😀語é!\n".repeat(50), "tail \ud83d", "\ude00 paired\n", "", "done\n"];
  for (const [i, delta] of deltas.entries()) {
    await store.append({ threadId: "t1", events: [streamed("t1", `o${i}`, SHELL, delta), streamed("t1", `x${i}`, "call-2", "another call\n"), noise("t1", `n${i}`)] });
  }
  await store.append({ threadId: "t1", events: [appendable("t1", "done", "tool.completed", SHELL, { itemType: "command_execution", status: "completed" })] });

  const legacy = await store.readToolOutput("t1", "done");
  assert.deepEqual([legacy?.output, legacy?.complete], [deltas.join(""), true]);
  const whole = Buffer.from(deltas.join(""), "utf8");
  for (const maxBytes of [1, 3, 7, 100, 4_096]) {
    const { bytes, windows } = await pageAll(store, "t1", "done", maxBytes);
    assert.ok(bytes.equals(whole), `maxBytes ${maxBytes}: byte-exact`);
    for (const window of windows) {
      assert.deepEqual([window.toolUseId, window.totalBytes, window.complete, window.truncated], [SHELL, whole.length, true, false]);
    }
  }
  // Any row of the call names the same join; a row naming no call, and an id never written, name none.
  assert.equal((await store.readToolOutputWindow("t1", "o3", { maxBytes: 5 }))?.text, "$ mak");
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.totalBytes, whole.length);
  assert.equal(await store.readToolOutputWindow("t1", "n1", {}), null);
  assert.equal(await store.readToolOutputWindow("t1", "never-written", {}), null);
  // An offset inside a character starts at it; one past the end answers the end, empty, with no nextOffset.
  const inside = await store.readToolOutputWindow("t1", "done", { offset: 8, maxBytes: 4 });
  assert.deepEqual([inside?.offset, inside?.text], [7, "😀"]);
  const past = await store.readToolOutputWindow("t1", "done", { offset: whole.length + 50, maxBytes: 4 });
  assert.deepEqual(past, { toolUseId: SHELL, offset: whole.length, text: "", totalBytes: whole.length, complete: true, truncated: false });
});

test("a running call's windows continue across appends: totalBytes grows, and complete flips when its completion lands", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "one\n")] });
  const first = await store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 100 });
  assert.deepEqual(first, { toolUseId: SHELL, offset: 0, text: "one\n", totalBytes: 4, complete: false, truncated: false });
  await store.append({ threadId: "t1", events: [noise("t1", "n1"), appendable("t1", "other-done", "tool.completed", "call-2", { itemType: "command_execution" }), streamed("t1", "o2", SHELL, "  two\n")] });
  const second = await store.readToolOutputWindow("t1", "start", { offset: 4, maxBytes: 100 });
  assert.deepEqual(second, { toolUseId: SHELL, offset: 4, text: "  two\n", totalBytes: 10, complete: false, truncated: false });
  await store.append({ threadId: "t1", events: [appendable("t1", "done", "tool.completed", SHELL, { itemType: "command_execution" })] });
  const last = await store.readToolOutputWindow("t1", "start", { offset: 10, maxBytes: 100 });
  assert.deepEqual(last, { toolUseId: SHELL, offset: 10, text: "", totalBytes: 10, complete: true, truncated: false });
  assert.deepEqual(await store.readToolOutput("t1", "start"), { toolUseId: SHELL, output: "one\n  two\n", complete: true, truncated: false });
});

test("a revert appended after the cache filled changes nothing: a rewind unprints nothing", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "before\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o2", SHELL, "in a turn the rewind removed\n"), reverted("t1"), streamed("t1", "o3", SHELL, "after\n")] });
  const window = await store.readToolOutputWindow("t1", "start", {});
  assert.equal(window?.text, "before\nin a turn the rewind removed\nafter\n");
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "before\nin a turn the rewind removed\nafter\n");
});

test("deleteThread drops the thread's cache: a thread recreated under the same id answers its own output and items", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution", title: "old" }), streamed("t1", "o1", SHELL, "old output\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "old output\n");
  assert.equal(((await store.readItem("t1", "start")) as { payload: { title: string } }).payload.title, "old");
  await store.deleteThread("t1");
  assert.equal(await store.readToolOutputWindow("t1", "start", {}), null, "gone with its log");
  // The same ids and the same line layout: only the log itself tells them apart.
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution", title: "new" }), streamed("t1", "o1", SHELL, "new output\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "new output\n");
  assert.equal(((await store.readItem("t1", "start")) as { payload: { title: string } }).payload.title, "new");
});

test("a torn fragment on disk (a crash mid-append) is cut before the first window, and never appears in one", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const writer = createThreadStore({ rootDir });
  await writer.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "whole\n")] });
  writer.close();
  const eventsPath = path.join(rootDir, "threads", "t1", "events.ndjson");
  const size = (await fs.stat(eventsPath)).size;
  // A chunk of the call whose line never got its end.
  const torn = JSON.stringify({ ...streamed("t1", "o2", SHELL, "TORN"), seq: 4 });
  await fs.appendFile(eventsPath, torn.slice(0, -3));
  const store = createThreadStore({ rootDir });
  t.after(() => store.close());
  assert.deepEqual(await store.readToolOutputWindow("t1", "start", {}), { toolUseId: SHELL, offset: 0, text: "whole\n", totalBytes: 6, complete: false, truncated: false });
  assert.equal((await fs.stat(eventsPath)).size, size, "the fragment was cut");
  // What lands next is joined after the whole line, never after the fragment.
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "next\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "whole\nnext\n");
});

test("concurrent windows of one call never join a chunk twice", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" })] });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
  for (const [i, line] of lines.entries()) await store.append({ threadId: "t1", events: [streamed("t1", `o${i}`, SHELL, line), noise("t1", `n${i}`)] });
  const windows = await Promise.all(Array.from({ length: 6 }, (_, i) => store.readToolOutputWindow("t1", "start", { offset: i * 7, maxBytes: 1_000 })));
  const whole = Buffer.from(lines.join(""), "utf8");
  for (const [i, window] of windows.entries()) {
    assert.deepEqual(window, { toolUseId: SHELL, offset: i * 7, text: whole.toString("utf8", i * 7), totalBytes: whole.length, complete: false, truncated: false });
  }
  // A page racing an append joins each chunk once.
  const [late] = await Promise.all([
    store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 1_000 }),
    store.append({ threadId: "t1", events: [streamed("t1", "o-late", SHELL, "late\n")] })
  ]);
  assert.ok(late?.text === lines.join("") || late?.text === `${lines.join("")}late\n`);
  assert.equal((await store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 1_000 }))?.text, `${lines.join("")}late\n`);
});

test("readItem follows updated item payloads and thread recreation", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "x", "tool.started", "call-1", { itemType: "command_execution", title: "v1" }), noise("t1", "n1")] });
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
  await store.append({ threadId: "t1", events: [noise("t1", "n2"), appendable("t1", "x", "tool.updated", "call-1", { itemType: "command_execution", title: "v2" }), noise("t1", "n3")] });
  const item = await store.readItem("t1", "x");
  assert.deepEqual([item?.kind === "activity" ? item.activityKind : null, (item as { payload: { title: string } }).payload.title], ["tool.updated", "v2"]);
  // A message's body is its deltas folded: the whole log, as before.
  await store.append({ threadId: "t1", events: [messageDelta("t1", "m1", "Hel", true), messageDelta("t1", "m1", "lo", true), messageDelta("t1", "m1", "", false)] });
  const message = await store.readItem("t1", "m1");
  assert.deepEqual([message?.kind, message?.kind === "message" ? message.text : null], ["message", "Hello"]);
  // An id the log never wrote has no item.
  assert.equal(await store.readItem("t1", "never-written"), null);
  // Deleted and recreated: the new log's item, never the old cursor's line.
  await store.deleteThread("t1");
  await store.append({ threadId: "t1", events: [created("t1"), noise("t1", "pad"), appendable("t1", "x", "tool.started", "call-9", { itemType: "command_execution", title: "v3" })] });
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v3");
});

test("readItem reconstructs a multipart message whose earlier deltas aged out of the resident window", async (t) => {
  const { store } = await tempStore(t);
  await store.append({ threadId: "t1", events: [
    created("t1"),
    messageDelta("t1", "old", "first ", true),
    ...Array.from({ length: 2_201 }, (_, i) => messageDelta("t1", `noise-${i}`, `message ${i}`, false)),
    ...Array.from({ length: 601 }, (_, i) => noise("t1", `activity-${i}`)),
    messageDelta("t1", "old", "last", true),
    messageDelta("t1", "old", "", false)
  ] });
  const item = await store.readItem("t1", "old");
  assert.deepEqual(item?.kind === "message" ? [item.text, item.streaming] : null, ["first last", false]);
});

test("full message reads preserve rewind survival and exclusion after window retention", async (t) => {
  const { store } = await tempStore(t);
  const turn = (turnId: string): AppendableDomainEvent => ({
    ...created("t1"), eventId: `start-${turnId}`, type: "thread.turn-start-requested",
    payload: { turnId, messageId: "", interactionMode: "default" }
  });
  const inTurn = (id: string, text: string, turnId: string): AppendableDomainEvent => ({
    ...created("t1"), eventId: id, type: "thread.message-sent",
    payload: { messageId: id, role: "assistant", text, streaming: false, turnId }
  });
  await store.append({ threadId: "t1", events: [
    created("t1"), turn("turn-1"), inTurn("keep", "retained answer", "turn-1"),
    turn("turn-2"), inTurn("drop", "removed answer", "turn-2"),
    ...Array.from({ length: 2_201 }, (_, i) => inTurn(`noise-${i}`, `message ${i}`, "turn-2")),
    { ...created("t1"), eventId: "rewind", type: "thread.reverted", payload: { turnCount: 1 } }
  ] });
  const kept = await store.readItem("t1", "keep");
  assert.equal(kept?.kind === "message" ? kept.text : null, "retained answer");
  assert.equal(await store.readItem("t1", "drop"), null);
});

test("an item line that no longer checks out under its cursor is read from the whole log, and the cursor starts over", async (t) => {
  const { store, rootDir } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "x", "tool.started", "call-1", { title: "v1" })] });
  const newest = await store.append({ threadId: "t1", events: [appendable("t1", "x", "tool.updated", "call-1", { title: "v2" })] });
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v2");
  // The newest write's line, rewritten in place under the store (same length): it is now another item's.
  const eventsPath = path.join(rootDir, "threads", "t1", "events.ndjson");
  const line = newest.positions[0]!;
  const bytes = await fs.readFile(eventsPath);
  const rewritten = bytes.toString("utf8", line.byteOffset, line.byteOffset + line.byteLength).replace('"id":"x"', '"id":"y"');
  assert.equal(Buffer.byteLength(rewritten), line.byteLength);
  const handle = await fs.open(eventsPath, "r+");
  await handle.write(rewritten, line.byteOffset, "utf8");
  await handle.close();
  // The log decides: x's newest write is now its first.
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
});

test("a line that does not decode ends the join for good, as it ends readLog: nothing past it is ever joined or re-read", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const writer = createThreadStore({ rootDir });
  await writer.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "before\n")] });
  writer.close();
  await fs.appendFile(path.join(rootDir, "threads", "t1", "events.ndjson"), "not a line of the log\n");
  const store = createThreadStore({ rootDir });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [streamed("t1", "o2", SHELL, "after\n")] });
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "before\n");
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "later\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  assert.equal(await store.readItem("t1", "o3"), null, "an item written past it does not exist for any reader");
});

/** Write a whole log file, one decoded event per line. */
const writeLog = (file: string, events: readonly DomainEvent[]): Promise<void> => fs.writeFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""));

/**
 * The tool-output cache over one log file a test writes itself — so its committed length is simply the file's — with
 * the store's own line decoding. What the store never does to its log (rewrite it, replace it mid-scan) is what these
 * tests do.
 */
function fileCache(file: string): ReturnType<typeof createToolOutputCache> {
  return createToolOutputCache({
    eventsPath: () => file,
    committedLength: async () => (await fs.stat(file)).size,
    decodeLine: (line) => {
      try {
        return parseAgentDomainEvent(JSON.parse(line)) as unknown as DomainEvent;
      } catch {
        return null;
      }
    },
    now: () => 0,
    decodeSliceMs: 8,
    yieldToLoop: () => new Promise((resolve) => setImmediate(resolve))
  });
}

test("a log that does not continue an entry's cursor — rewritten, or shorter — is read again from its start", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const file = path.join(rootDir, "events.ndjson");
  const write = (events: DomainEvent[]) => writeLog(file, events);
  const cache = fileCache(file);
  seq = 0;
  const start = row("start", "tool.started", SHELL, { itemType: "command_execution" });
  await write([start, chunk("o1", SHELL, "old\n")]);
  assert.equal((await cache.window("t1", "start", {}))?.text, "old\n");
  // The same first line, then another log whose line two is one byte longer: the cursor now sits on its newline,
  // which reads as an empty line followed by a line carrying the cursor's seq + 1 — never the next line the store wrote.
  seq = 1;
  await write([start, chunk("o1", SHELL, "new!\n"), chunk("o2", SHELL, "more\n")]);
  assert.equal((await cache.window("t1", "start", {}))?.text, "new!\nmore\n");
  // Two more bytes: the cursor falls inside a line, whose tail does not decode.
  seq = 1;
  await write([start, chunk("o1", SHELL, "newer!\n"), chunk("o2", SHELL, "more\n")]);
  assert.equal((await cache.window("t1", "start", {}))?.text, "newer!\nmore\n");
  // Shorter than the cursor: not the log it read either.
  await write([start]);
  assert.deepEqual(await cache.window("t1", "start", {}), { toolUseId: SHELL, offset: 0, text: "", totalBytes: 0, complete: false, truncated: false });
});

test("a thread deleted while its output is read returns only the recreated thread's output", async (t) => {
  const { store, rootDir } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL), streamed("t1", "o1", SHELL, "old\n")] });
  const probe = await fs.open(path.join(rootDir, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const read = prototype.read;
  let notifyRead!: () => void;
  const reading = new Promise<void>((resolve) => { notifyRead = resolve; });
  let resumeRead!: () => void;
  const resumed = new Promise<void>((resolve) => { resumeRead = resolve; });
  let pause = true;
  t.mock.method(prototype, "read", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["read"]>) {
    if (pause) {
      pause = false;
      notifyRead();
      await resumed;
    }
    return read.apply(this, args);
  });
  const pending = store.readToolOutputWindow("t1", "start", {});
  await reading;
  try {
    await store.deleteThread("t1");
    await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL), streamed("t1", "o1", SHELL, "new\n")] });
  } finally {
    resumeRead();
  }
  assert.deepEqual(await pending, { toolUseId: SHELL, offset: 0, text: "new\n", totalBytes: 4, complete: false, truncated: false });
});

test("a line whose seq does not climb ends a cold build's join for good, as it ends readLog", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const eventsPath = path.join(rootDir, "threads", "t1", "events.ndjson");
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  seq = 0;
  const log = [row("start", "tool.started", SHELL, { itemType: "command_execution" }), chunk("o1", SHELL, "before\n")];
  seq = 1;
  log.push(chunk("o2", SHELL, "a repeated seq\n"));
  log.push(chunk("o3", SHELL, "after it\n"));
  await writeLog(eventsPath, log);
  const store = createThreadStore({ rootDir });
  t.after(() => store.close());
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "before\n", "readLog stops there");
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o4", SHELL, "appended later\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
});

test("an append that fails and is rolled back never reaches the cache — not even read while its bytes were on disk", async (t) => {
  const { store, rootDir } = await tempStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "one\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "one\n");
  const eventsPath = path.join(rootDir, "threads", "t1", "events.ndjson");
  const committed = (await fs.stat(eventsPath)).size;

  // The batch lands on disk, then its fsync fails: while the append is still in flight, a window and the whole join
  // are read. The window reads only what appends have reported; `readLog` reads to the end of the file.
  const probe = await fs.open(path.join(rootDir, "probe"), "w");
  const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const realSync = fileHandleProto.sync;
  let during: { window: Window | null; whole: string | undefined } | null = null;
  fileHandleProto.sync = async () => {
    during = {
      window: await store.readToolOutputWindow("t1", "start", {}),
      whole: (await store.readToolOutput("t1", "start"))?.output
    };
    throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" });
  };
  try {
    await assert.rejects(store.append({ threadId: "t1", events: [streamed("t1", "o2", SHELL, "never acknowledged\n")] }), /EIO/);
  } finally {
    fileHandleProto.sync = realSync;
  }
  const seen = during as { window: Window | null; whole: string | undefined } | null;
  assert.equal(seen?.whole, "one\nnever acknowledged\n", "precondition: the batch was on disk while it was read");
  assert.equal(seen?.window?.text, "one\n", "an append in flight is not committed: the cache never saw it");
  assert.equal((await fs.stat(eventsPath)).size, committed, "the failed batch was rolled back");

  // What lands next continues the cursor: read by the tail, never from the start.
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "two\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "one\ntwo\n");
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "one\ntwo\n");
});
