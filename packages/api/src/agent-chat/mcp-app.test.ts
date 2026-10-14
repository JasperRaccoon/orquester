/**
 * MCP Apps' shared module (spec 2026-10-14 §3): CSP building, the snapshot's
 * document, the reference, the per-provider tool-row readers and the
 * ownership check. CSP and reference cases derived from T3 Code (MIT):
 * `packages/shared/src/mcpApp.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_APP_MAX_HTML_BYTES,
  clampMcpAppHeight,
  injectMcpAppCsp,
  isMcpAppUnloadNotice,
  mcpAppAllowAttribute,
  mcpAppContentSecurityPolicy,
  mcpAppCspReachesOrigin,
  mcpAppReferenceOfActivityPayload,
  mcpAppReferencesEqual,
  mcpAppToolCallOfActivityPayload,
  mcpAppToolCallableByApp,
  mcpCallOfActivityPayload,
  normalizeMcpAppToolResult,
  readMcpAppCsp,
  readMcpAppDocument,
  readMcpAppReference,
  readMcpAppResourceUri,
  type McpAppReference
} from "./mcp-app.ts";
import { slimActivityPayload } from "./slim.ts";

const ATTACHMENT = "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const reference: McpAppReference = {
  attachmentId: ATTACHMENT,
  server: "charts",
  tool: "show_chart",
  resourceUri: "ui://charts/view.html"
};

test("the CSP blocks every undeclared origin and never names 'self'", () => {
  const policy = mcpAppContentSecurityPolicy(undefined);
  assert.match(policy, /^default-src 'none'; /);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.equal(policy.includes("'self'"), false);
  assert.match(policy, /script-src 'unsafe-inline'(;|$)/);
});

test("declared domains widen only their own directive", () => {
  const policy = mcpAppContentSecurityPolicy({
    connectDomains: ["https://api.example.com", "wss://live.example.com"],
    resourceDomains: ["https://cdn.example.com"],
    frameDomains: ["https://*.embed.example.com"],
    baseUriDomains: ["https://base.example.com"]
  });
  assert.match(policy, /connect-src https:\/\/api\.example\.com wss:\/\/live\.example\.com/);
  assert.match(policy, /script-src 'unsafe-inline' https:\/\/cdn\.example\.com/);
  assert.match(policy, /img-src data: blob: https:\/\/cdn\.example\.com/);
  assert.match(policy, /frame-src https:\/\/\*\.embed\.example\.com/);
  assert.match(policy, /base-uri https:\/\/base\.example\.com/);
});

test("only scheme-qualified origins survive a declared CSP", () => {
  const csp = readMcpAppCsp({
    connectDomains: [
      "https://ok.example.com",
      "'self'",
      "*",
      "https://evil.example.com; script-src *",
      "javascript:alert(1)",
      "https://ok.example.com/path",
      "http://localhost:8080",
      42
    ],
    resourceDomains: "https://not-a-list.example.com",
    frameDomains: []
  });
  assert.deepEqual(csp, { connectDomains: ["https://ok.example.com"] });
  assert.equal(readMcpAppCsp({ connectDomains: ["'unsafe-eval'"] }), undefined);
  assert.equal(readMcpAppCsp("https://x.example.com"), undefined);
});

test("the CSP meta goes right after a doctype, escaped", () => {
  const withDoctype = injectMcpAppCsp("<!DOCTYPE html><html><head></head></html>", undefined);
  assert.match(withDoctype, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  const without = injectMcpAppCsp("<p>hi</p>", { connectDomains: ["https://a.example.com"] });
  assert.match(without, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.equal(without.endsWith("<p>hi</p>"), true);
});

test("a resource's document is prepared with its policy first, then the bootstraps", () => {
  const document = readMcpAppDocument(
    [
      { uri: "ui://other", mimeType: "text/html;profile=mcp-app", text: "<p>wrong uri</p>" },
      { uri: "ui://charts/view.html", mimeType: "text/plain", text: "not an app" },
      {
        uri: "ui://charts/view.html",
        mimeType: "text/html; profile=mcp-app",
        text: "<!doctype html><script>app()</script>",
        _meta: {
          ui: {
            csp: { connectDomains: ["https://api.example.com", "'self'"] },
            permissions: { clipboardWrite: {}, camera: true },
            prefersBorder: true
          }
        }
      }
    ],
    "ui://charts/view.html"
  );
  assert.equal(document.kind, "document");
  if (document.kind !== "document") return;
  assert.deepEqual(document.csp, { connectDomains: ["https://api.example.com"] });
  assert.deepEqual(document.permissions, { clipboardWrite: {} });
  assert.equal(document.prefersBorder, true);
  const metaAt = document.html.indexOf('<meta http-equiv="Content-Security-Policy"');
  const firstScript = document.html.indexOf("<script>");
  assert.equal(document.html.startsWith("<!doctype html><meta"), true);
  assert.ok(metaAt < firstScript, "the policy precedes every script");
  assert.ok(document.html.indexOf("document.cookie") < document.html.indexOf("app()"));
  assert.ok(document.html.indexOf("colorScheme") < document.html.indexOf("app()"));
  // The document reports its own unload, from a listener installed before the app's.
  assert.ok(document.html.indexOf('"pagehide"') < document.html.indexOf("app()"));
  assert.match(document.html, /orq\/notifications\/document-unloaded/);
  assert.equal(isMcpAppUnloadNotice({ jsonrpc: "2.0", method: "orq/notifications/document-unloaded" }), true);
  assert.equal(isMcpAppUnloadNotice({ jsonrpc: "2.0", method: "ui/notifications/size-changed" }), false);
});

test("a base64 blob is decoded and oversized documents are refused before decoding", () => {
  const html = "<!doctype html><h1>blob app</h1>";
  const blob = Buffer.from(html, "utf8").toString("base64");
  const document = readMcpAppDocument([{ mimeType: "text/html;profile=mcp-app", blob }], "ui://x");
  assert.equal(document.kind, "document");
  if (document.kind === "document") assert.match(document.html, /<h1>blob app<\/h1>/);

  const huge = "x".repeat(MCP_APP_MAX_HTML_BYTES + 1);
  assert.deepEqual(readMcpAppDocument([{ mimeType: "text/html;profile=mcp-app", text: huge }], "ui://x"), {
    kind: "too-large"
  });
  // Multi-byte text under the length cap but over the byte cap.
  const wide = "é".repeat(MCP_APP_MAX_HTML_BYTES / 2 + 1);
  assert.deepEqual(readMcpAppDocument([{ mimeType: "text/html;profile=mcp-app", text: wide }], "ui://x"), {
    kind: "too-large"
  });
  assert.deepEqual(readMcpAppDocument([{ mimeType: "text/html;profile=mcp-app", text: "  " }], "ui://x"), {
    kind: "none"
  });
  assert.deepEqual(readMcpAppDocument("nope", "ui://x"), { kind: "none" });
});

test("a reference is read whole or not at all", () => {
  assert.deepEqual(readMcpAppReference({ ...reference, prefersBorder: false, extra: 1 }), {
    ...reference,
    prefersBorder: false
  });
  assert.equal(readMcpAppReference({ ...reference, attachmentId: "thread_1-file.txt" }), undefined);
  assert.equal(readMcpAppReference({ ...reference, resourceUri: "https://x.example.com" }), undefined);
  assert.equal(readMcpAppReference({ ...reference, server: "" }), undefined);
  assert.equal(readMcpAppReference({ ...reference, tool: "x".repeat(300) }), undefined);
  assert.equal(readMcpAppReference(null), undefined);
  assert.ok(mcpAppReferencesEqual(reference, { ...reference }));
  assert.equal(mcpAppReferencesEqual(reference, { ...reference, prefersBorder: true }), false);
});

test("the resource URI and visibility are read from a tool's `_meta`", () => {
  assert.equal(readMcpAppResourceUri({ ui: { resourceUri: "ui://a/b" } }), "ui://a/b");
  assert.equal(readMcpAppResourceUri({ "ui/resourceUri": "ui://flat" }), "ui://flat");
  assert.equal(readMcpAppResourceUri({ ui: { resourceUri: "https://a" } }), undefined);
  assert.equal(readMcpAppResourceUri(undefined), undefined);
  assert.equal(mcpAppToolCallableByApp(undefined), true);
  assert.equal(mcpAppToolCallableByApp({ ui: { visibility: ["model", "app"] } }), true);
  assert.equal(mcpAppToolCallableByApp({ ui: { visibility: ["model"] } }), false);
});

// The rows each exposing provider's adapter writes (Codex `items.ts`, Grok `tool-calls.ts`).
const codexRow = (mcpApp: unknown, server = "charts", tool = "show_chart") => ({
  itemType: "mcp_tool_call",
  status: "completed",
  title: `${server}: ${tool}`,
  data: {
    server,
    tool,
    arguments: { range: "7d" },
    result: { content: [{ type: "text", text: "ok" }], structuredContent: { points: 3 }, _meta: null },
    mcpApp
  }
});
const grokRow = (mcpApp: unknown, server = "charts", tool = "show_chart") => ({
  itemType: "dynamic_tool_call",
  status: "completed",
  title: `${server}__${tool}`,
  data: {
    toolUseId: "call-1",
    vendorTool: "use_tool",
    rawInput: { variant: "UseTool", tool_name: `${server}__${tool}`, tool_input: { range: "7d" } },
    rawOutput: { type: "MCP", tool_name: tool, server_name: server, output: { OkayOutput: 'ok\n{"points":3}' } },
    mcpApp
  }
});

test("a row's app counts only when it names the row's own server and tool", () => {
  assert.deepEqual(mcpAppReferenceOfActivityPayload(codexRow(reference)), reference);
  assert.deepEqual(mcpAppReferenceOfActivityPayload(grokRow(reference)), reference);
  // Another server's or another tool's app on this row is refused.
  assert.equal(mcpAppReferenceOfActivityPayload(codexRow({ ...reference, server: "other" })), undefined);
  assert.equal(mcpAppReferenceOfActivityPayload(grokRow({ ...reference, tool: "other_tool" })), undefined);
  assert.equal(mcpAppReferenceOfActivityPayload(codexRow(reference, "other")), undefined);
  // No reference, or a malformed one.
  assert.equal(mcpAppReferenceOfActivityPayload({ data: { server: "charts", tool: "show_chart" } }), undefined);
  assert.equal(mcpAppReferenceOfActivityPayload(codexRow({ ...reference, attachmentId: "x" })), undefined);
  assert.deepEqual(mcpCallOfActivityPayload(grokRow(reference)), { server: "charts", tool: "show_chart" });
  assert.equal(mcpCallOfActivityPayload({ data: { rawOutput: { type: "Bash" } } }), undefined);
});

test("the slimmed row keeps a checked reference and never a foreign one", () => {
  for (const row of [codexRow(reference), grokRow(reference)]) {
    const slim = slimActivityPayload(row) as { data: Record<string, unknown> };
    assert.deepEqual(slim.data.mcpApp, reference);
    // Read from the slim row alone, and slimmed twice.
    assert.deepEqual(mcpAppReferenceOfActivityPayload(slim), reference);
    const twice = slimActivityPayload(slim) as { data: Record<string, unknown> };
    assert.deepEqual(twice.data.mcpApp, reference);
  }
  const foreign = slimActivityPayload(codexRow({ ...reference, server: "other" })) as {
    data: Record<string, unknown>;
  };
  assert.equal("mcpApp" in foreign.data, false);
});

test("the original call is read in each provider's layout", () => {
  assert.deepEqual(mcpAppToolCallOfActivityPayload(codexRow(reference)), {
    arguments: { range: "7d" },
    result: { content: [{ type: "text", text: "ok" }], structuredContent: { points: 3 } }
  });
  assert.deepEqual(mcpAppToolCallOfActivityPayload(grokRow(reference)), {
    arguments: { range: "7d" },
    result: { content: [{ type: "text", text: 'ok\n{"points":3}' }] }
  });
  assert.deepEqual(
    mcpAppToolCallOfActivityPayload({
      data: { rawInput: { tool_input: {} }, content: [{ type: "content", content: { type: "text", text: "acp" } }] }
    }),
    { arguments: {}, result: { content: [{ type: "text", text: "acp" }] } }
  );
  assert.deepEqual(mcpAppToolCallOfActivityPayload({ data: {} }), { arguments: {} });
});

test("a result is normalised to what the MCP Apps SDK accepts", () => {
  assert.deepEqual(normalizeMcpAppToolResult({ content: null, structuredContent: null, _meta: null, isError: false }), {
    content: []
  });
  assert.deepEqual(normalizeMcpAppToolResult({ content: [1], isError: true, _meta: { a: 1 } }), {
    content: [1],
    isError: true,
    _meta: { a: 1 }
  });
});

test("the allow attribute names only declared permissions, and heights clamp", () => {
  assert.equal(mcpAppAllowAttribute(undefined), "");
  assert.equal(mcpAppAllowAttribute({ camera: {}, clipboardWrite: {} }), "camera; clipboard-write");
  assert.equal(clampMcpAppHeight(10), 80);
  assert.equal(clampMcpAppHeight(5000), 2000);
  assert.equal(clampMcpAppHeight(Number.NaN), 320);
});

test("loopback, private and bare-TLD wildcard domains are dropped", () => {
  const csp = readMcpAppCsp({
    connectDomains: [
      "http://localhost:47831",
      "https://dev.localhost",
      "http://printer.local",
      "http://127.0.0.1:47831",
      "http://10.0.0.5",
      "https://172.20.1.1",
      "https://192.168.1.10",
      "http://169.254.169.254",
      "http://100.64.0.1",
      "http://0.0.0.0",
      "https://*.com",
      "wss://*.io",
      "https://*.example.com",
      "https://8.8.8.8",
      "https://172.32.0.1"
    ]
  });
  assert.deepEqual(csp, {
    connectDomains: ["https://*.example.com", "https://8.8.8.8", "https://172.32.0.1"]
  });
});

test("an app whose domains reach Orquester's own origin is recognised", () => {
  const csp = { connectDomains: ["https://api.example.com"], resourceDomains: ["https://*.orq.example.net"] };
  assert.equal(mcpAppCspReachesOrigin(csp, "https://api.example.com"), true);
  assert.equal(mcpAppCspReachesOrigin(csp, "wss://api.example.com:8443"), true);
  assert.equal(mcpAppCspReachesOrigin(csp, "https://box.orq.example.net"), true);
  assert.equal(mcpAppCspReachesOrigin(csp, "https://orq.example.net"), false, "a wildcard never covers its own apex");
  assert.equal(mcpAppCspReachesOrigin(csp, "https://other.example.com"), false);
  assert.equal(mcpAppCspReachesOrigin(undefined, "https://api.example.com"), false);
  assert.equal(mcpAppCspReachesOrigin(csp, "unix:///run/daemon.sock"), false);
  assert.equal(mcpAppCspReachesOrigin(csp, "not a url"), false);
});
