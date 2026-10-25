/**
 * Agent visuals' shared module (spec 2026-10-14 §2): the reference, sizing,
 * the per-provider tool-row reader, the bridge parsers, theme tokens and the
 * bootstrap. Sizing and bootstrap cases derived from T3 Code (MIT):
 * `packages/shared/src/htmlRender.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderReferenceOfActivityPayload,
  htmlRenderReferencesEqual,
  htmlRenderShortcutsMessage,
  htmlRenderStockTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeFromPalette,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
  matchesHtmlRenderShortcut,
  readHtmlRenderContentHeight,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
  sanitizeHtmlRenderThemeVariables,
  type HtmlRenderReference
} from "./html-render.ts";
import { boundSessionToolData, sessionToolMarkedData } from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";

const ID = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const REF = { attachmentId: ID, title: "Chart", height: 420 };
const RESULT_JSON = JSON.stringify({ htmlRender: REF, message: "Shown to the reader above your reply." });

test("a reference is validated, trimmed and clamped", () => {
  assert.deepEqual(readHtmlRenderReference({ ...REF, title: "  Chart  ", height: 5 }), {
    attachmentId: ID,
    title: "Chart",
    height: HTML_RENDER_MIN_HEIGHT
  });
  assert.equal(readHtmlRenderReference({ ...REF, height: 99_999 })?.height, HTML_RENDER_MAX_HEIGHT);
  assert.equal(readHtmlRenderReference({ ...REF, title: "   " })?.title, "HTML");
  // Only a published page's id: an image attachment, a traversal, junk.
  assert.equal(readHtmlRenderReference({ ...REF, attachmentId: ID.replace(/-html$/, "-png") }), undefined);
  assert.equal(readHtmlRenderReference({ ...REF, attachmentId: "../../etc/passwd" }), undefined);
  assert.equal(readHtmlRenderReference({ ...REF, height: Number.NaN }), undefined);
  assert.equal(readHtmlRenderReference(null), undefined);
});

test("measured heights are sorted, clamped, and all-or-nothing", () => {
  assert.deepEqual(readHtmlRenderReference({ ...REF, heights: [[728, 300], [320, 9000]] })?.heights, [
    [320, HTML_RENDER_MAX_HEIGHT],
    [728, 300]
  ]);
  assert.equal(readHtmlRenderReference({ ...REF, heights: [[728, 300], ["x", 1]] })?.heights, undefined);
  assert.equal(readHtmlRenderReference({ ...REF, heights: [] })?.heights, undefined);
});

test("references compare by page and sizes", () => {
  const a = readHtmlRenderReference({ ...REF, heights: [[320, 500]] })!;
  assert.ok(htmlRenderReferencesEqual(a, { ...a, heights: [[320, 500]] }));
  assert.ok(!htmlRenderReferencesEqual(a, { ...a, heights: [[320, 501]] }));
  assert.ok(!htmlRenderReferencesEqual(a, { ...a, title: "Other" }));
});

test("frame height: unmeasured pages take the smaller of the agent's height and the page's", () => {
  const ref: HtmlRenderReference = { attachmentId: ID, title: "t", height: 400 };
  assert.equal(htmlRenderFrameHeight(ref, 728), 400);
  assert.equal(htmlRenderFrameHeight(ref, 728, 250), 250);
  assert.equal(htmlRenderFrameHeight(ref, 728, 900), 400);
  assert.equal(htmlRenderFrameHeight(ref, 728, 10), HTML_RENDER_MIN_HEIGHT);
});

test("frame height: a measured page fits itself unless the agent asked for a scrolling frame", () => {
  const heights = [
    [320, 900],
    [728, 500],
    [1144, 400]
  ] as const;
  // The agent's 600 is above the page's 500 at the column: no cap, exact fit.
  const fits: HtmlRenderReference = { attachmentId: ID, title: "t", height: 600, heights };
  assert.equal(htmlRenderFrameHeight(fits, 320), 900);
  assert.equal(htmlRenderFrameHeight(fits, 728), 500);
  // Between two measured widths the taller one wins.
  assert.equal(htmlRenderFrameHeight(fits, 500), 900);
  // The page's own report wins over the measurement.
  assert.equal(htmlRenderFrameHeight(fits, 728, 512), 512);
  // The agent's 300 is below the page's 500 at the column: it caps.
  const scrolls: HtmlRenderReference = { ...fits, height: 300 };
  assert.equal(htmlRenderFrameHeight(scrolls, 320), 300);
  assert.equal(htmlRenderFrameHeight(scrolls, 728, 512), 300);
});

test("download names drop characters file systems reject", () => {
  assert.equal(htmlRenderFileName('a/b:c*"d"'), "a b c d.html");
  assert.equal(htmlRenderFileName("   "), "Page.html");
});

/** The session tools the host registered, as its ingestion is handed them. */
const REGISTERED = new Set(["html_render", "html_preview"]);

/** A row as the host's ingestion persists it: the provenance marker stamped on a registered tool's call. */
function ingested(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, data: boundSessionToolData(sessionToolMarkedData(row.data, REGISTERED)) };
}

/** A completed html_render row as each adapter emits it (before ingestion). */
const PROVIDER_ROWS: Record<string, Record<string, unknown>> = {
  claude: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "mcp__orquester__html_render",
    data: {
      toolName: "mcp__orquester__html_render",
      input: { html: `<p>${"x".repeat(200_000)}</p>`, title: "Chart", height: 420 },
      result: { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: RESULT_JSON }] }
    }
  },
  "claude (string content)": {
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      toolName: "mcp__orquester__html_render",
      result: { type: "tool_result", tool_use_id: "toolu_1", content: RESULT_JSON }
    }
  },
  codex: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "orquester: html_render",
    data: {
      server: "orquester",
      tool: "html_render",
      arguments: { title: "Chart" },
      result: { content: [{ type: "text", text: RESULT_JSON }], structuredContent: { htmlRender: REF }, _meta: null }
    }
  },
  "codex (structured content only)": {
    itemType: "mcp_tool_call",
    status: "completed",
    data: { server: "orquester", tool: "html_render", result: { content: [], structuredContent: { htmlRender: REF } } }
  },
  // OpenCode: one `orquester-<16 hex>` server per thread (adapters/opencode/session-tools.ts).
  opencode: {
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      tool: "orquester-0123456789abcdef_html_render",
      toolUseId: "call_1",
      state: { status: "completed", input: {}, output: RESULT_JSON, title: "", metadata: {} },
      result: RESULT_JSON
    }
  },
  // Grok calls an MCP tool through its `use_tool` meta-tool; the end carries
  // no ACP content, only `OkayOutput`: the result's text blocks and its
  // structuredContent as JSON, one per line (fixture
  // `apps/daemon/test/fixtures/grok/32-mcp-use-tool-call.ndjson`). A session
  // tool's `jsonResult` is a JSON text block + the same structuredContent.
  grok: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "orquester__html_render",
    data: {
      toolUseId: "call_1",
      kind: "other",
      vendorTool: "use_tool",
      rawInput: { variant: "UseTool", tool_name: "orquester__html_render", tool_input: { title: "Chart" } },
      rawOutput: {
        type: "MCP",
        tool_name: "html_render",
        server_name: "orquester",
        output: { OkayOutput: `${RESULT_JSON}\n${RESULT_JSON}` }
      }
    }
  },
  "grok (a text block before the structured line)": {
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      vendorTool: "use_tool",
      rawInput: { variant: "UseTool", tool_name: "orquester__html_render" },
      rawOutput: { type: "MCP", output: { OkayOutput: `Published.\n${JSON.stringify({ htmlRender: REF })}` } }
    }
  }
};

test("the reference is found in every provider's bounded html_render row, slimmed once or twice", () => {
  for (const [provider, row] of Object.entries(PROVIDER_ROWS)) {
    const payload = ingested(row);
    assert.deepEqual(htmlRenderReferenceOfActivityPayload(payload), REF, provider);
    const once = slimActivityPayload(payload);
    assert.deepEqual(htmlRenderReferenceOfActivityPayload(once), REF, `${provider} slimmed`);
    assert.deepEqual(htmlRenderReferenceOfActivityPayload(slimActivityPayload(once)), REF, `${provider} slimmed twice`);
  }
});

test("only the ingestion's marker makes a row a page: the spelling alone does not", () => {
  for (const [provider, row] of Object.entries(PROVIDER_ROWS)) {
    assert.equal(htmlRenderReferenceOfActivityPayload(row), undefined, provider);
  }
  // A host that registered no html_render (or none at all) marks nothing.
  assert.equal(
    htmlRenderReferenceOfActivityPayload({ ...PROVIDER_ROWS.claude, data: sessionToolMarkedData(PROVIDER_ROWS.claude!.data, new Set(["echo"])) }),
    undefined
  );
});

test("another server's tool, another session tool, or a result without a reference, is no visual", () => {
  assert.equal(
    htmlRenderReferenceOfActivityPayload(
      ingested({ itemType: "mcp_tool_call", data: { toolName: "mcp__other__html_render", result: { content: RESULT_JSON } } })
    ),
    undefined
  );
  assert.equal(
    htmlRenderReferenceOfActivityPayload(
      ingested({ itemType: "mcp_tool_call", data: { toolName: "mcp__orquester__html_preview", result: { content: RESULT_JSON } } })
    ),
    undefined
  );
  // OpenCode's legacy single-server spelling is no session tool's.
  assert.equal(
    htmlRenderReferenceOfActivityPayload(
      ingested({ itemType: "mcp_tool_call", data: { tool: "orquester_html_render", result: RESULT_JSON } })
    ),
    undefined
  );
  assert.equal(
    htmlRenderReferenceOfActivityPayload(
      ingested({
        itemType: "mcp_tool_call",
        status: "failed",
        data: { toolName: "mcp__orquester__html_render", result: { content: "Error: image too large", is_error: true } }
      })
    ),
    undefined
  );
});

test("bridge parsers accept only well-formed JSON-RPC", () => {
  assert.equal(
    readHtmlRenderContentHeight({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 321 } }),
    321
  );
  assert.equal(readHtmlRenderContentHeight({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: -1 } }), undefined);
  assert.equal(readHtmlRenderContentHeight({ method: "ui/notifications/size-changed", params: { height: 3 } }), undefined);

  assert.deepEqual(
    readHtmlRenderLinkRequest({ jsonrpc: "2.0", id: "l1", method: "ui/open-link", params: { url: "https://x.dev/a", ctrlKey: true } }),
    { id: "l1", url: "https://x.dev/a", metaKey: false, ctrlKey: true }
  );
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "//x.dev"]) {
    assert.equal(readHtmlRenderLinkRequest({ jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url } }), undefined, url);
  }
  assert.equal(readHtmlRenderLinkRequest({ jsonrpc: "2.0", method: "ui/open-link", params: { url: "https://x.dev" } }), undefined);

  assert.deepEqual(
    readHtmlRenderKeyDown({ jsonrpc: "2.0", method: "orq/notifications/keydown", params: { key: "k", code: "KeyK", ctrlKey: true } }),
    { key: "k", code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false }
  );
  assert.equal(readHtmlRenderKeyDown({ jsonrpc: "2.0", method: "orq/notifications/keydown", params: { key: 1 } }), undefined);
});

test("a reported key matches only an allowed chord exactly", () => {
  const palette = { key: "k", code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
  const press = { key: "k", code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
  assert.ok(matchesHtmlRenderShortcut(press, palette));
  assert.ok(matchesHtmlRenderShortcut({ ...press, key: "л" }, palette), "the physical key survives a layout");
  assert.ok(!matchesHtmlRenderShortcut({ ...press, shiftKey: true }, palette));
  assert.ok(!matchesHtmlRenderShortcut({ ...press, ctrlKey: false }, palette));
  assert.deepEqual(htmlRenderShortcutsMessage([palette]).params.shortcuts, [palette]);
});

test("theme variables from a host message are sanitised as the bootstrap does", () => {
  assert.deepEqual(
    sanitizeHtmlRenderThemeVariables({ "--ok": "#fff;}body{x:y", "--Bad": "1", "not-var": "2", "--n": "<x>" }),
    { "--ok": "#fffbodyx:y", "--n": "x" }
  );
});

test("the stock theme gives every token, colours as hex", () => {
  for (const appearance of ["dark", "light"] as const) {
    const theme = htmlRenderStockTheme(appearance);
    // Public theme-token names from agent visuals §2.3, independent of the exporter's list.
    const requiredTokens = (
      "--background --foreground --muted --muted-foreground --card --card-foreground --popover " +
      "--popover-foreground --secondary --secondary-foreground --border --input --ring --primary " +
      "--primary-foreground --accent --accent-foreground --accent-surface --accent-surface-foreground " +
      "--destructive --destructive-foreground --destructive-surface --warning --warning-foreground " +
      "--warning-surface --success --success-foreground --info --info-foreground --code-background " +
      "--code-foreground --chart-1 --chart-2 --chart-3 --chart-4 --chart-5 --chart-6 --radius --font-sans --font-mono"
    ).split(" ");
    for (const token of requiredTokens) {
      const value = theme.variables[token];
      assert.ok(typeof value === "string" && value.length > 0, `${appearance} ${token}`);
      if (token === "--radius" || token.startsWith("--font-")) continue;
      assert.match(value, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/, `${appearance} ${token}`);
    }
  }
});

test("palette RGB colors map to page tokens; an invalid triple falls back to stock", () => {
  const palette: Record<string, string> = { "--n-950": "17 34 51", "--n-100": "170 187 204" };
  const mapped = htmlRenderThemeFromPalette((variable) => palette[variable], "dark");
  assert.equal(mapped.variables["--background"], "#112233");
  assert.equal(mapped.variables["--foreground"], "#aabbcc");
  const fallback = htmlRenderThemeFromPalette((variable) => (variable === "--n-950" ? "garbage" : undefined), "dark");
  assert.equal(fallback.variables["--background"], htmlRenderStockTheme("dark").variables["--background"]);
});

test("the theme fragment and message round-trip the theme", () => {
  const theme = htmlRenderStockTheme("light");
  const fragment = htmlRenderThemeFragment(theme);
  assert.ok(fragment.startsWith("#orq-theme="));
  assert.deepEqual(JSON.parse(decodeURIComponent(fragment.slice("#orq-theme=".length))), theme);
  const message = htmlRenderThemeMessage(theme);
  assert.equal(message.method, "ui/notifications/host-context-changed");
  assert.equal(message.params.theme, "light");
  assert.deepEqual(message.params.styles.variables, theme.variables);
});

test("the bootstrap lands at the start of the head, before the page's own markup", () => {
  const page = '<!doctype html><html><head><meta charset="utf-8"><style>p{}</style></head><body><p>x</p></body></html>';
  const out = injectHtmlRenderBootstrap(page);
  const at = out.indexOf("<style");
  assert.ok(at > out.indexOf("<head>") && at < out.indexOf("<style>p{}"));
  assert.equal(out.match(/<meta\b[^>]*\bcharset\s*=/gi)?.length, 1);
  assert.ok(out.endsWith("<body><p>x</p></body></html>"));
});

test("the bootstrap is never injected into a comment, script or template", () => {
  const page = "<!-- <head> --><script>var s='<head>'</script><template><head></template><p>x</p>";
  const out = injectHtmlRenderBootstrap(page);
  assert.match(out, /^<!doctype html>\s*<head\b/i);
  assert.ok(out.endsWith(page));
});

test("a page with only <html> or a doctype gets a head of its own", () => {
  assert.match(injectHtmlRenderBootstrap("<html lang=en><p>x</p></html>"), /^<html lang=en><head\b/i);
  assert.match(injectHtmlRenderBootstrap("<!DOCTYPE html><p>x</p>"), /^<!doctype html><head\b/i);
});
