/**
 * Catalog family `tailnet` (tailnet machines spec 2026-11-22 §4.7.4): `share_preview` and
 * `unshare_preview`, chat-only, advertised while Tailscale on the daemon host can serve HTTPS
 * (`session-tools/manifest.ts`). Act tier, no card: a share reaches only tailnet members, and the
 * daemon ends it when the chat closes or the port stops listening.
 *
 * Both go through `DaemonApi.request` to `tailnetRoutes.previews`, whose handler reads the chat
 * and its project from the stamped agent principal (a box project's port is shared through its
 * host forward) and never takes a port another app serves.
 */

import { z } from "zod";
import { tailnetRoutes, type TailnetPreviewShareResponse, type TailnetPreviewSharesResponse } from "@orquester/api";

import { defineTool, MUTATING, MUTATING_IDEMPOTENT, type AnyOrquesterTool, type ScopeClaim, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";

const port = z.number().int().min(1024).max(65535).describe("The port the dev server listens on, as this chat sees it (in its box, for a box project).");

/** The daemon's refusal, with the problem's fix appended so the agent can tell the user what to do. */
function refusal(res: DaemonResponse): ToolError {
  const error = daemonError(res);
  const problem = (res.body as { problem?: { fix?: unknown } } | null)?.problem;
  return typeof problem?.fix === "string" ? new ToolError(error.code, `${error.message} Fix: ${problem.fix}`, error.detail) : error;
}

function ownChat(caller: ToolCaller, name: string): Promise<ScopeClaim> {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${name} is a chat tool.`);
  return Promise.resolve({ projects: [], sessions: [caller.threadId], self: "allow", reads: "none", writes: true, causesTurnIn: [] });
}

const sharePreview = defineTool({
  name: "share_preview",
  title: "Share a dev server on the tailnet",
  description:
    "Share a running dev server (Vite, Next, …) at https://<this server>.ts.net:<port> so the user can open it on their other devices on the tailnet (phone, laptop). The dev server must already listen on the port. Only tailnet members can reach it; it stops when this chat closes or the port stops listening.",
  chatNote: "If the page answers \"host not allowed\" (Vite), add '.ts.net' to server.allowedHosts and restart the dev server.",
  input: { port },
  audiences: ["chat"],
  toolset: "tailnet",
  tier: "act",
  scope: (_args, ctx) => ownChat(ctx.caller, "share_preview"),
  annotations: { ...MUTATING_IDEMPOTENT, openWorldHint: true },
  resultKind: "json",
  async run(args, { api }) {
    const res = await api.request("POST", tailnetRoutes.previews, { body: { port: args.port } });
    if (res.status >= 400) throw refusal(res);
    const { preview } = res.body as TailnetPreviewShareResponse;
    return { url: preview.url, port: args.port, ...(preview.port !== args.port ? { hostPort: preview.port } : {}) };
  }
});

const unsharePreview = defineTool({
  name: "unshare_preview",
  title: "Stop sharing a dev server",
  description: "Stop sharing a port this chat shared with share_preview. Answers the ports this chat still shares.",
  input: { port },
  audiences: ["chat"],
  toolset: "tailnet",
  tier: "act",
  scope: (_args, ctx) => ownChat(ctx.caller, "unshare_preview"),
  annotations: MUTATING,
  resultKind: "json",
  async run(args, { api }) {
    const res = await api.request("DELETE", tailnetRoutes.preview(args.port));
    if (res.status >= 400) throw refusal(res);
    return { shared: (res.body as TailnetPreviewSharesResponse).previews.map((preview) => ({ port: preview.port, url: preview.url })) };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const tailnetFamily: readonly AnyOrquesterTool[] = [sharePreview, unsharePreview];
