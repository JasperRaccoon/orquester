/**
 * MCP Apps — what an app's requests do on this client (spec 2026-10-14 §3):
 * which reach the daemon, which wait on the user's consent first, and what the
 * app is told when they are refused. Pure (no React): the frame supplies the
 * daemon request, the consent prompt and the browser's link and file
 * handling.
 *
 * The consent rules:
 * - `tools/call` asks unless the server marks the tool read-only
 *   (`annotations.readOnlyHint`, read through the daemon's `tool-info`) — and
 *   a tool hidden from apps is refused before anyone is asked (the host
 *   refuses it again regardless);
 * - `ui/message` always asks: it sends a message as the user;
 * - `ui/download-file` always asks: it writes a file on the user's machine;
 * - `resources/read`, `ui/update-model-context` and links ask nothing (a link
 *   opens only from a click in the focused app).
 * Nobody to ask (no dock mounted for the thread) refuses rather than proceeds.
 *
 * Ported in spirit from T3 Code (MIT): `apps/web/src/components/chat/McpAppFrame.tsx`.
 */

import type {
  McpAppCallToolResult,
  McpAppModelContextRequest,
  McpAppOperation,
  McpAppReadResourceResponse,
  McpAppReference,
  McpAppToolInfoResponse
} from "@orquester/api/agent-chat";

import { McpAppHostRefusal, mcpResourceBytes, type McpAppDownload, type McpAppHostOptions } from "./mcp-app-host";
import type { McpAppConsentKind } from "./mcp-app-consent";

/** Largest file an app may hand the user through `ui/download-file`. */
export const MCP_APP_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface McpAppActionDeps {
  readonly app: McpAppReference;
  /** One request of this app to the daemon (`api.mcpAppRequest` bound to its thread and row). */
  readonly request: <T>(operation: McpAppOperation, body: Record<string, unknown>) => Promise<T>;
  /** Ask the user; `undefined` when nobody can be asked. */
  readonly ask: (input: { kind: McpAppConsentKind; title: string; detail: string }) => Promise<boolean | undefined>;
  /** Sends a message into the thread as the user, or undefined where none can be sent. */
  readonly sendMessage: ((text: string) => Promise<void>) | undefined;
  /** Whether a link may open now: the app's frame is focused and the reader just used it. */
  readonly linkAllowed: () => boolean;
  readonly openLink: (url: string) => void;
  readonly saveFile: (file: { name: string; mimeType: string; bytes: Uint8Array }) => void;
}

/** A daemon refusal as the message the app shows. */
function refusal(error: unknown): McpAppHostRefusal {
  if (error instanceof McpAppHostRefusal) return error;
  const message =
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";
  return new McpAppHostRefusal(message);
}

async function consent(
  deps: McpAppActionDeps,
  input: { kind: McpAppConsentKind; title: string; detail: string }
): Promise<void> {
  const allowed = await deps.ask(input);
  if (allowed === undefined) throw new McpAppHostRefusal("Orquester could not ask for approval here.");
  if (!allowed) throw new McpAppHostRefusal("Declined by the user.");
}

const MAX_DETAIL_CHARS = 4000;

function argumentsDetail(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    text = "(arguments that cannot be shown)";
  }
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

export type McpAppActions = Pick<
  McpAppHostOptions,
  "callTool" | "readResource" | "openLink" | "sendMessage" | "updateModelContext" | "downloadFile"
>;

export function mcpAppActions(deps: McpAppActionDeps): McpAppActions {
  const request = async <T>(operation: McpAppOperation, body: Record<string, unknown>): Promise<T> => {
    try {
      return await deps.request<T>(operation, body);
    } catch (error) {
      throw refusal(error);
    }
  };

  return {
    callTool: async ({ name, arguments: args }) => {
      const info = await request<McpAppToolInfoResponse>("tool-info", { name });
      if (!info.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
      if (!info.readOnly) {
        await consent(deps, {
          kind: "tool",
          title: `Run ${info.title ?? name}?`,
          detail: argumentsDetail(args)
        });
      }
      return request<McpAppCallToolResult>("call-tool", { name, arguments: args });
    },

    readResource: ({ uri }) => request<McpAppReadResourceResponse>("read-resource", { uri }),

    openLink: async (url) => {
      // Only right after the reader used this frame, as with agent pages.
      if (!deps.linkAllowed()) throw new McpAppHostRefusal("Links open only from a click in the app.");
      deps.openLink(url);
    },

    sendMessage: async (text) => {
      const send = deps.sendMessage;
      if (send === undefined) throw new McpAppHostRefusal("Messages cannot be sent from here.");
      await consent(deps, { kind: "message", title: "Send this message?", detail: text });
      try {
        await send(text);
      } catch (error) {
        throw refusal(error);
      }
    },

    updateModelContext: async (context) => {
      const body: McpAppModelContextRequest = {
        ...(context.content === undefined ? {} : { content: [...context.content] }),
        ...(context.structuredContent === undefined ? {} : { structuredContent: context.structuredContent })
      };
      await request<Record<string, never>>("model-context", body as Record<string, unknown>);
    },

    downloadFile: async (files: ReadonlyArray<McpAppDownload>) => {
      await consent(deps, {
        kind: "download",
        title: files.length === 1 ? `Save ${files[0]!.name}?` : `Save ${files.length} files?`,
        detail: files.map((file) => file.name).join("\n")
      });
      for (const file of files) {
        let bytes: Uint8Array | undefined;
        let mimeType = file.mimeType ?? "application/octet-stream";
        if (file.kind === "embedded") {
          bytes = file.bytes;
        } else {
          // A linked file is read from the app's own server, like its other reads.
          const read = await request<McpAppReadResourceResponse>("read-resource", { uri: file.uri });
          const content = read.contents[0];
          bytes = mcpResourceBytes(content);
          const declared = (content as { mimeType?: unknown } | undefined)?.mimeType;
          if (typeof declared === "string") mimeType = declared;
        }
        if (bytes === undefined) throw new McpAppHostRefusal(`${file.name} has no contents.`);
        if (bytes.byteLength > MCP_APP_MAX_DOWNLOAD_BYTES) {
          throw new McpAppHostRefusal(`${file.name} is too large to save.`);
        }
        deps.saveFile({ name: file.name, mimeType, bytes });
      }
    }
  };
}
