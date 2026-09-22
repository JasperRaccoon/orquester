/**
 * Grok adapter — projecting a provider-side transcript into runtime events
 * (E6, `AgentAdapter.projectHistory`).
 *
 * A thread resumed from a conversation the host has never seen — the §6.1
 * resume picker, or a thread whose `events.ndjson` predates this host — has an
 * empty timeline while the provider happily knows the whole conversation. This
 * module turns what Grok replays into the §4.2 events a timeline is built
 * from, stamped so the fold can tell reconstructed history from live traffic.
 *
 * **What Grok actually gives us.** There is no transcript RPC. The one source
 * is the `session/load` replay (README 10): ordinary `session/update` frames
 * with `_meta.isReplay: true`, plus the xAI-private ones under
 * `_x.ai/session/update` — a method name T3 does not register at all, which is
 * why an adapter that only knows `_x.ai/session_notification` sees none of the
 * `turn_completed` rows that delimit the turns.
 *
 * **And the honest limit.** Replay is *partial*: capture `02` produced 39
 * events and `session/load` replayed **5** (README 10). So this projection
 * restores the shape of the conversation — who said what, which turns
 * happened — and never claims to be the transcript. Token usage is reported
 * `unavailable` for every projected turn even when a replayed `turn_completed`
 * carries a usage block, because that block covers the original turn's whole
 * work and attributing it to a handful of replayed rows would overstate what
 * is being shown.
 */

import {
  HISTORICAL_RAW_SOURCE,
  type ProviderThreadTurnSnapshot,
  type RuntimeEvent,
  type RuntimeEventRaw,
  type ThreadSnapshot
} from "@orquester/api/agent-chat";

/**
 * The method stamped on every projected event's `raw`. The SOURCE is
 * `HISTORICAL_RAW_SOURCE`, which is what a consumer keys on to know the event
 * describes something that already happened — so it never raises attention,
 * never fires a push and never moves a live turn. The method is kept alongside
 * it because it names *which* provider channel the row was reconstructed from,
 * which is the only way to tell a Grok projection from any other once the
 * source is shared.
 */
export const GROK_HISTORY_RAW_METHOD = "_x.ai/session/update#replay";

/**
 * One opaque item of a `ThreadSnapshot` turn (§4.1 calls these opaque; this is
 * the shape THIS adapter puts in them).
 */
export type GrokHistoryItem =
  | { readonly kind: "user_message"; readonly text: string }
  | { readonly kind: "assistant_message"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly title?: string;
      readonly toolKind?: string;
      readonly status?: string;
      readonly detail?: string;
    }
  /** A turn this process observed live; it carries no restorable content. */
  | {
      readonly kind: "observed_turn";
      readonly providerPromptId: string | null;
      readonly stopReason: string | null;
      readonly cancellationCategory?: string;
      readonly errorMessage?: string;
    };

export function isGrokHistoryItem(value: unknown): value is GrokHistoryItem {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "user_message" ||
    kind === "assistant_message" ||
    kind === "tool_call" ||
    kind === "observed_turn"
  );
}

export interface ProjectHistoryDeps {
  readonly threadId: string;
  stamp(): { eventId: string; createdAt: string };
}

/**
 * Project a `ThreadSnapshot` into the events a timeline is rebuilt from.
 *
 * Per turn: `turn.started`, then an `item.completed` for each restorable item,
 * then `turn.completed {state:"completed", tokenUsage: unavailable}`. A turn
 * with nothing restorable — the `observed_turn` marker, i.e. a turn this
 * process ran and already streamed — contributes nothing, because its events
 * are already in the host's log and projecting them again would double them.
 *
 * Returns `[]` when there is nothing to project; the host renders its own info
 * activity in that case rather than an empty timeline.
 */
export function projectGrokHistory(snapshot: ThreadSnapshot, deps: ProjectHistoryDeps): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const turn of snapshot.turns) {
    events.push(...projectTurn(turn, deps));
  }
  return events;
}

function projectTurn(turn: ProviderThreadTurnSnapshot, deps: ProjectHistoryDeps): RuntimeEvent[] {
  const items = turn.items.filter(isGrokHistoryItem).filter((item) => item.kind !== "observed_turn");
  if (items.length === 0) {
    return [];
  }

  const raw: RuntimeEventRaw = {
    source: HISTORICAL_RAW_SOURCE,
    method: GROK_HISTORY_RAW_METHOD,
    payload: { turnId: turn.id }
  };
  const events: RuntimeEvent[] = [];
  const event = (type: RuntimeEvent["type"], payload: unknown, itemId?: string): RuntimeEvent => {
    const stamp = deps.stamp();
    return {
      eventId: stamp.eventId,
      threadId: deps.threadId,
      createdAt: stamp.createdAt,
      turnId: turn.id,
      ...(itemId === undefined ? {} : { itemId }),
      raw,
      type,
      payload
    } as RuntimeEvent;
  };

  events.push(event("turn.started", {}));

  let index = 0;
  for (const item of items) {
    index += 1;
    switch (item.kind) {
      case "user_message":
        events.push(
          event(
            "item.completed",
            { itemType: "user_message", status: "completed", detail: item.text },
            `${turn.id}:user:${index}`
          )
        );
        break;
      case "assistant_message":
        events.push(
          event(
            "item.completed",
            { itemType: "assistant_message", status: "completed", detail: item.text },
            `${turn.id}:assistant:${index}`
          )
        );
        break;
      case "tool_call":
        events.push(
          event(
            "item.completed",
            {
              // The replayed rows carry no ACP `kind`, so a tool call is
              // restored as the generic tool-lifecycle type rather than a
              // guess at which one it was.
              itemType: "dynamic_tool_call",
              status: item.status === "failed" ? "failed" : "completed",
              ...(item.title === undefined ? {} : { title: item.title }),
              ...(item.detail === undefined ? {} : { detail: item.detail }),
              data: { toolUseId: item.toolCallId }
            },
            item.toolCallId
          )
        );
        break;
      default:
        break;
    }
  }

  events.push(
    event("turn.completed", {
      state: "completed",
      stopReason: null,
      // Never `complete`: a replayed `turn_completed`'s usage covers the whole
      // original turn, and attributing it to the handful of rows replay
      // actually returns would overstate what is being shown.
      tokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false }
    })
  );
  return events;
}

// ---------------------------------------------------------------------------
// Collecting the replay
// ---------------------------------------------------------------------------

/**
 * Accumulates the frames `session/load` replays into turns.
 *
 * The delimiter is the private channel's `turn_completed`, which names its
 * `prompt_id` — the provider's own turn id. Chunks seen before it belong to
 * that turn; anything left over at the end is a turn the agent never finished
 * recording, and is kept under a synthetic id so it is not silently lost.
 */
export class GrokHistoryCollector {
  private readonly turns: ProviderThreadTurnSnapshot[] = [];
  private pending: GrokHistoryItem[] = [];
  private userText = "";
  private assistantText = "";

  /** One replayed `session/update` body. */
  observeAcpUpdate(update: { sessionUpdate?: unknown; content?: unknown; toolCallId?: unknown; title?: unknown; status?: unknown }): void {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      this.userText += textOf(update.content);
      return;
    }
    if (kind === "agent_message_chunk") {
      this.assistantText += textOf(update.content);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = update.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        return;
      }
      this.flushText();
      this.pending.push({
        kind: "tool_call",
        toolCallId,
        ...(typeof update.title === "string" ? { title: update.title } : {}),
        ...(typeof update.status === "string" ? { status: update.status } : {})
      });
    }
  }

  /** One replayed `_x.ai/session/update` body. */
  observeXaiUpdate(update: { sessionUpdate?: unknown; prompt_id?: unknown }): void {
    if (update.sessionUpdate !== "turn_completed") {
      return;
    }
    const promptId = typeof update.prompt_id === "string" ? update.prompt_id : undefined;
    this.closeTurn(promptId);
  }

  /** Every turn the replay produced, oldest first. */
  snapshotTurns(): ProviderThreadTurnSnapshot[] {
    this.closeTurn(undefined);
    return this.turns.map((turn) => ({ id: turn.id, items: [...turn.items] }));
  }

  private flushText(): void {
    if (this.userText.length > 0) {
      this.pending.push({ kind: "user_message", text: this.userText });
      this.userText = "";
    }
    if (this.assistantText.length > 0) {
      this.pending.push({ kind: "assistant_message", text: this.assistantText });
      this.assistantText = "";
    }
  }

  private closeTurn(promptId: string | undefined): void {
    this.flushText();
    if (this.pending.length === 0) {
      return;
    }
    this.turns.push({
      id: promptId ?? `grok-history-${this.turns.length + 1}`,
      items: this.pending
    });
    this.pending = [];
  }
}

function textOf(content: unknown): string {
  if (content === null || typeof content !== "object") {
    return "";
  }
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}
