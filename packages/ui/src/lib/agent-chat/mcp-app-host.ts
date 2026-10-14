/**
 * MCP Apps — the host side of the bridge (spec 2026-10-14 §3; ext-apps spec
 * 2026-01-26, plus the draft additions the current SDK sends:
 * `ui/download-file` and `ui/notifications/request-teardown`): JSON-RPC 2.0
 * over postMessage between the client and one app document. Transport-free
 * and React-free: the frame supplies how to post a message and how to reach
 * the daemon, and every protocol rule lives here, under test.
 *
 * Ported from T3 Code (MIT): `packages/client-runtime/src/mcpApps/host.ts`.
 */

import {
  MCP_APP_MAX_MESSAGE_BYTES,
  MCP_APP_PROTOCOL_VERSION,
  normalizeMcpAppToolResult,
  type McpAppCallToolResult,
  type McpAppReference
} from "@orquester/api/agent-chat";

/** Requests an app may have in flight at once; more are refused, not queued. */
const MAX_PENDING_REQUESTS = 16;
/** How long the host waits for an app to answer `ui/resource-teardown`. */
const TEARDOWN_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";

export interface McpAppHostContext {
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: McpAppDisplayMode;
  readonly availableDisplayModes: ReadonlyArray<McpAppDisplayMode>;
  /**
   * `maxHeight` when the host sizes the frame to the app's reported height,
   * `height` when the frame is a fixed box the app must fit (spec
   * "Container Dimensions").
   */
  readonly containerDimensions:
    | { readonly width: number; readonly maxHeight: number }
    | { readonly width: number; readonly height: number };
  readonly platform: "web" | "desktop" | "mobile";
  readonly locale?: string;
  readonly timeZone?: string;
  readonly userAgent?: string;
  readonly deviceCapabilities?: { readonly touch?: boolean; readonly hover?: boolean };
  readonly safeAreaInsets?: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  /** The tool call that created the app: the server's MCP `Tool` definition. */
  readonly toolInfo?: { readonly tool: unknown };
}

/** A file an app asked the host to save (`ui/download-file`): embedded, or linked on its server. */
export type McpAppDownload =
  | { readonly kind: "embedded"; readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }
  | { readonly kind: "link"; readonly name: string; readonly uri: string; readonly mimeType?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * The bytes of an MCP resource's contents: `text` as UTF-8, `blob` decoded
 * from base64. Undefined when it has neither or the base64 is malformed.
 */
export function mcpResourceBytes(content: unknown): Uint8Array | undefined {
  const record = asRecord(content);
  if (record === undefined) return undefined;
  if (typeof record.text === "string") return encoder.encode(record.text);
  if (typeof record.blob === "string") return decodeBase64(record.blob);
  return undefined;
}

/** Thrown by host callbacks to refuse a request with a message the app can show. */
export class McpAppHostRefusal extends Error {}

export interface McpAppHostOptions {
  readonly app: McpAppReference;
  readonly hostVersion: string;
  /** Posts one JSON-RPC message to the app document. */
  readonly post: (message: unknown) => void;
  readonly hostContext: () => McpAppHostContext;
  /**
   * Whether the agent can take `ui/update-model-context` (the provider has an
   * additive context channel). Read at initialize: without it the host does
   * not declare the capability, and refuses the request.
   */
  readonly supportsModelContext: () => boolean;

  readonly callTool: (input: { readonly name: string; readonly arguments: Record<string, unknown> }) => Promise<McpAppCallToolResult>;
  readonly readResource: (input: { readonly uri: string }) => Promise<unknown>;
  readonly openLink: (url: string) => Promise<void>;
  readonly sendMessage: (text: string) => Promise<void>;
  /** Replaces what this app tells the agent on its next turn; undefined content clears it. */
  readonly updateModelContext: (context: {
    readonly content?: ReadonlyArray<unknown>;
    readonly structuredContent?: Record<string, unknown>;
  }) => Promise<void>;
  /** Switches to a mode both the host and the app offer, answering the resulting mode. */
  readonly requestDisplayMode: (mode: McpAppDisplayMode) => Promise<McpAppDisplayMode>;
  readonly downloadFile: (files: ReadonlyArray<McpAppDownload>) => Promise<void>;
  /** The app asked to be closed (`ui/notifications/request-teardown`). */
  readonly onRequestTeardown: () => void;
  readonly onSizeChanged: (size: { readonly width?: number; readonly height?: number }) => void;
}

export interface McpAppHost {
  /** Handles one message the app posted; the caller has already checked its source. */
  readonly receive: (data: unknown) => void;
  /**
   * The original tool call's arguments and result. They reach the app once it
   * has initialized, whichever happens last, and only once.
   */
  readonly setToolCall: (call: { readonly arguments: unknown; readonly result: McpAppCallToolResult | undefined }) => void;
  /** Sends `host-context-changed` with the fields that differ from what the app last saw. */
  readonly updateHostContext: () => void;
  /**
   * Asks the app to wrap up before its document goes away
   * (`ui/resource-teardown`), resolving once it answers or after a short
   * timeout, then disposes the host.
   */
  readonly teardown: () => Promise<void>;
  readonly dispose: () => void;
}

function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

const errorMessage = (error: unknown) =>
  error instanceof McpAppHostRefusal
    ? error.message
    : error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "Request failed.";

export function makeMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let initialized = false;
  let disposed = false;
  let toolCall: { readonly arguments: unknown; readonly result: McpAppCallToolResult | undefined } | undefined;
  let toolCallSent = false;
  let pending = 0;
  let sentContext: McpAppHostContext | undefined;
  /** Modes the app declared at initialize; undefined when it declared none. */
  let appDisplayModes: ReadonlyArray<string> | undefined;
  let nextHostRequestId = 0;
  const hostRequests = new Map<string, () => void>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });

  const sendToolCall = () => {
    if (!initialized || toolCall === undefined || toolCallSent) return;
    toolCallSent = true;
    notify("ui/notifications/tool-input", { arguments: asRecord(toolCall.arguments) ?? {} });
    if (toolCall.result !== undefined) {
      notify("ui/notifications/tool-result", normalizeMcpAppToolResult(toolCall.result));
    }
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    let work: Promise<unknown>;
    try {
      work = run();
    } catch (error) {
      work = Promise.reject(error);
    }
    work.then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      }
    );
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        const declared = asRecord(params.appCapabilities)?.availableDisplayModes;
        appDisplayModes = Array.isArray(declared)
          ? declared.filter((mode): mode is string => typeof mode === "string")
          : undefined;
        sentContext = options.hostContext();
        respond(id, {
          // One version is spoken; an app asking for another gets ours.
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "orquester", version: options.hostVersion },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: { text: {} },
            ...(options.supportsModelContext() ? { updateModelContext: { text: {}, structuredContent: {} } } : {}),
            downloadFile: {},
            sandbox: {
              ...(options.app.csp === undefined ? {} : { csp: options.app.csp }),
              ...(options.app.permissions === undefined ? {} : { permissions: options.app.permissions })
            }
          },
          hostContext: sentContext
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string" || name.trim() === "" || asRecord(args) === undefined) {
          fail(id, -32602, "tools/call needs a tool name and object arguments.");
          return;
        }
        answer(id, () =>
          options.callTool({ name, arguments: args as Record<string, unknown> }).then(normalizeMcpAppToolResult)
        );
        return;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string" || uri.trim() === "") {
          fail(id, -32602, "resources/read needs a uri.");
          return;
        }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case "ui/open-link": {
        const url = params.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, "Only http(s) links can be opened.");
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        // The SDK sends an array of content blocks; the spec text shows one block.
        const blocks = Array.isArray(params.content) ? params.content : [params.content];
        const texts = blocks.map((block) => {
          const record = asRecord(block);
          return record?.type === "text" && typeof record.text === "string" ? record.text : undefined;
        });
        if (params.role !== "user" || texts.length === 0 || texts.includes(undefined)) {
          fail(id, -32602, "Only text messages from the user role are supported.");
          return;
        }
        const text = texts.join("\n").trim();
        if (text === "") {
          fail(id, -32602, "ui/message needs non-empty text.");
          return;
        }
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/request-display-mode": {
        const current = options.hostContext().displayMode;
        const mode = params.mode;
        // A mode the host lacks, or the app did not declare, leaves the
        // current one; the spec has the host answer with whichever applies.
        const allowed =
          typeof mode === "string" &&
          options.hostContext().availableDisplayModes.includes(mode as McpAppDisplayMode) &&
          (appDisplayModes === undefined || appDisplayModes.includes(mode));
        if (!allowed || mode === current) {
          respond(id, { mode: current });
          return;
        }
        answer(id, () => options.requestDisplayMode(mode as McpAppDisplayMode).then((result) => ({ mode: result })));
        return;
      }
      case "ui/update-model-context": {
        const content = params.content;
        const structured = params.structuredContent;
        if (!options.supportsModelContext()) {
          fail(id, -32601, "This agent cannot take context from an app.");
          return;
        }
        if ((content !== undefined && !Array.isArray(content)) || (structured !== undefined && asRecord(structured) === undefined)) {
          fail(id, -32602, "Model context needs content blocks or an object of structured content.");
          return;
        }
        answer(id, () =>
          options
            .updateModelContext({
              ...(content === undefined ? {} : { content: content as unknown[] }),
              ...(structured === undefined ? {} : { structuredContent: structured as Record<string, unknown> })
            })
            .then(() => ({}))
        );
        return;
      }
      case "ui/download-file": {
        const files = readDownloads(params.contents);
        if (files === undefined) {
          fail(id, -32602, "ui/download-file needs embedded resources or resource links.");
          return;
        }
        answer(id, () =>
          options.downloadFile(files).then(
            () => ({}),
            // The draft reports a refused or failed download in the result.
            (error: unknown) => (error instanceof McpAppHostRefusal ? { isError: true } : Promise.reject(error))
          )
        );
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/notifications/initialized": {
        if (initialized) return;
        initialized = true;
        sendToolCall();
        // The theme or size may have changed since the initialize response.
        handle.updateHostContext();
        return;
      }
      case "ui/notifications/size-changed": {
        const width = typeof params.width === "number" && Number.isFinite(params.width) ? params.width : undefined;
        const height = typeof params.height === "number" && Number.isFinite(params.height) ? params.height : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height })
          });
        }
        return;
      }
      case "ui/notifications/request-teardown":
        options.onRequestTeardown();
        return;
      default:
      // `notifications/message` (logging) and unknown notifications are ignored.
    }
  };

  /** A response to a request the host sent the app. */
  const handleResponse = (id: JsonRpcId) => {
    const settle = hostRequests.get(String(id));
    if (settle === undefined) return;
    hostRequests.delete(String(id));
    settle();
  };

  const handle: McpAppHost = {
    receive: (data) => {
      const message = asRecord(data);
      if (disposed || message === undefined || message.jsonrpc !== "2.0") return;
      if (jsonBytes(message) > MCP_APP_MAX_MESSAGE_BYTES) {
        if (isId(message.id) && typeof message.method === "string") fail(message.id, -32600, "Message too large.");
        return;
      }
      const method = message.method;
      if (typeof method !== "string") {
        if (isId(message.id) && ("result" in message || "error" in message)) handleResponse(message.id);
        return;
      }
      const params = asRecord(message.params) ?? {};
      if (isId(message.id)) handleRequest(message.id, method, params);
      else handleNotification(method, params);
    },
    setToolCall: (call) => {
      toolCall ??= call;
      sendToolCall();
    },
    updateHostContext: () => {
      // The spec forbids messages before the app finishes initializing; it
      // reads the then-current context from the initialize response anyway.
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as Array<keyof McpAppHostContext>) {
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) changes[key] = next[key];
      }
      sentContext = next;
      if (Object.keys(changes).length > 0) notify("ui/notifications/host-context-changed", changes);
    },
    teardown: () =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          clearTimeout(timer);
          disposed = true;
          resolve();
        };
        // Before initialization the app has nothing to save and may not be
        // listening; the spec only asks for teardown after it.
        if (disposed || !initialized) {
          finish();
          return;
        }
        const id = `orq-host-${nextHostRequestId++}`;
        hostRequests.set(id, finish);
        timer = setTimeout(() => {
          hostRequests.delete(id);
          finish();
        }, TEARDOWN_TIMEOUT_MS);
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      }),
    dispose: () => {
      disposed = true;
    }
  };
  return handle;
}

const MAX_DOWNLOAD_NAME = 200;

/** The file name an app gave a download, or the last part of its URI. */
function downloadName(uri: unknown, name: unknown): string {
  const raw =
    typeof name === "string" && name.trim() !== ""
      ? name
      : typeof uri === "string"
        ? (uri.split(/[/?#]/).filter(Boolean).at(-1) ?? "download")
        : "download";
  // Path separators, reserved characters, and control characters.
  const safe = Array.from(raw, (char) => (/[\\/:*?"<>|]/.test(char) || char.charCodeAt(0) < 32 ? "-" : char)).join("");
  return safe.slice(0, MAX_DOWNLOAD_NAME) || "download";
}

/** `ui/download-file` contents: MCP embedded resources and resource links. */
function readDownloads(contents: unknown): ReadonlyArray<McpAppDownload> | undefined {
  if (!Array.isArray(contents) || contents.length === 0) return undefined;
  const files: McpAppDownload[] = [];
  for (const value of contents) {
    const entry = asRecord(value);
    if (entry === undefined) return undefined;
    const resource = asRecord(entry.resource);
    if (entry.type === "resource" && resource !== undefined) {
      const bytes = mcpResourceBytes(resource);
      if (bytes === undefined) return undefined;
      files.push({
        kind: "embedded",
        name: downloadName(resource.uri, resource.name),
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream",
        bytes
      });
    } else if (entry.type === "resource_link" && typeof entry.uri === "string") {
      files.push({
        kind: "link",
        name: downloadName(entry.uri, entry.name),
        uri: entry.uri,
        ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {})
      });
    } else {
      return undefined;
    }
  }
  return files;
}

/**
 * Maps the page theme tokens (`htmlRenderThemeTokens`, spec §2.3) to the
 * MCP Apps spec's standardized style names, so apps written for any host pick
 * up the thread's colours and fonts.
 */
export function mcpAppStyleVariables(theme: Readonly<Record<string, string>>): Record<string, string> {
  const pick = (name: string) => theme[name];
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--color-background-primary", pick("--background")],
    ["--color-background-secondary", pick("--card")],
    ["--color-background-tertiary", pick("--muted")],
    ["--color-background-inverse", pick("--foreground")],
    ["--color-background-info", pick("--info")],
    ["--color-background-danger", pick("--destructive-surface")],
    ["--color-background-warning", pick("--warning-surface")],
    ["--color-text-primary", pick("--foreground")],
    ["--color-text-secondary", pick("--muted-foreground")],
    ["--color-text-tertiary", pick("--muted-foreground")],
    ["--color-text-inverse", pick("--background")],
    ["--color-text-info", pick("--info-foreground")],
    ["--color-text-danger", pick("--destructive-foreground")],
    ["--color-text-success", pick("--success-foreground")],
    ["--color-text-warning", pick("--warning-foreground")],
    ["--color-border-primary", pick("--border")],
    ["--color-border-secondary", pick("--input")],
    ["--color-border-danger", pick("--destructive")],
    ["--color-ring-primary", pick("--ring")],
    ["--font-sans", pick("--font-sans")],
    ["--font-mono", pick("--font-mono")],
    ["--border-radius-md", pick("--radius")]
  ];
  const variables: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (value !== undefined && value !== "") variables[name] = value;
  }
  return variables;
}
