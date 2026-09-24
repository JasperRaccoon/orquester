import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ThreadItemOutputResponse, ThreadItemResponse } from "@orquester/api/agent-chat";

import { joinLifecycleDetails } from "../../components/agent-chat/timeline/row-chrome";
import type { WorkLogEntry } from "./contracts";
import { deriveWorkLogEntries } from "./entries.logic";
import {
  createViewerReads,
  fullOutputNotes,
  fullOutputSourceOf,
  readFullOutput,
  type FullOutputReads
} from "./full-output";
import { activity, resetBuilders } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

/** The reads the viewer makes, recorded; each answers what the test gives it. */
function reads(answers: {
  item?: (itemId: string) => Promise<ThreadItemResponse>;
  streamedOutput?: (itemId: string) => Promise<ThreadItemOutputResponse | null>;
}): FullOutputReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    item: (itemId) => {
      asked.push(`item ${itemId}`);
      return answers.item ? answers.item(itemId) : Promise.reject(new Error("no item read expected"));
    },
    streamedOutput: (itemId) => {
      asked.push(`output ${itemId}`);
      return answers.streamedOutput ? answers.streamedOutput(itemId) : Promise.reject(new Error("no join read expected"));
    }
  };
}

const join = (output: string, over: Partial<ThreadItemOutputResponse> = {}): ThreadItemOutputResponse => ({
  toolUseId: "call-1",
  output,
  complete: true,
  truncated: false,
  ...over
});

describe("the row's Load full output", () => {
  const row = (over: Partial<WorkLogEntry>): WorkLogEntry => ({
    id: "a1",
    createdAt: "2026-09-24T10:00:00.000Z",
    turnId: "t1",
    label: "npm test",
    tone: "tool",
    ...over
  });

  it("a command whose output streamed offers it whether or not its own payload was cut, and reads the join", () => {
    assert.equal(fullOutputSourceOf(row({ itemType: "command_execution", streamedOutput: true })), "streamed");
    assert.equal(fullOutputSourceOf(row({ itemType: "command_execution", streamedOutput: true, truncated: true })), "streamed");
  });

  it("a row whose payload the wire cut offers its item; a plain one offers nothing", () => {
    assert.equal(fullOutputSourceOf(row({ itemType: "file_change", truncated: true })), "item");
    assert.equal(fullOutputSourceOf(row({ itemType: "command_execution", detail: "2 passed" })), null);
  });
});

describe("the full-output viewer's read", () => {
  it("shows the whole output of a command whose early chunks the window evicted — not what the window still holds", async () => {
    // 600 lines streamed; the window kept the call's completion — its detail a preview, its own payload not marked
    // cut — and its last two chunks.
    const whole = Array.from({ length: 600 }, (_, index) => `line ${index + 1}\n`).join("");
    const completion = activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-1", title: "npm test", command: "npm test", status: "completed", detail: "line 1" },
      { turnId: "t1" }
    );
    const kept = [599, 600].map((line) =>
      activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta: `line ${line}\n` }, { turnId: "t1" })
    );
    const [entry] = joinLifecycleDetails(deriveWorkLogEntries([...kept, completion]));
    assert.equal(entry?.detail, "line 599\nline 600\n", "the row shows what the window holds");
    assert.equal(entry?.truncated, undefined, "and nothing cut its own payload");
    const source = fullOutputSourceOf(entry!);
    assert.equal(source, "streamed");

    const viewer = reads({ streamedOutput: async () => join(whole) });
    const output = await readFullOutput(viewer, entry!.id, source!);

    assert.deepEqual(output, { kind: "streamed", text: whole, running: false, cut: false });
    assert.deepEqual(viewer.asked, [`output ${completion.id}`], "the call's join, named by the row's own item");
  });

  it("a running call's output is what exists now, and a join past the host's cap is its head: both are said", async () => {
    const running = await readFullOutput(reads({ streamedOutput: async () => join("so far\n", { complete: false }) }), "a1", "streamed");
    assert.deepEqual(running, { kind: "streamed", text: "so far\n", running: true, cut: false });
    assert.deepEqual(fullOutputNotes(running), ["Still running — this is its output so far."]);

    const cut = await readFullOutput(reads({ streamedOutput: async () => join("head\n", { truncated: true }) }), "a1", "streamed");
    assert.deepEqual(fullOutputNotes(cut), ["Only the first 8 MiB of this output were kept."]);

    const both = await readFullOutput(
      reads({ streamedOutput: async () => join("head\n", { complete: false, truncated: true }) }),
      "a1",
      "streamed"
    );
    assert.equal(fullOutputNotes(both).length, 2);
    assert.deepEqual(fullOutputNotes({ kind: "streamed", text: "all\n", running: false, cut: false }), []);
  });

  it("reads the item where the host has no join to give — a 404 — or the call streamed nothing: never an error", async () => {
    const item = activity("tool.completed", { itemType: "command_execution", toolUseId: "call-1", status: "completed" }, { id: "a1" });
    for (const answer of [null, join("")]) {
      const viewer = reads({ streamedOutput: async () => answer, item: async () => ({ item }) });
      assert.deepEqual(await readFullOutput(viewer, "a1", "streamed"), { kind: "item", item });
      assert.deepEqual(viewer.asked, ["output a1", "item a1"]);
    }
  });

  it("a row whose payload the wire cut reads its item alone: the join is never asked", async () => {
    const item = activity("tool.completed", { itemType: "file_change", toolUseId: "call-e", status: "completed" }, { id: "e1" });
    const viewer = reads({ item: async () => ({ item }) });
    assert.deepEqual(await readFullOutput(viewer, "e1", "item"), { kind: "item", item });
    assert.deepEqual(await readFullOutput(viewer, "e1"), { kind: "item", item });
    assert.deepEqual(viewer.asked, ["item e1", "item e1"]);
    assert.deepEqual(fullOutputNotes({ kind: "item", item }), []);
  });

  it("a join read that fails is the viewer's error, not a quiet fallback", async () => {
    const viewer = reads({ streamedOutput: async () => Promise.reject(new Error("The agent host is restarting.")) });
    await assert.rejects(() => readFullOutput(viewer, "a1", "streamed"), /restarting/);
    assert.deepEqual(viewer.asked, ["output a1"]);
  });
});

describe("the viewer's reads, one at a time", () => {
  it("a new read retires the one before it, and closing the viewer retires the last", () => {
    const viewer = createViewerReads();
    const first = viewer.begin();
    const second = viewer.begin();
    assert.equal(first.aborted, true, "its answer is dropped, and its next window never asked for");
    assert.equal(second.aborted, false);
    viewer.retire();
    assert.equal(second.aborted, true, "a closed viewer is never reopened by a late answer");
    viewer.retire();
    assert.equal(viewer.begin().aborted, false, "and the next read starts afresh");
  });
});
