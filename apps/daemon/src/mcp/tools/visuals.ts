/**
 * Catalog family `visuals` (unified MCP design 2026-10-15 §4 rows 42–43): `html_preview` and
 * `html_render`, chat-only, in the `core` group. Ported from the session toolkit
 * `session-tools/html/` (design 2026-10-14 §2.1; itself ported from T3 Code, MIT) with behaviour
 * unchanged and the descriptions trimmed to the §9.5 targets: the page rules are stated once (in
 * `html_render`) and the theme tokens compacted to one line of names.
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
  HTML_RENDER_TOOL_NAME
} from "@orquester/api/agent-chat";

import { defineTool, type AnyOrquesterTool, type ScopeClaim, type ThreadCaller, type ToolCaller } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { imageResult } from "../../session-tools/results.ts";

export const HTML_PREVIEW_TOOL_NAME = "html_preview";

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

/** Neither tool claims anything the gate judges beyond the caller itself: it shows or measures a page. */
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
    description: `Show a finished HTML page (chart, table, diagram, mockup) inline in this chat above your final text reply; call it before writing that reply, which should not announce or restate the page. The frame fits the page's height at each reader's width; a height below contentHeight caps it and the rest scrolls inside. ${PAGE_RULES} ${LAYOUT} ${THEME}`,
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
  })
];
