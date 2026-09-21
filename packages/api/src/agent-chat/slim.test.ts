/**
 * Activity payload slimming (§5.6). Cases derived from T3 Code (MIT):
 * `apps/server/src/orchestration/ActivityPayloadProjection.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_ITEM_KEPT_FIELDS,
  SLIM_MAX_CHANGED_FILES,
  SLIM_MAX_STRING_BYTES,
  SLIM_SUMMARY_ELIDE_CHARS,
  slimActivityPayload,
  summarizeToolTextOutput
} from "./slim.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", "expected a record");
  return value as Record<string, unknown>;
}

test("a payload with no data record is returned by identity", () => {
  const payload = { itemType: "command_execution", title: "ls" };
  assert.equal(slimActivityPayload(payload), payload);
});

test("a non-record payload passes through", () => {
  assert.equal(slimActivityPayload("hello"), "hello");
  assert.equal(slimActivityPayload(null), null);
  assert.equal(slimActivityPayload(7), 7);
});

test("summarizeToolTextOutput takes the first meaningful line, elided at 84", () => {
  assert.equal(summarizeToolTextOutput("   \n\n  first line  \nsecond"), "first line");
  const long = "x".repeat(200);
  const summary = summarizeToolTextOutput(long)!;
  assert.equal(summary.length, SLIM_SUMMARY_ELIDE_CHARS);
  assert.ok(summary.endsWith("…"));
});

test("summarizeToolTextOutput falls back to an N-lines count", () => {
  assert.equal(summarizeToolTextOutput("```\n```\n"), "2 lines");
  assert.equal(summarizeToolTextOutput("```"), null, "one unrenderable line has no summary");
  assert.equal(summarizeToolTextOutput(""), null);
});

test("tool output is summarised and the row is flagged truncated", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "command_execution",
      status: "completed",
      data: {
        command: "pnpm test",
        rawOutput: { stdout: `line one\n${"noise\n".repeat(500)}` }
      }
    })
  );
  assert.equal(slim.truncated, true);
  const data = record(slim.data);
  assert.equal(data.command, "pnpm test");
  assert.deepEqual(data.rawOutput, { content: "line one" });
});

test("an MCP tool call keeps only the allow-listed item fields", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "mcp_tool_call",
      status: "completed",
      data: {
        toolCallId: "call-1",
        item: {
          type: "mcp_tool_call",
          id: "i1",
          tool: "search",
          server: "docs",
          status: "completed",
          arguments: { q: "x" },
          appContext: null,
          error: null,
          durationMs: 12,
          result: { content: [{ type: "text", text: "first hit\nsecond hit" }] },
          secretInternalBlob: "x".repeat(50_000)
        }
      }
    })
  );
  const item = record(record(slim.data).item);
  assert.deepEqual(
    Object.keys(item).sort(),
    [...MCP_ITEM_KEPT_FIELDS, "result"].sort()
  );
  assert.deepEqual(item.result, { content: "first hit" });
  assert.equal(slim.truncated, true);
});

test("changed files are promoted to a bounded top-level path list", () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts` }));
  const slim = record(
    slimActivityPayload({
      itemType: "file_change",
      status: "completed",
      data: { item: { result: { files } } }
    })
  );
  const changedFiles = slim.changedFiles as string[];
  assert.equal(changedFiles.length, SLIM_MAX_CHANGED_FILES);
  assert.equal(changedFiles[0], "src/f0.ts");
});

test("a changed-file path deeper than the depth bound is not collected", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "file_change",
      data: { item: { result: { patch: { operations: { edits: [{ path: "deep.ts" }] } } } } }
    })
  );
  assert.equal(slim.changedFiles, undefined);
});

test("a completed payload over a failed item is re-stamped failed", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "command_execution",
      status: "completed",
      data: { item: { status: "failed", command: "false" } }
    })
  );
  assert.equal(slim.status, "failed");
});

test("a declined nested item re-stamps too, and a real success is left alone", () => {
  assert.equal(
    record(
      slimActivityPayload({ status: "completed", data: { item: { status: "declined" } } })
    ).status,
    "declined"
  );
  assert.equal(
    record(
      slimActivityPayload({ status: "completed", data: { item: { status: "completed" } } })
    ).status,
    "completed"
  );
});

test("the status re-stamp still runs when there is no data record to rebuild", () => {
  // `data` is not a record, so the allow-list rebuild is skipped, but a failed
  // tool must never render as a success.
  const slim = record(slimActivityPayload({ status: "completed", data: [1, 2, 3] }));
  assert.equal(slim.status, "completed");
});

test("every string is capped at 16 KiB and the row flagged truncated", () => {
  const huge = "a".repeat(SLIM_MAX_STRING_BYTES + 1_000);
  const slim = record(slimActivityPayload({ itemType: "error", detail: huge, data: {} }));
  assert.equal((slim.detail as string).length, SLIM_MAX_STRING_BYTES + 1);
  assert.equal(slim.truncated, true);
});

test("the task linkage bundle survives slimming so the roster still folds", () => {
  const slim = record(
    slimActivityPayload({
      taskId: "t1",
      agentKind: "agent",
      title: "Reviewer",
      model: "opus",
      status: "running",
      data: { rawOutput: { stdout: "chatter" } }
    })
  );
  assert.equal(slim.taskId, "t1");
  assert.equal(slim.agentKind, "agent");
  assert.equal(slim.title, "Reviewer");
  assert.equal(slim.model, "opus");
});

test("a small tool row that loses nothing is not flagged truncated", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "command_execution",
      status: "completed",
      toolUseId: "tu-1",
      data: { toolCallId: "tu-1", kind: "bash", toolName: "Bash" }
    })
  );
  assert.equal(slim.truncated, undefined);
  assert.deepEqual(slim.data, { toolCallId: "tu-1", kind: "bash", toolName: "Bash" });
  assert.equal(slim.toolUseId, "tu-1");
});

test("ACP content blocks are summarised", () => {
  const slim = record(
    slimActivityPayload({
      itemType: "dynamic_tool_call",
      data: {
        content: [
          { type: "content", content: { type: "text", text: "hello from acp" } },
          { type: "other" }
        ]
      }
    })
  );
  assert.deepEqual(record(slim.data).rawOutput, { content: "hello from acp" });
});
