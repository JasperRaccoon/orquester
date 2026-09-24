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
  THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES,
  commandOutputText,
  type DomainEvent,
  type ThreadActivityItem
} from "@orquester/api/agent-chat";
import { parseAgentDomainEvent } from "@orquester/config";

import { backgroundShellItemId } from "../adapters/claude/normalize.ts";
import { BATCH_INTERVAL_MS, createIngestion } from "../ingestion/index.ts";
import { FakeClock, FakeTimers, RecordingLiveness, counterIdGen, runtimeEvent } from "../ingestion/test-harness.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "./index.ts";
import { createToolOutputCache } from "./tool-output-cache.ts";
import { ToolOutputJoin, joinToolOutput, nextItemWrite, toolOutputWindow, utf8Window, type ItemWrite } from "./tool-output.ts";

let seq = 0;
/** One logged event, as the store decodes it back. */
function logged(type: "thread.activity-appended", payload: { activity: ThreadActivityItem }): DomainEvent;
function logged(type: "thread.message-sent", payload: { messageId: string; role: "assistant"; text: string; streaming: boolean; turnId: string | null }): DomainEvent;
function logged(type: "thread.reverted", payload: { turnCount: number }): DomainEvent;
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

test("joins every chunk of the item's call verbatim in log order, and reports complete once the call's completion exists", () => {
  const shell = "bgshell:task-1";
  const events = [
    row("start", "tool.started", shell, { itemType: "command_execution", status: "inProgress" }),
    chunk("o1", shell, "$ make\n"),
    chunk("x1", "call-2", "another call's output\n"),
    chunk("o2", shell, "  building…\n\n"),
    row("x-done", "tool.completed", "call-2", { itemType: "command_execution", status: "completed" }),
    chunk("o3", shell, "done"),
    row("done", "tool.completed", shell, { itemType: "command_execution", status: "completed", data: { toolName: "Bash", background: true } })
  ];
  const whole = { toolUseId: shell, output: "$ make\n  building…\n\ndone", complete: true, truncated: false };
  // Named by any row of the call: its completion, its start, even one of its chunks.
  assert.deepEqual(joinToolOutput(events, "done"), whole);
  assert.deepEqual(joinToolOutput(events, "start"), whole);
  assert.deepEqual(joinToolOutput(events, "o2"), whole);
  // Before the completion lands the call is still running: the output so far, not complete.
  assert.deepEqual(joinToolOutput(events.slice(0, 5), "start"), { toolUseId: shell, output: "$ make\n  building…\n\n", complete: false, truncated: false });
  // Another call's completion never completes this one.
  assert.equal(joinToolOutput(events.slice(0, 6), "start")!.complete, false);
});

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

test("a rewind does not unprint output: chunks written in the turns a revert removed are still joined", () => {
  // Chunks written before a rewind are what the command printed, and a rewind unprints nothing: the raw log keeps them
  // (documented, not filtered). A Claude rewind restarts the session, which closes an open shell first (its item
  // settles `failed`, `closeLiveTasks`), so the shell's end lands before the revert and nothing of it follows.
  const shell = "bgshell:task-1";
  const events = [
    row("start", "tool.started", shell, { itemType: "command_execution" }),
    chunk("o1", shell, "before\n"),
    chunk("o2", shell, "in a turn the rewind removed\n"),
    row("end", "tool.completed", shell, { itemType: "command_execution", status: "failed" }),
    logged("thread.reverted", { turnCount: 1 })
  ];
  assert.deepEqual(joinToolOutput(events, "start"), { toolUseId: shell, output: "before\nin a turn the rewind removed\n", complete: true, truncated: false });
});

test("the cap cuts the join in-band, on a character boundary, and the completion after the cut is still reported", () => {
  const events = [
    chunk("o1", "call-1", "abcd"),
    // "語" is 3 bytes: at a 10-byte cap, 4 + "ef" + "語" = 9 fit and the next "語" would pass it.
    chunk("o2", "call-1", "ef語語gh"),
    chunk("o3", "call-1", "never read"),
    row("done", "tool.completed", "call-1")
  ];
  assert.deepEqual(joinToolOutput(events, "done", 10), { toolUseId: "call-1", output: "abcdef語", complete: true, truncated: true });
  // Exactly at the cap nothing is cut.
  assert.deepEqual(joinToolOutput(events.slice(0, 1).concat(events.slice(3)), "done", 4), { toolUseId: "call-1", output: "abcd", complete: true, truncated: false });
  // A 4-byte character never splits: a cap that falls inside it leaves it out whole.
  assert.equal(joinToolOutput([chunk("o", "call-1", "a😀b"), row("done", "tool.completed", "call-1")], "done", 3)!.output, "a");
});

// --- the incremental join: what the store's cache holds --------------------------------------------------------------

/**
 * The store's tool-output cache as a model over decoded events (`tool-output-cache.ts` keeps exactly these two things,
 * over the log's bytes): the item's newest write, extended one event at a time, and one incremental join PER CALL, each
 * extended from where it stopped. `pages` are the log lengths a reader asks at: each page extends the item, then the
 * join of the call the item names at that point — built from the log's start the first time that call is asked for.
 */
function cachedJoin(events: readonly DomainEvent[], itemId: string, cap: number, pages: readonly number[]): ToolOutputJoin | null {
  const joins = new Map<string, { join: ToolOutputJoin; at: number }>();
  let write: ItemWrite = { kind: "none" };
  let itemAt = 0;
  let answer: ToolOutputJoin | null = null;
  for (const at of [...pages, events.length]) {
    for (; itemAt < at; itemAt += 1) write = nextItemWrite(write, events[itemAt]!, itemId, { byteOffset: itemAt, byteLength: 1 });
    const toolUseId = write.kind === "activity" ? write.toolUseId : undefined;
    if (toolUseId === undefined) {
      answer = null;
      continue;
    }
    let entry = joins.get(toolUseId);
    if (entry === undefined) {
      entry = { join: new ToolOutputJoin(toolUseId, cap), at: 0 };
      joins.set(toolUseId, entry);
    }
    for (; entry.at < at; entry.at += 1) entry.join.push(events[entry.at]!);
    answer = entry.join;
  }
  return answer;
}

/** `cachedJoin` equals the whole-log join: the same call, flags, and bytes — `Buffer.from(output)`, what offsets count in. */
function sameAsReference(got: ToolOutputJoin | null, reference: ReturnType<typeof joinToolOutput>): boolean {
  if (reference === null) return got === null;
  const bytes = Buffer.from(reference.output, "utf8");
  return got !== null && got.toolUseId === reference.toolUseId && got.bytes().equals(bytes) && got.totalBytes === bytes.length
    && got.complete === reference.complete && got.truncated === reference.truncated;
}

/**
 * A random log in the prototype's shape (`/tmp/fix7/scratch-D/incremental.mts`): the item `start` names call A, then
 * chunks of A and B interleave — 1-4 byte characters, lone high and low surrogates (so a pair splits across chunks),
 * `""` and non-string deltas — with completions of either call, reverts, warnings, and in some trials the item
 * re-pointed at B (and back at A) or reused as a message id.
 */
function randomLog(rnd: (n: number) => number, trial: number): DomainEvent[] {
  const pieces = ["ab", "é", "語", "😀", "\ud83d", "\ude00", "\n", "", "x".repeat(20)];
  const events = [row("start", "tool.started", "A", { itemType: "command_execution" })];
  const n = 5 + rnd(25);
  for (let i = 0; i < n; i += 1) {
    const r = rnd(20);
    if (r < 12) {
      let delta = "";
      for (let k = 0, parts = 1 + rnd(4); k < parts; k += 1) delta += pieces[rnd(pieces.length)];
      events.push(chunk(`o${i}`, rnd(5) ? "A" : "B", delta));
    } else if (r === 12) events.push(chunk(`odd${i}`, "A", 42));
    else if (r === 13) events.push(row(`done${i}`, "tool.completed", rnd(2) ? "A" : "B"));
    else if (r === 14) events.push(logged("thread.reverted", { turnCount: 0 }));
    else if (r === 15 && trial % 7 === 0) events.push(row("start", "tool.updated", "B"));
    else if (r === 16 && trial % 5 === 0) events.push(row("start", "tool.updated", "A"));
    else if (r === 17 && trial % 11 === 0) events.push(logged("thread.message-sent", { messageId: "start", role: "assistant", text: "hi", streaming: false, turnId: null }));
    else events.push(row(`w${i}`, "runtime.warning", undefined, { message: "noise" }));
  }
  return events;
}

test("the incremental join equals joinToolOutput at every split point: built over a prefix, extended by the rest", () => {
  let checks = 0;
  for (const seed of [7, 11, 12345]) {
    let state = seed;
    const rnd = (n: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    for (let trial = 0; trial < 150; trial += 1) {
      const events = randomLog(rnd, trial);
      const cap = [3, 5, 8, 13, 1_000][rnd(5)]!;
      // The item, one of its call's chunks, and an id the log never wrote.
      for (const itemId of ["start", "o1", "nope"]) {
        const reference = joinToolOutput(events, itemId, cap);
        for (let k = 0; k <= events.length; k += 1) {
          // Two pages (at k, then at the end), and three (at k, somewhere after it, then at the end).
          const later = k + rnd(events.length - k + 1);
          for (const pages of [[k], [k, later]]) {
            checks += 1;
            assert.ok(sameAsReference(cachedJoin(events, itemId, cap, pages), reference), `seed ${seed} trial ${trial} item ${itemId} cap ${cap} pages ${pages.join(",")}`);
          }
        }
        // The last state pages back to the join byte for byte, through the window rule.
        const whole = cachedJoin(events, itemId, cap, []);
        if (whole === null) continue;
        const maxBytes = 1 + rnd(7);
        const parts: Buffer[] = [];
        for (let offset: number | undefined = 0; offset !== undefined;) {
          const window: ReturnType<ToolOutputJoin["window"]> = whole.window({ offset, maxBytes });
          parts.push(Buffer.from(window.text, "utf8"));
          offset = window.nextOffset;
        }
        assert.ok(Buffer.concat(parts).equals(Buffer.from(reference!.output, "utf8")));
      }
    }
  }
  assert.ok(checks > 20_000, `${checks} checks`);
});

test("the call is the item's newest write over everything read so far: a cold build never re-decides on an older write", () => {
  const events = [
    row("same", "tool.started", "old-call"),
    // The new call streams before the item names it: those chunks are its output all the same.
    chunk("n1", "new-call", "new, before\n"),
    chunk("o1", "old-call", "old\n"),
    row("same", "tool.updated", "new-call"),
    chunk("n2", "new-call", "new, after\n"),
    row("done", "tool.completed", "new-call")
  ];
  const expected = { toolUseId: "new-call", output: "new, before\nnew, after\n", complete: true, truncated: false };
  assert.deepEqual(joinToolOutput(events, "same"), expected);
  // Cold over the whole log: the newest write decides — the older one met on the way names nothing.
  const cold = cachedJoin(events, "same", 1_000, []);
  assert.deepEqual([cold?.toolUseId, cold?.bytes().toString("utf8"), cold?.complete], ["new-call", expected.output, true]);
  // A page before the re-point read the old call; the next one reads the new call's whole join, its early chunk included.
  const warm = cachedJoin(events, "same", 1_000, [2]);
  assert.deepEqual([warm?.toolUseId, warm?.bytes().toString("utf8")], ["new-call", expected.output]);
  // Re-pointed back: the old call's join resumes where its page left it.
  const back = [...events, row("same", "tool.updated", "old-call"), chunk("o2", "old-call", "old again\n")];
  assert.equal(cachedJoin(back, "same", 1_000, [2, 5])?.bytes().toString("utf8"), "old\nold again\n");
  // Reused as a message id: no call at all.
  assert.equal(cachedJoin([...events, logged("thread.message-sent", { messageId: "same", role: "assistant", text: "hi", streaming: false, turnId: null })], "same", 1_000, [3]), null);
});

test("nextItemWrite is readItem's newest write: an activity's line and call, a message, or nothing", () => {
  const events = [row("a", "tool.started", "call-1"), row("b", "runtime.warning", undefined), row("a", "tool.updated", "")];
  let write: ItemWrite = { kind: "none" };
  write = nextItemWrite(write, events[0]!, "a", { byteOffset: 10, byteLength: 20 });
  assert.deepEqual(write, { kind: "activity", seq: events[0]!.seq, byteOffset: 10, byteLength: 20, toolUseId: "call-1" });
  // Another item's write changes nothing.
  assert.equal(nextItemWrite(write, events[1]!, "a", { byteOffset: 30, byteLength: 5 }), write);
  // A newer write naming no call (an empty id is none) still becomes the item's line.
  assert.deepEqual(nextItemWrite(write, events[2]!, "a", { byteOffset: 35, byteLength: 7 }), { kind: "activity", seq: events[2]!.seq, byteOffset: 35, byteLength: 7 });
  const message = logged("thread.message-sent", { messageId: "a", role: "assistant", text: "hi", streaming: true, turnId: null });
  assert.deepEqual(nextItemWrite(write, message, "a", { byteOffset: 42, byteLength: 9 }), { kind: "message" });
});

test("a lone high surrogate at the join's end reads as U+FFFD, and becomes the 4-byte pair when its low half arrives", () => {
  const join = new ToolOutputJoin("call-1");
  join.push(chunk("o1", "call-1", "a\ud83d"));
  // As Buffer.from(join) reads it at this moment: "a" + U+FFFD.
  assert.equal(join.totalBytes, 4);
  assert.ok(join.bytes().equals(Buffer.from("a\ud83d", "utf8")));
  assert.deepEqual(join.window({ offset: 0, maxBytes: 10 }), { toolUseId: "call-1", offset: 0, text: "a�", totalBytes: 4, complete: false, truncated: false });
  join.push(chunk("o2", "call-1", "\ude00b"));
  assert.equal(join.totalBytes, 6);
  assert.ok(join.bytes().equals(Buffer.from("a😀b", "utf8")));
  // A lone low surrogate, and a high one another high one follows, stay U+FFFD for good.
  join.push(chunk("o3", "call-1", "\ude00\ud83d\ud83d"));
  join.push(chunk("o4", "call-1", "c"));
  assert.ok(join.bytes().equals(Buffer.from("a😀b\ude00\ud83d\ud83dc", "utf8")));
});

test("utf8Window never splits a character, starts an offset inside one at its lead byte, and always takes one whole character", () => {
  // 4-, 3-, 2- and 1-byte characters, so almost every window edge falls inside one.
  const bytes = Buffer.from("😀語é!\n".repeat(40), "utf8");
  assert.deepEqual(utf8Window(bytes, 5, 5), { start: 4, end: 9 }, "inside 語: from its lead byte, 語é");
  assert.deepEqual(utf8Window(bytes, 0, 1), { start: 0, end: 4 }, "narrower than 😀: 😀 whole");
  assert.deepEqual(utf8Window(bytes, 0, 7), { start: 0, end: 7 }, "😀語");
  assert.deepEqual(utf8Window(bytes, 0, 8), { start: 0, end: 7 }, "é would pass maxBytes");
  // At the end: empty. Past it, however far: the end.
  for (const offset of [bytes.length, bytes.length + 1, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(utf8Window(bytes, offset, 10), { start: bytes.length, end: bytes.length }, String(offset));
  }
  assert.deepEqual(utf8Window(Buffer.alloc(0), 0, 10), { start: 0, end: 0 });
  // Chained through each window's end, the windows are the bytes, exactly.
  for (const maxBytes of [1, 2, 3, 5, 7, 100, 1_001]) {
    const parts: Buffer[] = [];
    for (let offset = 0; ;) {
      const { start, end } = utf8Window(bytes, offset, maxBytes);
      assert.equal(start, offset, "a chained window starts where the last one ended");
      if (end === start) break;
      const text = bytes.toString("utf8", start, end);
      assert.ok(!text.includes("�"), "no character was split");
      assert.ok(end - start <= maxBytes || [...text].length === 1, `maxBytes ${maxBytes}: a ${end - start}-byte window`);
      parts.push(bytes.subarray(start, end));
      offset = end;
    }
    assert.ok(Buffer.concat(parts).equals(bytes), `maxBytes ${maxBytes}: byte-exact`);
  }
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
  const wide = { ...joined, output: "x".repeat(THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES + 10) };
  assert.equal(toolOutputWindow(wide, { maxBytes: 10 * THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES }).nextOffset, THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES);
  assert.equal(toolOutputWindow(wide, {}).nextOffset, THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES);
  // Numbers no query string carries: an unbounded size is the widest, NaN the default, and any offset reads as bytes.
  assert.equal(toolOutputWindow(wide, { maxBytes: Number.POSITIVE_INFINITY }).nextOffset, THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES);
  assert.equal(toolOutputWindow(wide, { maxBytes: Number.NaN }).nextOffset, THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES);
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
  const store = createThreadStore({ rootDir, sweepIntervalMs: 0 });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [created("t1")] });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  // The real ingestion, its real slimming, appending through the real store.
  const ingestion = createIngestion({
    sink: async (threadId, events) => { await store.append({ threadId, events }); },
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  // The shell's rows as the Claude normaliser builds them (`openBackgroundShellItem`, `backgroundShellOutput`,
  // `closeBackgroundShellItem`): its own item id, stamped with the task as its agent.
  const itemId = backgroundShellItemId("task-1");
  const shell = { threadId: "t1", turnId: "turn-1", itemId, agentId: "task-1" };
  const data = { toolName: "Bash", input: { command: "make -j8", description: "Build" }, background: true };
  await ingestion.ingest(runtimeEvent("item.started", { itemType: "command_execution", status: "inProgress", title: "Background shell", agentId: "task-1", data }, { ...shell, eventId: "shell-start" }));
  const chunks = ["make: entering\n", "  [ 50%] cc a.o\n", "\n  [100%] linked\n"];
  for (const delta of chunks) {
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta }, shell));
    // Another call streams in between: its output never joins the shell's.
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: "noise\n" }, { threadId: "t1", turnId: "turn-1", itemId: "call-2" }));
    timers.advance(BATCH_INTERVAL_MS);
    await ingestion.drain();
  }
  await ingestion.ingest(runtimeEvent("item.completed", { itemType: "command_execution", status: "completed", title: "Background shell", agentId: "task-1", data: { ...data, exitCode: 0 } }, { ...shell, eventId: "shell-done" }));
  await ingestion.drain();
  await store.drain();

  const log = (await store.readAll("t1")).events.flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []));
  const outputRows = log.filter((activity) => activity.activityKind === "tool.output" && (activity.payload as { toolUseId?: unknown }).toolUseId === itemId);
  assert.equal(outputRows.length, 3, "one tool.output row per flush, keyed by the shell's item id");
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

/** A store in a temp dir that records every read of a log (`onLogRead`). */
async function recordingStore(t: { after(fn: () => unknown): void }, options: Partial<Parameters<typeof createThreadStore>[0]> = {}): Promise<{ store: Store; rootDir: string; reads: Array<[string, number, number]> }> {
  const rootDir = await tempRoot();
  const reads: Array<[string, number, number]> = [];
  const store = createThreadStore({ rootDir, sweepIntervalMs: 0, onLogRead: (threadId, from, to) => reads.push([threadId, from, to]), ...options });
  t.after(async () => {
    store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { store, rootDir, reads };
}
const coldReads = (reads: Array<[string, number, number]>): number => reads.filter(([, from]) => from === 0).length;

const SHELL = "bgshell:task-1";

test("readToolOutputWindow pages a call's join to the byte: the windows are the whole join's bytes, for any window size", async (t) => {
  const { store } = await recordingStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" })] });
  // Multi-byte characters, a surrogate pair split across two chunks, and another call streaming in between.
  const deltas = ["$ make\n", "😀語é!\n".repeat(50), "tail \ud83d", "\ude00 paired\n", "", "done\n"];
  for (const [i, delta] of deltas.entries()) {
    await store.append({ threadId: "t1", events: [streamed("t1", `o${i}`, SHELL, delta), streamed("t1", `x${i}`, "call-2", "another call\n"), noise("t1", `n${i}`)] });
  }
  await store.append({ threadId: "t1", events: [appendable("t1", "done", "tool.completed", SHELL, { itemType: "command_execution", status: "completed" })] });

  const legacy = await store.readToolOutput("t1", "done");
  assert.deepEqual([legacy?.output, legacy?.complete], [deltas.join(""), true]);
  const whole = Buffer.from(legacy!.output, "utf8");
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
  const { store } = await recordingStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "one\n")] });
  const first = await store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 100 });
  assert.deepEqual(first, { toolUseId: SHELL, offset: 0, text: "one\n", totalBytes: 4, complete: false, truncated: false });
  await store.append({ threadId: "t1", events: [noise("t1", "n1"), streamed("t1", "o2", SHELL, "  two\n")] });
  const second = await store.readToolOutputWindow("t1", "start", { offset: 4, maxBytes: 100 });
  assert.deepEqual(second, { toolUseId: SHELL, offset: 4, text: "  two\n", totalBytes: 10, complete: false, truncated: false });
  await store.append({ threadId: "t1", events: [appendable("t1", "done", "tool.completed", SHELL, { itemType: "command_execution" })] });
  const last = await store.readToolOutputWindow("t1", "start", { offset: 10, maxBytes: 100 });
  assert.deepEqual(last, { toolUseId: SHELL, offset: 10, text: "", totalBytes: 10, complete: true, truncated: false });
  assert.deepEqual(await store.readToolOutput("t1", "start"), { toolUseId: SHELL, output: "one\n  two\n", complete: true, truncated: false });
});

test("a warm page reads only the log's tail, and an item read is that tail plus the item's own line", async (t) => {
  const { store, reads } = await recordingStore(t);
  const start = await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" })] });
  for (let i = 0; i < 40; i += 1) {
    await store.append({ threadId: "t1", events: [noise("t1", `n${i}`), streamed("t1", `o${i}`, SHELL, `line ${i}\n`)] });
  }
  // The first page builds both from the log's start: the item's newest write, then its call's join.
  assert.ok(await store.readItem("t1", "start"));
  assert.ok(await store.readToolOutputWindow("t1", "start", { offset: 0 }));
  assert.equal(coldReads(reads), 2, "one cold read for the item, one for the join");

  const before = await store.logLength("t1");
  await store.append({ threadId: "t1", events: [noise("t1", "n-late"), streamed("t1", "o-late", SHELL, "late\n")] });
  const after = await store.logLength("t1");
  reads.length = 0;
  const item = await store.readItem("t1", "start");
  assert.equal(item?.kind === "activity" ? item.activityKind : null, "tool.started");
  const window = await store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 1_000_000 });
  assert.ok(window?.text.endsWith("line 39\nlate\n"));
  const line = start.positions[1]!;
  assert.deepEqual(reads, [
    ["t1", before, after],
    ["t1", line.byteOffset, line.byteOffset + line.byteLength],
    ["t1", before, after]
  ], "the item's tail, its line, then the join's tail — never the log from its start");
  // Nothing new: nothing read at all.
  reads.length = 0;
  await store.readToolOutputWindow("t1", "start", { offset: 5 });
  assert.deepEqual(reads, []);
});

test("a revert appended after the cache filled changes nothing: a rewind unprints nothing", async (t) => {
  const { store } = await recordingStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "before\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o2", SHELL, "in a turn the rewind removed\n"), reverted("t1"), streamed("t1", "o3", SHELL, "after\n")] });
  const window = await store.readToolOutputWindow("t1", "start", {});
  assert.equal(window?.text, "before\nin a turn the rewind removed\nafter\n");
  assert.equal(window?.text, (await store.readToolOutput("t1", "start"))?.output);
});

test("deleteThread drops the thread's cache: a thread recreated under the same id answers its own output and items", async (t) => {
  const { store } = await recordingStore(t);
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
  const writer = createThreadStore({ rootDir, sweepIntervalMs: 0 });
  await writer.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "whole\n")] });
  writer.close();
  const eventsPath = path.join(rootDir, "threads", "t1", "events.ndjson");
  const size = (await fs.stat(eventsPath)).size;
  // A chunk of the call whose line never got its end.
  const torn = JSON.stringify({ ...streamed("t1", "o2", SHELL, "TORN"), seq: 4 });
  await fs.appendFile(eventsPath, torn.slice(0, -3));
  const store = createThreadStore({ rootDir, sweepIntervalMs: 0 });
  t.after(() => store.close());
  assert.deepEqual(await store.readToolOutputWindow("t1", "start", {}), { toolUseId: SHELL, offset: 0, text: "whole\n", totalBytes: 6, complete: false, truncated: false });
  assert.equal((await fs.stat(eventsPath)).size, size, "the fragment was cut");
  // What lands next is joined after the whole line, never after the fragment.
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "next\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "whole\nnext\n");
});

test("the cache is bounded: past its byte budget the least recently used join goes, and is rebuilt from the log when read again", async (t) => {
  // Each call's join holds ~5 KB, in an 8 KiB buffer: a 12 KiB budget keeps one of them.
  const { store, reads } = await recordingStore(t, { toolOutputCacheBytes: 12 * 1024 });
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "a", "tool.started", "call-a", { itemType: "command_execution" }), appendable("t1", "b", "tool.started", "call-b", { itemType: "command_execution" })] });
  for (let i = 0; i < 50; i += 1) {
    await store.append({ threadId: "t1", events: [streamed("t1", `a${i}`, "call-a", `${"a".repeat(99)}\n`), streamed("t1", `b${i}`, "call-b", `${"b".repeat(99)}\n`)] });
  }
  const expectA = `${"a".repeat(99)}\n`.repeat(50);
  assert.equal((await store.readToolOutputWindow("t1", "a", {}))?.text, expectA);
  assert.equal(coldReads(reads), 2);
  assert.equal((await store.readToolOutputWindow("t1", "b", {}))?.text, `${"b".repeat(99)}\n`.repeat(50));
  assert.equal(coldReads(reads), 4);
  // b stays: warm, nothing read.
  reads.length = 0;
  await store.readToolOutputWindow("t1", "b", { offset: 10 });
  assert.deepEqual(reads, []);
  // a was evicted: its item is still known, its join is read again from the start — and is right.
  assert.equal((await store.readToolOutputWindow("t1", "a", {}))?.text, expectA);
  assert.equal(coldReads(reads), 1, "only the join is rebuilt");
});

test("the cache is bounded in entries too, and an entry idle past its time is rebuilt from the log", async (t) => {
  const clock = new FakeClock();
  const { store, reads } = await recordingStore(t, { clock, toolOutputCacheEntries: 2, toolOutputCacheIdleMs: 1_000 });
  await store.append({ threadId: "t1", events: [created("t1"), ...["x", "y", "z"].map((id) => appendable("t1", id, "tool.started", `call-${id}`, { itemType: "command_execution" })), streamed("t1", "ox", "call-x", "x\n")] });
  for (const id of ["x", "y", "z"]) assert.ok(await store.readItem("t1", id));
  assert.equal(coldReads(reads), 3);
  // Two cursors kept: z and y. x's is rebuilt.
  reads.length = 0;
  assert.ok(await store.readItem("t1", "z"));
  assert.ok(await store.readItem("t1", "y"));
  assert.equal(coldReads(reads), 0);
  assert.ok(await store.readItem("t1", "x"));
  assert.equal(coldReads(reads), 1);
  // Idle: just under its time it is kept, past it rebuilt.
  reads.length = 0;
  assert.equal((await store.readToolOutputWindow("t1", "x", {}))?.text, "x\n");
  assert.equal(coldReads(reads), 1, "the join, built once");
  clock.advance(999);
  await store.readToolOutputWindow("t1", "x", {});
  assert.equal(coldReads(reads), 1);
  clock.advance(1_000);
  assert.equal((await store.readToolOutputWindow("t1", "x", {}))?.text, "x\n");
  assert.equal(coldReads(reads), 3, "both expired: the item and the join are read again");
});

test("concurrent windows of one call build it once, and never join a chunk twice", async (t) => {
  const { store, reads } = await recordingStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" })] });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
  for (const [i, line] of lines.entries()) await store.append({ threadId: "t1", events: [streamed("t1", `o${i}`, SHELL, line), noise("t1", `n${i}`)] });
  const windows = await Promise.all(Array.from({ length: 6 }, (_, i) => store.readToolOutputWindow("t1", "start", { offset: i * 7, maxBytes: 1_000 })));
  const whole = Buffer.from(lines.join(""), "utf8");
  for (const [i, window] of windows.entries()) {
    assert.deepEqual(window, { toolUseId: SHELL, offset: i * 7, text: whole.toString("utf8", i * 7), totalBytes: whole.length, complete: false, truncated: false });
  }
  assert.equal(coldReads(reads), 2, "one cold read for the item, one for the join");
  // A page racing an append joins each chunk once.
  const [late] = await Promise.all([
    store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 1_000 }),
    store.append({ threadId: "t1", events: [streamed("t1", "o-late", SHELL, "late\n")] })
  ]);
  assert.ok(late?.text === lines.join("") || late?.text === `${lines.join("")}late\n`);
  assert.equal((await store.readToolOutputWindow("t1", "start", { offset: 0, maxBytes: 1_000 }))?.text, `${lines.join("")}late\n`);
});

test("readItem answers the newest write through the item's cursor — the tail and one line — and a message still folds", async (t) => {
  const { store, reads } = await recordingStore(t);
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "x", "tool.started", "call-1", { itemType: "command_execution", title: "v1" }), noise("t1", "n1")] });
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
  const before = await store.logLength("t1");
  const appended = await store.append({ threadId: "t1", events: [noise("t1", "n2"), appendable("t1", "x", "tool.updated", "call-1", { itemType: "command_execution", title: "v2" }), noise("t1", "n3")] });
  reads.length = 0;
  const item = await store.readItem("t1", "x");
  assert.deepEqual([item?.kind === "activity" ? item.activityKind : null, (item as { payload: { title: string } }).payload.title], ["tool.updated", "v2"]);
  const line = appended.positions[1]!;
  assert.deepEqual(reads, [["t1", before, appended.logBytes], ["t1", line.byteOffset, line.byteOffset + line.byteLength]]);
  // A message's body is its deltas folded: the whole log, as before.
  await store.append({ threadId: "t1", events: [messageDelta("t1", "m1", "Hel", true), messageDelta("t1", "m1", "lo", true), messageDelta("t1", "m1", "", false)] });
  const message = await store.readItem("t1", "m1");
  assert.deepEqual([message?.kind, message?.kind === "message" ? message.text : null], ["message", "Hello"]);
  // An id the log never wrote costs no read of its own once its cursor is at the end.
  assert.equal(await store.readItem("t1", "never-written"), null);
  reads.length = 0;
  assert.equal(await store.readItem("t1", "never-written"), null);
  assert.deepEqual(reads, []);
  // Deleted and recreated: the new log's item, never the old cursor's line.
  await store.deleteThread("t1");
  await store.append({ threadId: "t1", events: [created("t1"), noise("t1", "pad"), appendable("t1", "x", "tool.started", "call-9", { itemType: "command_execution", title: "v3" })] });
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v3");
});

test("the store's windows never disagree with its whole join: a random log, appended in random batches, paged at every step", async (t) => {
  const { store } = await recordingStore(t, { toolOutputCacheBytes: 64 * 1024 });
  let state = 99;
  const rnd = (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const pieces = ["ab", "é", "語", "😀", "\ud83d", "\ude00", "\n", "", "x".repeat(40)];
  await store.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", "A", { itemType: "command_execution" })] });
  const items = ["start", "c0", "nope"];
  for (let step = 0; step < 60; step += 1) {
    const batch: AppendableDomainEvent[] = [];
    for (let i = 0, size = 1 + rnd(4); i < size; i += 1) {
      const r = rnd(20);
      const id = `c${step}-${i}`;
      if (r < 12) {
        let delta = "";
        for (let k = 0, parts = 1 + rnd(4); k < parts; k += 1) delta += pieces[rnd(pieces.length)];
        batch.push(streamed("t1", step === 0 && i === 0 ? "c0" : id, rnd(4) ? "A" : "B", delta));
      } else if (r === 12) batch.push(appendable("t1", id, "tool.completed", rnd(2) ? "A" : "B"));
      else if (r === 13) batch.push(reverted("t1"));
      else if (r === 14) batch.push(appendable("t1", "start", "tool.updated", rnd(2) ? "A" : "B"));
      else if (r === 15) batch.push(messageDelta("t1", "start", "hi", false));
      else batch.push(noise("t1", id));
    }
    await store.append({ threadId: "t1", events: batch });
    for (const itemId of items) {
      const legacy = await store.readToolOutput("t1", itemId);
      const offset = rnd(64);
      const window = await store.readToolOutputWindow("t1", itemId, { offset, maxBytes: 1 + rnd(9) });
      if (legacy === null) {
        assert.equal(window, null, `step ${step} ${itemId}`);
        continue;
      }
      const whole = Buffer.from(legacy.output, "utf8");
      assert.ok(window !== null, `step ${step} ${itemId}`);
      assert.deepEqual([window.toolUseId, window.totalBytes, window.complete, window.truncated], [legacy.toolUseId, whole.length, legacy.complete, legacy.truncated], `step ${step} ${itemId}`);
      const bytes = Buffer.from(window.text, "utf8");
      assert.ok(bytes.equals(whole.subarray(window.offset, window.offset + bytes.length)), `step ${step} ${itemId}: the window's bytes`);
      assert.ok(window.offset <= Math.min(offset, whole.length) && window.offset >= Math.min(offset, whole.length) - 3);
    }
  }
});

test("an item line that no longer checks out under its cursor is read from the whole log, and the cursor starts over", async (t) => {
  const { store, rootDir, reads } = await recordingStore(t);
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
  reads.length = 0;
  // The log decides: x's newest write is now its first.
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
  assert.deepEqual(reads.map(([, from]) => from), [line.byteOffset, 0], "the recorded line, then the whole log");
  reads.length = 0;
  assert.equal(((await store.readItem("t1", "x")) as { payload: { title: string } }).payload.title, "v1");
  assert.equal(coldReads(reads), 1, "the cursor was rebuilt from the log's start");
});

test("a line that does not decode ends the join for good, as it ends readLog: nothing past it is ever joined or re-read", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const writer = createThreadStore({ rootDir, sweepIntervalMs: 0 });
  await writer.append({ threadId: "t1", events: [created("t1"), appendable("t1", "start", "tool.started", SHELL, { itemType: "command_execution" }), streamed("t1", "o1", SHELL, "before\n")] });
  writer.close();
  await fs.appendFile(path.join(rootDir, "threads", "t1", "events.ndjson"), "not a line of the log\n");
  const reads: Array<[string, number, number]> = [];
  const store = createThreadStore({ rootDir, sweepIntervalMs: 0, onLogRead: (threadId, from, to) => reads.push([threadId, from, to]) });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [streamed("t1", "o2", SHELL, "after\n")] });
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "before\n");
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "later\n")] });
  reads.length = 0;
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  assert.deepEqual(reads, [], "a cursor stopped at a bad line never reads past it");
  assert.equal(await store.readItem("t1", "o3"), null, "an item written past it does not exist for any reader");
});

/** Write a whole log file, one decoded event per line. */
const writeLog = (file: string, events: readonly DomainEvent[]): Promise<void> => fs.writeFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""));

/**
 * The tool-output cache over one log file a test writes itself — so its committed length is simply the file's — with
 * the store's own line decoding. What the store never does to its log (rewrite it, replace it mid-scan) is what these
 * tests do.
 */
function fileCache(file: string, overrides: Partial<Parameters<typeof createToolOutputCache>[0]> = {}): ReturnType<typeof createToolOutputCache> {
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
    maxJoinBytes: 1024 * 1024,
    maxEntries: 16,
    idleMs: 60_000,
    decodeSliceMs: 8,
    yieldToLoop: () => new Promise((resolve) => setImmediate(resolve)),
    ...overrides
  });
}

test("a log that does not continue an entry's cursor — rewritten, or shorter — is read again from its start", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const file = path.join(rootDir, "events.ndjson");
  const write = (events: DomainEvent[]) => writeLog(file, events);
  const reads: number[] = [];
  const cache = fileCache(file, { onLogRead: (_threadId, from) => reads.push(from) });
  seq = 0;
  const start = row("start", "tool.started", SHELL, { itemType: "command_execution" });
  await write([start, chunk("o1", SHELL, "old\n")]);
  assert.equal((await cache.window("t1", "start", {}))?.text, "old\n");
  // The same first line, then another log whose line two is one byte longer: the cursor now sits on its newline,
  // which reads as an empty line followed by a line carrying the cursor's seq + 1 — never the next line the store wrote.
  seq = 1;
  await write([start, chunk("o1", SHELL, "new!\n"), chunk("o2", SHELL, "more\n")]);
  reads.length = 0;
  assert.equal((await cache.window("t1", "start", {}))?.text, "new!\nmore\n");
  assert.ok(reads.includes(0), "rebuilt from the log's start");
  // Two more bytes: the cursor falls inside a line, whose tail does not decode.
  seq = 1;
  await write([start, chunk("o1", SHELL, "newer!\n"), chunk("o2", SHELL, "more\n")]);
  reads.length = 0;
  assert.equal((await cache.window("t1", "start", {}))?.text, "newer!\nmore\n");
  assert.ok(reads.includes(0), "rebuilt from the log's start");
  // Shorter than the cursor: not the log it read either.
  await write([start]);
  assert.deepEqual(await cache.window("t1", "start", {}), { toolUseId: SHELL, offset: 0, text: "", totalBytes: 0, complete: false, truncated: false });
});

test("a thread deleted while one of its entries is read publishes nothing from the old log: the read starts over on the new one", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const file = path.join(rootDir, "events.ndjson");
  seq = 0;
  const start = row("start", "tool.started", SHELL, { itemType: "command_execution" });
  const oldLog = [start, chunk("o1", SHELL, "old one\n"), chunk("o2", SHELL, "old two\n"), chunk("o3", SHELL, "old three\n")];
  seq = 1;
  const newLog = [start, chunk("n1", SHELL, "new\n")];
  // A scan yields after every line here, so the seam runs mid-scan: the `at`-th time, the thread is deleted and its
  // id recreated — the log replaced by a new file under the same name, then `dropThread`, as `deleteThread` does.
  // The old log has four lines: yields 1-4 are the item's scan, 5-8 the join's.
  for (const [phase, at] of [["during the item's scan", 1], ["during the join's scan", 5]] as const) {
    await writeLog(file, oldLog);
    let yields = 0;
    let replaced = false;
    const cache: ReturnType<typeof createToolOutputCache> = fileCache(file, {
      decodeSliceMs: 0,
      yieldToLoop: async () => {
        yields += 1;
        if (yields === at) {
          await fs.rm(file);
          await writeLog(file, newLog);
          cache.dropThread("t1");
          replaced = true;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    const window = await cache.window("t1", "start", {});
    assert.ok(replaced, `${phase}: precondition, the log was replaced mid-scan`);
    assert.deepEqual(window, { toolUseId: SHELL, offset: 0, text: "new\n", totalBytes: 4, complete: false, truncated: false }, phase);
  }
});

test("a read whose thread is deleted under it on every attempt gives up after three, rather than answer from two logs", async (t) => {
  const rootDir = await tempRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const file = path.join(rootDir, "events.ndjson");
  seq = 0;
  await writeLog(file, [row("start", "tool.started", SHELL, { itemType: "command_execution" }), chunk("o1", SHELL, "one\n")]);
  let scans = 0;
  const cache: ReturnType<typeof createToolOutputCache> = fileCache(file, {
    decodeSliceMs: 0,
    onLogRead: () => {
      scans += 1;
    },
    yieldToLoop: async () => {
      cache.dropThread("t1");
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  await assert.rejects(cache.window("t1", "start", {}), /thread t1 was deleted while its log was read/);
  assert.equal(scans, 3, "three attempts, each fenced off before its item's scan could publish");
  await assert.rejects(cache.itemWrite("t1", "start"), /thread t1 was deleted while its log was read/);
  assert.equal(scans, 6);
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
  const reads: Array<[string, number, number]> = [];
  const store = createThreadStore({ rootDir, sweepIntervalMs: 0, onLogRead: (threadId, from, to) => reads.push([threadId, from, to]) });
  t.after(() => store.close());
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "before\n", "readLog stops there");
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  await store.append({ threadId: "t1", events: [streamed("t1", "o4", SHELL, "appended later\n")] });
  reads.length = 0;
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "before\n");
  assert.deepEqual(reads, [], "a cursor stopped at the regression never reads past it");
});

test("an append that fails and is rolled back never reaches the cache — not even read while its bytes were on disk", async (t) => {
  const { store, rootDir, reads } = await recordingStore(t);
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
  reads.length = 0;
  await store.append({ threadId: "t1", events: [streamed("t1", "o3", SHELL, "two\n")] });
  assert.equal((await store.readToolOutputWindow("t1", "start", {}))?.text, "one\ntwo\n");
  assert.equal(coldReads(reads), 0);
  assert.equal((await store.readToolOutput("t1", "start"))?.output, "one\ntwo\n");
});
