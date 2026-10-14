/**
 * Grok's `orquester` session-tool wiring, pure parts (design 2026-10-14
 * §1.2–§1.4): the ACP `mcpServers` entry and `_meta.rules`, the recognition
 * of a session tool's call, and the raw-frame redaction of its credential.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactAcpFrame } from "./acp/redact.ts";
import type { ToolCallUpdate } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import { grokSessionMcpServers, grokSessionMeta, grokSessionToolName, isGrokSessionToolCall } from "./session-tools.ts";

const launch = {
  url: "http://127.0.0.1:4711/mcp",
  authorization: "Bearer cred-0123456789abcdef",
  instructions: "## Orquester",
  toolNames: new Set(["echo"])
};

test("the mcpServers entry is ACP http, named orquester, with the bearer as a header", () => {
  assert.deepEqual(grokSessionMcpServers(launch), [
    {
      type: "http",
      name: "orquester",
      url: "http://127.0.0.1:4711/mcp",
      headers: [{ name: "Authorization", value: "Bearer cred-0123456789abcdef" }]
    }
  ]);
  assert.deepEqual(grokSessionMcpServers(undefined), []);
});

test("the instruction block is `_meta.rules`, absent when empty", () => {
  assert.deepEqual(grokSessionMeta(launch), { rules: "## Orquester" });
  assert.equal(grokSessionMeta({ ...launch, instructions: "" }), undefined);
  assert.equal(grokSessionMeta(undefined), undefined);
});

test("a session tool's call is recognised by its exact name, never a substring", () => {
  const meta = (name: string, namespace?: string) => ({ "x.ai/tool": { name, ...(namespace ? { namespace } : {}) } });
  assert.equal(isGrokSessionToolCall({ title: null, _meta: meta("orquester__echo") }), true);
  assert.equal(isGrokSessionToolCall({ title: null, _meta: meta("echo", "orquester") }), true);
  assert.equal(isGrokSessionToolCall({ title: "orquester__echo", _meta: null }), true);
  assert.equal(isGrokSessionToolCall({ title: "Run orquester__echo now", _meta: null }), false);
  assert.equal(isGrokSessionToolCall({ title: "write", _meta: meta("write", "opencode") }), false);
  assert.equal(isGrokSessionToolCall({ title: null, _meta: meta("linear__get_issue") }), false);
  assert.equal(isGrokSessionToolCall(undefined), false);
  assert.equal(grokSessionToolName({ title: null, _meta: meta("orquester__echo") }), "echo");
  assert.equal(grokSessionToolName({ title: "write", _meta: null }), null);
});

test("a call through Grok's use_tool meta-tool is recognised by its tool_name argument", () => {
  // Fixture 32 (`32-mcp-use-tool-call.ndjson`): the first frame is titled and
  // `_meta`-named `use_tool`, the qualified catalog key is in `rawInput`; the
  // update after it keeps the vendor block; the end has none.
  const useTool = { "x.ai/tool": { version: 1, name: "use_tool", kind: "use_tool", namespace: "grok_build" } };
  const rawInput = { tool_name: "orquester__html_render", tool_input: { title: "Chart" } };
  assert.equal(grokSessionToolName({ title: "use_tool", _meta: useTool, rawInput }), "html_render");
  // A frame without the vendor block counts only when an earlier one said `use_tool`.
  assert.equal(grokSessionToolName({ title: null, _meta: null, rawInput: { variant: "UseTool", ...rawInput } }), null);
  assert.equal(
    grokSessionToolName({ title: null, _meta: null, rawInput: { variant: "UseTool", ...rawInput } }, { usesTool: true }),
    "html_render"
  );
  assert.equal(isGrokSessionToolCall({ title: "use_tool", _meta: null, rawInput }), true);
  // Another server through use_tool, or a `tool_name` argument of any other tool.
  assert.equal(grokSessionToolName({ title: "use_tool", _meta: useTool, rawInput: { tool_name: "serena__find_symbol" } }), null);
  assert.equal(grokSessionToolName({ title: "read_file", _meta: null, rawInput }), null);
});

test("fixture 33: the captured permission request for an MCP use_tool call names the session tool", () => {
  const request = agentFrames(readCapture("33-mcp-use-tool-permission.ndjson")).find(
    (frame) => frame.method === "session/request_permission"
  );
  assert.ok(request, "the capture holds the request");
  const toolCall = (request.params as { toolCall: ToolCallUpdate }).toolCall;
  // As captured: the qualified title, the use_tool vendor block, rawInput.tool_name.
  assert.equal(toolCall.title, "orquester__echo");
  assert.equal(grokSessionToolName(toolCall), "echo");
  // Either half alone suffices: the title, or the vendor block with tool_name.
  assert.equal(grokSessionToolName({ ...toolCall, title: "use_tool" }), "echo");
  assert.equal(grokSessionToolName({ ...toolCall, rawInput: {} }), "echo");
  // Without the vendor block and the qualified title, an argument names nothing.
  assert.equal(grokSessionToolName({ ...toolCall, title: "use_tool", _meta: null }), "echo", "title use_tool is the marker");
  assert.equal(grokSessionToolName({ ...toolCall, title: "read_file", _meta: null }), null);
  const options = (request.params as { options: Array<{ optionId: string; kind: string }> }).options;
  assert.deepEqual(
    options.map((option) => option.kind),
    ["allow_always", "allow_once", "reject_once"]
  );
});

test("the raw log masks an MCP server's headers like its env", () => {
  const frame = {
    jsonrpc: "2.0",
    id: 3,
    method: "session/new",
    params: { cwd: "/w", mcpServers: grokSessionMcpServers(launch), _meta: { rules: "## Orquester" } }
  };
  const redacted = JSON.stringify(redactAcpFrame(frame));
  assert.ok(!redacted.includes("cred-0123456789abcdef"));
  assert.ok(redacted.includes("http://127.0.0.1:4711/mcp"), "only the secret goes");
  assert.ok(redacted.includes("Authorization"), "the header's name stays");
});
