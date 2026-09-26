/**
 * Grok adapter — the segments a turn's words and thinking stream into
 * (§4.5): the parent's assistant bubbles, and a subagent's own words and
 * thinking, which its child session streams as that agent's rows. Functions
 * over the normaliser's state (`normalizer-state.ts`); `normalize.ts` routes
 * the chunks here.
 */

import type { RuntimeEvent, RuntimeEventRaw } from "@orquester/api/agent-chat";

import type { SessionNotification } from "./acp/_generated/schema.ts";
import type { ChildSession } from "./normalize.ts";
import {
  ACP_RAW_SOURCE,
  event,
  eventWithItem,
  ownedEvent,
  type GrokNormalizerState
} from "./normalizer-state.ts";

/**
 * A child's words: the agent's assistant message, a segment of its own
 * (`assistant:…:agent:<task>:…`, so a turnless one can be closed by its
 * own `item.completed` — ingestion's `handleTurnlessCompletion`). Visible
 * text ends the agent's thinking block; a segment whose turn has ended is
 * closed and a new one opens on the turn live now.
 */
export function childText(
  state: GrokNormalizerState,
  child: ChildSession,
  content: { type?: string; text?: string } | undefined,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
    return [];
  }
  const turnId = state.deps.activeTurnId();
  const events = closeChildReasoning(state, child);
  if (child.text !== undefined && child.text.turnId !== turnId) {
    events.push(...closeChildText(state, child));
  }
  if (child.text === undefined) {
    if (content.text.trim().length === 0) {
      return events;
    }
    const itemId = `assistant:${state.runtimeId}:agent:${child.taskId}:${child.sessionId}:segment:${child.nextSegment}`;
    child.nextSegment += 1;
    child.text = { itemId, turnId };
    events.push(
      ownedEvent(
        state,
        "item.started",
        { itemType: "assistant_message", status: "inProgress", agentId: child.taskId },
        child.taskId,
        turnId,
        itemId
      )
    );
  }
  events.push(
    ownedEvent(
      state,
      "content.delta",
      { streamKind: "assistant_text", delta: content.text },
      child.taskId,
      child.text.turnId,
      child.text.itemId,
      raw
    )
  );
  return events;
}

/** A child's thinking: the agent's reasoning row, one block per run of chunks. */
export function childReasoning(
  state: GrokNormalizerState,
  child: ChildSession,
  content: { type?: string; text?: string } | undefined,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
    return [];
  }
  const turnId = state.deps.activeTurnId();
  const events: RuntimeEvent[] = [];
  if (child.reasoning !== undefined && child.reasoning.turnId !== turnId) {
    events.push(...closeChildReasoning(state, child));
  }
  if (child.reasoning === undefined) {
    child.reasoning = {
      itemId: `reasoning:${state.runtimeId}:agent:${child.taskId}:${child.sessionId}:${child.nextSegment}`,
      turnId
    };
    child.nextSegment += 1;
  }
  events.push(
    ownedEvent(
      state,
      "content.delta",
      { streamKind: "reasoning_text", delta: content.text },
      child.taskId,
      child.reasoning.turnId,
      child.reasoning.itemId,
      raw
    )
  );
  return events;
}

function closeChildText(state: GrokNormalizerState, child: ChildSession): RuntimeEvent[] {
  const open = child.text;
  if (open === undefined) {
    return [];
  }
  child.text = undefined;
  return [
    ownedEvent(
      state,
      "item.completed",
      { itemType: "assistant_message", status: "completed", agentId: child.taskId },
      child.taskId,
      open.turnId,
      open.itemId
    )
  ];
}

function closeChildReasoning(state: GrokNormalizerState, child: ChildSession): RuntimeEvent[] {
  const open = child.reasoning;
  if (open === undefined) {
    return [];
  }
  child.reasoning = undefined;
  return [
    ownedEvent(
      state,
      "item.completed",
      { itemType: "reasoning", status: "completed", agentId: child.taskId },
      child.taskId,
      open.turnId,
      open.itemId
    )
  ];
}

/**
 * Close a child's open segments — every one, or (`only` given) those riding
 * that turn, `undefined` meaning the turnless ones.
 */
export function closeChildSegments(
  state: GrokNormalizerState,
  child: ChildSession,
  only?: { readonly turnId: string | undefined }
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (child.reasoning !== undefined && (only === undefined || child.reasoning.turnId === only.turnId)) {
    events.push(...closeChildReasoning(state, child));
  }
  if (child.text !== undefined && (only === undefined || child.text.turnId === only.turnId)) {
    events.push(...closeChildText(state, child));
  }
  return events;
}

export function contentDelta(
  state: GrokNormalizerState,
  content: { type?: string; text?: string } | undefined,
  streamKind: "assistant_text" | "reasoning_text",
  params: SessionNotification
): RuntimeEvent[] {
  if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
    // Non-text content (image/resource) has no stream kind on this surface.
    return [];
  }
  const raw: RuntimeEventRaw = { source: ACP_RAW_SOURCE, method: "session/update", payload: params };

  if (streamKind === "reasoning_text") {
    // Reasoning is never attached to an assistant item and never opens or
    // closes a segment.
    return [event(state, "content.delta", { streamKind, delta: content.text }, undefined, raw)];
  }
  if (!state.assistantUpdatesOpen) {
    // A late chunk after the turn settled must not reopen it.
    return [];
  }

  const events: RuntimeEvent[] = [];
  if (state.activeAssistantItemId === undefined && content.text.trim().length === 0) {
    // Whitespace never OPENS a segment (it would produce an empty bubble for
    // a provider that flushes a trailing newline) but is kept inside one.
    return [];
  }
  const itemId = ensureAssistantSegment(state, events);
  events.push(
    eventWithItem(state, "content.delta", { streamKind, delta: content.text }, itemId, raw)
  );
  return events;
}

function ensureAssistantSegment(state: GrokNormalizerState, events: RuntimeEvent[]): string {
  if (state.activeAssistantItemId !== undefined) {
    return state.activeAssistantItemId;
  }
  const itemId = `assistant:${state.runtimeId}:segment:${state.nextSegmentIndex}`;
  state.nextSegmentIndex += 1;
  state.activeAssistantItemId = itemId;
  events.push(
    eventWithItem(state, "item.started", { itemType: "assistant_message", status: "inProgress" }, itemId)
  );
  return itemId;
}

export function closeAssistantSegment(state: GrokNormalizerState): RuntimeEvent[] {
  const itemId = state.activeAssistantItemId;
  if (itemId === undefined) {
    return [];
  }
  state.activeAssistantItemId = undefined;
  return [
    eventWithItem(state, "item.completed", { itemType: "assistant_message", status: "completed" }, itemId)
  ];
}
