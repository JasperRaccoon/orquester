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
import {
  classifyToolItemType,
  cliDenialReason,
  extractTextContent,
  isCliDenialResult,
  summarizeToolRequest,
  titleForTool,
  trimmedString
} from "./classify.ts";

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
export function readHistoryMessage(item: unknown): HistoryMessage | undefined {
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
export function compactSummaryText(item: unknown): string | undefined {
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
    const base = (extra?: { itemId?: string; providerItemId?: string }) => ({
      eventId: deps.ids.eventId(),
      threadId: snapshot.threadId,
      createdAt: deps.clock.nowIso(),
      turnId: turn.id,
      ...(extra?.itemId !== undefined ? { itemId: extra.itemId } : {}),
      ...(extra?.providerItemId !== undefined
        ? { providerRefs: { providerItemId: extra.providerItemId } }
        : {})
    });

    // A tool call spans two items — the assistant's `tool_use` and the user's
    // `tool_result` — so the first is held until its result is seen.
    const pendingTools = new Map<string, PendingToolUse>();
    const turnEvents: RuntimeEvent[] = [];
    let model: string | undefined;

    for (const item of turn.items) {
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
      model ??= trimmedString(message.model);
      const blocks = contentBlocks(message.content);

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
            ...base({ itemId: toolUseId, providerItemId: toolUseId }),
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
            ...base({ itemId }),
            type: "content.delta",
            payload: { streamKind: "reasoning_summary_text", delta: text },
            raw: raw(block)
          });
          turnEvents.push({
            ...base({ itemId }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              detail: elide(text),
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
          const itemId = deps.ids.messageId("msg");
          if (message.role === "assistant") {
            // The same shape the live path produces, so a consumer that
            // assembles assistant text from deltas sees it either way.
            turnEvents.push({
              ...base({ itemId }),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: text },
              raw: raw(block)
            });
          }
          turnEvents.push({
            ...base({ itemId }),
            type: "item.completed",
            payload: {
              itemType: message.role === "user" ? "user_message" : "assistant_message",
              status: "completed",
              detail: elide(text),
              data: { text }
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
        ...base({ itemId: pending.id, providerItemId: pending.id }),
        type: "item.completed",
        payload: {
          itemType,
          status: "failed",
          title: titleForTool(itemType),
          detail: summarizeToolRequest(pending.name, pending.input),
          data: { toolUseId: pending.id, toolName: pending.name, input: pending.input }
        },
        raw: raw(pending)
      });
    }

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
        tokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false }
      },
      raw: raw({ turnId: turn.id })
    });
  }

  return events;
}
