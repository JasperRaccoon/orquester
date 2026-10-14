/**
 * Session tools — visual replies (design 2026-10-14 §2.1): `html_preview`
 * and `html_render`.
 *
 * Ported from T3 Code (MIT): `apps/server/src/mcp/toolkits/html/{tools,handlers}.ts`
 * and the "Showing visuals" paragraph of
 * `packages/provider-core/src/server/orchestrationInstructions.ts`, with
 * Orquester's names, widths and theme tokens (`@orquester/api` `html-render.ts`).
 *
 * The agent host loads this module to advertise the tools, so it reaches the
 * daemon only through `ctx.api`: the preview browser, the page store and the
 * image inlining all run in the daemon (`../../html-preview/`,
 * `../../agent-chat/html-render-publish.ts`).
 */

import { z } from "zod";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_HTML_CHARS,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  HTML_PREVIEW_MAX_WIDTH,
  HTML_PREVIEW_MIN_WIDTH
} from "@orquester/api/agent-chat";

import { defineSessionTool, defineSessionToolkit } from "../contract.ts";
import { imageResult, jsonResult, ToolError } from "../results.ts";

export const HTML_PREVIEW_TOOL_NAME = "html_preview";

/** What `html_render` tells the agent once the page is shown (spec §2.1). */
export const HTML_RENDER_SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically when they are inside this thread\'s project (at most 10 MiB each, 25 MiB for the whole page); remote http(s) URLs, such as a CDN chart library, load as-is.';

/** The "Showing visuals" paragraph of the Orquester instruction block (§1.4). */
export const HTML_TOOLKIT_INSTRUCTIONS = `### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`${HTML_PREVIEW_TOOL_NAME}\`, then publish it with \`${HTML_RENDER_TOOL_NAME}\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`;

const html = z.string().min(1).max(HTML_RENDER_MAX_HTML_CHARS).describe("A complete, self-contained HTML document.");

export const htmlToolkit = defineSessionToolkit({
  id: "html",
  instructions: HTML_TOOLKIT_INSTRUCTIONS,
  tools: [
    defineSessionTool({
      name: HTML_PREVIEW_TOOL_NAME,
      title: "Preview HTML",
      description: `Render an HTML page in Orquester's headless browser and get back a screenshot of its top (at most 4000px; PNG, or JPEG scaled down when a PNG would pass 3 MiB — its size is in screenshot), contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before ${HTML_RENDER_TOOL_NAME}. The preview cannot reach this machine or its local network, only public addresses. If the machine has no browser to render with, the call says so; ${HTML_RENDER_TOOL_NAME} still works without a preview. ${PAGE_RULES} The page gets the theme variables and layout described in ${HTML_RENDER_TOOL_NAME}.`,
      input: {
        html,
        width: z
          .number()
          .int()
          .min(HTML_PREVIEW_MIN_WIDTH)
          .max(HTML_PREVIEW_MAX_WIDTH)
          .optional()
          .describe(
            `Viewport width in CSS pixels, ${HTML_PREVIEW_MIN_WIDTH}-${HTML_PREVIEW_MAX_WIDTH}. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`
          ),
        appearance: z.enum(["dark", "light"]).optional().describe("Theme to preview. Defaults to dark.")
      },
      // Read-only: it touches no workspace and shows nothing to the reader.
      // Open-world: the page may load remote resources.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      resultKind: "image",
      run: async (args, ctx) => {
        const outcome = await ctx.api.previewHtmlRender({
          threadId: ctx.threadId,
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
    defineSessionTool({
      name: HTML_RENDER_TOOL_NAME,
      title: "Render HTML",
      description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with ${HTML_PREVIEW_TOOL_NAME} first. Orquester fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
      input: {
        html,
        title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH).describe("Short name for the page."),
        height: z
          .number()
          .int()
          .min(HTML_RENDER_MIN_HEIGHT)
          .max(HTML_RENDER_MAX_HEIGHT)
          .describe(
            `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use ${HTML_PREVIEW_TOOL_NAME}'s contentHeight, or less to make long content scroll inside the frame.`
          )
      },
      // Read-only in the MCP sense: it shows a page in the caller's own thread
      // and touches no workspace. Open-world: the page may load remote resources.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      resultKind: "json",
      run: async (args, ctx) => {
        const outcome = await ctx.api.publishHtmlRender({
          threadId: ctx.threadId,
          html: args.html,
          title: args.title,
          height: args.height,
          signal: ctx.signal
        });
        if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
        return jsonResult({ htmlRender: outcome.value, message: HTML_RENDER_SHOWN_MESSAGE });
      }
    })
  ]
});
