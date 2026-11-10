/**
 * Catalog family `visuals` (unified MCP design 2026-10-15 §4 rows 42–43): `html_preview` and
 * `html_render`, chat-only, in the `core` group. Ported from the session toolkit
 * `session-tools/html/` (design 2026-10-14 §2.1; itself ported from T3 Code, MIT) with behaviour
 * unchanged and the descriptions trimmed to the §9.5 targets: the page rules are stated once (in
 * `html_render`) and the theme tokens compacted to one line of names. And `show_image` (images in chats, design
 * 2026-11-10 §9.3): image files the agent points at, copied into the chat and shown as an inline image row
 * (`imageRef`), resolved by `../chat-images.ts`.
 *
 * The agent host loads this module statically (the catalog), so it reaches the daemon only through
 * `ctx.api`: the preview browser, the page store and the image inlining all run in the daemon
 * (`../../html-preview/`, `../../agent-chat/html-render-publish.ts`).
 */

import { z } from "zod";
import {
  HTML_PREVIEW_MAX_WIDTH,
  HTML_PREVIEW_MIN_WIDTH,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_HTML_CHARS,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_TOKENS,
  HTML_RENDER_TOOL_NAME,
  chatImageMarkdown,
  IMAGE_CAPTION_MAX_LENGTH,
  IMAGE_TITLE_MAX_LENGTH,
  IMAGE_TOOL_MAX_IMAGES,
  MAX_TURN_IMAGE_BYTES,
  boundImageToolReference,
  readImageToolReference,
  SHOW_IMAGE_TOOL_NAME,
  type ChatImageReference
} from "@orquester/api/agent-chat";

import { defineTool, type AnyOrquesterTool, type ScopeClaim, type ThreadCaller, type ToolCaller } from "../catalog/contract.ts";
import { chatImageScopePaths, resolveChatImages, storeChatImage } from "../chat-images.ts";
import { ToolError } from "../errors.ts";
import { imageResult } from "../../session-tools/results.ts";

export const HTML_PREVIEW_TOOL_NAME = "html_preview";

/** What `show_image` tells the agent once the images are shown (design 2026-11-10 §9.3). */
const IMAGE_SHOWN_MESSAGE = "Shown to the user above your reply: don't describe what they can now see.";

/** What `html_render` tells the agent once the page is shown (design 2026-10-14 §2.1). */
const HTML_RENDER_SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

/** The theme tokens as one line of names, the six chart hues as a range. */
const HTML_RENDER_TOKEN_LINE = (() => {
  const names: string[] = [];
  for (const token of HTML_RENDER_THEME_TOKENS) {
    if (!token.startsWith("--chart-")) names.push(token);
    else if (token === "--chart-1") names.push("--chart-1 … --chart-6 (chart series)");
  }
  return names.join(" ");
})();

const PAGE_RULES =
  'One self-contained document, inline <style> and <script>. Local images by absolute path (src="/abs/a.png", CSS url() or a JS string) inside this chat\'s project are inlined (≤ 10 MiB each, 25 MiB a page); remote http(s) URLs (e.g. a CDN chart library) load as-is.';

const LAYOUT =
  `Layout: a borderless frame on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px desktop, wider if widened, ~360px phones). Keep html, body and the outermost element transparent (even over style preferences like a black page), fluid-width, no horizontal padding, outer card, border or banner title. A box with its own background: ≥ 16px padding, var(--radius) corners. Charts: fixed px heights. Content sets the height: no 100vh or height:100% on html/body.`;

const THEME = `Theme: :root CSS variables (hex), following the user's theme and light/dark live: ${HTML_RENDER_TOKEN_LINE}. The base stylesheet sets html background, color and font from them, body margin 0, no scrollbar; your CSS wins.`;

const html = z.string().min(1).max(HTML_RENDER_MAX_HTML_CHARS).describe("A complete, self-contained HTML document.");

/** The caller itself, nothing else the gate judges: a page shown or measured (`show_image` adds the files it reads). */
const ownThread = (caller: ToolCaller, writes: boolean): ScopeClaim => ({
  projects: [],
  sessions: caller.kind === "thread" ? [caller.threadId] : [],
  self: "allow",
  reads: "none",
  writes,
  causesTurnIn: []
});

/** These are chat tools: the executor never serves them to an external caller (defence in depth). */
function chatCaller(caller: ToolCaller, tool: string): ThreadCaller {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${tool} is a chat tool.`);
  return caller;
}

export const visualsFamily: readonly AnyOrquesterTool[] = [
  defineTool({
    name: HTML_PREVIEW_TOOL_NAME,
    title: "Preview HTML",
    description: `Render an HTML page in a headless browser: a screenshot of its top (≤ 4000px; PNG, or scaled-down JPEG past 3 MiB), contentHeight (the height it needs at this width) and console output (logs, errors, uncaught exceptions; stack traces point into page.html; console.log can report your own checks). Iterate with it before ${HTML_RENDER_TOOL_NAME}. It reaches only public addresses, not this machine or its network. Without a browser on the machine it says so; ${HTML_RENDER_TOOL_NAME} still works. Page rules, layout and theme: ${HTML_RENDER_TOOL_NAME}'s.`,
    input: {
      html,
      width: z
        .number()
        .int()
        .min(HTML_PREVIEW_MIN_WIDTH)
        .max(HTML_PREVIEW_MAX_WIDTH)
        .optional()
        .describe(`CSS px. Default ${HTML_RENDER_COLUMN_WIDTH}, the reply column; ~390 checks phones.`),
      appearance: z.enum(["dark", "light"]).optional().describe("Default dark.")
    },
    audiences: ["chat"],
    toolset: "core",
    tier: "read",
    planSafe: true,
    scope: async (_args, ctx) => ownThread(ctx.caller, false),
    // Read-only: it touches no workspace and shows nothing to the reader. Open-world: the page may load remote resources.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    resultKind: "image",
    run: async (args, ctx) => {
      const caller = chatCaller(ctx.caller, HTML_PREVIEW_TOOL_NAME);
      const outcome = await ctx.api.previewHtmlRender({
        threadId: caller.threadId,
        html: args.html,
        ...(args.width !== undefined ? { width: args.width } : {}),
        ...(args.appearance !== undefined ? { appearance: args.appearance } : {}),
        signal: ctx.signal
      });
      if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
      const { screenshot, ...preview } = outcome.value;
      const { data, ...shot } = screenshot;
      return imageResult({ data, mimeType: screenshot.mimeType }, { ...preview, screenshot: shot });
    }
  }),
  defineTool({
    name: HTML_RENDER_TOOL_NAME,
    title: "Render HTML",
    description: `Show a finished HTML page (chart, table, diagram, mockup), checked first with html_preview, inline in this chat above your final text reply; call it before writing that reply, which should not announce or restate the page. The frame fits the page's height at each reader's width; a height below contentHeight caps it and the rest scrolls inside. ${PAGE_RULES} ${LAYOUT} ${THEME}`,
    input: {
      html,
      title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH).describe("Short name for the page."),
      height: z
        .number()
        .int()
        .min(HTML_RENDER_MIN_HEIGHT)
        .max(HTML_RENDER_MAX_HEIGHT)
        .describe(`CSS px: ${HTML_PREVIEW_TOOL_NAME}'s contentHeight, or less to scroll inside.`)
    },
    audiences: ["chat"],
    toolset: "core",
    tier: "act",
    // Showing a visual is how a plan is explained, too (§4 row 43).
    planSafe: true,
    scope: async (_args, ctx) => ownThread(ctx.caller, true),
    // Read-only in the MCP sense: it shows a page in the caller's own chat and touches no workspace.
    // Open-world: the page may load remote resources.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    resultKind: "json",
    run: async (args, ctx) => {
      const caller = chatCaller(ctx.caller, HTML_RENDER_TOOL_NAME);
      const outcome = await ctx.api.publishHtmlRender({
        threadId: caller.threadId,
        html: args.html,
        title: args.title,
        height: args.height,
        signal: ctx.signal
      });
      if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
      return { htmlRender: outcome.value, message: HTML_RENDER_SHOWN_MESSAGE };
    }
  }),
  defineTool({
    name: SHOW_IMAGE_TOOL_NAME,
    title: "Show image",
    description: `Show images to the user inline in this chat, large and always visible: a screenshot you took, a project image, an image the user pasted or one generated here. PNG, JPEG, WebP or GIF (by content), ≤ ${MAX_TURN_IMAGE_BYTES / (1024 * 1024)} MiB each. Each entry is {path} or {ref}. path: a file in the workspaces (relative: from this chat's directory), in this chat's attachments or in a temp folder (browser or simulator screenshots land there); in a box chat, a path in the box. ref: "recent:1" is the latest image pasted, shown or generated in this chat ("recent:2" the one before), "attachment:<id>" one stored here. Returns each image's attachmentId and markdown: write ![alt](attachment:<id>) in a reply to show it again (![](path) shows a project file). The images are not sent back to you. ${IMAGE_SHOWN_MESSAGE}`,
    input: {
      images: z
        .array(
          z
            .object({
              path: z.string().min(1).max(4096).optional(),
              ref: z.string().min(1).max(300).optional(),
              caption: z.string().min(1).max(IMAGE_CAPTION_MAX_LENGTH).optional()
            })
            .strict()
        )
        .min(1)
        .max(IMAGE_TOOL_MAX_IMAGES)
        .describe("Each: path or ref, and an optional one-line caption."),
      title: z.string().min(1).max(IMAGE_TITLE_MAX_LENGTH).optional().describe("One line above the images.")
    },
    audiences: ["chat"],
    toolset: "core",
    tier: "act",
    // Showing a picture explains a plan as well as a page does.
    planSafe: true,
    // The caller's own chat, and every workspace file it reads, which the gate classifies as read_file's path: another
    // project's image is that project's card (the Act row: the call also changes this chat), a workflow's chat is refused.
    scope: async (args, ctx) => {
      const paths = await chatImageScopePaths(ctx.api, ctx.caller, args.images);
      return paths.length > 0 ? { ...ownThread(ctx.caller, true), reads: "content", paths } : ownThread(ctx.caller, true);
    },
    // Read-only in the MCP sense: it copies images into the caller's own chat and touches no workspace.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    resultKind: "json",
    run: async (args, ctx) => {
      const caller = chatCaller(ctx.caller, SHOW_IMAGE_TOOL_NAME);
      // Every image is read and checked before any is stored: a refusal stores nothing.
      const resolved = await resolveChatImages(ctx.api, caller, args.images, "images");
      const images: ChatImageReference[] = [];
      const shown: Array<{ attachmentId: string; markdown: string }> = [];
      for (const [index, image] of resolved.entries()) {
        let attachmentId = image.attachmentId;
        if (attachmentId === undefined) {
          try {
            ({ attachmentId } = await storeChatImage(ctx.api, caller, image));
          } catch (error) {
            if (error instanceof ToolError) throw new ToolError(error.code, `images[${index}]: ${error.message}`, error.detail);
            throw error;
          }
        }
        const caption = args.images[index]!.caption;
        images.push({
          attachmentId,
          mimeType: image.mimeType,
          ...(image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : {}),
          ...(caption !== undefined ? { caption } : {}),
          ...(image.path !== undefined ? { path: image.path } : {})
        });
        shown.push({ attachmentId, markdown: chatImageMarkdown(attachmentId, caption ?? image.name.replace(/\.[^.]*$/, "")) });
      }
      // Through the one reader the timeline uses, so what is stored is what renders, and within the size a row keeps.
      const read = readImageToolReference({ ...(args.title !== undefined ? { title: args.title } : {}), images });
      const imageRef = read && boundImageToolReference(read);
      return { imageRef, images: shown, shown: shown.length, message: IMAGE_SHOWN_MESSAGE };
    }
  })
];
