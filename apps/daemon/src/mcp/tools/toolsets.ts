/**
 * Catalog family `toolsets` (unified MCP design 2026-10-15 §4 row 45, §9.3, §13): `request_toolset`,
 * chat-only, in the locked `core` toolset — the agent-raisable one-click card "Claude asks to enable
 * <toolset> for this chat". Turning a toolset on is the user's act: the tool only asks.
 *
 * - A workflow-owned chat is refused first (`PERMISSION_DENIED`), whatever the toolset (§5.4).
 * - Already on in this chat (`GET agentChatRoutes.agentTools(id)` `resolved`) → `{enabled: true}`
 *   at once, no card (§13). The port answers the same for a toolset it finds on (`approvalId: ""`).
 * - Otherwise the card goes through the executor's port (`ctx.requestToolsetCard`): kind and family
 *   `toolset`, never a grant; the executor refuses a workflow-owned chat (`PERMISSION_DENIED`)
 *   before any card; the port refuses a toolset declined in the last 30 minutes
 *   (`TOOLSET_DECLINED`, with `detail {toolset, declinedUntil}`), a second pending card for the
 *   same toolset, and any card while the master switch is off (`PERMISSION_DENIED`). Approving
 *   persists the chat override and fires `onToolsetsChanged` BEFORE this call resumes.
 * - Results are `RequestToolsetResult` (`@orquester/api`): enabled `available: "now"` — the running
 *   provider session already advertises the chat's toolsets — or `"after-restart"`: the chat's
 *   resolved toolsets differ from what its provider session advertises (`appliesAtNextIdle`), so
 *   the agent ends its turn, the chat transport restarts the session with resume at idle and posts
 *   the automatic continue turn (Task 6, §9.3); not enabled: `declined` (with `declinedUntil` and
 *   the user's words), `timed_out`, `cancelled`.
 *
 * Integration point (chat transport, plan Task 6): `available` reads the chat view's
 * `appliesAtNextIdle` right after the card settles. A provider that re-lists on
 * `notifications/tools/list_changed` gets "now" only when its `onToolsetsChanged` listener — which
 * runs after the override is saved and before this call resumes — has already reported the new set
 * as advertised (`AgentToolsService.setAdvertisedToolsets`); otherwise the call answers
 * "after-restart", and a result reading `available: "after-restart"` is what owes the chat its
 * restart and automatic continue turn. An unreadable view answers "after-restart" (the transport
 * restarts whenever the resolved set differs from the advertised one).
 */

import { z } from "zod";
import {
  TOOL_APPROVAL_REASON_MAX_CHARS,
  TOOLSET_DECLINE_MS,
  TOOLSET_IDS,
  toolsetById,
  type ApprovalPreviewSection,
  type RequestToolsetResult,
  type ThreadAgentToolsResponse,
  type ToolsetId,
  type ToolTier
} from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";

import { closedWorld, defineTool, MUTATING_IDEMPOTENT, type AnyOrquesterTool, type CallContext, type ThreadCaller } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { clipText } from "../result.ts";

export const REQUEST_TOOLSET_TOOL_NAME = "request_toolset";

/** Every toolset an agent can ask for: all but the locked `core`, which is always on. */
export const REQUESTABLE_TOOLSETS = TOOLSET_IDS.filter((id) => !toolsetById(id).locked) as [Exclude<ToolsetId, "core">, ...Exclude<ToolsetId, "core">[]];

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** The tier badge each tool carries on the card. */
const TIER_WORDS: Readonly<Record<ToolTier, string>> = {
  read: "Read: changes nothing",
  act: "Act: changes chats or data you can see, or stops work",
  admin: "Admin: asks you on its own card every time"
};

/** What the agent is told with each result. */
export const REQUEST_TOOLSET_NOTES = {
  now: "The tools are available now: call them in this turn.",
  "after-restart":
    "End your turn now. Orquester restarts this chat's agent session with the new tools (the conversation is kept) and then sends you a message to continue.",
  declined: "The user declined. Don't ask for this toolset again before declinedUntil; carry on without it or say in your reply what it blocks.",
  timed_out: "Nobody answered the card in time; nothing changed. Ask again only if the user still wants it.",
  cancelled: "The request ended before the user answered (the turn was stopped or the chat closed); nothing changed."
} as const;

/** The card's content: the toolset, its tools with their tiers (§7.1 "toolset card"). */
export function toolsetCardSections(toolset: ToolsetId): ApprovalPreviewSection[] {
  const spec = toolsetById(toolset);
  return [
    {
      kind: "fields",
      title: `${spec.label}: ${spec.tools.length} ${spec.tools.length === 1 ? "tool" : "tools"}`,
      rows: spec.tools.map((tool) => ({ label: tool.name, value: TIER_WORDS[tool.tier] }))
    },
    {
      kind: "text",
      text: "Turns these tools on for this chat only; Settings › Agent tools keeps the defaults. Changes that need your approval still ask you on their own card."
    }
  ];
}

/** This chat's toolsets as the Tools chip reads them; null when the view cannot be read. */
async function threadView(ctx: CallContext, threadId: string): Promise<ThreadAgentToolsResponse | null> {
  try {
    const response = await ctx.api.request("GET", agentChatRoutes.agentTools(threadId));
    if (response.status >= 400 || response.body === null || typeof response.body !== "object") return null;
    const body = response.body as Partial<ThreadAgentToolsResponse>;
    return Array.isArray(body.resolved) && typeof body.appliesAtNextIdle === "boolean" ? (body as ThreadAgentToolsResponse) : null;
  } catch {
    return null;
  }
}

/** Enabled: "now" only when the running provider session already advertises this chat's toolsets. */
function enabled(toolset: ToolsetId, view: ThreadAgentToolsResponse | null): RequestToolsetResult & { note: string } {
  const available = view !== null && view.resolved.includes(toolset) && !view.appliesAtNextIdle ? "now" : "after-restart";
  return { enabled: true, toolset, available, note: REQUEST_TOOLSET_NOTES[available] };
}

export const toolsetsFamily: readonly AnyOrquesterTool[] = [
  defineTool({
    name: REQUEST_TOOLSET_TOOL_NAME,
    title: "Request a toolset",
    description:
      'Ask the user to turn on a toolset that is off in this chat: they get a one-click card with its tools and your reason. Result: enabled with available "now" (use the tools in this turn) or "after-restart" (end your turn; Orquester resumes you with them), or declined (don\'t ask again for 30 min), timed_out, cancelled.',
    input: {
      toolset: z.enum(REQUESTABLE_TOOLSETS).describe("A toolset that is off here."),
      reason: z.string().trim().min(1).max(TOOL_APPROVAL_REASON_MAX_CHARS).describe("Why the task needs it; shown on the card.")
    },
    audiences: ["chat"],
    toolset: "core",
    tier: "act",
    // Allowed in every permission mode and while planning: the card is the user's act (§9.3).
    planSafe: true,
    scope: async (_args, ctx) => ({
      projects: [],
      sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [],
      self: "allow",
      reads: "none",
      writes: true,
      causesTurnIn: []
    }),
    annotations: closedWorld(MUTATING_IDEMPOTENT),
    resultKind: "json",
    run: async (args, ctx) => {
      const caller: ThreadCaller | null = ctx.caller.kind === "thread" ? ctx.caller : null;
      if (caller === null) throw new ToolError("TOOL_NOT_FOUND", `${REQUEST_TOOLSET_TOOL_NAME} is a chat tool.`);
      const toolset: ToolsetId = args.toolset;

      // A workflow-owned chat never raises a toolset card, and is told so even for a toolset already on (§5.4).
      if (caller.workflowOwned) {
        throw new ToolError("PERMISSION_DENIED", "This chat runs inside an automated workflow, where nobody can approve a toolset.");
      }
      // Already on: nothing to ask (§13).
      const before = await threadView(ctx, caller.threadId);
      if (before?.resolved.includes(toolset)) return enabled(toolset, before);

      if (!ctx.requestToolsetCard) throw new ToolError("PERMISSION_DENIED", "Toolset cards are not available here.");
      const agent = AGENT_LABELS[caller.agentId] ?? caller.agentId;
      const outcome = await ctx.requestToolsetCard({
        toolset,
        title: `${agent} asks to enable ${toolsetById(toolset).label} for this chat`,
        sections: toolsetCardSections(toolset),
        reason: args.reason
      });
      switch (outcome.outcome) {
        case "approved":
          // The override is saved and the transport's listener has run (it runs before this resumes).
          return enabled(toolset, await threadView(ctx, caller.threadId));
        case "denied": {
          const after = await threadView(ctx, caller.threadId);
          const declinedUntil = after?.declines[toolset] ?? new Date(ctx.now() + TOOLSET_DECLINE_MS).toISOString();
          const reason = outcome.reason?.trim() ? clipText(outcome.reason.trim(), 500) : undefined;
          const result: RequestToolsetResult & { note: string } = {
            enabled: false,
            toolset,
            outcome: "declined",
            declinedUntil,
            ...(reason ? { reason } : {}),
            note: REQUEST_TOOLSET_NOTES.declined
          };
          return result;
        }
        case "timed_out":
          return { enabled: false, toolset, outcome: "timed_out", note: REQUEST_TOOLSET_NOTES.timed_out } satisfies RequestToolsetResult & { note: string };
        case "cancelled":
          return { enabled: false, toolset, outcome: "cancelled", note: REQUEST_TOOLSET_NOTES.cancelled } satisfies RequestToolsetResult & { note: string };
      }
    }
  })
];
