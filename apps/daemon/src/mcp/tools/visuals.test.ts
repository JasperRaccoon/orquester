/**
 * The `visuals` family (unified MCP design 2026-10-15 §4 rows 42–43; design 2026-10-14 §2.1),
 * ported from `session-tools/html/html.test.ts` and run through THE executor as a chat caller:
 * what it may send and what it gets back. Advertised metadata and byte budgets live in
 * `catalog/registry.test.ts`, measured through the serializers clients consume.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HTML_RENDER_MAX_HTML_CHARS,
  type HtmlRenderReference
} from "@orquester/api/agent-chat";

import type { ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

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
    { approvals: null },
    { name, arguments: args },
    { caller: opts.caller ?? chatCaller(), api, signal: opts.signal ?? new AbortController().signal }
  );

function errorOf(result: CallToolResult): { code: string; message: string } {
  assert.equal(result.isError, true);
  return result.structuredContent as { code: string; message: string };
}

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
        value: { screenshot: { data: "AAAA", mimeType: "image/png", width: 1, height: 1 }, width: request.width ?? 1, contentHeight: 1, capturedHeight: 1, consoleMessages: [] }
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
    const expected = result.structuredContent as { htmlRender: HtmlRenderReference; message: string };
    assert.deepEqual(expected.htmlRender, REFERENCE);
    assert.equal(typeof expected.message, "string");
    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), expected);
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

describe("show_image", () => {
  const PNG = (() => {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(320, 16);
    bytes.writeUInt32BE(200, 20);
    return bytes;
  })();

  async function sandbox(t: { after(fn: () => Promise<void>): void }) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "show-image-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "workspaces");
    const attachments = join(root, "threads", THREAD, "attachments");
    await mkdir(join(ws, "acme", "app"), { recursive: true });
    await mkdir(attachments, { recursive: true });
    const api = new FakeDaemonApi();
    api.fsRoot = ws;
    api.workspacesDir = ws;
    const stored = join(attachments, "thread-1-kept.png");
    await writeFile(stored, PNG);
    Object.assign(api, {
      chatImageRoots: () => ({ attachmentsDir: attachments, tempDirs: [] }),
      chatAttachmentPath: async (_threadId: string, id: string) => (id === "thread-1-kept-png" ? stored : null)
    });
    // A chat of the project acme/app, at the workspaces root.
    const inProject = chatCaller({ projectPath: join(ws, "acme", "app"), workspace: "acme", cwd: ws });
    return { ws, api, inProject };
  }

  it("copies each image into the CALLING chat and answers the image row's reference and Markdown, never the bytes", async (t) => {
    const s = await sandbox(t);
    await writeFile(join(s.ws, "acme", "app", "logo.png"), PNG);
    const result = await call(s.api, "show_image", {
      title: "Logo",
      images: [{ path: "acme/app/logo.png", caption: "the new logo" }, { ref: "attachment:thread-1-kept-png" }]
    }, { caller: s.inProject });
    assert.equal(result.isError, undefined);
    // The project file is stored as this chat's attachment; one already stored here is shown as it is, not copied.
    assert.deepEqual(s.api.uploads.map((upload) => [upload.sessionId, upload.meta, upload.bytes]), [[THREAD, { name: "logo.png", type: "image/png" }, PNG]]);
    const body = result.structuredContent as Record<string, unknown>;
    const uploaded = `${THREAD}-att-1`;
    assert.deepEqual(body.imageRef, {
      title: "Logo",
      images: [
        { attachmentId: uploaded, mimeType: "image/png", width: 320, height: 200, caption: "the new logo", path: join(s.ws, "acme", "app", "logo.png") },
        { attachmentId: "thread-1-kept-png", mimeType: "image/png", width: 320, height: 200 }
      ]
    });
    assert.deepEqual(body.images, [
      { attachmentId: uploaded, markdown: `![the new logo](attachment:${uploaded})` },
      { attachmentId: "thread-1-kept-png", markdown: "![image](attachment:thread-1-kept-png)" }
    ]);
    assert.equal(body.shown, 2);
    assert.ok(result.content.every((block) => block.type === "text"), "no image content goes back to the model");
    assert.ok(!JSON.stringify(result).includes(PNG.toString("base64")), "no bytes are echoed");
  });

  it("stores nothing when any image is refused", async (t) => {
    const s = await sandbox(t);
    await writeFile(join(s.ws, "acme", "app", "logo.png"), PNG);
    await writeFile(join(s.ws, "acme", "app", "readme.png"), "# not an image");
    const error = errorOf(await call(s.api, "show_image", { images: [{ path: "acme/app/logo.png" }, { path: "acme/app/readme.png" }] }, { caller: s.inProject }));
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /^images\[1\]: not a PNG, JPEG, WebP or GIF image/);
    assert.equal(s.api.uploads.length, 0);
  });

  it("an image in another project is that project's card, as read_file's path is, and a workflow's chat is refused", async (t) => {
    const s = await sandbox(t);
    await mkdir(join(s.ws, "acme", "other"), { recursive: true });
    await writeFile(join(s.ws, "acme", "other", "secret.png"), PNG);
    for (const caller of [s.inProject, { ...s.inProject, workflowOwned: true }]) {
      const error = errorOf(await call(s.api, "show_image", { images: [{ path: "acme/other/secret.png" }] }, { caller }));
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.match(error.message, caller.workflowOwned ? /automated workflow/ : /approval/);
    }
    assert.equal(s.api.uploads.length, 0);
  });

  it("is no external tool", async () => {
    const api = new FakeDaemonApi();
    assert.equal(errorOf(await call(api, "show_image", { images: [{ ref: "recent:1" }] }, { caller: { kind: "external" } })).code, "TOOL_NOT_FOUND");
  });
});
