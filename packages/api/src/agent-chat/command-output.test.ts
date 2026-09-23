/**
 * What a command row shows under its label (§7.2): the provider's `detail`,
 * or the output its data carries where that detail says less. These pin the
 * rule the GUI's timeline and the MCP's transcript share — the output
 * locations and their order, and when a `detail` is an echo of the command.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { commandDisplayDetail } from "./command-output.ts";
import { slimActivityPayload } from "./slim.ts";

const command = (fields: Record<string, unknown>) => ({ itemType: "command_execution", ...fields });

test("Codex: a command with no detail shows its item's aggregatedOutput, trimmed", () => {
  const payload = command({
    title: "Bash",
    data: { item: { command: "ls -1", aggregatedOutput: "a\nb\n" } }
  });
  assert.equal(commandDisplayDetail(payload), "a\nb");
  // The item's result is the next place, when there is no aggregated output.
  const result = command({ data: { item: { result: { content: "  done  " } } } });
  assert.equal(commandDisplayDetail(result), "done");
});

test("a detail that repeats the row's title gives way to the output", () => {
  const payload = command({
    title: "pnpm test",
    detail: "pnpm test",
    data: { item: { aggregatedOutput: "2 passed\n" } }
  });
  assert.equal(commandDisplayDetail(payload), "2 passed");
  // With no output to show instead, the detail stands.
  assert.equal(commandDisplayDetail(command({ title: "pnpm test", detail: "pnpm test" })), "pnpm test");
});

test("Grok: an executing call whose detail echoes the command shows rawOutput's stdout and stderr, joined", () => {
  const payload = command({
    title: "Execute `echo hi`",
    detail: "echo hi",
    data: { kind: "execute", command: "echo hi", rawOutput: { stdout: "hi\n", stderr: "  warning: slow\n" } }
  });
  assert.equal(commandDisplayDetail(payload), "hi\nwarning: slow");
  const stderrOnly = command({
    detail: "false",
    data: { kind: "execute", command: "false", rawOutput: { stdout: "  ", stderr: "exit 1" } }
  });
  assert.equal(commandDisplayDetail(stderrOnly), "exit 1");
});

test("Grok: ACP content blocks are read when rawOutput says nothing, only their `content` blocks' text", () => {
  const payload = command({
    title: "Execute `echo hi`",
    detail: "echo hi",
    data: {
      kind: "execute",
      command: "echo hi",
      content: [
        { type: "content", content: { type: "text", text: "hi from ACP" } },
        { type: "diff", path: "a.ts", oldText: "", newText: "x" },
        { type: "content", content: { type: "text", text: "   " } },
        { type: "content", content: { type: "text", text: " second block " } }
      ]
    }
  });
  assert.equal(commandDisplayDetail(payload), "hi from ACP\nsecond block");
});

test("an echo with no output yet shows no detail at all: the row already shows the command", () => {
  const echo = command({ detail: "echo hi", data: { kind: "execute", command: "echo hi" } });
  assert.equal(commandDisplayDetail(echo), undefined);
  // A top-level command counts the same as the data's.
  assert.equal(commandDisplayDetail(command({ detail: "echo hi", command: "echo hi", data: { kind: "execute" } })), undefined);
  // Blank output is no output.
  assert.equal(commandDisplayDetail(command({ detail: "echo hi", data: { kind: "execute", command: "echo hi", rawOutput: { stdout: " \n" } } })), undefined);
});

test("an echo cut short with \"...\" or \"…\" is still an echo, and cannot mask the output", () => {
  const longCommand = `echo ${"x".repeat(200)}`;
  for (const cut of [`${longCommand.slice(0, 177)}...`, `${longCommand.slice(0, 80)}…`]) {
    const data = { kind: "execute", command: longCommand };
    assert.equal(commandDisplayDetail(command({ detail: cut, data: { ...data, rawOutput: { content: "done" } } })), "done");
    assert.equal(commandDisplayDetail(command({ detail: cut, data })), undefined);
  }
  // A cut that is not a head of the command is not an echo; nor is a bare ellipsis.
  const data = { kind: "execute", command: longCommand };
  assert.equal(commandDisplayDetail(command({ detail: "rm -rf …", data })), "rm -rf …");
  assert.equal(commandDisplayDetail(command({ detail: "...", data })), "...");
});

test("an echo counts only on a call whose data says it executes (ACP's kind, any case)", () => {
  const data = { command: "ls", rawOutput: { content: "a.ts" } };
  // With no kind (Claude's data carries none), a detail equal to the command stands.
  assert.equal(commandDisplayDetail(command({ detail: "ls", data })), "ls");
  assert.equal(commandDisplayDetail(command({ detail: "ls", data: { ...data, kind: " EXECUTE " } })), "a.ts");
  assert.equal(commandDisplayDetail(command({ detail: "ls", data: { ...data, kind: "read" } })), "ls");
});

test("the output places are read in order, the first non-blank one winning", () => {
  const places: [string, Record<string, unknown>][] = [
    ["aggregatedOutput", { item: { aggregatedOutput: "aggregatedOutput", result: { content: "item result" } } }],
    ["item result", { item: { result: { content: "item result" } }, rawOutput: "raw text" }],
    ["raw text", { rawOutput: "raw text" }],
    ["raw content", { rawOutput: { content: "raw content", stdout: "stdout" } }],
    ["stdout", { rawOutput: { stdout: "stdout", output: "output" } }],
    ["output", { rawOutput: { output: "output", output_for_prompt: "for prompt" } }],
    ["for prompt", { rawOutput: { output_for_prompt: "for prompt" }, content: [{ type: "content", content: { text: "acp" } }] }],
    ["acp", { content: [{ type: "content", content: { text: "acp" } }], result: { content: "result content" } }],
    ["result content", { result: { content: "result content" } }],
    ["result text", { result: "result text" }]
  ];
  for (const [expected, data] of places) {
    assert.equal(commandDisplayDetail(command({ data })), expected, expected);
  }
  // A blank place is passed over, never taken.
  assert.equal(commandDisplayDetail(command({ data: { item: { aggregatedOutput: "  " }, rawOutput: { content: "raw content" } } })), "raw content");
});

test("a provider detail that already says more stands (OpenCode's output, Codex's own detail)", () => {
  const openCode = command({ detail: "first line\nsecond line", data: { command: "cat file", result: "first line" } });
  assert.equal(commandDisplayDetail(openCode), "first line\nsecond line");
  assert.equal(commandDisplayDetail(command({ detail: "  2 passed  ", data: { command: "pnpm test" } })), "2 passed");
});

test("any other row shows its own detail, trimmed, whatever output its data carries", () => {
  const patch = { itemType: "file_change", title: "Edit", detail: "  3 lines ", data: { rawOutput: { content: "x" } } };
  assert.equal(commandDisplayDetail(patch), "3 lines");
  assert.equal(commandDisplayDetail({ itemType: "mcp_tool_call", data: { result: "r" } }), undefined);
  for (const payload of [null, undefined, "text", 7, ["detail"]]) {
    assert.equal(commandDisplayDetail(payload), undefined);
  }
});

test("options.detail is the detail the caller kept: none reads as an empty one", () => {
  const payload = command({ title: "t", detail: "the label", data: { rawOutput: { content: "out" } } });
  assert.equal(commandDisplayDetail(payload), "the label");
  assert.equal(commandDisplayDetail(payload, { detail: undefined }), "out");
  assert.equal(commandDisplayDetail({ detail: "the label" }, { detail: undefined }), undefined);
  assert.equal(commandDisplayDetail({ detail: "ignored" }, { detail: "kept" }), "kept");
});

test("the output survives the wire projection every read path applies", () => {
  const grok = slimActivityPayload(command({
    title: "Execute `echo hi`",
    detail: "echo hi",
    data: { kind: "execute", command: "echo hi", rawOutput: { stdout: "hi\n", output_for_prompt: "exit: 0\nhi\n" } }
  }));
  assert.equal(commandDisplayDetail(grok), "hi");
  const acp = slimActivityPayload(command({
    detail: "echo hi",
    data: { kind: "execute", command: "echo hi", content: [{ type: "content", content: { type: "text", text: "hi from ACP" } }] }
  }));
  assert.equal(commandDisplayDetail(acp), "hi from ACP");
  // Codex's aggregated output reaches the wire as its first meaningful line.
  const codex = slimActivityPayload(command({ title: "Bash", data: { item: { command: "pnpm test", aggregatedOutput: "\n> pnpm test\n2 passed\n" } } }));
  assert.equal(commandDisplayDetail(codex), "> pnpm test");
});
