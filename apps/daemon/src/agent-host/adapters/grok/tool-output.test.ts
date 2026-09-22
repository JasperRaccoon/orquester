/**
 * Tool-output bounding and coalescing — the rules that stop Grok's
 * resend-everything `tool_call_update` from flooding the bus.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  acpKindFromVendorKind,
  TOOL_CALL_CONTENT_MAX_CHARS,
  TOOL_CALL_CONTENT_TRUNCATION_MARKER,
  TOOL_CALL_RAW_BYTES_MAX,
  boundRawOutput,
  boundToolContent,
  boundToolOutputText,
  decideToolEmission,
  extractToolCommand,
  itemTypeFromToolKind,
  normalizeToolKind,
  requestTypeFromToolKind,
  toolContentText,
  toolOutputUnchanged,
  toolProgressLength
} from "./tool-output.ts";

test("short output passes through untouched, by reference", () => {
  const text = "hi\n";
  assert.equal(boundToolOutputText(text), text);
});

test("long output keeps the TAIL and is marked", () => {
  const text = "x".repeat(TOOL_CALL_CONTENT_MAX_CHARS + 500) + "END";
  const bounded = boundToolOutputText(text);
  assert.ok(bounded.startsWith(TOOL_CALL_CONTENT_TRUNCATION_MARKER));
  assert.ok(bounded.endsWith("END"), "the end is the useful part of a redrawing tool");
  assert.equal(
    bounded.length,
    TOOL_CALL_CONTENT_MAX_CHARS + TOOL_CALL_CONTENT_TRUNCATION_MARKER.length
  );
});

test("boundRawOutput bounds Grok's cumulative text fields", () => {
  const raw = {
    type: "Bash",
    output_for_prompt: "y".repeat(TOOL_CALL_CONTENT_MAX_CHARS + 10),
    exit_code: 0
  };
  const bounded = boundRawOutput(raw) as Record<string, unknown>;
  assert.notEqual(bounded, raw);
  assert.ok((bounded["output_for_prompt"] as string).startsWith(TOOL_CALL_CONTENT_TRUNCATION_MARKER));
  assert.equal(bounded["exit_code"], 0);
});

test("boundRawOutput bounds the BYTE ARRAY T3's list does not know about", () => {
  const raw = { type: "Bash", output: new Array(TOOL_CALL_RAW_BYTES_MAX + 100).fill(65) };
  const bounded = boundRawOutput(raw) as Record<string, unknown>;
  assert.equal((bounded["output"] as number[]).length, TOOL_CALL_RAW_BYTES_MAX);
});

test("boundRawOutput reaches one level into Grok's discriminated payload", () => {
  const raw = {
    type: "ReadFile",
    FileContent: { content: "z".repeat(TOOL_CALL_CONTENT_MAX_CHARS + 1), total_lines: 4 }
  };
  const bounded = boundRawOutput(raw) as Record<string, Record<string, unknown>>;
  assert.ok((bounded["FileContent"]["content"] as string).startsWith(TOOL_CALL_CONTENT_TRUNCATION_MARKER));
  assert.equal(bounded["FileContent"]["total_lines"], 4);
});

test("identity is preserved when nothing changed — coalescing depends on it", () => {
  const raw = { type: "Bash", output_for_prompt: "hi\n" };
  assert.equal(boundRawOutput(raw), raw);
  const content = [{ type: "content", content: { type: "text", text: "hi" } }];
  assert.equal(boundToolContent(content), content);
  assert.equal(
    toolOutputUnchanged({ content, rawOutput: raw }, { content, rawOutput: raw }),
    true
  );
});

test("toolContentText joins and bounds the text entries", () => {
  assert.equal(
    toolContentText([
      { type: "content", content: { type: "text", text: " a " } },
      { type: "diff", path: "/x", newText: "ignored" },
      { type: "content", content: { type: "text", text: "b" } }
    ]),
    "a\nb"
  );
  assert.equal(toolContentText([]), undefined);
  assert.equal(toolContentText(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test("a terminal status always emits", () => {
  const previous = { title: "t", status: "in_progress", detail: "d" };
  for (const status of ["completed", "failed"]) {
    assert.deepEqual(decideToolEmission({ previous, next: { ...previous, status }, skippedSinceEmit: 3 }), {
      emit: true,
      skipped: 0
    });
  }
});

test("a first sighting, a title change and a status change all emit", () => {
  assert.equal(decideToolEmission({ next: { title: "t" }, skippedSinceEmit: 0 }).emit, true);
  const previous = { title: "a", status: "in_progress" };
  assert.equal(decideToolEmission({ previous, next: { title: "b", status: "in_progress" }, skippedSinceEmit: 0 }).emit, true);
  assert.equal(decideToolEmission({ previous, next: { title: "a", status: "pending" }, skippedSinceEmit: 0 }).emit, true);
});

test("an UNCHANGED update is not emitted and does not count as a skip", () => {
  const content = [{ type: "content", content: { type: "text", text: "hi" } }];
  const snapshot = { title: "t", status: "in_progress", detail: "d", content };
  assert.deepEqual(decideToolEmission({ previous: snapshot, next: { ...snapshot }, skippedSinceEmit: 4 }), {
    emit: false,
    skipped: 4
  });
});

test("small growth is skipped until the coalesce limit", () => {
  const base = { title: "t", status: "in_progress" };
  let skipped = 0;
  let lastEmitted = 0;
  for (let index = 1; index <= 9; index += 1) {
    const next = { ...base, detail: "x".repeat(index) };
    const decision = decideToolEmission({
      previous: { ...base, detail: "x".repeat(index - 1) },
      next,
      lastEmittedProgressLength: lastEmitted,
      skippedSinceEmit: skipped
    });
    assert.equal(decision.emit, false, `update ${index} should coalesce`);
    skipped = decision.skipped;
  }
  const tenth = decideToolEmission({
    previous: { ...base, detail: "x".repeat(9) },
    next: { ...base, detail: "x".repeat(10) },
    lastEmittedProgressLength: lastEmitted,
    skippedSinceEmit: skipped
  });
  assert.deepEqual(tenth, { emit: true, skipped: 0 });
  void lastEmitted;
});

test("big growth emits immediately, and a SHRINKING tail counts too", () => {
  const base = { title: "t", status: "in_progress" };
  assert.equal(
    decideToolEmission({
      previous: { ...base, detail: "a" },
      next: { ...base, detail: "b".repeat(300) },
      lastEmittedProgressLength: 1,
      skippedSinceEmit: 0
    }).emit,
    true
  );
  assert.equal(
    decideToolEmission({
      previous: { ...base, detail: "b".repeat(300) },
      next: { ...base, detail: "c" },
      lastEmittedProgressLength: 300,
      skippedSinceEmit: 0
    }).emit,
    true
  );
});

test("progress is measured across content and rawOutput, not just detail", () => {
  // The regression this guards: a command tool pins `detail` to the command
  // string, so a detail-only measure never grows and live stdout is withheld.
  const snapshot = {
    detail: "echo hi",
    content: [{ type: "content", content: { type: "text", text: "x".repeat(500) } }],
    rawOutput: { output_for_prompt: "y".repeat(900) }
  };
  assert.equal(toolProgressLength(snapshot), 900);
});

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

test("the item map and the request map differ on `read` and on `search`", () => {
  assert.equal(itemTypeFromToolKind("read"), "dynamic_tool_call");
  assert.equal(requestTypeFromToolKind("read"), "file_read_approval");
  assert.equal(itemTypeFromToolKind("search"), "web_search");
  assert.equal(requestTypeFromToolKind("search"), "dynamic_tool_call");
  assert.equal(itemTypeFromToolKind("execute"), "command_execution");
  assert.equal(requestTypeFromToolKind("execute"), "exec_command_approval");
  for (const kind of ["edit", "delete", "move"]) {
    assert.equal(itemTypeFromToolKind(kind), "file_change");
    assert.equal(requestTypeFromToolKind(kind), "file_change_approval");
  }
  assert.equal(itemTypeFromToolKind(undefined), "dynamic_tool_call");
});

test("normalizeToolKind trims and rejects blanks", () => {
  assert.equal(normalizeToolKind("  edit "), "edit");
  assert.equal(normalizeToolKind("   "), undefined);
  assert.equal(normalizeToolKind(7), undefined);
});

test("the command comes from rawInput, then argv, then the title's backticks", () => {
  assert.equal(extractToolCommand({ variant: "Bash", command: "echo hi" }, "Execute"), "echo hi");
  assert.equal(extractToolCommand({ command: ["ls", "-la"] }, undefined), "ls -la");
  assert.equal(extractToolCommand({ executable: "git", args: ["status"] }, undefined), "git status");
  assert.equal(extractToolCommand({}, "Write `/tmp/a.txt`"), "/tmp/a.txt");
  assert.equal(extractToolCommand(undefined, "Terminal"), undefined);
});

test("the vendor tool kind leads, because ACP's is absent on the first frame", () => {
  // A `write` used to land on `dynamic_tool_call` and render as a generic tool
  // row rather than a file change — seen live against 1.0.34.
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("write")), "file_change");
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("edit")), "file_change");
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("execute")), "command_execution");
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("search")), "web_search");
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("read")), "dynamic_tool_call");
  assert.equal(itemTypeFromToolKind(acpKindFromVendorKind("list")), "dynamic_tool_call");
  // An unknown vendor kind falls through to whatever ACP said.
  assert.equal(acpKindFromVendorKind("enter_plan"), undefined);
  assert.equal(acpKindFromVendorKind(undefined), undefined);
});
