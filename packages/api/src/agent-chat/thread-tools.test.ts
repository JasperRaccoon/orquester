/**
 * The thread and delegation tools' link to the thread they acted on (design 2026-10-14 §5): kept
 * through slimming on every provider's row, read only off a marked session-tool row.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sessionToolMarkedData, SESSION_TOOL_REFERENCE_KEYS } from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";
import {
  readThreadToolReference,
  THREAD_TOOL_REFERENCE_KEY,
  threadToolReference,
  threadToolReferenceOfActivityData
} from "./thread-tools.ts";

const ref = { threadId: "c7", title: "Task: audit", relation: "delegate" };
/** A long result, as delegate_task's can be once it quotes a reply: slimming summarises it. */
const resultText = JSON.stringify({ notice: "data", taskId: "c7", result: "x".repeat(20_000), threadRef: ref });

test("the reference key is a session-tool reference key", () => {
  assert.ok(SESSION_TOOL_REFERENCE_KEYS.includes(THREAD_TOOL_REFERENCE_KEY));
});

test("every provider's row keeps the link through slimming, twice", () => {
  const rows = [
    // Claude: a tool_result's text block.
    { toolName: "mcp__orquester__task_wait", input: {}, result: { type: "tool_result", content: [{ type: "text", text: resultText }] } },
    // Codex: structuredContent beside the text.
    { server: "orquester", tool: "task_wait", arguments: {}, result: { content: [{ type: "text", text: resultText }], structuredContent: JSON.parse(resultText) } },
    // OpenCode: the output text.
    { tool: "orquester-0123456789abcdef_task_wait", state: { output: resultText } },
    // Grok's use_tool: the joined OkayOutput.
    { vendorTool: "use_tool", rawInput: { tool_name: "orquester__task_wait" }, rawOutput: { type: "MCP", output: { OkayOutput: `${resultText}\n${resultText}` } } }
  ];
  for (const data of rows) {
    const payload = { itemType: "mcp_tool_call", status: "completed", data: sessionToolMarkedData(data, new Set(["task_wait"])) };
    assert.deepEqual(threadToolReferenceOfActivityData(payload.data), ref);
    const once = slimActivityPayload(payload) as { data: Record<string, unknown> };
    const twice = slimActivityPayload(once) as { data: Record<string, unknown> };
    assert.deepEqual(threadToolReferenceOfActivityData(once.data), ref, JSON.stringify(Object.keys(data)));
    assert.deepEqual(threadToolReferenceOfActivityData(twice.data), ref);
  }
});

test("an unmarked row — a user's same-named server — makes no link, and a malformed reference is none", () => {
  const data = { toolName: "mcp__orquester__task_wait", input: {}, result: { content: [{ type: "text", text: resultText }] } };
  assert.equal(threadToolReferenceOfActivityData(data), undefined);
  assert.equal(readThreadToolReference({ threadId: "", title: "x", relation: "delegate" }), undefined);
  assert.equal(readThreadToolReference({ threadId: "c1", title: "x", relation: "sibling" }), undefined);
  assert.equal(readThreadToolReference("c1"), undefined);
  assert.deepEqual(readThreadToolReference({ threadId: "c1", title: 5, relation: "fork" }), { threadId: "c1", title: "", relation: "fork" });
});

test("a built reference trims and caps its title", () => {
  const built = threadToolReference("c1", `  ${"t".repeat(300)}  `, "thread");
  assert.equal(built.title.length, 200);
  assert.ok(built.title.endsWith("…"));
});
