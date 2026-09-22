/**
 * Agent host — replaying an OpenCode conversation that this host never saw
 * (E6, `AgentAdapter.projectHistory`).
 *
 * A thread adopted from a `ses_…` the daemon did not drive has no
 * `events.ndjson` behind it: the transcript lives only in OpenCode's own
 * store. `GET /session/:id/message` is that store, and `readThread` already
 * reads it, so this turns that snapshot into the same `RuntimeEvent` union a
 * live turn produces — the timeline then folds history and live traffic
 * through one path.
 *
 * **Pure and synchronous.** No HTTP, no clock, no ids beyond the ones the
 * caller supplies, which is what lets `history.test.ts` drive it straight from
 * the committed capture.
 *
 * Three things it deliberately does NOT do:
 * - **No usage.** Every replayed turn carries
 *   `tokenUsage {usageStatus: "unavailable"}`. The `step-finish` parts do hold
 *   token counts, but attributing them to a turn needs the live ownership
 *   bookkeeping of `state.ts` (which assistant message belongs to which
 *   prompt); inventing a number here would put a wrong cost in the UI.
 * - **No requests.** An approval answered days ago is not actionable, and
 *   replaying `request.opened` would re-open a card nothing can resolve.
 * - **No deltas.** History is complete text; it arrives as finished
 *   `item.completed` rows rather than a stream of `content.delta`.
 */

import { HISTORICAL_RAW_SOURCE } from "@orquester/api/agent-chat";
import type {
  CanonicalItemType,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeEventRawSource,
  RuntimeItemStatus,
  ThreadSnapshot,
  TurnTokenUsage
} from "@orquester/api/agent-chat";

import { toToolLifecycleItemType } from "./normalize.ts";
import { isRecord, type OpenCodeMessageInfo, type OpenCodePart } from "./protocol.ts";

/**
 * The `raw.source` every replayed event carries, so a consumer can tell a
 * reconstructed row from one this host actually observed.
 *
 * Taken from the shared `HISTORICAL_RAW_SOURCE` (§4.2) rather than spelled
 * again here: the host tests that literal to decide what must not raise
 * attention, fire a push or move a live turn, so a second spelling would
 * silently make every replayed row look live.
 */
export const OPENCODE_HISTORY_SOURCE: RuntimeEventRawSource = HISTORICAL_RAW_SOURCE;

/** Replayed turns produce no usable per-turn usage — see the module header. */
const UNAVAILABLE_USAGE: TurnTokenUsage = {
  usageStatus: "unavailable",
  usageScope: "main_agent",
  hasSubagents: false
};

export interface ProjectHistoryContext {
  eventId: () => string;
  /** Fallback stamp for an item whose own `time` the provider did not record. */
  nowIso: () => string;
}

function isMessageInfo(value: unknown): value is OpenCodeMessageInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant")
  );
}

function isPart(value: unknown): value is OpenCodePart {
  return (
    isRecord(value) && typeof value.type === "string" && typeof value.messageID === "string"
  );
}

function isoFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The best timestamp a message carries: when it completed, else when created. */
function messageTime(info: OpenCodeMessageInfo): string | undefined {
  return isoFromEpochMs(info.time?.completed) ?? isoFromEpochMs(info.time?.created);
}

function partTime(part: OpenCodePart): string | undefined {
  const record = part as unknown as Record<string, unknown>;
  const time = record.time;
  if (isRecord(time)) {
    return isoFromEpochMs(time.end) ?? isoFromEpochMs(time.start);
  }
  const state = record.state;
  if (isRecord(state) && isRecord(state.time)) {
    return isoFromEpochMs(state.time.end) ?? isoFromEpochMs(state.time.start);
  }
  return undefined;
}

/**
 * `ThreadSnapshot` → the events a live turn would have produced.
 *
 * `items` is `unknown[]` by contract (§4.1, "opaque provider items"), so this
 * is the only place that knows the snapshot's OpenCode shape:
 * `[userInfo?, assistantInfo, ...parts]`, which is what `readThread` packs.
 */
export function projectOpenCodeHistory(
  snapshot: ThreadSnapshot,
  ctx: ProjectHistoryContext
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const seenTurnIds = new Set<string>();

  for (const turn of snapshot.turns) {
    if (typeof turn.id !== "string" || turn.id.length === 0 || seenTurnIds.has(turn.id)) {
      continue;
    }
    seenTurnIds.add(turn.id);

    const infos = turn.items.filter(isMessageInfo);
    const parts = turn.items.filter(isPart);
    // A turn with nothing in it is not worth a pair of markers.
    if (infos.length === 0 && parts.length === 0) {
      continue;
    }

    const assistant = infos.find((info) => info.role === "assistant");
    const model = assistant === undefined ? undefined : modelSlugOf(assistant);
    const startedAt =
      (infos[0] === undefined ? undefined : messageTime(infos[0])) ?? ctx.nowIso();

    const base = (input: {
      itemId?: string;
      createdAt?: string;
      payload: unknown;
    }): RuntimeEventBase => ({
      eventId: ctx.eventId(),
      threadId: snapshot.threadId,
      createdAt: input.createdAt ?? startedAt,
      turnId: turn.id,
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      providerRefs: { providerTurnId: turn.id },
      raw: { source: OPENCODE_HISTORY_SOURCE, payload: input.payload }
    });

    events.push({
      ...base({ payload: assistant ?? infos[0] ?? null }),
      type: "turn.started",
      payload: { ...(model !== undefined ? { model } : {}) }
    });

    const roleById = new Map(infos.map((info) => [info.id, info.role] as const));
    for (const part of parts) {
      const event = projectPart(part, roleById.get(part.messageID), base);
      if (event !== null) {
        events.push(event);
      }
    }

    events.push({
      ...base({
        createdAt: assistant === undefined ? startedAt : (messageTime(assistant) ?? startedAt),
        payload: assistant ?? null
      }),
      type: "turn.completed",
      payload: {
        // History is, by definition, over. `interrupted` would be a guess and
        // would colour a settled row red for no reason.
        state: "completed",
        tokenUsage: UNAVAILABLE_USAGE
      }
    });
  }

  return events;
}

function modelSlugOf(info: OpenCodeMessageInfo): string | undefined {
  const record = info as unknown as Record<string, unknown>;
  const providerID = record.providerID;
  const modelID = record.modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    return `${providerID}/${modelID}`;
  }
  const model = record.model;
  if (isRecord(model) && typeof model.providerID === "string" && typeof model.modelID === "string") {
    return `${model.providerID}/${model.modelID}`;
  }
  return undefined;
}

/** One part → at most one `item.completed`. Bookkeeping parts produce none. */
function projectPart(
  part: OpenCodePart,
  role: "user" | "assistant" | undefined,
  base: (input: { itemId?: string; createdAt?: string; payload: unknown }) => RuntimeEventBase
): RuntimeEvent | null {
  if (part.type === "text") {
    const text = (part as Extract<OpenCodePart, { type: "text" | "reasoning" }>).text;
    if (typeof text !== "string" || text.length === 0) {
      return null;
    }
    // A user part carries the prompt; anything else is the assistant's answer.
    const itemType: CanonicalItemType = role === "user" ? "user_message" : "assistant_message";
    return {
      ...base({ itemId: part.id, createdAt: partTime(part), payload: part }),
      type: "item.completed",
      payload: {
        itemType,
        status: "completed",
        title: itemType === "user_message" ? "You" : "Assistant message",
        detail: text
      }
    };
  }

  if (part.type === "reasoning") {
    const text = (part as Extract<OpenCodePart, { type: "text" | "reasoning" }>).text;
    if (typeof text !== "string" || text.length === 0) {
      return null;
    }
    return {
      ...base({ itemId: part.id, createdAt: partTime(part), payload: part }),
      type: "item.completed",
      payload: { itemType: "reasoning", status: "completed", title: "Reasoning", detail: text }
    };
  }

  if (part.type === "tool") {
    const tool = part as Extract<OpenCodePart, { type: "tool" }>;
    const itemType = toToolLifecycleItemType(tool.tool);
    const status: RuntimeItemStatus = tool.state?.status === "error" ? "failed" : "completed";
    const detail = tool.state?.status === "error" ? tool.state.error : tool.state?.output;
    const command = tool.state?.input?.command;
    return {
      ...base({ itemId: tool.callID, createdAt: partTime(part), payload: part }),
      type: "item.completed",
      payload: {
        itemType,
        status,
        title: tool.state?.title ?? tool.tool,
        ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
        data: {
          tool: tool.tool,
          // The stable handle across a call's lifecycle (§5.1).
          toolUseId: tool.callID,
          state: tool.state,
          ...(typeof command === "string" ? { command } : {}),
          ...(itemType === "file_change" ? { input: tool.state?.input } : {})
        }
      }
    };
  }

  // `step-start` / `step-finish` / `snapshot` are the provider's own
  // bookkeeping — they were never timeline rows live either.
  return null;
}
