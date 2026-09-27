import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  slimActivityPayload,
  TASK_PROMPT_MAX_CHARS,
  type ThreadActivityItem,
  type ThreadItemOutputResponse,
  type ThreadItemResponse
} from "@orquester/api/agent-chat";

import { joinLifecycleDetails } from "../../components/agent-chat/timeline/row-chrome";
import type { WorkLogEntry } from "./contracts";
import { deriveWorkLogEntries } from "./entries.logic";
import {
  createViewerReads,
  fullOutputNotes,
  fullOutputSourceOf,
  fullOutputText,
  fullOutputViewerCopy,
  readFullOutput,
  type FullOutputReads
} from "./full-output";
import { activity, message, resetBuilders } from "./test-helpers";

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
      return answers.streamedOutput
        ? answers.streamedOutput(itemId)
        : Promise.reject(new Error("no join read expected"));
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
    assert.equal(
      fullOutputSourceOf(row({ itemType: "command_execution", streamedOutput: true, truncated: true })),
      "streamed"
    );
  });

  it("a row whose payload the wire cut offers its item; a plain one offers nothing", () => {
    assert.equal(fullOutputSourceOf(row({ itemType: "file_change", truncated: true })), "item");
    assert.equal(fullOutputSourceOf(row({ itemType: "command_execution", detail: "2 passed" })), null);
  });
});

describe("the full-output viewer's read", () => {
  it("shows the whole output of a command whose early chunks the window evicted, not what it still holds", async () => {
    // 600 lines streamed; the window kept the call's completion — its detail a preview, its own payload not marked
    // cut — and its last two chunks.
    const whole = Array.from({ length: 600 }, (_, index) => `line ${index + 1}\n`).join("");
    const completion = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "call-1",
        title: "npm test",
        command: "npm test",
        status: "completed",
        detail: "line 1"
      },
      { turnId: "t1" }
    );
    const kept = [599, 600].map((line) =>
      activity(
        "tool.output",
        { toolUseId: "call-1", streamKind: "command_output", delta: `line ${line}\n` },
        { turnId: "t1" }
      )
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

  it("a running call's output is what exists now, and a join past the host's cap is its head: both said", async () => {
    const running = await readFullOutput(
      reads({ streamedOutput: async () => join("so far\n", { complete: false }) }),
      "a1",
      "streamed"
    );
    assert.deepEqual(running, { kind: "streamed", text: "so far\n", running: true, cut: false });
    assert.deepEqual(fullOutputNotes(running), ["Still running — this is its output so far."]);

    const cut = await readFullOutput(
      reads({ streamedOutput: async () => join("head\n", { truncated: true }) }),
      "a1",
      "streamed"
    );
    // The log keeps every chunk: only this read stops at the host's cap.
    assert.deepEqual(fullOutputNotes(cut), ["Only the first 8 MiB of this output can be shown here."]);

    const both = await readFullOutput(
      reads({ streamedOutput: async () => join("head\n", { complete: false, truncated: true }) }),
      "a1",
      "streamed"
    );
    assert.equal(fullOutputNotes(both).length, 2);
    assert.deepEqual(fullOutputNotes({ kind: "streamed", text: "all\n", running: false, cut: false }), []);
  });

  it("reads the item where the host has no join (a 404) or the call streamed nothing: never an error", async () => {
    const item = activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-1", status: "completed" },
      { id: "a1" }
    );
    for (const answer of [null, join("")]) {
      const viewer = reads({ streamedOutput: async () => answer, item: async () => ({ item }) });
      assert.deepEqual(await readFullOutput(viewer, "a1", "streamed"), { kind: "item", item });
      assert.deepEqual(viewer.asked, ["output a1", "item a1"]);
    }
  });

  it("a row whose payload the wire cut reads its item alone: the join is never asked", async () => {
    const item = activity(
      "tool.completed",
      { itemType: "file_change", toolUseId: "call-e", status: "completed" },
      { id: "e1" }
    );
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

describe("a Codex completion that kept only its output's head (stored cut past 64 KiB)", () => {
  // As the Codex adapter stores a command whose output passed its bound (`boundCommandOutput`): the whole output up to
  // 64 KiB in `data.item.aggregatedOutput`, only its head past that, and the payload marked `truncated`.
  const whole = Array.from({ length: 3_000 }, (_, index) => `ok ${index} - parses case ${index}\n`).join("");
  const head = whole.slice(0, 1_000);
  const codex = (payload: Record<string, unknown>): ThreadActivityItem =>
    activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "item_7",
        title: "pnpm test",
        detail: `${whole.slice(0, 177)}...`,
        status: "completed",
        data: {
          command: "pnpm test",
          cwd: "/w/p",
          source: "unifiedExecStartup",
          commandActions: [],
          exitCode: 0,
          durationMs: 812,
          item: { aggregatedOutput: head }
        },
        ...payload
      },
      { id: "done-7", turnId: "t1" }
    );
  const stored = codex({ truncated: true });
  // The row as the timeline derives it from what a snapshot sends: slimmed on the wire (§5.6), and none of the call's
  // chunks in view — the retention boundary between its last chunk and its completion, or a page between them.
  const rowOf = (item: ThreadActivityItem): WorkLogEntry => {
    const wire = { ...item, payload: slimActivityPayload(item.payload) } as ThreadActivityItem;
    const [row] = joinLifecycleDetails(deriveWorkLogEntries([wire]));
    assert.ok(row !== undefined);
    return row;
  };

  it("reads the call's join before its item's head: the host holds the whole output", async () => {
    const row = rowOf(stored);
    assert.equal(row.streamedOutput, undefined, "no chunk of the call in view");
    assert.equal(fullOutputSourceOf(row), "item");
    const viewer = reads({
      item: async () => ({ item: stored }),
      streamedOutput: async () => join(whole, { toolUseId: "item_7" })
    });

    assert.deepEqual(await readFullOutput(viewer, row.id, "item"), {
      kind: "streamed",
      text: whole,
      running: false,
      cut: false
    });
    assert.deepEqual(viewer.asked, ["item done-7", "output done-7"], "the item first, then (stored cut) the join");
  });

  it("shows the head as the command printed it, saying only part was kept, where no join answers", async () => {
    for (const answer of [join("", { toolUseId: "item_7" }), null]) {
      const viewer = reads({ item: async () => ({ item: stored }), streamedOutput: async () => answer });
      const output = await readFullOutput(viewer, stored.id, "item");
      assert.deepEqual(output, { kind: "kept", text: head });
      assert.deepEqual(fullOutputNotes(output), ["Only part of this output was kept."]);
    }
  });

  it("asks the join once: a row that streamed read it first, and its item's head answers after", async () => {
    const viewer = reads({
      item: async () => ({ item: stored }),
      streamedOutput: async () => join("", { toolUseId: "item_7" })
    });
    assert.deepEqual(await readFullOutput(viewer, stored.id, "streamed"), { kind: "kept", text: head });
    assert.deepEqual(viewer.asked, ["output done-7", "item done-7"]);
  });

  it("a completion that kept its whole output still reads it, and never asks the join", async () => {
    const intact = codex({ data: { command: "pnpm test", item: { aggregatedOutput: head } } });
    const viewer = reads({ item: async () => ({ item: intact }) });
    const output = await readFullOutput(viewer, intact.id, "item");
    assert.deepEqual(output, { kind: "item", item: intact });
    assert.equal(fullOutputText(intact), head);
    assert.deepEqual(fullOutputNotes(output), []);
    assert.deepEqual(viewer.asked, ["item done-7"]);
  });

  it("an update stored cut reads the join too, then (nothing streamed) its payload, never its preview", async () => {
    // Ingestion persists every tool.updated already slimmed (§5.6): its data is a one-line preview, no part of it.
    const live = activity(
      "tool.updated",
      {
        itemType: "command_execution",
        toolUseId: "item_7",
        status: "inProgress",
        data: { item: { command: "pnpm test", aggregatedOutput: whole } }
      },
      { id: "live-7", turnId: "t1" }
    );
    const update = { ...live, payload: slimActivityPayload(live.payload) } as ThreadActivityItem;
    const viewer = reads({
      item: async () => ({ item: update }),
      streamedOutput: async () => join("", { toolUseId: "item_7" })
    });
    const output = await readFullOutput(viewer, update.id, "item");
    assert.deepEqual(output, { kind: "item", item: update });
    assert.equal(fullOutputText(update), JSON.stringify(update.payload, null, 2));
    assert.deepEqual(viewer.asked, ["item live-7", "output live-7"]);
  });
});

describe("an OpenCode completion whose final output the tool cut (the END of it, behind its note)", () => {
  // As the OpenCode adapter stores a `bash` completion that 1.18.32's `ShellTool.run` cut past its limits: the final
  // output in `data.result` — the note naming the saved file, then the LAST lines — and the payload marked `truncated`.
  const printed = Array.from({ length: 3_000 }, (_, index) => `line ${index}\n`).join("");
  const saved = "/home/u/.local/share/opencode/tool-output/tool_0c9a";
  const kept = `...output truncated...\n\nFull output saved to: ${saved}\n\n${printed.slice(-2_000)}`;
  const stored = activity(
    "tool.completed",
    {
      itemType: "command_execution",
      toolUseId: "call_bash",
      title: "seq 0 2999",
      status: "completed",
      truncated: true,
      data: { tool: "bash", toolUseId: "call_bash", command: "seq 0 2999", result: kept }
    },
    { id: "done-oc", turnId: "t1" }
  );

  it("reads the call's join first: every line the command printed, and where the whole was saved", async () => {
    const whole = `${printed}\n\nFull output saved to: ${saved}`;
    const viewer = reads({ streamedOutput: async () => join(whole, { toolUseId: "call_bash" }) });
    assert.deepEqual(await readFullOutput(viewer, stored.id, "streamed"), {
      kind: "streamed",
      text: whole,
      running: false,
      cut: false
    });
    assert.deepEqual(viewer.asked, ["output done-oc"]);
  });

  it("with no join to give, shows the part the tool kept as text, saying only part was kept — never that it is the start", async () => {
    for (const answer of [join("", { toolUseId: "call_bash" }), null]) {
      const viewer = reads({ item: async () => ({ item: stored }), streamedOutput: async () => answer });
      const output = await readFullOutput(viewer, stored.id, "streamed");
      assert.deepEqual(output, { kind: "kept", text: kept });
      assert.deepEqual(fullOutputNotes(output), ["Only part of this output was kept."]);
    }
  });
});

describe("the viewer's text for an item", () => {
  it("a command's output as the command printed it, where its own data carries it: a Codex completion's", () => {
    // Where the Codex adapter keeps a completion's output (whole up to 64 KiB): `data.item.aggregatedOutput`.
    const output = "PASS a.test.ts\n  ✓ adds\n\nTests: 1 passed\n";
    const codex = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "item_7",
        title: "npm test",
        detail: "PASS a.test.ts",
        status: "completed",
        data: {
          command: "npm test",
          cwd: "/w/p",
          source: "agent",
          commandActions: [],
          exitCode: 0,
          durationMs: 812,
          item: { aggregatedOutput: output }
        }
      },
      { turnId: "t1" }
    );
    assert.equal(fullOutputText(codex), output);
  });

  it("and a Claude Bash call's, its result's text", () => {
    const bash = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "toolu_1",
        title: "Command run",
        detail: "Bash: ls",
        status: "completed",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          result: { type: "tool_result", tool_use_id: "toolu_1", content: "a.ts\nb.ts\n" }
        }
      },
      { turnId: "t1" }
    );
    assert.equal(fullOutputText(bash), "a.ts\nb.ts\n");
  });

  it("never out of an item stored cut: its data holds only a head, so the payload shows, as JSON", () => {
    const cut = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "item_8",
        status: "completed",
        truncated: true,
        data: { command: "cat big.log", item: { aggregatedOutput: "the first 64 KiB" } }
      },
      { turnId: "t1" }
    );
    assert.equal(fullOutputText(cut), JSON.stringify(cut.payload, null, 2));
  });

  it("anything else as the viewer always showed it: a message's text, a string payload, JSON, else the summary", () => {
    assert.equal(fullOutputText(message("assistant", "done")), "done");
    assert.equal(fullOutputText(activity("runtime.warning", "as it is")), "as it is");
    const edit = activity(
      "tool.completed",
      { itemType: "file_change", toolUseId: "call-e", status: "completed", data: { changes: [{ path: "/w/p/a.ts" }] } },
      { turnId: "t1" }
    );
    assert.equal(fullOutputText(edit), JSON.stringify(edit.payload, null, 2));
    // A command whose data carries no output — a background shell's completion — is its payload too.
    const shell = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "bgshell:t1",
        status: "completed",
        data: { input: { command: "npm run dev" }, exitCode: 0 }
      },
      { turnId: "t1" }
    );
    assert.equal(fullOutputText(shell), JSON.stringify(shell.payload, null, 2));
    assert.equal(fullOutputText(activity("tool.completed", undefined, { summary: "Ran a command" })), "Ran a command");
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

describe("an agent's launch prompt in the viewer (§7.6: a wire-cut prompt's 'Show full prompt')", () => {
  const start = (extra: Record<string, unknown>) =>
    activity("task.started", { taskId: "a1", agentKind: "agent", title: "Find callers", ...extra }, { turnId: "t1" });

  it("shows the prompt itself, never its launch row as JSON", () => {
    const whole = "Find every caller of parse().\n".repeat(900);
    assert.equal(fullOutputText(start({ prompt: whole })), whole);
    assert.deepEqual(fullOutputNotes({ kind: "item", item: start({ prompt: whole }) }), []);
  });

  it("says when only the prompt's start was ever kept, and names the cap it was cut at", () => {
    const item = start({ prompt: "The start of it", promptTruncated: true });
    const notes = fullOutputNotes({ kind: "item", item });
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /^Only the start of this prompt was kept/);
    // `TASK_PROMPT_MAX_CHARS` counts UTF-16 units, cut on a code point: an upper bound in characters.
    assert.ok(
      notes[0]!.includes(`up to ${TASK_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters`),
      `the note names ingestion's cap at rest: ${notes[0]}`
    );
  });

  it("a start with no prompt is its payload, as before", () => {
    const item = start({});
    assert.equal(fullOutputText(item), JSON.stringify(item.payload, null, 2));
  });
});

describe("a wire-cut launch prompt never makes its spawn row a 'Load full output' (review M2)", () => {
  it("a task row is no tool output: the prompt has its own read, the prompt row's", () => {
    // Over 16 KiB of UTF-8 — about 5.4 K CJK characters is enough — the wire cuts it and stamps `truncated`.
    const payload = slimActivityPayload({
      taskId: "agent-1",
      agentKind: "agent",
      taskType: "subagent",
      toolUseId: "call-agent",
      title: "Audit",
      prompt: "監".repeat(6_000)
    }) as Record<string, unknown>;
    assert.equal(payload.truncated, true, "the wire did cut it");
    const [spawn] = deriveWorkLogEntries([activity("task.started", payload, { turnId: "t1", tone: "info" })]);
    assert.ok(spawn?.agentSpawn, "the launch is the batch's spawn row");
    assert.equal(spawn.truncated, undefined, "no promise of more output on it");
    assert.equal(fullOutputSourceOf(spawn), null);
  });

  it("a task's end carries none either", () => {
    const payload = slimActivityPayload({
      taskId: "agent-1",
      agentKind: "agent",
      status: "completed",
      summary: "監".repeat(6_000)
    }) as Record<string, unknown>;
    const [end] = deriveWorkLogEntries([activity("task.completed", payload, { turnId: "t1", tone: "info" })]);
    assert.equal(end?.truncated, undefined);
  });
});

describe("the viewer's copy follows what it reads (review N1)", () => {
  it("a launch prompt's viewer is titled for a prompt", () => {
    assert.deepEqual(fullOutputViewerCopy("prompt"), {
      title: "Prompt",
      missing: "That prompt is no longer available."
    });
  });

  it("an output's, as before", () => {
    for (const source of [undefined, "item", "streamed"] as const) {
      assert.deepEqual(fullOutputViewerCopy(source), {
        title: "Full output",
        missing: "That output is no longer available."
      });
    }
  });

  it("a prompt is read as its item", async () => {
    const item = activity("task.started", { taskId: "a1", prompt: "The whole prompt." }, { turnId: "t1" });
    const read = reads({ item: async () => ({ item }) as unknown as ThreadItemResponse });
    const output = await readFullOutput(read, item.id, "prompt");
    assert.deepEqual(read.asked, [`item ${item.id}`]);
    assert.equal(output.kind === "item" ? fullOutputText(output.item) : null, "The whole prompt.");
  });
});
