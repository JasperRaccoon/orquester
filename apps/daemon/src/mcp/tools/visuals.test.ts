/**
 * The `visuals` family (unified MCP design 2026-10-15 §4 rows 42–43; design 2026-10-14 §2.1),
 * ported from `session-tools/html/html.test.ts` and run through THE executor as a chat caller:
 * what the agent is told, what it may send, and what it gets back. Plus the §9.5 byte budgets of
 * every Task 13 tool, measured on `tools/list` as an MCP client receives it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_HTML_CHARS,
  HTML_RENDER_THEME_TOKENS,
  type HtmlRenderReference
} from "@orquester/api/agent-chat";

import type { AnyOrquesterTool, ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import { catalogFor, toolByName } from "../catalog/index.ts";
import { audienceDescription, audienceSchema, audienceShape, executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { secretsFamily } from "./secrets.ts";
import { toolsetsFamily } from "./toolsets.ts";
import { HTML_RENDER_SHOWN_MESSAGE, HTML_RENDER_TOKEN_LINE, visualsFamily } from "./visuals.ts";

const THREAD = "thread-1";
const REFERENCE: HtmlRenderReference = {
  attachmentId: "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  title: "Chart",
  height: 420,
  heights: [
    [320, 610],
    [728, 420]
  ]
};

function chatCaller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: THREAD, title: "Charts", projectPath: "", workspace: "", cwd: "/w/ws/p", agentId: "claude", callId: "call-1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

const call = (api: FakeDaemonApi, name: string, args: unknown, opts: { signal?: AbortSignal; caller?: ToolCaller } = {}): Promise<CallToolResult> =>
  executeToolCall(
    { approvals: null, enabledToolsets: async () => new Set(["core"]) },
    { name, arguments: args },
    { caller: opts.caller ?? chatCaller(), api, signal: opts.signal ?? new AbortController().signal }
  );

function errorOf(result: CallToolResult): { code: string; message: string } {
  assert.equal(result.isError, true);
  return result.structuredContent as { code: string; message: string };
}

const tool = (name: string) => visualsFamily.find((entry) => entry.name === name)!;

describe("visuals definitions", () => {
  const preview = tool("html_preview");
  const render = tool("html_render");

  it("are chat-only core tools: html_preview Read, html_render Act, both plan-safe; the catalog serves them", () => {
    for (const entry of [preview, render]) {
      assert.deepEqual(entry.audiences, ["chat"]);
      assert.equal(entry.toolset, "core");
      assert.equal(entry.planSafe, true);
      assert.equal(toolByName(entry.name, "chat"), entry, `${entry.name} is the catalog's`);
      assert.equal(toolByName(entry.name, "external"), undefined);
    }
    assert.equal(preview.tier, "read");
    assert.equal(render.tier, "act");
  });

  it("keep the guidance with Orquester's widths and theme tokens, stated once", () => {
    for (const fragment of [
      "headless browser",
      "screenshot of its top (at most 4000px; PNG, or JPEG scaled down when a PNG would pass 3 MiB",
      "contentHeight",
      "stack traces pointing into page.html",
      "before html_render",
      "cannot reach this machine or its local network",
      "html_render still works without a preview",
      "page rules, layout and theme variables are html_render's"
    ]) {
      assert.ok(preview.description.includes(fragment), fragment);
    }
    for (const fragment of [
      "above your final text reply",
      "should not announce it",
      "Preview with html_preview first",
      "fits the frame to the page's height at each reader's width",
      "inside this chat's project",
      "transparent",
      "var(--radius)",
      "100vh",
      `${HTML_RENDER_COLUMN_WIDTH}px`,
      HTML_RENDER_TOKEN_LINE
    ]) {
      assert.ok(render.description.includes(fragment), fragment.slice(0, 60));
    }
    // Every token a page receives is named for the agent, on one line.
    for (const token of HTML_RENDER_THEME_TOKENS.filter((name) => !name.startsWith("--chart-"))) {
      assert.ok(HTML_RENDER_TOKEN_LINE.includes(token), token);
    }
    assert.ok(HTML_RENDER_TOKEN_LINE.includes("--chart-1 … --chart-6"));
    assert.doesNotMatch(`${preview.description} ${render.description}`, /\bT3\b/);
    // The page rules live in html_render only (§9.5: one rule stated once).
    assert.doesNotMatch(preview.description, /self-contained document/);
  });

  it("are read-only and open-world; only the preview is idempotent", () => {
    assert.deepEqual(preview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.deepEqual(render.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.equal(preview.resultKind, "image");
    assert.equal(render.resultKind, "json");
  });
});

describe("visuals argument bounds", () => {
  const page = "<p>hi</p>";
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["html_preview", { html: "" }, /html/],
    ["html_preview", { html: "x".repeat(HTML_RENDER_MAX_HTML_CHARS + 1) }, /html/],
    ["html_preview", { html: page, width: 239 }, /width/],
    ["html_preview", { html: page, width: 1601 }, /width/],
    ["html_preview", { html: page, width: 400.5 }, /width/],
    ["html_preview", { html: page, appearance: "sepia" }, /appearance/],
    ["html_preview", { html: page, threadId: "someone-else" }, /threadId/],
    ["html_render", { html: page, title: "", height: 200 }, /title/],
    ["html_render", { html: page, title: "t".repeat(201), height: 200 }, /title/],
    ["html_render", { html: page, title: "T", height: 79 }, /height/],
    ["html_render", { html: page, title: "T", height: 2001 }, /height/],
    ["html_render", { html: page, title: "T" }, /height/],
    ["html_render", { html: page, height: 300 }, /title/],
    ["html_render", { html: page, title: "T", height: 300, threadId: "someone-else" }, /threadId/]
  ];

  for (const [name, args, field] of refused) {
    it(`${name} refuses ${JSON.stringify(args).slice(0, 70)}`, async () => {
      const api = new FakeDaemonApi();
      const error = errorOf(await call(api, name, args));
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, field);
      assert.equal(api.previews.length + api.publishes.length, 0);
    });
  }

  it("accepts the bounds themselves", async () => {
    const api = new FakeDaemonApi()
      .onPublishHtml(() => ({ ok: true, value: REFERENCE }))
      .onPreviewHtml((request) => ({
        ok: true,
        value: { screenshot: { data: "AAAA", mimeType: "image/png", width: 1, height: 1 }, width: request.width ?? HTML_RENDER_COLUMN_WIDTH, contentHeight: 1, capturedHeight: 1, consoleMessages: [] }
      }));
    for (const [name, args] of [
      ["html_preview", { html: "x".repeat(HTML_RENDER_MAX_HTML_CHARS), width: 240, appearance: "light" }],
      ["html_preview", { html: "x", width: 1600 }],
      ["html_render", { html: "x", title: "t".repeat(200), height: 80 }],
      ["html_render", { html: "x", title: "T", height: 2000 }]
    ] as const) {
      const result = await call(api, name, args);
      assert.notEqual(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 60)}`);
    }
  });
});

describe("html_render", () => {
  it("publishes into the CALLING chat and answers the reference and the message, as text and structured", async () => {
    const api = new FakeDaemonApi().onPublishHtml(() => ({ ok: true, value: REFERENCE }));
    const controller = new AbortController();
    const result = await call(api, "html_render", { html: "<p>chart</p>", title: "Chart", height: 420 }, { signal: controller.signal });
    assert.equal(result.isError, undefined);
    assert.equal(api.publishes.length, 1);
    const request = api.publishes[0]!;
    assert.equal(request.threadId, THREAD);
    assert.equal(request.html, "<p>chart</p>");
    assert.equal(request.title, "Chart");
    assert.equal(request.height, 420);
    assert.equal(request.signal, controller.signal);
    const expected = { htmlRender: REFERENCE, message: HTML_RENDER_SHOWN_MESSAGE };
    assert.deepEqual(result.structuredContent, expected);
    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), expected);
    assert.equal(
      HTML_RENDER_SHOWN_MESSAGE,
      "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say."
    );
  });

  it("answers a refusal as an error result with the publisher's own message", async () => {
    const api = new FakeDaemonApi().onPublishHtml(() => ({
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "These local images could not be read: /p/x.png. Use absolute paths to existing image files, or remove them."
    }));
    const error = errorOf(await call(api, "html_render", { html: "<img src='/p/x.png'>", title: "T", height: 200 }));
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /could not be read: \/p\/x\.png/);
  });

  it("works while the chat plans, in every permission mode, and for a workflow-owned chat", async () => {
    for (const over of [{ planning: true }, { runtimeMode: "full-access" as const }, { workflowOwned: true }]) {
      const api = new FakeDaemonApi().onPublishHtml(() => ({ ok: true, value: REFERENCE }));
      const result = await call(api, "html_render", { html: "<p>x</p>", title: "T", height: 200 }, { caller: chatCaller(over) });
      assert.equal(result.isError, undefined, JSON.stringify(over));
    }
  });

  it("is no external tool", async () => {
    const api = new FakeDaemonApi();
    const error = errorOf(await call(api, "html_render", { html: "<p>x</p>", title: "T", height: 200 }, { caller: { kind: "external" } }));
    assert.equal(error.code, "TOOL_NOT_FOUND");
    assert.equal(api.publishes.length, 0);
  });
});

describe("html_preview", () => {
  it("answers the screenshot as MCP image content first (its own type), then the measurements as JSON", async () => {
    const api = new FakeDaemonApi().onPreviewHtml(() => ({
      ok: true,
      value: {
        screenshot: { data: "/9j/4AAQ", mimeType: "image/jpeg", width: 195, height: 450 },
        width: 390,
        contentHeight: 900,
        capturedHeight: 900,
        consoleMessages: [{ level: "log", text: "ok" }],
        missingImages: ["/p/gone.png"]
      }
    }));
    const result = await call(api, "html_preview", { html: "<p>x</p>", width: 390, appearance: "light" }, { caller: chatCaller({ planning: true }) });
    assert.equal(result.isError, undefined);
    const request = api.previews[0]!;
    assert.equal(request.threadId, THREAD);
    assert.equal(request.width, 390);
    assert.equal(request.appearance, "light");
    assert.deepEqual(result.content[0], { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" });
    const expected = {
      screenshot: { mimeType: "image/jpeg", width: 195, height: 450 },
      width: 390,
      contentHeight: 900,
      capturedHeight: 900,
      consoleMessages: [{ level: "log", text: "ok" }],
      missingImages: ["/p/gone.png"]
    };
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(JSON.parse((result.content[1] as { text: string }).text), expected);
  });

  it("leaves width and appearance to the daemon's defaults when the agent omits them", async () => {
    const api = new FakeDaemonApi().onPreviewHtml(() => ({ ok: false, code: "UNAVAILABLE", message: "no browser" }));
    await call(api, "html_preview", { html: "<p>x</p>" });
    assert.equal("width" in api.previews[0]!, false);
    assert.equal("appearance" in api.previews[0]!, false);
  });

  it("answers no browser, a timeout, or a cancellation as an error result", async () => {
    for (const [code, message] of [
      ["UNAVAILABLE", "Orquester has no Chromium-family browser on this machine yet"],
      ["TIMEOUT", "The page did not finish loading within 20 seconds."]
    ] as const) {
      const api = new FakeDaemonApi().onPreviewHtml(() => ({ ok: false, code, message }));
      const error = errorOf(await call(api, "html_preview", { html: "<p>x</p>" }));
      assert.deepEqual(error, { code, message });
    }
    const api = new FakeDaemonApi().onPreviewHtml(() => ({ ok: true, value: { screenshot: { data: "A", mimeType: "image/png", width: 1, height: 1 }, width: 1, contentHeight: 1, capturedHeight: 1, consoleMessages: [] } }));
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(errorOf(await call(api, "html_preview", { html: "<p>x</p>" }, { signal: aborted.signal })).code, "CANCELLED");
    assert.equal(api.previews.length, 0);
  });
});

// ---------------------------------------------------------------------------
// §9.5 budgets of Task 13's tools, on tools/list as an MCP client receives it
// ---------------------------------------------------------------------------

async function listed(tools: readonly AnyOrquesterTool[]): Promise<Map<string, { bytes: number; description: number }>> {
  const server = new McpServer({ name: "orquester", version: "test" });
  for (const entry of tools) {
    const shape = audienceShape(entry, "chat");
    server.registerTool(
      entry.name,
      { title: entry.title, description: audienceDescription(entry, "chat"), inputSchema: Object.keys(shape).length > 0 ? shape : audienceSchema(entry, "chat"), annotations: entry.annotations },
      () => ({ content: [] })
    );
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "budget", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools: rows } = await client.listTools();
    return new Map(rows.map((row) => [row.name, { bytes: Buffer.byteLength(JSON.stringify(row), "utf8"), description: Buffer.byteLength(row.description ?? "", "utf8") }]));
  } finally {
    await client.close();
    await server.close();
  }
}

describe("§9.5 byte budgets", () => {
  it("each Task 13 tool meets its per-tool target (request_toolset: the fixed schema overhead, see the report)", async () => {
    const rows = await listed([...visualsFamily, ...secretsFamily, ...toolsetsFamily]);
    // Targets (baselines): html_preview 1 700 (1 849), html_render 3 000 (3 669), request_secret 1 500 (1 792);
    // request_toolset 700 is under its own schema + annotations overhead (~670 bytes): held to 1 000.
    const targets: Record<string, { bytes: number; description: number }> = {
      html_preview: { bytes: 1_700, description: 2_000 },
      html_render: { bytes: 3_000, description: 2_000 },
      request_secret: { bytes: 1_500, description: 1_000 },
      request_toolset: { bytes: 1_000, description: 1_000 }
    };
    assert.deepEqual([...rows.keys()].sort(), Object.keys(targets).sort());
    for (const [name, target] of Object.entries(targets)) {
      const row = rows.get(name)!;
      assert.ok(row.bytes <= target.bytes, `${name}: ${row.bytes} bytes > ${target.bytes}`);
      assert.ok(row.description <= target.description, `${name}: description ${row.description} bytes > ${target.description}`);
    }
    // Together they stay inside the sum of the §9.5 targets (6 900).
    const sum = [...rows.values()].reduce((total, row) => total + row.bytes, 0);
    assert.ok(sum <= 6_900, `Task 13's tools are ${sum} bytes together`);
  });

  it("every .describe() text is ≤ 160 bytes, and the chat catalog serves all four", () => {
    for (const entry of [...visualsFamily, ...secretsFamily, ...toolsetsFamily]) {
      assert.ok(catalogFor("chat").includes(entry), entry.name);
      for (const [key, field] of Object.entries(entry.input as Record<string, { description?: string }>)) {
        assert.ok(Buffer.byteLength(field.description ?? "", "utf8") <= 160, `${entry.name}.${key}`);
      }
    }
  });
});
