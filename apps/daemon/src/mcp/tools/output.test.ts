import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentChatRoutes, slimActivityPayload, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { ToolError } from "../errors.ts";
import { activity, chatSummary, message, shellSummary, snapshot } from "../fixtures.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "../result.ts";
import { FakeDaemonApi } from "../testing.ts";
import { READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { messageTools } from "./messages.ts";
import { DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, outputTools } from "./output.ts";

const tool = outputTools.find((t) => t.name === "read_tool_output")!;
/** The arguments as `run()` receives them: parsed by the tool's own schema, strict, defaults applied (server.ts). */
const parse = (t: ToolDef, args: Record<string, unknown>) => z.object(t.input).strict().parse(args) as never;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => 0 });

/** A daemon whose chat session c1 holds `item` whole (the unslimmed read, §5.6), beside a terminal tab t1. */
function holding(item: ThreadItem, api = new FakeDaemonApi()): FakeDaemonApi {
  return api
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), shellSummary()] })
    .on("GET", agentChatRoutes.item("c1", item.id), { status: 200, body: { item } });
}

const read = (api: FakeDaemonApi, args: Record<string, unknown>) => tool.run(parse(tool, { sessionId: "c1", ...args }), ctx(api));

/** A command row as its provider wrote it: a `command_execution` completion carrying `data`. */
const commandRow = (data: unknown, over: Record<string, unknown> = {}) =>
  activity("tool.completed", { itemType: "command_execution", toolUseId: "call-1", title: "Run it", status: "completed", data, ...over }, { tone: "tool", summary: "Run it" });

/** Page through an item the way a caller is told to: from `nextOffset` until there is none. */
async function readAll(api: FakeDaemonApi, itemId: string, maxBytes?: number): Promise<{ text: string; pages: Record<string, unknown>[] }> {
  const pages: Record<string, unknown>[] = [];
  let text = "";
  let offset = 0;
  for (;;) {
    const page = await read(api, { itemId, offset, ...(maxBytes === undefined ? {} : { maxBytes }) });
    pages.push(page);
    assert.ok(resultBytes(page) <= MAX_RESULT_BYTES, `page ${pages.length} is ${resultBytes(page)} bytes`);
    assert.equal(page.offset, offset, "every page starts where the last one ended");
    text += page.text as string;
    if (!("nextOffset" in page)) return { text, pages };
    assert.equal(page.nextOffset, offset + Buffer.byteLength(page.text as string), "nextOffset is offset + the page's UTF-8 bytes");
    assert.ok((page.nextOffset as number) > offset, "every page advances");
    offset = page.nextOffset as number;
  }
}

test("read_tool_output is a read-only tool whose description names where item ids come from and how to page", () => {
  assert.deepEqual(outputTools.map((t) => t.name), ["read_tool_output"]);
  assert.deepEqual(tool.annotations, READ_ONLY);
  assert.ok(tool.title);
  assert.ok(tool.description.length <= 400, `${tool.description.length} chars`);
  for (const needle of ["read_transcript", "outputItemId", "nextOffset"]) assert.ok(tool.description.includes(needle), needle);
  assert.equal(DEFAULT_OUTPUT_BYTES, 40_000);
  assert.equal(MAX_OUTPUT_BYTES, 55_000);
  const defaults = parse(tool, { sessionId: "c1", itemId: "i1" }) as { offset: number; maxBytes: number };
  assert.deepEqual([defaults.offset, defaults.maxBytes], [0, DEFAULT_OUTPUT_BYTES]);
  for (const maxBytes of [0, MAX_OUTPUT_BYTES + 1]) assert.throws(() => parse(tool, { sessionId: "c1", itemId: "i1", maxBytes }), maxBytes === 0 ? /greater than or equal to 1/ : /less than or equal to 55000/);
  assert.throws(() => parse(tool, { sessionId: "c1", itemId: "i1", offset: -1 }));
  assert.throws(() => parse(tool, { sessionId: "c1", itemId: "" }));
});

test("a Codex command answers its item's whole aggregatedOutput as command-output — not the wire's one-line preview", async () => {
  const output = `\n> api@1.0.0 test\n${Array.from({ length: 300 }, (_, i) => `ok ${i} - parses case ${i}`).join("\n")}\n  # pass 300\n`;
  const row = commandRow({ item: { type: "commandExecution", command: "pnpm test", aggregatedOutput: output, exitCode: 0 } });
  const api = holding(row);
  const r = await read(api, { itemId: row.id });
  assert.deepEqual(r, { itemId: row.id, kind: "command-output", text: output, offset: 0, totalBytes: Buffer.byteLength(output) });
  // What the transcript carries instead: the first meaningful line, with `truncated` promising the rest.
  const wire = slimActivityPayload(row.payload) as { truncated?: unknown; data: { item: { aggregatedOutput: string } } };
  assert.equal(wire.truncated, true);
  assert.equal(wire.data.item.aggregatedOutput, "> api@1.0.0 test");
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/sessions", `GET ${agentChatRoutes.item("c1", row.id)}`]);
});

test("a Grok command answers rawOutput's stdout then its stderr, and ACP content blocks where rawOutput has no text", async () => {
  const streams = commandRow({ kind: "execute", command: "make", rawOutput: { stdout: "building\n  done\n", stderr: "warning: deprecated flag\n", exit_code: 0 } });
  assert.deepEqual(await read(holding(streams), { itemId: streams.id }), {
    itemId: streams.id, kind: "command-output", text: "building\n  done\nwarning: deprecated flag\n", offset: 0, totalBytes: 41
  });
  const acp = commandRow({ kind: "execute", command: "ls", rawOutput: { type: "Bash", output: [97, 10], exit_code: 0 }, content: [
    { type: "content", content: { type: "text", text: "a.ts\n" } },
    { type: "diff", path: "b.ts", oldText: "", newText: "x" },
    { type: "content", content: { type: "text", text: "  c.ts" } }
  ] });
  const r = await read(holding(acp), { itemId: acp.id });
  assert.equal(r.kind, "command-output");
  assert.equal(r.text, "a.ts\n  c.ts");
});

test("a message answers its text, and any other item the GUI viewer's text: a string payload as it is, else indented JSON, else the summary", async () => {
  const reply = message("assistant", `Done.\n\n${"The migration ran. ".repeat(2_000)}`);
  assert.deepEqual(await read(holding(reply), { itemId: reply.id }), { itemId: reply.id, kind: "message", text: reply.text, offset: 0, totalBytes: Buffer.byteLength(reply.text) });
  // An MCP tool call: no command output to read, so its payload whole, as the GUI's viewer shows it.
  const mcpCall = activity("tool.completed", { itemType: "mcp_tool_call", toolUseId: "m1", title: "search", data: { item: { tool: "search", result: { content: [{ type: "text", text: "found" }] } } } }, { tone: "tool" });
  assert.deepEqual(await read(holding(mcpCall), { itemId: mcpCall.id }), {
    itemId: mcpCall.id, kind: "payload", text: JSON.stringify(mcpCall.payload, null, 2), offset: 0, totalBytes: Buffer.byteLength(JSON.stringify(mcpCall.payload, null, 2))
  });
  // A command whose data carries no output in any place the preview reads (Claude's block-array tool_result) is a payload too.
  const blocks = commandRow({ toolName: "Bash", input: { command: "ls" }, result: { type: "tool_result", content: [{ type: "text", text: "a.ts" }] } });
  const r = await read(holding(blocks), { itemId: blocks.id });
  assert.deepEqual([r.kind, r.text], ["payload", JSON.stringify(blocks.payload, null, 2)]);
  const text = activity("runtime.warning", "a plain string payload\n", { summary: "Warning" });
  const t = await read(holding(text), { itemId: text.id });
  assert.deepEqual([t.kind, t.text], ["payload", "a plain string payload\n"]);
  const bare = activity("session.identity-changed", undefined, { summary: "Switched to the work account" });
  const b = await read(holding(bare), { itemId: bare.id });
  assert.deepEqual([b.kind, b.text], ["payload", "Switched to the work account"]);
});

test("windows are UTF-8 byte windows that never split a character, and chain through nextOffset to the end", async () => {
  // 4-, 3-, 2- and 1-byte characters, so almost every window edge falls inside one.
  const output = "😀語é!\n".repeat(300);
  const row = commandRow({ item: { command: "yes", aggregatedOutput: output } });
  const api = holding(row);
  for (const maxBytes of [1, 2, 3, 5, 7, 100, 1_001]) {
    const all = await readAll(api, row.id, maxBytes);
    assert.ok(Buffer.from(all.text, "utf8").equals(Buffer.from(output, "utf8")), `maxBytes ${maxBytes}: byte-exact`);
    for (const page of all.pages) {
      assert.ok(!(page.text as string).includes("\ufffd"), "no character was split");
      assert.equal(page.totalBytes, Buffer.byteLength(output));
      // A window holds at most maxBytes, unless maxBytes is narrower than the one character it starts with.
      const bytes = Buffer.byteLength(page.text as string);
      assert.ok(bytes <= maxBytes || [...(page.text as string)].length === 1, `maxBytes ${maxBytes}: a ${bytes}-byte page`);
    }
  }
  // The default window, over a longer output: at most 40 000 bytes, ended on a character boundary.
  const long = commandRow({ item: { command: "yes", aggregatedOutput: "😀語é!\n".repeat(5_000) } });
  const first = await read(holding(long), { itemId: long.id });
  assert.equal(first.totalBytes, 55_000);
  assert.ok((first.nextOffset as number) <= DEFAULT_OUTPUT_BYTES && (first.nextOffset as number) > DEFAULT_OUTPUT_BYTES - 4, `nextOffset ${first.nextOffset}`);
  assert.equal(Buffer.byteLength(first.text as string), first.nextOffset);
  // A maxBytes narrower than the character at offset takes that character whole, so paging always advances.
  const narrow = await read(api, { itemId: row.id, maxBytes: 1 });
  assert.deepEqual([narrow.text, narrow.nextOffset], ["😀", 4]);
  // An offset inside a character starts at that character: `offset` says where the text begins.
  const inside = await read(api, { itemId: row.id, offset: 5, maxBytes: 5 });
  assert.deepEqual([inside.offset, inside.text, inside.nextOffset], [4, "語é", 9]);
});

test("an offset at the end reads nothing more; one past it is refused, naming totalBytes", async () => {
  const row = commandRow({ item: { command: "echo hi", aggregatedOutput: "hi\n" } });
  const api = holding(row);
  assert.deepEqual(await read(api, { itemId: row.id, offset: 3 }), { itemId: row.id, kind: "command-output", text: "", offset: 3, totalBytes: 3 });
  await assert.rejects(read(api, { itemId: row.id, offset: 4 }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /offset 4 is past the end/);
    assert.match(error.message, /3 bytes \(totalBytes\)/);
    return true;
  });
});

test("every answer stays within the result cap: an escape-heavy window at the largest maxBytes comes back shorter", async () => {
  // Terminal output with ANSI colours: an ESC is six bytes once JSON-escaped, a quote or a backslash two, a newline two.
  const output = Array.from({ length: 6_000 }, (_, i) => `\u001b[32m✓\u001b[0m "case ${i}" C:\\tmp\\${i}\n`).join("");
  const row = commandRow({ item: { command: "pnpm test --color", aggregatedOutput: output } });
  const api = holding(row);
  const first = await read(api, { itemId: row.id, maxBytes: MAX_OUTPUT_BYTES });
  assert.ok(resultBytes(first) <= MAX_RESULT_BYTES, `${resultBytes(first)} bytes`);
  assert.ok(resultBytes(first) > MAX_RESULT_BYTES - 16, "the window fills the room it has, to the last character");
  assert.ok((first.nextOffset as number) < MAX_OUTPUT_BYTES, "the window was shortened");
  assert.equal(ok(first).structuredContent, first, "never ok()'s last-resort cut");
  assert.equal((await readAll(api, row.id, MAX_OUTPUT_BYTES)).text, output);
  // Control characters alone (six bytes each once escaped) and CJK (three bytes each, unescaped).
  for (const text of [String.fromCharCode(...Array.from({ length: 30_000 }, (_, i) => 1 + (i % 7))), "語".repeat(30_000)]) {
    const other = commandRow({ item: { command: "cat", aggregatedOutput: text } });
    const page = await read(holding(other), { itemId: other.id, maxBytes: MAX_OUTPUT_BYTES });
    assert.ok(resultBytes(page) <= MAX_RESULT_BYTES, `${resultBytes(page)} bytes`);
    assert.equal((await readAll(holding(other), other.id, MAX_OUTPUT_BYTES)).text, text);
  }
});

test("an item the host does not have is NOT_FOUND, saying where item ids come from; any other failure keeps its code", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary()] })
    .on("GET", agentChatRoutes.item("c1", "gone"), { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No item 'gone'." } } })
    .on("GET", agentChatRoutes.item("c1", "busy"), { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting. Retry the same commandId." } } })
    .on("GET", agentChatRoutes.item("c1", "odd"), { status: 200, body: { nothing: true } });
  await assert.rejects(read(api, { itemId: "gone" }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /^No item "gone" in this session: it is gone, or it never existed\./);
    assert.match(error.message, /read_transcript/);
    assert.match(error.message, /outputItemId/);
    return true;
  });
  await assert.rejects(read(api, { itemId: "busy" }), (error: unknown) => error instanceof ToolError && error.code === "HOST_UNAVAILABLE");
  await assert.rejects(read(api, { itemId: "odd" }), (error: unknown) => error instanceof ToolError && error.code === "INTERNAL");
  // A caller's long id is quoted back cut.
  await assert.rejects(read(api, { itemId: "x".repeat(5_000) }), (error: unknown) => error instanceof ToolError && error.code === "NOT_FOUND" && error.message.length < 300);
});

test("only a chat session's items are read: an unknown session and a terminal tab are refused before any item read", async () => {
  const row = commandRow({ item: { aggregatedOutput: "x" } });
  const api = holding(row);
  await assert.rejects(read(api, { sessionId: "nope", itemId: row.id }), (error: unknown) => error instanceof ToolError && error.code === "SESSION_NOT_FOUND");
  await assert.rejects(read(api, { sessionId: "t1", itemId: row.id }), (error: unknown) => error instanceof ToolError && error.code === "NOT_A_CHAT_SESSION");
  assert.ok(!api.calls.some((c) => c.path.includes("/items/")), "no item was read");
  // An id is a path segment: it goes out encoded, as agentChatRoutes builds it.
  const shell = activity("tool.completed", { itemType: "command_execution", toolUseId: "bg", data: { item: { aggregatedOutput: "tail\n" } } }, { id: "bgshell:task-1/2" });
  const r = await read(holding(shell), { itemId: "bgshell:task-1/2" });
  assert.equal(r.text, "tail\n");
});

test("read_transcript's outputItemId is what read_tool_output reads: the command's whole output behind the row's preview", async () => {
  const output = `Tests  ${"·".repeat(10)}\n${Array.from({ length: 120 }, (_, i) => `  ✓ case ${i} (${i} ms)`).join("\n")}\n`;
  const started = activity("tool.started", { itemType: "command_execution", toolUseId: "call-9", title: "pnpm test", status: "inProgress" }, { tone: "tool" });
  const completed = commandRow({ item: { command: "pnpm test", aggregatedOutput: output } }, { toolUseId: "call-9", title: "pnpm test" });
  // The snapshot every read serves: payloads slimmed, `truncated` stamped where the slimmer cut.
  const served: ThreadSnapshotPayload = snapshot({ items: [message("user", "Run the tests.", { id: "u1" }), started, { ...completed, payload: slimActivityPayload(completed.payload) }] });
  const api = holding(completed).on("GET", agentChatRoutes.thread("c1"), { status: 200, body: { kind: "snapshot", thread: served } });
  const transcript = await messageTools.find((t) => t.name === "read_transcript")!.run(parse(messageTools.find((t) => t.name === "read_transcript")!, { sessionId: "c1" }), ctx(api));
  const row = (transcript.entries as { kind: string; outputItemId?: string; tool?: { detail?: string } }[]).find((e) => e.kind === "tool")!;
  assert.equal(row.tool!.detail, "Tests ··········");
  assert.equal(row.outputItemId, completed.id);
  const whole = await read(api, { itemId: row.outputItemId! });
  assert.deepEqual([whole.kind, whole.text, "nextOffset" in whole], ["command-output", output, false]);
});
