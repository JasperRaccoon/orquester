import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentChatRoutes, slimActivityPayload, type ThreadItem, type ThreadItemOutputResponse, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { ToolError } from "../errors.ts";
import { activity, chatSummary, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
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
  for (const needle of ["read_transcript", "outputItemId", "nextOffset", "running"]) assert.ok(tool.description.includes(needle), needle);
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
  // A command whose data carries no output in any place the preview reads (Claude's block-array tool_result), and that
  // streamed none (this daemon answers the join 404), is a payload too.
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

// --- streamed output: the chunks the host joins (`GET …/items/:itemId/output`) -----------------------------------

/** A daemon whose session c1 holds `item`, and whose host joins the streamed output of its call as `joined` answers. */
function streaming(item: ThreadItem, joined: { status: number; body: unknown }): FakeDaemonApi {
  return holding(item).on("GET", agentChatRoutes.itemOutput("c1", item.id), joined);
}
const joinedOutput = (over: Partial<ThreadItemOutputResponse> = {}): { status: number; body: ThreadItemOutputResponse } =>
  ({ status: 200, body: { toolUseId: "bgshell:task-1", output: "make: entering\n  [100%] linked\n", complete: true, truncated: false, ...over } });

/** A background shell's completion as ingestion stores it: whole, and holding no output — the CLI streamed it. */
const shellDone = () => activity("tool.completed", {
  itemType: "command_execution", toolUseId: "bgshell:task-1", title: "Background shell", status: "completed", agentId: "task-1",
  data: { toolName: "Bash", input: { command: "make -j8" }, background: true, exitCode: 0 }
}, { tone: "tool", agentId: "task-1", summary: "Background shell" });

test("a background shell's output — in no item's data — answers the host's join as command-output", async () => {
  const row = shellDone();
  const api = streaming(row, joinedOutput());
  const r = await read(api, { itemId: row.id });
  const text = "make: entering\n  [100%] linked\n";
  assert.deepEqual(r, { itemId: row.id, kind: "command-output", text, offset: 0, totalBytes: Buffer.byteLength(text) });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/sessions", `GET ${agentChatRoutes.item("c1", row.id)}`, `GET ${agentChatRoutes.itemOutput("c1", row.id)}`]);
});

test("a running call answers its output so far with running: true, and says truncated when the host's cap cut it", async () => {
  const started = activity("tool.started", { itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status: "inProgress", data: { item: { command: "pnpm test", aggregatedOutput: null } } }, { tone: "tool" });
  const so_far = await read(streaming(started, joinedOutput({ toolUseId: "call-1", output: "test 0 passed\n", complete: false })), { itemId: started.id });
  assert.deepEqual(so_far, { itemId: started.id, kind: "command-output", text: "test 0 passed\n", offset: 0, totalBytes: 14, running: true });
  // Cut by the host's cap, and escape-heavy (ANSI colours): every page still fits the result cap, flags and all.
  const long = Array.from({ length: 6_000 }, (_, i) => `\u001b[32m✓\u001b[0m "case ${i}" C:\\tmp\\${i}\n`).join("");
  const api = streaming(started, joinedOutput({ toolUseId: "call-1", output: long, complete: false, truncated: true }));
  const { text, pages } = await readAll(api, started.id, MAX_OUTPUT_BYTES);
  assert.equal(text, long);
  for (const page of pages) {
    assert.deepEqual([page.kind, page.running, page.truncated], ["command-output", true, true]);
    assert.ok(resultBytes(page) <= MAX_RESULT_BYTES, `${resultBytes(page)} bytes`);
  }
  assert.ok(resultBytes(pages[0]!) > MAX_RESULT_BYTES - 16, "the window fills the room it has, to the last character");
});

test("the item's own unslimmed output comes first: the host's join is never asked for it", async () => {
  const output = `${Array.from({ length: 100 }, (_, i) => `ok ${i}`).join("\n")}\n`;
  const row = activity("tool.completed", { itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status: "completed", data: { item: { command: "pnpm test", aggregatedOutput: output } } }, { tone: "tool" });
  const api = streaming(row, joinedOutput({ toolUseId: "call-1", output: "the streamed copy" }));
  const r = await read(api, { itemId: row.id });
  assert.deepEqual([r.kind, r.text, "running" in r], ["command-output", output, false]);
  assert.ok(!api.calls.some((c) => c.path.endsWith("/output")), "the join was never read");
});

test("a stored-slimmed update is never command-output: its data is the preview — the join answers, else its payload", async () => {
  const output = `${Array.from({ length: 50 }, (_, i) => `test ${i} passed`).join("\n")}\n`;
  const live = activity("tool.updated", { itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status: "inProgress", data: { item: { command: "pnpm test", aggregatedOutput: output } } }, { tone: "tool" });
  // As ingestion persists it (§5.6) and `GET …/items/:itemId` serves it back: cut, `truncated` and all.
  const stored = { ...live, payload: slimActivityPayload(live.payload) } as ThreadItem;
  const joined = await read(streaming(stored, joinedOutput({ toolUseId: "call-1", output, complete: false })), { itemId: stored.id });
  assert.deepEqual([joined.kind, joined.text, joined.running], ["command-output", output, true]);
  // Nothing streamed: the payload as it is stored, never its one-line preview labelled as the output.
  const none = await read(streaming(stored, joinedOutput({ toolUseId: "call-1", output: "", complete: false })), { itemId: stored.id });
  assert.deepEqual([none.kind, none.text], ["payload", JSON.stringify(stored.kind === "activity" ? stored.payload : null, null, 2)]);
});

test("a host without the join — an older one's route miss, or its own 404 — falls back to the item's text, never an error", async () => {
  const row = shellDone();
  const payloadText = JSON.stringify(row.payload, null, 2);
  // Until its drain-restart after a deploy, an older host answers the new route as its generic route miss.
  const older = streaming(row, { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: `No route for GET /threads/c1/items/${row.id}/output.` } } });
  const r = await read(older, { itemId: row.id });
  assert.deepEqual([r.kind, r.text, "running" in r], ["payload", payloadText, false]);
  const own = await read(streaming(row, { status: 404, body: { error: { code: "ITEM_NOT_FOUND", message: "No tool call behind item." } } }), { itemId: row.id });
  assert.deepEqual([own.kind, own.text], ["payload", payloadText]);
  // Any other failure of the join keeps its code; a body that is not a join is INTERNAL.
  await assert.rejects(read(streaming(row, { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } } }), { itemId: row.id }),
    (error: unknown) => error instanceof ToolError && error.code === "HOST_UNAVAILABLE");
  await assert.rejects(read(streaming(row, { status: 200, body: { output: 7 } }), { itemId: row.id }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL");
});

test("a live Claude Bash call streams its result's text as a command's output: a result given as blocks reads back through the join", async () => {
  // As the Claude normaliser writes it: the completion keeps the tool_result block, and the result's text went out as a
  // `command_output` delta on the call's own item, which ingestion wrote as a tool.output row.
  const blocks = commandRow({ toolName: "Bash", input: { command: "ls" }, result: { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "a.ts\nb.ts\n" }] } });
  const r = await read(streaming(blocks, joinedOutput({ toolUseId: "call-1", output: "a.ts\nb.ts\n" })), { itemId: blocks.id });
  assert.deepEqual([r.kind, r.text, "running" in r], ["command-output", "a.ts\nb.ts\n", false]);
});

test("a file change is never command-output: a Write whose result streamed as file_change_output answers its payload", async () => {
  // Claude streams every Edit/Write result's text as `file_change_output` (fixture 14a): the host would join it, but it
  // is no command's output. The payload — the edit's input included — is what the GUI's viewer shows.
  const write = activity("tool.completed", {
    itemType: "file_change", toolUseId: "w1", title: "Write", status: "completed",
    data: { toolName: "Write", input: { file_path: "/w/c.txt", content: "c\n" }, result: { type: "tool_result", tool_use_id: "w1", content: "File created successfully at: /w/c.txt" } }
  }, { tone: "tool" });
  const api = streaming(write, joinedOutput({ toolUseId: "w1", output: "File created successfully at: /w/c.txt", complete: true }));
  const r = await read(api, { itemId: write.id });
  assert.deepEqual([r.kind, r.text], ["payload", JSON.stringify(write.payload, null, 2)]);
  assert.match(r.text as string, /"file_path": "\/w\/c\.txt"/);
  assert.ok(!api.calls.some((c) => c.path.endsWith("/output")), "the join was never read");
  // A chunk: only a command's (`command_output`) is joined; a file change's is its payload as it is.
  const editChunk = activity("tool.output", { toolUseId: "w1", streamKind: "file_change_output", delta: "File created successfully at: /w/c.txt" }, { tone: "tool", summary: "Tool output" });
  const e = await read(streaming(editChunk, joinedOutput({ toolUseId: "w1", output: "File created successfully at: /w/c.txt" })), { itemId: editChunk.id });
  assert.deepEqual([e.kind, e.text], ["payload", JSON.stringify(editChunk.payload, null, 2)]);
  const bashChunk = activity("tool.output", { toolUseId: "b1", streamKind: "command_output", delta: "a\n" }, { tone: "tool", summary: "Tool output" });
  const b = await read(streaming(bashChunk, joinedOutput({ toolUseId: "b1", output: "a\nb\n", complete: false })), { itemId: bashChunk.id });
  assert.deepEqual([b.kind, b.text, b.running], ["command-output", "a\nb\n", true]);
});

test("only a command row's call is joined: a message, a task row and a row naming no call never ask the host", async () => {
  const task = activity("task.started", { taskId: "task-1", toolUseId: "toolu_launch", agentKind: "agent", detail: "Explore" }, { summary: "Task started" });
  const warning = activity("runtime.warning", { message: "careful" }, { summary: "careful" });
  for (const item of [message("assistant", "done"), task, warning]) {
    const api = holding(item);
    await read(api, { itemId: item.id });
    assert.ok(!api.calls.some((c) => c.path.endsWith("/output")), item.id);
  }
});

test("read_transcript's outputItemId on a background shell's drill-in row is what read_tool_output joins", async () => {
  const shell = (activityKind: string, payload: Record<string, unknown>) =>
    activity(activityKind, { toolUseId: "bgshell:task-1", ...payload }, { agentId: "task-1", tone: "tool", turnId: "t1" });
  const started = shell("tool.started", { itemType: "command_execution", title: "Background shell", status: "inProgress", data: { toolName: "Bash", input: { command: "make" }, background: true } });
  const chunks = [shell("tool.output", { streamKind: "command_output", delta: "building\n" }), shell("tool.output", { streamKind: "command_output", delta: "  still building\n" })];
  const served: ThreadSnapshotPayload = snapshot({ turns: [turn({ state: "completed", requestedAt: stamp(0) })], items: [message("user", "build it", { id: "u1" }), started, ...chunks].map((item) => (item.kind === "activity" ? { ...item, payload: slimActivityPayload(item.payload) } : item)) });
  const api = streaming(started, joinedOutput({ output: "building\n  still building\n", complete: false }))
    .on("GET", agentChatRoutes.thread("c1"), { status: 200, body: { kind: "snapshot", thread: served } });
  const transcript = messageTools.find((t) => t.name === "read_transcript")!;
  const read_ = await transcript.run(parse(transcript, { sessionId: "c1", agentId: "task-1" }), ctx(api));
  const row = (read_.entries as { kind: string; outputItemId?: string }[]).find((e) => e.kind === "tool")!;
  assert.equal(row.outputItemId, started.id);
  const whole = await read(api, { itemId: row.outputItemId! });
  assert.deepEqual([whole.kind, whole.text, whole.running], ["command-output", "building\n  still building\n", true]);
});
