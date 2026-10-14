/**
 * MCP Apps (https://github.com/modelcontextprotocol/ext-apps, spec
 * 2026-01-26; spec 2026-10-14 §3): an MCP tool can name a `ui://` HTML
 * resource that hosts render as an interactive view of its result. The
 * adapter whose provider exposes that resource (Codex, Grok — see the spec's
 * appendix for the evidence) snapshots it when the call completes, stores it
 * as a thread attachment (id suffix `-html`, served by the agent-visuals
 * route), and writes an {@link McpAppReference} on the completed tool row as
 * `data.mcpApp`. The client frames the snapshot and speaks the MCP Apps
 * JSON-RPC bridge with it; the app's own `tools/call` and `resources/read`
 * go back through the thread's live provider session, to its own server only.
 *
 * Ported from T3 Code (MIT): `packages/shared/src/mcpApp.ts` (reference,
 * CSP, bootstraps, allow attribute) and `apps/server/src/mcpApps/McpAppSnapshot.ts`
 * (reading the document out of a `resources/read` result), plus Orquester's
 * per-provider readers of the tool row. Pure (it imports only the session-tool
 * name readers and the page bridge's shortcut methods): the host (capture,
 * request checks), `slim.ts` and the UI read one copy.
 */

import { HTML_RENDER_KEY_DOWN_METHOD, HTML_RENDER_SHORTCUTS_METHOD } from "./html-render.ts";
import { isSessionToolsServerName, sessionToolNameOfData } from "./session-tools.ts";

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The MCP extension id a client declares to receive UI resources (SEP-1724). */
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_RESOURCE_SCHEME = "ui://";

const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;
/** Largest app document a thread stores (spec §3: ≤ 5 MiB). */
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Largest context one app may keep for the agent's next turn, in UTF-8 bytes. */
export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;
/** Largest JSON-RPC message a frame may post the host, in UTF-8 bytes. */
export const MCP_APP_MAX_MESSAGE_BYTES = 256 * 1024;
/** How long a capture may take to read a resource before the call stays a plain row. */
export const MCP_APP_CAPTURE_TIMEOUT_MS = 15_000;

const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
// A `ui://` URI can carry a path and query; the reference stays bounded.
const MAX_RESOURCE_URI_LENGTH = 4096;
/** `<thread segment>-<uuid>-html`: the attachment store's id shape, html only. */
const HTML_ATTACHMENT_ID =
  /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/i;

/** `_meta.ui.csp` on a UI resource: origins the app needs, by kind. */
export interface McpAppCsp {
  readonly connectDomains?: ReadonlyArray<string>;
  readonly resourceDomains?: ReadonlyArray<string>;
  readonly frameDomains?: ReadonlyArray<string>;
  readonly baseUriDomains?: ReadonlyArray<string>;
}

/** `_meta.ui.permissions` on a UI resource. */
export interface McpAppPermissions {
  readonly camera?: Record<string, never>;
  readonly microphone?: Record<string, never>;
  readonly geolocation?: Record<string, never>;
  readonly clipboardWrite?: Record<string, never>;
}

/** What a completed tool row carries (`data.mcpApp`) so a client can host its app. */
export interface McpAppReference {
  /** The snapshot: a thread attachment id ending in `-html`, naming its own thread. */
  readonly attachmentId: string;
  /** The MCP server the tool belongs to, as the provider names it. */
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly csp?: McpAppCsp;
  readonly permissions?: McpAppPermissions;
  readonly prefersBorder?: boolean;
}

/** An MCP `CallToolResult` as the bridge hands it to an app. */
export interface McpAppCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

/** The original call an app replays: its arguments and, once known, its result. */
export interface McpAppToolCall {
  readonly arguments: Record<string, unknown>;
  readonly result?: McpAppCallToolResult;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH ? value : undefined;
}

// Only scheme-qualified origins, optionally with a leading `*.` subdomain
// wildcard, survive. Anything else (keywords, paths, quotes, whitespace) could
// widen or break the generated policy, so it is dropped.
const DOMAIN_PATTERN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

/** `scheme://[*.]host[:port]` split, lower-cased; undefined when not one. */
function splitDomain(domain: string): { wildcard: boolean; host: string } | undefined {
  const match = /^(?:https?|wss?):\/\/(\*\.)?([^:/]+)(?::\d{1,5})?$/i.exec(domain);
  return match ? { wildcard: match[1] !== undefined, host: match[2]!.toLowerCase() } : undefined;
}

/**
 * A host an app's frame must never be let reach: loopback, link-local and
 * private addresses (the daemon, the user's own network) and `.localhost` /
 * `.local` names.
 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function acceptableDomain(domain: unknown): domain is string {
  if (typeof domain !== "string" || domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    return false;
  }
  const parts = splitDomain(domain);
  if (parts === undefined || isPrivateHost(parts.host)) return false;
  // `*.com`: a wildcard over a whole top-level domain is no declaration at all.
  return !(parts.wildcard && !parts.host.includes("."));
}

function readDomains(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value.filter(acceptableDomain).slice(0, MAX_DOMAINS);
  return domains.length === 0 ? undefined : domains;
}

/**
 * Whether an app's declared domains would let it reach `origin` — the
 * Orquester origin its client runs on, or the daemon it talks to. The
 * snapshot's policy is fixed when it is captured, so a client refuses to
 * frame such an app rather than hand it a path to its own API. Matched by
 * host, whatever the scheme or port.
 */
export function mcpAppCspReachesOrigin(csp: McpAppCsp | undefined, origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "") return false;
  for (const key of CSP_KEYS) {
    for (const domain of csp?.[key] ?? []) {
      const parts = splitDomain(domain);
      if (parts === undefined) continue;
      if (parts.wildcard ? host.endsWith(`.${parts.host}`) : host === parts.host) return true;
    }
  }
  return false;
}

const CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const;

/** The well-formed part of a resource's declared `_meta.ui.csp`. */
export function readMcpAppCsp(value: unknown): McpAppCsp | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const csp: { -readonly [K in keyof McpAppCsp]: McpAppCsp[K] } = {};
  for (const key of CSP_KEYS) {
    const domains = readDomains(record[key]);
    if (domains !== undefined) csp[key] = domains;
  }
  return Object.keys(csp).length === 0 ? undefined : csp;
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

/** The permissions a resource declared, each as the spec's empty object. */
export function readMcpAppPermissions(value: unknown): McpAppPermissions | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const permissions: Partial<Record<(typeof PERMISSION_KEYS)[number], Record<string, never>>> = {};
  for (const key of PERMISSION_KEYS) {
    if (asRecord(record[key]) !== undefined) permissions[key] = {};
  }
  return Object.keys(permissions).length === 0 ? undefined : permissions;
}

/** Whether an attachment id is a stored HTML document's (`…-html`). */
export function isMcpAppAttachmentId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && HTML_ATTACHMENT_ID.test(value);
}

/** A validated reference, or undefined when `value` is not one. */
export function readMcpAppReference(value: unknown): McpAppReference | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const attachmentId = record.attachmentId;
  const server = asName(record.server);
  const tool = asName(record.tool);
  const resourceUri =
    typeof record.resourceUri === "string" && record.resourceUri.length <= MAX_RESOURCE_URI_LENGTH
      ? record.resourceUri
      : undefined;
  if (
    !isMcpAppAttachmentId(attachmentId) ||
    server === undefined ||
    tool === undefined ||
    resourceUri === undefined ||
    !resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)
  ) {
    return undefined;
  }
  const csp = readMcpAppCsp(record.csp);
  const permissions = readMcpAppPermissions(record.permissions);
  return {
    attachmentId,
    server,
    tool,
    resourceUri,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(typeof record.prefersBorder === "boolean" ? { prefersBorder: record.prefersBorder } : {})
  };
}

export function mcpAppReferencesEqual(left: McpAppReference, right: McpAppReference): boolean {
  return (
    left.attachmentId === right.attachmentId &&
    left.server === right.server &&
    left.tool === right.tool &&
    left.resourceUri === right.resourceUri &&
    left.prefersBorder === right.prefersBorder &&
    JSON.stringify(left.csp ?? null) === JSON.stringify(right.csp ?? null) &&
    JSON.stringify(left.permissions ?? null) === JSON.stringify(right.permissions ?? null)
  );
}

/** A tool's `_meta.ui.resourceUri` (or the deprecated flat key), if it names a UI resource. */
export function readMcpAppResourceUri(meta: unknown): string | undefined {
  const record = asRecord(meta);
  if (record === undefined) return undefined;
  const nested = asRecord(record.ui)?.resourceUri;
  const uri = nested ?? record["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) && uri.length <= MAX_RESOURCE_URI_LENGTH
    ? uri
    : undefined;
}

/**
 * Whether a tool's `_meta.ui.visibility` lets an app call it. The spec
 * defaults to visible to both the model and apps.
 */
export function mcpAppToolCallableByApp(meta: unknown): boolean {
  const visibility = asRecord(asRecord(meta)?.ui)?.visibility;
  return !Array.isArray(visibility) || visibility.includes("app");
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The Content-Security-Policy for an app document, per the spec's
 * construction: undeclared origins stay blocked, and nothing loads from the
 * host's own origin (`'self'` would reach Orquester's API).
 */
export function mcpAppContentSecurityPolicy(csp: McpAppCsp | undefined): string {
  const resources = csp?.resourceDomains?.join(" ") ?? "";
  const list = (domains: ReadonlyArray<string> | undefined, fallback: string) =>
    domains === undefined || domains.length === 0 ? fallback : domains.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    "object-src 'none'",
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "form-action 'none'"
  ].join("; ");
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Puts the app's policy at the top of its document as a CSP meta tag, ahead of
 * any script. The serving route's `sandbox` header already makes the origin
 * opaque; browsers enforce both policies, so the document can only tighten
 * this one, never widen it.
 */
export function injectMcpAppCsp(html: string, csp: McpAppCsp | undefined): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
    mcpAppContentSecurityPolicy(csp)
  )}">`;
  // After a leading doctype, so the document stays in standards mode; the
  // parser moves the tag into the head it opens.
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `<!doctype html>${meta}${html}`;
}

/** The doctype and CSP meta a snapshot starts with: anything injected goes after them. */
const SNAPSHOT_PREFIX =
  /^﻿?\s*<!doctype[^>]*>\s*(?:<meta http-equiv="Content-Security-Policy" content="[^"]*">)?/i;

function insertAfterPolicy(html: string, script: string): string {
  const prefix = SNAPSHOT_PREFIX.exec(html);
  return prefix ? `${prefix[0]}${script}${html.slice(prefix[0].length)}` : `<!doctype html>${script}${html}`;
}

/**
 * Not MCP Apps: the captured document's own word, from its `pagehide`, that it
 * is going away. A frame that navigates keeps its window, so a page Orquester
 * never served could otherwise talk to the bridge before the frame's second
 * `load` is seen; this arrives first (messages from one window are delivered
 * in order), and the client stops the bridge on it.
 */
export const MCP_APP_UNLOAD_METHOD = "orq/notifications/document-unloaded";

/** Whether a frame's message is the captured document's unload notice. */
export function isMcpAppUnloadNotice(data: unknown): boolean {
  const record = asRecord(data);
  return record?.jsonrpc === "2.0" && record.method === MCP_APP_UNLOAD_METHOD;
}

/**
 * Installed before vendor scripts so an app that omits its own theme handling
 * still gives its canvas and native controls the host's appearance — and so
 * the document reports its own unload ({@link MCP_APP_UNLOAD_METHOD}) from the
 * first `pagehide` listener. The frame has an opaque origin, so messages are
 * authenticated by the parent window.
 *
 * Not MCP Apps either: like an agent page's bootstrap, it passes on the app
 * shortcuts the host names (`orq/notifications/shortcuts`) as
 * `orq/notifications/keydown` — a key typed in a focused frame never reaches
 * the app's own listeners otherwise. Only a trusted key the app did not handle
 * itself, outside text entry.
 */
export function injectMcpAppThemeBootstrap(html: string): string {
  return insertAfterPolicy(
    html,
    // The parent is read at install, before any app script could shadow
    // `window.parent`; a page kept in the back-forward cache (`persisted`)
    // is not going away, so it says nothing.
    `<script>(function(){var P=window.parent;window.addEventListener("pagehide",function(ev){if(ev&&ev.persisted)return;try{P.postMessage({jsonrpc:"2.0",method:${JSON.stringify(
      MCP_APP_UNLOAD_METHOD
    )}},"*");}catch(e){}},true);window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.jsonrpc!=="2.0")return;var t=m.method==="ui/notifications/host-context-changed"?m.params&&m.params.theme:(m.id!==undefined&&m.method===undefined&&m.result&&m.result.hostContext?m.result.hostContext.theme:undefined);if(t==="light"||t==="dark")document.documentElement.style.colorScheme=t;});var K=[];window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data,p=m&&m.params;if(m&&m.jsonrpc==="2.0"&&m.method===${JSON.stringify(
      HTML_RENDER_SHORTCUTS_METHOD
    )}&&p&&Array.isArray(p.shortcuts))K=p.shortcuts;});window.addEventListener("keydown",function(e){var t=e.composedPath?e.composedPath()[0]:e.target,l=(e.key||"").toLowerCase(),f,s=function(c){return c&&c.metaKey===e.metaKey&&c.ctrlKey===e.ctrlKey&&c.shiftKey===e.shiftKey&&c.altKey===e.altKey&&(c.key===l||(!!c.code&&c.code===e.code));};if(!e.isTrusted||e.isComposing||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))||!K.some(s))return;f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;e.preventDefault();try{P.postMessage({jsonrpc:"2.0",method:${JSON.stringify(
      HTML_RENDER_KEY_DOWN_METHOD
    )},params:{key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat}},"*");}catch(x){}};window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);})();</script>`
  );
}

/**
 * Analytics libraries often read cookies during startup. An opaque document
 * has none, but browsers throw instead of returning an empty cookie string;
 * this keeps the sandbox and makes that case behave like no cookies.
 */
export function injectMcpAppCookieBootstrap(html: string): string {
  return insertAfterPolicy(
    html,
    `<script>(function(){try{void document.cookie;}catch(error){if(error&&error.name==="SecurityError"){Object.defineProperty(document,"cookie",{configurable:true,get:function(){return "";},set:function(){}});}}})();</script>`
  );
}

/** The iframe `allow` attribute for the permissions an app declared. */
export function mcpAppAllowAttribute(permissions: McpAppPermissions | undefined): string {
  const features: string[] = [];
  if (permissions?.camera) features.push("camera");
  if (permissions?.microphone) features.push("microphone");
  if (permissions?.geolocation) features.push("geolocation");
  if (permissions?.clipboardWrite) features.push("clipboard-write");
  return features.join("; ");
}

export function clampMcpAppHeight(height: number): number {
  if (!Number.isFinite(height)) return MCP_APP_DEFAULT_HEIGHT;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, height)));
}

/** A download-safe name for the snapshot: the tool's. */
export function mcpAppFileName(tool: string): string {
  const name = tool.replace(/[^\w.-]+/g, "-").slice(0, 80) || "app";
  return `${name}.html`;
}

const utf8 = new TextEncoder();

function decodeBase64(text: string): string | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The outcome of reading a `resources/read` result for an app's document. */
export type McpAppDocument =
  | {
      readonly kind: "document";
      /** The prepared document: CSP meta and bootstraps first, the app after. */
      readonly html: string;
      readonly csp?: McpAppCsp;
      readonly permissions?: McpAppPermissions;
      readonly prefersBorder?: boolean;
    }
  /** The resource is an app document over {@link MCP_APP_MAX_HTML_BYTES}. */
  | { readonly kind: "too-large" }
  /** No `text/html;profile=mcp-app` content with a body for this URI. */
  | { readonly kind: "none" };

/**
 * The app's HTML document in a `resources/read` result's `contents`, with the
 * `_meta.ui` the resource declared, prepared for storing. Only
 * `text/html;profile=mcp-app` content counts; a `blob` is base64 per MCP.
 * Sizes are checked before decoding, so an oversized resource is refused
 * without first being copied: a string's UTF-8 form is at least its length,
 * and base64 decodes to three quarters of its own.
 */
export function readMcpAppDocument(contents: unknown, uri: string): McpAppDocument {
  if (!Array.isArray(contents)) return { kind: "none" };
  for (const entry of contents) {
    const content = asRecord(entry);
    if (content === undefined) continue;
    if (content.uri !== undefined && content.uri !== uri) continue;
    const mimeType = typeof content.mimeType === "string" ? content.mimeType : "";
    if (mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    let html: string | undefined;
    if (typeof content.text === "string") {
      if (content.text.length > MCP_APP_MAX_HTML_BYTES) return { kind: "too-large" };
      html = content.text;
    } else if (typeof content.blob === "string") {
      if (content.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4) return { kind: "too-large" };
      html = decodeBase64(content.blob);
    }
    if (html === undefined || html.trim() === "") continue;
    if (utf8.encode(html).byteLength > MCP_APP_MAX_HTML_BYTES) return { kind: "too-large" };
    const ui = asRecord(asRecord(content._meta)?.ui) ?? {};
    const csp = readMcpAppCsp(ui.csp);
    const permissions = readMcpAppPermissions(ui.permissions);
    const prepared = injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(injectMcpAppCsp(html, csp)));
    return {
      kind: "document",
      html: prepared,
      ...(csp === undefined ? {} : { csp }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {})
    };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// The tool row
// ---------------------------------------------------------------------------

/**
 * The MCP call a full (unslimmed) tool row records, as each exposing
 * provider's adapter ingests it:
 *
 * - Codex `mcpToolCall`: `data.server` + `data.tool` (or the same on `data.item`);
 * - Grok `use_tool`: `data.rawOutput` `{type: "MCP", server_name, tool_name}`.
 *
 * Undefined when the row names no MCP call in either layout — which a slimmed
 * row does not (`slim.ts` keeps the reference only after this check).
 */
export function mcpCallOfActivityPayload(payload: unknown): { server: string; tool: string } | undefined {
  const data = asRecord(asRecord(payload)?.data);
  if (data === undefined) return undefined;
  for (const record of [data, asRecord(data.item)]) {
    const server = asName(record?.server);
    const tool = asName(record?.tool);
    if (server !== undefined && tool !== undefined) return { server, tool };
  }
  const rawOutput = asRecord(data.rawOutput);
  if (rawOutput?.type === "MCP") {
    const server = asName(rawOutput.server_name);
    const tool = asName(rawOutput.tool_name);
    if (server !== undefined && tool !== undefined) return { server, tool };
  }
  return undefined;
}

/**
 * The app a completed tool row carries (`data.mcpApp`), if any. The reference
 * counts only when it names the very server and tool the row's own call
 * records — a server can only ever point at an app of its own. A row with no
 * call identity left is a slimmed one, whose `mcpApp` `slim.ts` wrote only
 * after this same check on the full row.
 *
 * Orquester's own session tools are never an MCP App (their pages are the
 * `visual` row, `html-render.ts`): a row the ingestion marked as a session
 * tool's (`data.sessionTool`), or an app naming a session-tools server, has none.
 */
export function mcpAppReferenceOfActivityPayload(payload: unknown): McpAppReference | undefined {
  const data = asRecord(asRecord(payload)?.data);
  if (data === undefined || !("mcpApp" in data)) return undefined;
  if (sessionToolNameOfData(data) !== null) return undefined;
  const reference = readMcpAppReference(data.mcpApp);
  if (reference === undefined || isSessionToolsServerName(reference.server)) return undefined;
  const call = mcpCallOfActivityPayload(payload);
  if (call !== undefined && (call.server !== reference.server || call.tool !== reference.tool)) {
    return undefined;
  }
  return reference;
}

/** A `CallToolResult` as the MCP Apps SDK accepts it: absent fields absent, never null. */
export function normalizeMcpAppToolResult(value: unknown): McpAppCallToolResult {
  const result = asRecord(value) ?? {};
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(asRecord(result.structuredContent) !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(asRecord(result._meta) !== undefined ? { _meta: result._meta } : {})
  };
}

/** ACP content blocks (`{type: "content", content: {...}}`) as MCP content. */
function acpContentBlocks(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.flatMap((entry) => {
    const record = asRecord(entry);
    const content = asRecord(record?.content);
    return record?.type === "content" && content !== undefined ? [content] : [];
  });
  return blocks.length === 0 ? undefined : blocks;
}

/**
 * The original call a full tool row records, for the app's
 * `ui/notifications/tool-input` and `…/tool-result`:
 *
 * - Codex: `data.arguments`, `data.result` (`{content, structuredContent, _meta}`);
 * - Grok: `data.rawInput.tool_input`, and as the result the text its CLI
 *   kept (`data.rawOutput.output.OkayOutput`) or the ACP content blocks —
 *   Grok folds `structuredContent` into that text and drops `_meta`.
 */
export function mcpAppToolCallOfActivityPayload(payload: unknown): McpAppToolCall {
  const data = asRecord(asRecord(payload)?.data) ?? {};
  const rawInput = asRecord(data.rawInput);
  const args = asRecord(data.arguments) ?? asRecord(asRecord(data.item)?.arguments) ?? asRecord(rawInput?.tool_input) ?? {};
  const codexResult = asRecord(data.result) ?? asRecord(asRecord(data.item)?.result);
  if (codexResult !== undefined) {
    return { arguments: args, result: normalizeMcpAppToolResult(codexResult) };
  }
  const okay = asRecord(asRecord(data.rawOutput)?.output)?.OkayOutput;
  if (typeof okay === "string") {
    return { arguments: args, result: { content: [{ type: "text", text: okay }] } };
  }
  const blocks = acpContentBlocks(data.content);
  return blocks === undefined ? { arguments: args } : { arguments: args, result: { content: blocks } };
}
