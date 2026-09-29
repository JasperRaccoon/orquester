/**
 * Claude adapter — projecting the native transcript into §4.2 events.
 *
 * A resume replays **nothing** onto the message stream: the model answers from
 * the loaded history, but not one `user` or `assistant` frame crosses
 * `query()` first (fixtures/claude README observation 8, `replayUuids: []`).
 * So a resumed thread's timeline is rebuilt from the provider's own transcript
 * — read out-of-band by the history worker — rather than from the stream.
 *
 * Pure and synchronous: the reading already happened in `readThread`. Every
 * event carries `raw.source = HISTORICAL_RAW_SOURCE`, because a consumer must
 * be able to tell "this already happened" from a live frame.
 *
 * The shapes accepted are the two this adapter produces:
 * - a live turn's item — a bare message body, `{role, content}`; and
 * - a native transcript row — `{type, uuid, message}` as `getSessionMessages`
 *   returns it.
 */

import type {
  CanonicalItemType,
  ItemLifecyclePayload,
  RuntimeEvent,
  RuntimeEventRaw,
  ThreadSnapshot
} from "@orquester/api/agent-chat";
import { HISTORICAL_RAW_SOURCE } from "@orquester/api/agent-chat";

import type { Clock, IdGen } from "../../adapter.ts";
import { isAttachmentPathBlock, stripAttachmentPathLines } from "../attachment-lines.ts";
import {
  classifyToolItemType,
  cliDenialReason,
  extractTextContent,
  isCliDenialResult,
  summarizeToolRequest,
  titleForTool,
  trimmedString
} from "./classify.ts";
import { WORKFLOW_HISTORY_ITEM_TYPE, type WorkflowHistoryRun } from "./workflow-history.ts";
import { WORKFLOW_MEMBER_TASK_TYPE, WORKFLOW_TASK_TYPE, workflowMemberTaskId } from "./workflow.ts";

/** Keeps one historical row's `detail` to a sane size for a timeline row. */
const MAX_DETAIL_CHARS = 400;

export interface ProjectHistoryDeps {
  clock: Clock;
  ids: IdGen;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: unknown;
  model?: unknown;
}

interface PendingToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Read either accepted item shape into `{role, content}`. Anything else — a
 * `system` transcript row, a malformed entry — yields `undefined` and is
 * skipped rather than guessed at.
 */
function readHistoryMessage(item: unknown): HistoryMessage | undefined {
  if (item === null || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  // A native transcript row wraps the body and names its own type.
  const wrapped =
    record.message !== null && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : undefined;
  const body = wrapped ?? record;
  const declared = typeof record.type === "string" ? record.type : undefined;
  const role =
    declared === "user" || declared === "assistant"
      ? declared
      : body.role === "user" || body.role === "assistant"
        ? body.role
        : undefined;
  if (role === undefined) {
    return undefined;
  }
  return {
    role,
    content: body.content,
    ...(body.model !== undefined ? { model: body.model } : {})
  };
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  // `content` is sometimes a plain string, not a block array — post
  // compaction, i.e. on a long thread (fixtures README observation 7).
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object"
  );
}

/**
 * The summary text of a transcript row the CLI marked `isCompactSummary`, or
 * `undefined` for every other row. The flag lives on the ROW, not inside
 * `message` — it is the transcript's own bookkeeping, and it is the only
 * marker a compaction leaves behind in native history (the boundary message
 * is not a conversation row and `groupClaudeHistoryTurns` drops it).
 */
function compactSummaryText(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") {
    return undefined;
  }
  const record = item as { isCompactSummary?: unknown; message?: unknown };
  if (record.isCompactSummary !== true) {
    return undefined;
  }
  const body = record.message;
  const content = body !== null && typeof body === "object"
    ? (body as { content?: unknown }).content
    : undefined;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  // A block array is not the shape this CLI writes, but a summary is too
  // important to drop over a shape change: take its text.
  const text = extractTextContent(content);
  return text.trim().length > 0 ? text : undefined;
}

function elide(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…` : flat;
}

/**
 * Whether a user text block holds any of the user's own text: not blank, and
 * not exactly the `Attached files:` block (`isAttachmentPathBlock`). Trimmed
 * first, so a block behind leading whitespace is still the block and not the
 * user's text.
 */
function carriesUserText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !isAttachmentPathBlock(t);
}

function isWorkflowHistoryRun(item: unknown): item is WorkflowHistoryRun {
  return (
    item !== null &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === WORKFLOW_HISTORY_ITEM_TYPE
  );
}

/**
 * Project one snapshot. One `turn.started` / `turn.completed` pair per turn,
 * and one `item.completed` per message, reasoning block and tool call.
 */
export function projectClaudeHistory(
  snapshot: ThreadSnapshot,
  deps: ProjectHistoryDeps
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];

  for (const turn of snapshot.turns) {
    const raw = (payload: unknown): RuntimeEventRaw => ({
      source: HISTORICAL_RAW_SOURCE,
      method: "claude/history",
      payload
    });
    const base = (extra?: { itemId?: string; providerItemId?: string; agentId?: string }) => ({
      eventId: deps.ids.eventId(),
      threadId: snapshot.threadId,
      createdAt: deps.clock.nowIso(),
      turnId: turn.id,
      ...(extra?.itemId !== undefined ? { itemId: extra.itemId } : {}),
      ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
      ...(extra?.providerItemId !== undefined
        ? { providerRefs: { providerItemId: extra.providerItemId } }
        : {})
    });

    const turnEvents: RuntimeEvent[] = [];
    let model: string | undefined;
    let hasSubagents = false;

    /**
     * One `Workflow` run the history reader found beside the transcript
     * (`workflow-history.ts`): its coordinator and member rows, each member's
     * conversation owned by it, and every end — the run is long over.
     */
    const projectWorkflowRun = (run: WorkflowHistoryRun): void => {
      hasSubagents = true;
      const coordinator = {
        taskType: WORKFLOW_TASK_TYPE,
        toolUseId: run.toolUseId,
        ...(run.description !== undefined ? { title: run.description } : {}),
        ...(run.workflowName !== undefined ? { workflowName: run.workflowName } : {}),
        ...(run.phases.length > 0 ? { phases: run.phases } : {}),
        runHandles: run.runHandles
      };
      turnEvents.push({
        ...base(),
        type: "task.started",
        payload: {
          taskId: run.taskId,
          ...(run.description !== undefined ? { description: run.description } : {}),
          ...(run.script !== undefined ? { prompt: run.script } : {}),
          ...coordinator
        },
        raw: raw({ taskId: run.taskId })
      });
      for (const agent of run.agents) {
        const taskId = workflowMemberTaskId(run.taskId, agent.index);
        const linkage = {
          taskType: WORKFLOW_MEMBER_TASK_TYPE,
          title: agent.label,
          parentAgentId: run.taskId,
          agentIndex: agent.index,
          ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
          ...(agent.phaseTitle !== undefined ? { phaseTitle: agent.phaseTitle } : {}),
          ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          timelineBypass: true
        };
        turnEvents.push({
          ...base(),
          type: "task.started",
          payload: {
            taskId,
            description: agent.label,
            ...(agent.prompt !== undefined ? { prompt: agent.prompt } : {}),
            ...linkage
          },
          raw: raw({ taskId })
        });
        projectItems(agent.records, taskId);
        const summary = agent.status === "completed" ? agent.result : agent.error;
        turnEvents.push({
          ...base(),
          type: "task.completed",
          payload: {
            taskId,
            status:
              agent.status === "completed" ? "completed" : agent.status === "failed" ? "failed" : "stopped",
            ...(summary !== undefined ? { summary } : {}),
            ...(agent.tokens !== undefined
              ? {
                  usage: {
                    totalTokens: agent.tokens,
                    ...(agent.toolCalls !== undefined ? { toolUses: agent.toolCalls } : {}),
                    ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {})
                  }
                }
              : {}),
            ...linkage
          },
          raw: raw({ taskId })
        });
      }
      turnEvents.push({
        ...base(),
        type: "task.completed",
        payload: {
          taskId: run.taskId,
          status: run.status,
          ...(run.tokens !== undefined
            ? {
                usage: {
                  totalTokens: run.tokens,
                  ...(run.toolCalls !== undefined ? { toolUses: run.toolCalls } : {}),
                  ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {})
                }
              }
            : {}),
          ...coordinator
        },
        raw: raw({ taskId: run.taskId })
      });
    };

    /**
     * Project a run of transcript rows: the turn's own, or — with `agentId` —
     * a workflow agent's, every item owned by it. An agent's `user` text is
     * its task, which its `task.started` already carries.
     */
    const projectItems = (items: readonly unknown[], agentId?: string): void => {
      const owned = agentId !== undefined ? { agentId } : {};
      // A tool call spans two items — the assistant's `tool_use` and the user's
      // `tool_result` — so the first is held until its result is seen.
      const pendingTools = new Map<string, PendingToolUse>();

      for (const item of items) {
        if (agentId === undefined && isWorkflowHistoryRun(item)) {
          projectWorkflowRun(item);
          continue;
        }
        // A compaction summary is not a prompt. The CLI marks its own row
        // `isCompactSummary` and gives it the shape of a user message, so the
        // projection used to replay an 18 KB "user message" nobody typed, at
        // the top of the resumed thread. It is the same marker the live stream
        // produces from `compact_boundary` + the synthetic frame — here the
        // boundary is long gone, so the summary alone carries it.
        const summary = compactSummaryText(item);
        if (summary !== undefined) {
          turnEvents.push({
            ...base(),
            type: "thread.state.changed",
            payload: { state: "compacted", summary },
            raw: raw(item)
          });
          continue;
        }
        const message = readHistoryMessage(item);
        if (message === undefined) {
          continue;
        }
        if (agentId === undefined) {
          model ??= trimmedString(message.model);
        }
        const blocks = contentBlocks(message.content);
        // A skill dispatch with attachments and no prose sends the block as a
        // text block of its OWN, ahead of the command block (`buildUserMessage`,
        // §4.5). Per block it is a whole message and the strip keeps it; per
        // message it is provider input beside the user's text, and ingestion
        // keeps one user message per turn — so the block was the bubble and the
        // `/command` the user typed never showed. It is dropped exactly when
        // another text block of the same message carries text; alone, it stays
        // as the turn's only evidence.
        const dropBlockOnlyText =
          message.role === "user" &&
          blocks.some(
            (block) =>
              block.type === "text" && typeof block.text === "string" && carriesUserText(block.text)
          );

        for (const block of blocks) {
          const type = typeof block.type === "string" ? block.type : "";

          if (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") {
            const id = trimmedString(block.id);
            const name = trimmedString(block.name);
            if (id === undefined || name === undefined) {
              continue;
            }
            pendingTools.set(id, {
              id,
              name,
              input:
                block.input !== null && typeof block.input === "object"
                  ? (block.input as Record<string, unknown>)
                  : {}
            });
            continue;
          }

          if (type === "tool_result") {
            const toolUseId = trimmedString(block.tool_use_id);
            if (toolUseId === undefined) {
              continue;
            }
            const pending = pendingTools.get(toolUseId);
            pendingTools.delete(toolUseId);
            const text = extractTextContent(block.content);
            const isError = block.is_error === true;
            const declined = isCliDenialResult(isError, text);
            const itemType: CanonicalItemType =
              pending === undefined
                ? "dynamic_tool_call"
                : classifyToolItemType(pending.name, pending.input);
            const detail =
              pending === undefined
                ? elide(text)
                : summarizeToolRequest(pending.name, pending.input);
            const payload: ItemLifecyclePayload = {
              itemType,
              status: declined ? "declined" : isError ? "failed" : "completed",
              title: titleForTool(itemType),
              ...(detail.length > 0 ? { detail } : {}),
              ...owned,
              data: {
                // The tool-use id is the stable handle across a call's lifecycle,
                // and it is this item's id.
                toolUseId,
                ...(pending !== undefined
                  ? { toolName: pending.name, input: pending.input }
                  : {}),
                result: block,
                ...(declined ? { deniedReason: cliDenialReason(text) } : {})
              }
            };
            turnEvents.push({
              ...base({ itemId: toolUseId, providerItemId: toolUseId, ...owned }),
              type: "item.completed",
              payload,
              raw: raw(block)
            });
            continue;
          }

          if (type === "thinking" || type === "redacted_thinking") {
            // Claude never returns the raw chain of thought; what a transcript
            // holds is the summary, so it maps to the same reasoning row the
            // live `reasoning_summary_text` deltas build.
            const text =
              typeof block.thinking === "string"
                ? block.thinking
                : extractTextContent(block.content);
            if (text.trim().length === 0) {
              continue;
            }
            const itemId = deps.ids.messageId("msg");
            turnEvents.push({
              ...base({ itemId, ...owned }),
              type: "content.delta",
              payload: { streamKind: "reasoning_summary_text", delta: text },
              raw: raw(block)
            });
            turnEvents.push({
              ...base({ itemId, ...owned }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                detail: elide(text),
                ...owned,
                data: { text }
              },
              raw: raw(block)
            });
            continue;
          }

          if (type === "text") {
            const text = typeof block.text === "string" ? block.text : "";
            if (text.trim().length === 0) {
              continue;
            }
            if (dropBlockOnlyText && isAttachmentPathBlock(text)) {
              continue;
            }
            if (agentId !== undefined && message.role === "user") {
              continue;
            }
            // A prompt block is the text the adapter SENT, with any
            // `Attached files:` block it appended (`attachment-lines.ts`):
            // provider input, not the user's own text. The agent's text was
            // never the adapter's and stays as it is.
            const shown = message.role === "user" ? stripAttachmentPathLines(text) : text;
            const itemId = deps.ids.messageId("msg");
            if (message.role === "assistant") {
              // The same shape the live path produces, so a consumer that
              // assembles assistant text from deltas sees it either way.
              turnEvents.push({
                ...base({ itemId, ...owned }),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: text },
                raw: raw(block)
              });
            }
            turnEvents.push({
              ...base({ itemId, ...owned }),
              type: "item.completed",
              payload: {
                itemType: message.role === "user" ? "user_message" : "assistant_message",
                status: "completed",
                detail: elide(shown),
                ...owned,
                data: { text: shown }
              },
              raw: raw(block)
            });
          }
        }
      }

      // A tool call whose result is not in the transcript (the turn was
      // interrupted, or the result aged out) is closed `failed` rather than left
      // spinning — a historical row must never look live.
      for (const pending of pendingTools.values()) {
        const itemType = classifyToolItemType(pending.name, pending.input);
        turnEvents.push({
          ...base({ itemId: pending.id, providerItemId: pending.id, ...owned }),
          type: "item.completed",
          payload: {
            itemType,
            status: "failed",
            title: titleForTool(itemType),
            detail: summarizeToolRequest(pending.name, pending.input),
            ...owned,
            data: { toolUseId: pending.id, toolName: pending.name, input: pending.input }
          },
          raw: raw(pending)
        });
      }
    };

    projectItems(turn.items);

    if (turnEvents.length === 0) {
      // Nothing projectable in this turn: no empty turn shell either.
      continue;
    }

    events.push({
      ...base(),
      type: "turn.started",
      payload: { ...(model !== undefined ? { model } : {}) },
      raw: raw({ turnId: turn.id })
    });
    events.push(...turnEvents);
    events.push({
      ...base(),
      type: "turn.completed",
      payload: {
        state: "completed",
        // A transcript carries no per-turn totals, and inventing them would
        // corrupt the cost line.
        tokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents }
      },
      raw: raw({ turnId: turn.id })
    });
  }

  return events;
}
