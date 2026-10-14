/**
 * Session tools as the timeline reads them (design 2026-10-14 §1.1, §1.5):
 * every provider's spelling, and the reference fields kept through slimming.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  boundSessionToolData,
  isSessionToolsServerName,
  SESSION_TOOL_PERSISTED_STRING_MAX_BYTES,
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
  // fixture 33: a text block equal to the structuredContent's JSON gave one line
  assert.deepEqual(sessionToolReferences({ rawOutput: { type: "MCP", output: { OkayOutput: json } } }, keys), { htmlRender: ref });
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

// ---------------------------------------------------------------------------
// What a session tool's row persists (an html_preview screenshot must not)
// ---------------------------------------------------------------------------

const PNG_BASE64 = "iVBORw0KGgo".padEnd(400_000, "A");
const PREVIEW_JSON = JSON.stringify({ width: 728, contentHeight: 300, capturedHeight: 300, consoleMessages: [] });

test("image bytes leave every provider's recorded result; the rest stays", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    // Codex: the MCP CallToolResult as the server answered it.
    [
      "codex",
      {
        server: "orquester",
        tool: "html_preview",
        arguments: { html: "<p>x</p>" },
        result: {
          content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }, { type: "text", text: PREVIEW_JSON }],
          structuredContent: JSON.parse(PREVIEW_JSON)
        }
      }
    ],
    // Claude: the CLI's tool_result block, the image as a base64 source.
    [
      "claude",
      {
        toolName: "mcp__orquester__html_preview",
        input: { html: "<p>x</p>" },
        result: {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
            { type: "text", text: PREVIEW_JSON }
          ]
        }
      }
    ],
    // OpenCode: images become data-URL attachments on the part's state.
    [
      "opencode",
      {
        tool: "orquester-0123456789abcdef_html_preview",
        state: {
          status: "completed",
          input: { html: "<p>x</p>" },
          output: PREVIEW_JSON,
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG_BASE64}` }]
        },
        result: PREVIEW_JSON
      }
    ],
    // Grok: ACP content blocks.
    [
      "grok",
      {
        vendorTool: "use_tool",
        rawInput: { tool_name: "orquester__html_preview", tool_input: { html: "<p>x</p>" } },
        content: [{ type: "content", content: { type: "image", data: PNG_BASE64, mimeType: "image/png" } }],
        rawOutput: { type: "MCP", tool_name: "html_preview", server_name: "orquester", output: { OkayOutput: PREVIEW_JSON } }
      }
    ]
  ];
  for (const [provider, data] of cases) {
    const bounded = boundSessionToolData({ ...data, sessionTool: { name: "html_preview" } }) as Record<string, unknown>;
    const json = JSON.stringify(bounded);
    assert.ok(!json.includes(PNG_BASE64.slice(0, 2000)), `${provider}: no image bytes`);
    assert.ok(json.length < 4_000, `${provider}: ${json.length} bytes`);
    assert.ok(json.includes("omitted"), provider);
    assert.ok(json.includes('\\"contentHeight\\":300') || json.includes('"contentHeight":300'), provider);
    assert.deepEqual(bounded.sessionTool, { name: "html_preview" });
  }
});

test("a string blob is cut at the cap; arguments, small values and untouched data keep their identity", () => {
  const big = "x".repeat(SESSION_TOOL_PERSISTED_STRING_MAX_BYTES + 5_000);
  const data = {
    toolName: "mcp__orquester__echo",
    input: { html: big },
    result: { type: "tool_result", content: big },
    sessionTool: { name: "echo" }
  };
  const bounded = boundSessionToolData(data) as typeof data;
  assert.equal(bounded.input, data.input, "the agent's arguments are kept as written");
  assert.ok(bounded.result.content.length < SESSION_TOOL_PERSISTED_STRING_MAX_BYTES + 100);
  assert.match(bounded.result.content, /… \[5000 bytes omitted\]$/);
  // Multi-byte text is cut on a whole character.
  const wide = boundSessionToolData({ result: "é".repeat(SESSION_TOOL_PERSISTED_STRING_MAX_BYTES) }) as { result: string };
  assert.match(wide.result, /^é+… \[\d+ bytes omitted\]$/);
  const small = { toolName: "mcp__orquester__echo", result: { content: [{ type: "text", text: "{}" }] }, sessionTool: { name: "echo" } };
  assert.equal(boundSessionToolData(small), small);
});

test("an html_render result keeps its reference through bounding and both slims", () => {
  const ref = { attachmentId: "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html", title: "Chart", height: 420 };
  const text = JSON.stringify({ htmlRender: ref, message: "Shown to the reader above your reply." });
  const data = {
    server: "orquester",
    tool: "html_render",
    arguments: { html: "<p>" + "x".repeat(200_000) + "</p>", title: "Chart", height: 420 },
    result: { content: [{ type: "text", text }], structuredContent: JSON.parse(text) },
    sessionTool: { name: "html_render" }
  };
  const bounded = boundSessionToolData(data) as Record<string, unknown>;
  assert.equal(bounded, data, "nothing in an html_render result is a blob");
  assert.deepEqual(sessionToolReferences(bounded), { htmlRender: ref });
  const slim = slimActivityPayload(slimActivityPayload({ itemType: "mcp_tool_call", status: "completed", data: bounded })) as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(slim.data.sessionTool, { name: "html_render", references: { htmlRender: ref } });
});
