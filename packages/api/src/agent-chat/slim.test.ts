/**
 * Activity payload slimming (§5.6). Cases derived from T3 Code (MIT):
 * `apps/server/src/orchestration/ActivityPayloadProjection.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseGoalUpdatedPayload } from "./goal.ts";
import { slimActivityPayload } from "./slim.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", "expected a record");
  return value as Record<string, unknown>;
}

test("a non-record payload passes through", () => {
  assert.equal(slimActivityPayload("hello"), "hello");
  assert.equal(slimActivityPayload(null), null);
  assert.equal(slimActivityPayload(7), 7);
});

test("wire command output keeps the first meaningful line, elided at 84", () => {
  for (const [output, expected] of [["   \n\n  first line  \nsecond", "first line"], ["x".repeat(200), `${"x".repeat(83)}…`]]) {
    const slim = record(slimActivityPayload({ data: { rawOutput: output } }));
    assert.deepEqual(record(slim.data).rawOutput, { content: expected });
  }
});

test("wire output uses a line-count fallback only for multiple unrenderable lines", () => {
  for (const [output, expected] of [["```\n```\n", { content: "2 lines" }], ["```", undefined], ["", undefined]]) {
    const slim = record(slimActivityPayload({ data: { rawOutput: output } }));
    assert.deepEqual(record(slim.data).rawOutput, expected);
  }
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
  assert.deepEqual(item, {
    type: "mcp_tool_call", id: "i1", tool: "search", server: "docs", status: "completed",
    arguments: { q: "x" }, appContext: null, error: null, durationMs: 12,
    result: { content: "first hit" }
  });
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
  assert.equal(changedFiles.length, 12);
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

test("a compaction summary survives slimming, capped and flagged", () => {
  // The marker reveals the provider's summary (§7.3), so `summary` must be a
  // field slimming keeps: it is top-level, and only `data` is rebuilt from an
  // allow-list. A real one runs to ~18 KB, so it meets the same 16 KiB wire
  // cap as every other string, and `truncated` points the row at
  // `GET …/items/:itemId` for the rest.
  const short = "Summary of everything before this point.";
  assert.equal(
    record(slimActivityPayload({ state: "compacted", summary: short })).summary,
    short,
    "a summary that fits is untouched"
  );
  const huge = "s".repeat(16_384 + 2_000);
  const slim = record(slimActivityPayload({ state: "compacted", summary: huge }));
  const summary = slim.summary as string;
  assert.equal(byteLength(summary), 16_384 + byteLength("…"));
  assert.equal(slim.truncated, true);
});

test("an agent's launch prompt survives slimming, capped and flagged, beside its at-rest mark", () => {
  // The drill-in shows it at its top (§7.6). A `task.started` row has no
  // `data`, so nothing is rebuilt: the prompt is one more top-level string,
  // capped at 16 KiB like the rest, with `truncated` pointing the row at
  // `GET …/items/:itemId` for the stored value. `promptTruncated` — the stored
  // value is itself cut — is not the wire's to change.
  const short = { taskId: "t1", agentKind: "agent", prompt: "Read b.txt and report its first word." };
  assert.deepEqual(slimActivityPayload(short), short);
  const huge = "p".repeat(16_384 + 2_000);
  const slim = record(
    slimActivityPayload({ taskId: "t1", agentKind: "agent", prompt: huge, promptTruncated: true })
  );
  assert.equal(byteLength(slim.prompt as string), 16_384 + byteLength("…"));
  assert.equal(slim.truncated, true);
  assert.equal(slim.promptTruncated, true);
  assert.equal(slim.taskId, "t1");
});

/** The cap is stated in BYTES, so the test measures bytes. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

test("the cap counts UTF-8 bytes, not UTF-16 code units", () => {
  // R5 #16: `value.length` let a CJK string reach ~3x the stated cap, and an
  // emoji string ~2x (a surrogate pair is 2 units but 4 bytes).
  for (const unit of ["世", "🙂"]) {
    const huge = unit.repeat(16_384);
    const slim = record(slimActivityPayload({ itemType: "error", detail: huge, data: {} }));
    const detail = slim.detail as string;
    assert.ok(
      byteLength(detail) <= 16_384 + byteLength("\u2026"),
      `${unit}: ${byteLength(detail)} bytes exceeds the cap`
    );
    assert.equal(slim.truncated, true);
    // Never split a surrogate pair: the result must round-trip through UTF-8.
    assert.ok(!/[\uD800-\uDBFF]$/.test(detail.slice(0, -1)), `${unit}: lone high surrogate`);
  }
});

test("a multi-byte string below the wire cap stays complete", () => {
  const payload = { itemType: "error", detail: "世".repeat(100), data: {} };
  const slim = record(slimActivityPayload(payload));
  assert.equal(slim.detail, payload.detail);
  assert.equal(slim.truncated, undefined);
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

test("a goal row's payload survives slimming whole: goal, change and previous (goals §4.3)", () => {
  // The client folds the thread's goal off the SLIMMED payload of a live
  // `goal.updated` row (goals §4.4), and the timeline marker reads the same
  // three fields — so they stay top-level and untouched, never rebuilt.
  const checked = {
    goal: {
      objective: "Make CI green",
      status: "active",
      rounds: 2,
      lastCheck: "lint still fails",
      tokenBudget: null
    },
    change: "checked",
    previous: { objective: "Old aim", status: "complete" }
  };
  assert.deepEqual(slimActivityPayload(checked), checked);
  const cleared = { goal: null, change: "cleared", previous: { objective: "Old aim", status: "active" } };
  assert.deepEqual(slimActivityPayload(cleared), cleared);
});

test("a goal row's strings meet the same wire cap as every other string, and nothing else moves", () => {
  const huge = "c".repeat(16_384 + 500);
  const slim = record(
    slimActivityPayload({
      goal: { objective: "Make CI green", status: "active", rounds: 3, lastCheck: huge },
      change: "checked",
      previous: { objective: "Old aim", status: "complete" }
    })
  );
  assert.equal(slim.change, "checked");
  assert.deepEqual(slim.previous, { objective: "Old aim", status: "complete" });
  const goal = record(slim.goal);
  assert.equal(goal.objective, "Make CI green");
  assert.equal(goal.status, "active");
  assert.equal(goal.rounds, 3);
  assert.equal(byteLength(goal.lastCheck as string), 16_384 + byteLength("…"));
  assert.equal(slim.truncated, true);
  // Still a goal payload: the client's fold adopts what slimming leaves.
  assert.notEqual(parseGoalUpdatedPayload(slim), null);
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
