/**
 * Grok adapter — the `orquester` session-tool server (design 2026-10-14
 * §1.2–§1.4).
 *
 * - **Transport.** An ACP `McpServer` entry of type `http` on both
 *   `session/new` and `session/load` (`acp/_generated/schema.ts`
 *   `McpServerHttp`; Grok advertises `mcpCapabilities: {http: true}`, fixture
 *   `01-initialize.ndjson`). The credential rides the entry's `headers` — a
 *   protocol frame, never argv or a file; the raw-frame redaction masks every
 *   `headers` value structurally (`acp/redact.ts`). Verified against grok
 *   1.0.46 with an authenticated scratch `GROK_HOME` (initialize →
 *   authenticate → `session/new` → `session/load`, no prompt; report
 *   `task-1-report.md`): it reached the endpoint with exactly this header
 *   (4 of 4 requests), advertised the tools as `orquester__<tool>`, and wrote
 *   the credential to no file of its home. The `GROK_CONFIG_PATH` overlay
 *   cannot carry MCP (`launch.ts`), so the protocol is the only way in.
 * - **Instructions.** `session/new`'s `_meta.rules` — "extra rules appended
 *   to the system prompt" (Grok's own `15-agent-mode.md`, "Session `_meta`
 *   options"). Verified: stored in the session's `system_prompt.txt` and as
 *   its history's `type: "system"` entry, and a `session/load` replays no
 *   frame carrying it. Also sent on `session/load`, where a CLI that keeps the
 *   session's first system prompt may ignore it; the tool descriptions carry
 *   the full guidance either way.
 * - **Approvals.** A `session/request_permission` for one of the REGISTERED
 *   tools is answered `allow_once` without a card (`session.ts`) — by name,
 *   so a user's own server that shares the `orquester` name (the external
 *   `/mcp`, `docs/orquester-mcp.md`) is never waved through.
 */

import { parseSessionToolName, SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import type { McpServer, ToolCallUpdate } from "./acp/_generated/schema.ts";

/** What a Grok session is given when session tools are on. */
export interface GrokSessionToolsLaunch {
  url: string;
  /** `Bearer <credential>`. */
  authorization: string;
  /** The "Orquester" instruction block; "" for none. */
  instructions: string;
  /** The registered tools' bare names: only these are answered without a card. */
  toolNames: ReadonlySet<string>;
}

/** The `mcpServers` list for `session/new` / `session/load`. */
export function grokSessionMcpServers(launch: GrokSessionToolsLaunch | undefined): McpServer[] {
  if (launch === undefined) {
    return [];
  }
  return [
    {
      type: "http",
      name: SESSION_TOOLS_SERVER_NAME,
      url: launch.url,
      headers: [{ name: "Authorization", value: launch.authorization }]
    }
  ];
}

/** `session/new`'s (and `session/load`'s) `_meta` for the instruction block, or undefined. */
export function grokSessionMeta(launch: GrokSessionToolsLaunch | undefined): { rules: string } | undefined {
  return launch !== undefined && launch.instructions.length > 0 ? { rules: launch.instructions } : undefined;
}

/** The fields of `_meta["x.ai/tool"]` this module reads. */
interface VendorTool {
  name?: unknown;
  namespace?: unknown;
}

/**
 * The bare session-tool name a tool call names, or null. Grok names an MCP
 * tool `server__tool` (its `22-permissions-and-safety.md`, "MCP Rules"); the
 * name is read off `_meta["x.ai/tool"]` and, failing that, the title — each
 * only as an exact spelling, never a substring.
 */
export function grokSessionToolName(toolCall: Pick<ToolCallUpdate, "title" | "_meta"> | null | undefined): string | null {
  if (toolCall === null || toolCall === undefined) {
    return null;
  }
  const vendor = (toolCall._meta?.["x.ai/tool"] ?? undefined) as VendorTool | undefined;
  const candidates: unknown[] = [vendor?.name, toolCall.title];
  if (typeof vendor?.namespace === "string" && typeof vendor.name === "string") {
    candidates.push(`${vendor.namespace}__${vendor.name}`);
  }
  for (const candidate of candidates) {
    const name = parseSessionToolName(candidate);
    if (name !== null) return name;
  }
  return null;
}

/** True when a tool call is a session tool's (any name, for the timeline's classification). */
export function isGrokSessionToolCall(toolCall: Pick<ToolCallUpdate, "title" | "_meta"> | null | undefined): boolean {
  return grokSessionToolName(toolCall) !== null;
}
