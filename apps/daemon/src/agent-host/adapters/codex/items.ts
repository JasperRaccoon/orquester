/**
 * Codex adapter — `ThreadItem` → `item.*` classification (spec §4.2).
 *
 * T3 classifies on a **substring heuristic over a de-camel-cased type name**
 * (`apps/server/src/provider/Layers/CodexAdapter.ts:633-663`). This file
 * deliberately does not copy that: the generated bindings give us a closed
 * discriminant union, so the switch below ends in `satisfies never` and a
 * protocol release that adds an item type is a **typecheck error** rather than
 * a row silently landing in the wrong bucket (brief, W7).
 *
 * The one thing the heuristic had going for it — never failing at runtime — is
 * preserved by `classifyItem` answering `unknown` plus a warning for a type
 * string this build does not know, so an older host still renders a newer CLI.
 */

import type { CanonicalItemType, RuntimeItemStatus } from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";

export type CodexThreadItem = CodexProtocol.v2.ThreadItem;
export type CodexItemType = CodexThreadItem["type"];

export interface ClassifiedItem {
  itemType: CanonicalItemType;
  status?: RuntimeItemStatus;
  title?: string;
  detail?: string;
  /** The slimmed provider payload put on `item.*`'s `data`. */
  data?: unknown;
  /**
   * True when the item must not become a timeline row of its own: it is the
   * message/reasoning/plan stream, already carried by `content.delta` and the
   * message path, or a review marker that nothing renders (§4.2).
   */
  timelineBypass: boolean;
  /** Set when the type string is not in this build's catalogue (§10). */
  unknownType?: string;
}

/** Item `type` strings this build knows, derived from the generated union. */
const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set<CodexItemType>([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
]);

export function isKnownCodexItemType(type: string): type is CodexItemType {
  return KNOWN_ITEM_TYPES.has(type);
}

/**
 * Classify one item. `phase` handling matters: an `agentMessage` whose phase
 * is `commentary` is the running "I'll do X next" narration, not the answer
 * (fixtures README observation 18), and §7.3 renders it as an activity row —
 * so it is reported as `assistant_message` with the phase in `data.phase`,
 * which is where ingestion reads it (`assistantPhase`, `ingestion/index.ts`).
 * `detail` mirrors it (`detail: "commentary"`) and is dropped as a marker only
 * because it equals `data.phase`. The message text is not forwarded: it is
 * built from `item/agentMessage/delta`. Were `item.text` ever forwarded, it
 * would belong in `data.text`, which ingestion always reads as text.
 */
export function classifyItem(item: CodexThreadItem): ClassifiedItem {
  switch (item.type) {
    case "userMessage":
      return { itemType: "user_message", timelineBypass: true };

    case "hookPrompt":
      // A hook's injected prompt fragment — provider bookkeeping, never a row.
      return { itemType: "unknown", timelineBypass: true };

    case "agentMessage":
      return {
        itemType: "assistant_message",
        timelineBypass: true,
        ...(item.phase !== null ? { detail: item.phase } : {}),
        data: {
          phase: item.phase,
          delivery: item.delivery,
          questions: item.questions
        }
      };

    case "functionCallOutput":
      return {
        itemType: "dynamic_tool_call",
        title: item.name,
        timelineBypass: false,
        data: { name: item.name, namespace: item.namespace }
      };

    case "plan":
      return { itemType: "plan", timelineBypass: true, data: { text: item.text } };

    case "reasoning":
      // Observed with EMPTY summary and content on this CLI even with
      // `-c model_reasoning_summary=detailed`: a reasoning row must tolerate
      // having no text ever (fixtures README observation 18).
      return { itemType: "reasoning", timelineBypass: true };

    case "commandExecution":
      return {
        itemType: "command_execution",
        status: commandStatus(item.status),
        title: item.command,
        ...(item.aggregatedOutput !== null ? { detail: item.aggregatedOutput } : {}),
        timelineBypass: false,
        data: {
          command: item.command,
          cwd: item.cwd,
          source: item.source,
          commandActions: item.commandActions,
          exitCode: item.exitCode,
          durationMs: item.durationMs
        }
      };

    case "fileChange":
      return {
        itemType: "file_change",
        status: patchStatus(item.status),
        title: fileChangeTitle(item.changes),
        timelineBypass: false,
        data: { changes: item.changes }
      };

    case "mcpToolCall":
      return {
        itemType: "mcp_tool_call",
        status: mcpStatus(item.status),
        title: `${item.server}: ${item.tool}`,
        ...(item.error !== null ? { detail: item.error.message } : {}),
        timelineBypass: false,
        data: {
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          readOnlyHint: item.readOnlyHint,
          durationMs: item.durationMs
        }
      };

    case "dynamicToolCall":
      return {
        itemType: "dynamic_tool_call",
        status: dynamicStatus(item.status),
        title: item.namespace !== null ? `${item.namespace}: ${item.tool}` : item.tool,
        timelineBypass: false,
        data: { tool: item.tool, namespace: item.namespace, arguments: item.arguments }
      };

    case "collabAgentToolCall":
      return {
        itemType: "collab_agent_tool_call",
        status: collabStatus(item.status),
        title: item.tool,
        ...(item.prompt !== null ? { detail: item.prompt } : {}),
        timelineBypass: false,
        data: {
          tool: item.tool,
          senderThreadId: item.senderThreadId,
          receiverThreadIds: item.receiverThreadIds,
          model: item.model,
          reasoningEffort: item.reasoningEffort
        }
      };

    case "subAgentActivity":
      // Codex emits `subAgentActivity {agentPath:"/root"}` ABOUT THE ROOT
      // THREAD; registering that as its own child made threads hang "working"
      // forever (§4.5 "Trap"). It is a task signal, never a timeline row.
      return {
        itemType: "unknown",
        timelineBypass: true,
        data: {
          kind: item.kind,
          agentThreadId: item.agentThreadId,
          agentPath: item.agentPath
        }
      };

    case "webSearch":
      return {
        itemType: "web_search",
        title: item.query,
        timelineBypass: false,
        data: { query: item.query, action: item.action }
      };

    case "imageView":
      return {
        itemType: "image_view",
        title: item.path,
        timelineBypass: false,
        data: { path: item.path }
      };

    case "sleep":
      return {
        itemType: "unknown",
        title: `sleep ${item.durationMs}ms`,
        timelineBypass: true,
        data: { durationMs: item.durationMs }
      };

    case "imageGeneration":
      return {
        itemType: "unknown",
        timelineBypass: true,
        ...(item.revisedPrompt !== null ? { title: item.revisedPrompt } : {}),
        data: { status: item.status }
      };

    case "enteredReviewMode":
      // Classified and then dropped: the two review types stay in the closed
      // enum exactly as in T3, but nothing starts a review here (§4.2, §2).
      return { itemType: "review_entered", timelineBypass: true };

    case "exitedReviewMode":
      return { itemType: "review_exited", timelineBypass: true };

    case "contextCompaction":
      // The ONLY signal that compaction happened: `thread/compacted` never
      // fires on this CLI (fixtures README observation 8).
      return { itemType: "context_compaction", timelineBypass: true };

    default: {
      // `satisfies never` proves the 19 generated arms are all handled; a new
      // item type in a newer protocol is a TYPE ERROR here rather than a row
      // silently landing in the wrong bucket (§4.2).
      item satisfies never;
      const type = (item as { type?: unknown }).type;
      return {
        itemType: "unknown",
        timelineBypass: false,
        unknownType: typeof type === "string" ? type : "(no type)"
      };
    }
  }
}

function fileChangeTitle(changes: readonly CodexProtocol.v2.FileUpdateChange[]): string {
  if (changes.length === 0) {
    return "file change";
  }
  if (changes.length === 1) {
    return changes[0]!.path;
  }
  return `${changes[0]!.path} +${changes.length - 1} more`;
}

function commandStatus(status: CodexProtocol.v2.CommandExecutionStatus): RuntimeItemStatus {
  return status;
}

function patchStatus(status: CodexProtocol.v2.PatchApplyStatus): RuntimeItemStatus {
  return status;
}

function mcpStatus(status: CodexProtocol.v2.McpToolCallStatus): RuntimeItemStatus {
  return status;
}

function dynamicStatus(status: CodexProtocol.v2.DynamicToolCallStatus): RuntimeItemStatus {
  return status;
}

/** `interrupted` has no `RuntimeItemStatus` equivalent; it settles as `failed`. */
function collabStatus(status: CodexProtocol.v2.CollabAgentToolCallStatus): RuntimeItemStatus {
  return status === "interrupted" ? "failed" : status;
}
