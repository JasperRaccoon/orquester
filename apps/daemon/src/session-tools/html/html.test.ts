/**
 * The visual-replies toolkit (design 2026-10-14 §2.1): what the agent is
 * told, what it may send, and what it gets back.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_THEME_TOKENS,
  type HtmlRenderReference
} from "@orquester/api/agent-chat";

import { HTML_RENDER_MAX_HTML_CHARS } from "../../agent-chat/html-render-publish.ts";
import { FakeDaemonApi } from "../../mcp/testing.ts";
import type { SessionToolContext } from "../contract.ts";
import { executeSessionToolCall } from "../executor.ts";
import { sessionToolRegistry } from "../index.ts";
import { HTML_PAGE_MAX_CHARS, HTML_RENDER_SHOWN_MESSAGE, HTML_TOOLKIT_INSTRUCTIONS, htmlToolkit } from "./index.ts";

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

function context(api: FakeDaemonApi, signal = new AbortController().signal): SessionToolContext {
  return {
    threadId: THREAD,
    projectPath: "/w/ws/p",
    cwd: "/w/ws/p",
    agentId: "claude",
    callId: "call-1",
    signal,
    api,
    now: () => 0
  };
}

const call = (api: FakeDaemonApi, name: string, args: unknown, signal?: AbortSignal) =>
  executeSessionToolCall(sessionToolRegistry(), { name, arguments: args }, context(api, signal));

function errorOf(result: { isError?: boolean; structuredContent?: unknown }): { code: string; message: string } {
  assert.equal(result.isError, true);
  return result.structuredContent as { code: string; message: string };
}

describe("html toolkit definitions", () => {
  const preview = htmlToolkit.tools.find((tool) => tool.name === "html_preview")!;
  const render = htmlToolkit.tools.find((tool) => tool.name === "html_render")!;

  it("ports T3's guidance with Orquester's widths and theme tokens", () => {
    for (const fragment of [
      "headless browser",
      "PNG screenshot",
      "contentHeight",
      "stack traces pointing into page.html",
      "before html_render",
      "cannot reach this machine or its local network",
      "html_render still works without a preview",
      "inside this thread's project"
    ]) {
      assert.ok(preview.description.includes(fragment), fragment);
    }
    for (const fragment of [
      "above your final text reply",
      "should not announce it",
      "Preview with html_preview first",
      "fits the frame to the page's height at each reader's width",
      HTML_RENDER_LAYOUT_GUIDE,
      HTML_RENDER_THEME_GUIDE,
      `${HTML_RENDER_COLUMN_WIDTH}px`
    ]) {
      assert.ok(render.description.includes(fragment), fragment.slice(0, 60));
    }
    // Every token a page receives is named for the agent.
    for (const token of HTML_RENDER_THEME_TOKENS.filter((name) => !name.startsWith("--chart-"))) {
      assert.ok(render.description.includes(token), token);
    }
    assert.ok(render.description.includes("--chart-1 … --chart-6"));
    assert.doesNotMatch(`${preview.description} ${render.description}`, /\bT3\b/);
  });

  it("is read-only and open-world; only the preview is idempotent", () => {
    assert.deepEqual(preview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.deepEqual(render.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.equal(preview.resultKind, "image");
    assert.equal(render.resultKind, "json");
  });

  it("contributes the Showing visuals paragraph", () => {
    assert.equal(htmlToolkit.instructions, HTML_TOOLKIT_INSTRUCTIONS);
    assert.match(HTML_TOOLKIT_INSTRUCTIONS, /check it with `html_preview`, then publish it with `html_render` before your final reply/);
    assert.ok(sessionToolRegistry().instructions.endsWith(HTML_TOOLKIT_INSTRUCTIONS));
  });

  it("bounds the page as the publisher does", () => {
    assert.equal(HTML_PAGE_MAX_CHARS, HTML_RENDER_MAX_HTML_CHARS);
  });
});

describe("html toolkit argument bounds", () => {
  const page = "<p>hi</p>";
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["html_preview", { html: "" }, /html/],
    ["html_preview", { html: "x".repeat(HTML_PAGE_MAX_CHARS + 1) }, /html/],
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
        value: { png: "AAAA", width: request.width ?? HTML_RENDER_COLUMN_WIDTH, contentHeight: 1, capturedHeight: 1, consoleMessages: [] }
      }));
    for (const [name, args] of [
      ["html_preview", { html: "x".repeat(HTML_PAGE_MAX_CHARS), width: 240, appearance: "light" }],
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
  it("publishes into the CALLING thread and answers the reference and the message, as text and structured", async () => {
    const api = new FakeDaemonApi().onPublishHtml(() => ({ ok: true, value: REFERENCE }));
    const controller = new AbortController();
    const result = await call(api, "html_render", { html: "<p>chart</p>", title: "Chart", height: 420 }, controller.signal);
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
});

describe("html_preview", () => {
  it("answers the screenshot as MCP image content first, then the measurements as JSON", async () => {
    const api = new FakeDaemonApi().onPreviewHtml(() => ({
      ok: true,
      value: {
        png: "iVBORw0KGgo=",
        width: 390,
        contentHeight: 900,
        capturedHeight: 900,
        consoleMessages: [{ level: "log", text: "ok" }],
        missingImages: ["/p/gone.png"]
      }
    }));
    const result = await call(api, "html_preview", { html: "<p>x</p>", width: 390, appearance: "light" });
    assert.equal(result.isError, undefined);
    const request = api.previews[0]!;
    assert.equal(request.threadId, THREAD);
    assert.equal(request.width, 390);
    assert.equal(request.appearance, "light");
    assert.deepEqual(result.content[0], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    const expected = {
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
  });
});
