/**
 * The thread and delegation tools' link to the thread they acted on (design 2026-10-14 §5): kept
 * through slimming on every provider's row, read only off a marked session-tool row.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sessionToolMarkedData, SESSION_TOOL_REFERENCE_KEYS } from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";
import { parseThreadLineage } from "./lineage.ts";
import {
  buildThreadMessage,
  parseThreadMessage,
  THREAD_MESSAGE_OVERHEAD_CHARS,
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

test("a message another thread caused round-trips: who, how, and the text alone", () => {
  for (const origin of ["sent", "opened", "delegated"] as const) {
    const text = buildThreadMessage({ origin, fromTitle: 'A "quoted"\ntitle', text: "  do X\n\nthen Y  " });
    assert.deepEqual(parseThreadMessage(text), { origin, fromTitle: 'A "quoted" title', body: "do X\n\nthen Y" });
  }
  assert.equal(parseThreadMessage("hello"), null);
  assert.equal(parseThreadMessage('[Sent by thread "x"] trailing'), null);
});

test("a lineage's delegation depth is read tolerantly: a bad one is dropped on its own", () => {
  const base = { parentThreadId: "p", relation: "delegate", createdAt: "t" };
  assert.equal(parseThreadLineage({ ...base, delegationDepth: 2 })?.delegationDepth, 2);
  for (const bad of [-1, 1.5, "2", 65]) {
    const lineage = parseThreadLineage({ ...base, delegationDepth: bad });
    assert.equal(lineage?.parentThreadId, "p");
    assert.equal(lineage?.delegationDepth, undefined, String(bad));
  }
});

test("the provenance header never outgrows its budget, whatever the title — quotes and backslashes included (T6-M1)", () => {
  for (const title of ['"'.repeat(300), "\\".repeat(300), `${"x".repeat(199)}"tail`, "😀".repeat(150), "a\\\"b".repeat(80)]) {
    for (const origin of ["sent", "opened", "delegated"] as const) {
      const message = buildThreadMessage({ origin, fromTitle: title, text: "body" });
      assert.ok(message.length - "body".length <= THREAD_MESSAGE_OVERHEAD_CHARS, `${origin}: ${message.length}`);
      const parsed = parseThreadMessage(message);
      assert.ok(parsed, "still reads back");
      assert.equal(parsed.body, "body");
      assert.ok(title.startsWith(parsed.fromTitle), "a prefix of the title, never a broken escape");
    }
  }
});
