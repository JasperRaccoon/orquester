/**
 * Codex adapter — projecting a resumed thread's native history into runtime
 * events (spec §4.5 "`readThread` must read the provider's native history
 * out-of-band"; §7.3 renders it; E2E finding E6).
 *
 * A resumed thread's timeline is otherwise empty: `thread/resume` hands back
 * `turns: []` by design and the conversation is re-hydrated through
 * `thread/turns/list` (fixtures README obs. 17). That hydration produces
 * `ThreadSnapshot`, which is opaque by contract — only the adapter that made it
 * knows how to read it, so the translation belongs here.
 *
 * **These events describe the past.** They carry the historical `raw.source`
 * so nothing downstream mistakes a replayed row for live traffic: no token
 * usage is claimed (`unavailable` — the provider reports none per turn, and
 * inventing one would double-count the thread), and every turn is already
 * settled.
 */

import type {
  RuntimeEventRaw,
  ThreadSnapshot,
  TurnTokenUsage
} from "@orquester/api/agent-chat";
import { HISTORICAL_RAW_SOURCE, isToolLifecycleItemType } from "@orquester/api/agent-chat";

import { stripAttachmentPathLines } from "../attachment-lines.ts";
import type { CodexProtocol } from "./_generated/index.ts";
import { classifyItem, type CodexThreadItem } from "./items.ts";
import type { RuntimeEventDraft } from "./normalise.ts";

/**
 * The marker that says "this frame is replayed history, not live traffic" —
 * the SHARED one every adapter's projection carries, so a consumer tells
 * history from live traffic without knowing which provider produced it.
 * `method` still names the call the rows were read back from.
 */
export const CODEX_RAW_HISTORY: RuntimeEventRaw["source"] = HISTORICAL_RAW_SOURCE;

/**
 * A history turn claims no usage. The provider reports per-turn usage only on
 * the live `thread/tokenUsage/updated` stream, and `turn/completed` carries
 * none at all (fixtures README obs. 6) — so `unavailable` is the honest
 * answer, and the alternative (re-reading the thread total) would charge every
 * replayed turn the whole conversation.
 */
const HISTORICAL_USAGE: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "unavailable",
  hasSubagents: false
};

/**
 * Project one `readThread` result into the events §7.3 renders.
 *
 * Per turn, in order: `turn.started`, one `item.completed` per message or
 * tool-lifecycle item, then `turn.completed {state:"completed"}`. Turns arrive
 * oldest-first (that is what `readThread` guarantees), so the emitted sequence
 * reads top-to-bottom like the original conversation.
 */
export function projectCodexHistory(snapshot: ThreadSnapshot): RuntimeEventDraft[] {
  const events: RuntimeEventDraft[] = [];

  for (const turn of snapshot.turns) {
    const raw = (item: unknown): RuntimeEventRaw => ({
      source: CODEX_RAW_HISTORY,
      method: "thread/turns/list",
      payload: item
    });

    events.push({
      type: "turn.started",
      payload: {},
      turnId: turn.id,
      providerRefs: { providerTurnId: turn.id },
      raw: raw({ turnId: turn.id })
    });

    for (const raw_item of turn.items) {
      const projected = projectItem(raw_item, turn.id, raw(raw_item));
      if (projected !== null) {
        events.push(projected);
      }
    }

    events.push({
      type: "turn.completed",
      payload: { state: "completed", tokenUsage: HISTORICAL_USAGE },
      turnId: turn.id,
      providerRefs: { providerTurnId: turn.id },
      raw: raw({ turnId: turn.id })
    });
  }

  return events;
}

/**
 * One history item, or `null` for an item that is not part of the transcript.
 *
 * Classification is on the **typed discriminants** (`classifyItem`), never on
 * a name heuristic — the same closed switch the live path uses, so a protocol
 * release that adds an item type is a typecheck error in one place rather than
 * a silently mis-bucketed history row.
 */
function projectItem(
  value: unknown,
  turnId: string,
  raw: RuntimeEventRaw
): RuntimeEventDraft | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const item = value as CodexThreadItem;
  if (typeof item.type !== "string" || typeof item.id !== "string") {
    return null;
  }

  const base = {
    turnId,
    // `itemId` is what ingestion turns into the activity's `toolUseId`
    // (`ingestion/activities.ts:178`), so a replayed tool row groups and
    // de-duplicates exactly like a live one.
    itemId: item.id,
    providerRefs: { providerTurnId: turnId, providerItemId: item.id },
    raw
  } as const;

  const classified = classifyItem(item);

  // --- messages -----------------------------------------------------------
  // `detail` IS the message text on an `item.completed`: ingestion treats it
  // as "a snapshot standing in for deltas that never arrived"
  // (`ingestion/index.test.ts:189-203`), which is precisely the history case.
  if (item.type === "userMessage") {
    const text = userMessageText(item.content);
    return text === null
      ? null
      : { type: "item.completed", payload: { itemType: "user_message", detail: text }, ...base };
  }

  if (item.type === "agentMessage") {
    const text = item.text.trim();
    return text.length === 0
      ? null
      : {
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            detail: text,
            // The phase rides `data`, not `detail`, because on a history row
            // `detail` is the text. Ingestion keeps the phase on replay.
            data: { phase: item.phase }
          },
          ...base
        };
  }

  // --- tool lifecycle -----------------------------------------------------
  if (isToolLifecycleItemType(classified.itemType)) {
    return {
      type: "item.completed",
      payload: {
        itemType: classified.itemType,
        // A history item is finished by construction; an `inProgress` status
        // read back from the rollout would put a spinner on a dead turn.
        status: classified.status === "declined" ? "declined" : terminalStatus(classified.status),
        ...(classified.title !== undefined ? { title: classified.title } : {}),
        ...(classified.detail !== undefined ? { detail: classified.detail } : {}),
        ...(classified.data !== undefined ? { data: classified.data } : {})
      },
      ...base
    };
  }

  // Everything else — reasoning, plan, the two review markers, compaction,
  // subagent bookkeeping, hook prompts — is either already represented
  // elsewhere or never a timeline row (§4.2). A resumed transcript shows the
  // conversation, not the provider's internal chatter.
  return null;
}

function terminalStatus(status: string | undefined): "completed" | "failed" {
  return status === "failed" ? "failed" : "completed";
}

/**
 * The text of a user message. `content` is an array of `UserInput` arms; only
 * the text ones carry prose, and an attachment-only message has none. The
 * rollout keeps the text the adapter SENT, with any `Attached files:` block it
 * appended (`attachment-lines.ts`) — provider input, not the user's own text,
 * so it is stripped here.
 */
function userMessageText(content: readonly CodexProtocol.v2.UserInput[]): string | null {
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type === "text" && entry.text.length > 0) {
      parts.push(entry.text);
    }
  }
  const text = stripAttachmentPathLines(parts.join("\n").trim());
  return text.length > 0 ? text : null;
}
