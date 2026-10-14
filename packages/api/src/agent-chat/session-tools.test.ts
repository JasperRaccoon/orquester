/**
 * Session tools as the timeline reads them (design 2026-10-14 §1.1, §1.5):
 * every provider's spelling, and the reference fields kept through slimming.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionToolsServerName,
  parseSessionToolName,
  projectSessionToolData,
  sessionToolMarkedData,
  sessionToolNameFromProviderData,
  sessionToolNameOfData,
  sessionToolReferences,
  SESSION_TOOL_REFERENCE_KEYS,
  SESSION_TOOL_REFERENCE_MAX_BYTES
} from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";

test("every provider's spelling parses to the bare name", () => {
  assert.equal(parseSessionToolName("mcp__orquester__html_render"), "html_render");
  assert.equal(parseSessionToolName("orquester__thread_wait"), "thread_wait");
  assert.equal(parseSessionToolName("orquester.task_status"), "task_status");
  assert.equal(parseSessionToolName("orquester-0123456789abcdef_echo"), "echo");
});

test("anything else is not a session tool", () => {
  for (const name of [
    "mcp__github__create_issue",
    "orquester",
    "mcp__orquester__",
    "mcp__orquester__Upper",
    "orquester-0123_echo", // a short key is not OpenCode's server
    "orquester-0123456789ABCDEF_echo",
    "xorquester__echo",
    undefined,
    7
  ]) {
    assert.equal(parseSessionToolName(name), null, String(name));
  }
  assert.equal(isSessionToolsServerName("orquester"), true);
  assert.equal(isSessionToolsServerName("orquester-0123456789abcdef"), true);
  assert.equal(isSessionToolsServerName("orquester-x"), false);
});

test("the provider spelling is read off each provider's activity data", () => {
  // Claude
  assert.equal(sessionToolNameFromProviderData({ toolName: "mcp__orquester__echo", input: {} }), "echo");
  // Codex
  assert.equal(sessionToolNameFromProviderData({ server: "orquester", tool: "echo", arguments: {} }), "echo");
  // Grok
  assert.equal(sessionToolNameFromProviderData({ toolUseId: "c1", vendorTool: "orquester__echo" }), "echo");
  // Grok's `use_tool` meta-tool, as it really calls an MCP tool (the qualified key is its argument)
  assert.equal(
    sessionToolNameFromProviderData({ vendorTool: "use_tool", rawInput: { tool_name: "orquester__echo", tool_input: {} } }),
    "echo"
  );
  assert.equal(
    sessionToolNameFromProviderData({ rawInput: { variant: "UseTool", tool_name: "orquester__echo" } }),
    null,
    "arguments alone are no use_tool call: the adapter's vendorTool says so"
  );
  assert.equal(
    sessionToolNameFromProviderData({ vendorTool: "use_tool", rawInput: { tool_name: "serena__echo" } }),
    null,
    "another server through use_tool"
  );
  assert.equal(
    sessionToolNameFromProviderData({ vendorTool: "read_file", rawInput: { tool_name: "orquester__echo" } }),
    null,
    "a tool_name argument of any other tool names nothing"
  );
  // OpenCode
  assert.equal(sessionToolNameFromProviderData({ tool: "orquester-0123456789abcdef_echo", toolUseId: "c" }), "echo");
  // another server's call — even one whose tool happens to be spelled like ours
  assert.equal(sessionToolNameFromProviderData({ server: "github", tool: "echo" }), null);
  assert.equal(sessionToolNameFromProviderData({ server: "github", tool: "orquester__echo" }), null);
  assert.equal(sessionToolNameFromProviderData(null), null);
});

test("a row is a session tool's only by the ingestion's marker, never by its spelling", () => {
  const registered = new Set(["echo"]);
  // The host's own tool: marked.
  const marked = sessionToolMarkedData({ toolName: "mcp__orquester__echo", input: {} }, registered);
  assert.deepEqual(marked, { toolName: "mcp__orquester__echo", input: {}, sessionTool: { name: "echo" } });
  assert.equal(sessionToolNameOfData(marked), "echo");
  // A user's same-named external /mcp server: spelled alike, never marked, never read as ours.
  const external = { toolName: "mcp__orquester__send_message", input: {} };
  assert.equal(sessionToolMarkedData(external, registered), external);
  assert.equal(sessionToolNameOfData(external), null);
  assert.equal(sessionToolNameOfData({ toolName: "mcp__orquester__echo" }), null, "spelling alone is not provenance");
  // No session tools: nothing marked.
  const plain = { server: "orquester", tool: "echo" };
  assert.equal(sessionToolMarkedData(plain, new Set()), plain);
});

test("reference fields are read from structuredContent or the JSON text block", () => {
  const ref = { attachmentId: "a1", title: "Chart", height: 400 };
  const keys = ["htmlRender"];
  // Codex: a CallToolResult with structuredContent
  assert.deepEqual(
    sessionToolReferences(
      { server: "orquester", tool: "x", result: { content: [], structuredContent: { htmlRender: ref, message: "m" } } },
      keys
    ),
    { htmlRender: ref }
  );
  // Claude: the tool_result block carries the JSON as text only
  assert.deepEqual(
    sessionToolReferences(
      {
        toolName: "mcp__orquester__x",
        result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ htmlRender: ref }) }] }
      },
      keys
    ),
    { htmlRender: ref }
  );
  // OpenCode: the output is the text itself
  assert.deepEqual(
    sessionToolReferences({ tool: "orquester-0123456789abcdef_x", result: JSON.stringify({ htmlRender: ref }) }, keys),
    { htmlRender: ref }
  );
  // Grok's use_tool: `rawOutput.output.OkayOutput` joins the text blocks and the
  // structuredContent (as JSON) one per line — fixture 32 in
  // apps/daemon/test/fixtures/grok shows `"widget shown\n{\"n\":1}"`.
  const json = JSON.stringify({ htmlRender: ref, message: "m" });
  assert.deepEqual(
    sessionToolReferences({ rawOutput: { type: "MCP", server_name: "orquester", output: { OkayOutput: `${json}\n${json}` } } }, keys),
    { htmlRender: ref }
  );
  assert.deepEqual(
    sessionToolReferences({ rawOutput: { type: "MCP", output: { OkayOutput: `Published.\n${json}` } } }, keys),
    { htmlRender: ref }
  );
  // the last line carrying a listed key wins; a line that is no JSON object is skipped
  assert.deepEqual(
    sessionToolReferences({ rawOutput: { output: { OkayOutput: `{"htmlRender":1}\n{not json\n{"other":2}` } } }, keys),
    { htmlRender: 1 }
  );
  // a key nobody listed is not kept, and an oversized reference is dropped whole
  assert.equal(sessionToolReferences({ result: { structuredContent: { other: 1 } } }, keys), undefined);
  const huge = { htmlRender: { blob: "x".repeat(SESSION_TOOL_REFERENCE_MAX_BYTES) } };
  assert.equal(sessionToolReferences({ result: { structuredContent: huge } }, keys), undefined);
  // not JSON, or no listed keys at all
  assert.equal(sessionToolReferences({ result: "plain text" }, keys), undefined);
  assert.equal(sessionToolReferences({ result: { structuredContent: { htmlRender: ref } } }, []), undefined);
});

test("projectSessionToolData keeps the marker and adds its references", () => {
  assert.deepEqual(projectSessionToolData({ server: "orquester", tool: "echo", sessionTool: { name: "echo" } }, ["x"]), { name: "echo" });
  assert.deepEqual(
    projectSessionToolData(
      { server: "orquester", tool: "echo", sessionTool: { name: "echo" }, result: { structuredContent: { x: 1 } } },
      ["x"]
    ),
    { name: "echo", references: { x: 1 } }
  );
  assert.equal(projectSessionToolData({ server: "orquester", tool: "echo" }, ["x"]), undefined, "unmarked");
});

test("a row slimmed before keeps its references: the summary its result became is not re-read", () => {
  const ref = { attachmentId: "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html", title: "Chart", height: 400 };
  const slimmedOnce = {
    server: "orquester",
    tool: "html_render",
    result: '{"htmlRender":{"attachmentId":"t1-0f8fad5b-d9cb-469f-a165-7086…',
    sessionTool: { name: "html_render", references: { htmlRender: ref } }
  };
  assert.deepEqual(projectSessionToolData(slimmedOnce), { name: "html_render", references: { htmlRender: ref } });
  // Only the listed keys, and still under the size cap.
  assert.equal(projectSessionToolData({ ...slimmedOnce, sessionTool: { name: "html_render", references: { other: 1 } } })?.references, undefined);
});

test("htmlRender is a kept reference key and survives a double slim through the unified path", () => {
  assert.ok(SESSION_TOOL_REFERENCE_KEYS.includes("htmlRender"));
  const ref = { attachmentId: "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html", title: "Chart", height: 400 };
  const payload = {
    itemType: "mcp_tool_call",
    status: "completed",
    data: sessionToolMarkedData(
      {
        toolName: "mcp__orquester__html_render",
        input: { html: "<p>hi</p>" },
        result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ htmlRender: ref, message: "Shown." }) }] }
      },
      new Set(["html_render"])
    )
  };
  const once = slimActivityPayload(payload) as { data: Record<string, unknown> };
  const twice = slimActivityPayload(once) as { data: Record<string, unknown> };
  assert.deepEqual(once.data.sessionTool, { name: "html_render", references: { htmlRender: ref } });
  assert.deepEqual(twice.data.sessionTool, { name: "html_render", references: { htmlRender: ref } });
});

test("a marked row keeps data.sessionTool through slimming; an unmarked MCP row has none", () => {
  const slim = slimActivityPayload({
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      toolName: "mcp__orquester__echo",
      input: { text: "hi" },
      result: { content: [{ type: "text", text: "{}" }] },
      sessionTool: { name: "echo" }
    }
  }) as { data: Record<string, unknown> };
  assert.deepEqual(slim.data.sessionTool, { name: "echo" });
  for (const data of [{ toolName: "mcp__github__list", input: {} }, { toolName: "mcp__orquester__send_message", input: {} }]) {
    const other = slimActivityPayload({ itemType: "mcp_tool_call", status: "completed", data }) as {
      data: Record<string, unknown>;
    };
    assert.equal(other.data.sessionTool, undefined, "no marker, no session tool");
  }
});
