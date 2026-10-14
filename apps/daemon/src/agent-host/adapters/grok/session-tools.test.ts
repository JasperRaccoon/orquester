/**
 * Grok's `orquester` session-tool wiring, pure parts (design 2026-10-14
 * §1.2–§1.4): the ACP `mcpServers` entry and `_meta.rules`, the recognition
 * of a session tool's call, and the raw-frame redaction of its credential.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactAcpFrame } from "./acp/redact.ts";
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
