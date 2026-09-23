/**
 * A tool call's streamed output, joined from the log (`GET …/items/:itemId/output`): the pure join over a log's
 * events, then the real pipeline — ingestion's `tool.output` rows, appended by the real store, read back by it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { commandOutputText, type DomainEvent, type ThreadActivityItem } from "@orquester/api/agent-chat";

import { backgroundShellItemId } from "../adapters/claude/normalize.ts";
import { BATCH_INTERVAL_MS, createIngestion } from "../ingestion/index.ts";
import { FakeClock, FakeTimers, RecordingLiveness, counterIdGen, runtimeEvent } from "../ingestion/test-harness.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "./index.ts";
import { joinToolOutput } from "./tool-output.ts";

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
