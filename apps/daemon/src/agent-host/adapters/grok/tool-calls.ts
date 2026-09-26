/**
 * Grok adapter — tool calls: a call's frames coalesced into its item rows
 * (§4.2), a finished call never started again, and the one-call close the
 * adapter writes itself (a Stop, a steer's cancel, the session's end, a
 * subagent's end). A call's answer may start or end background work — a
 * `spawn_subagent` call is a roster agent (`subagents.ts`); a shell, a
 * monitor, a poll or a kill answer is `background-tasks.ts`'s — and a
 * plan-mode write proposes the plan card. Functions over the normaliser's
 * state (`normalizer-state.ts`); `normalize.ts` routes `tool_call` and
 * `tool_call_update` here, the parent session's and a child session's alike.
 */

import type { RuntimeEvent, RuntimeEventRaw, RuntimeItemStatus } from "@orquester/api/agent-chat";

import type { SessionNotification, SessionUpdate, ToolCallStatus } from "./acp/_generated/schema.ts";
import { backgroundFromToolCall, PARENT_SCOPE } from "./background-tasks.ts";
import {
  ACP_RAW_SOURCE,
  event,
  eventWithItem,
  evictOldest,
  ownedEvent,
  type GrokNormalizerState
} from "./normalizer-state.ts";
import { nextPlanModeActive, planMarkdownFromToolCall } from "./plan.ts";
import { closeAssistantSegment, closeChildSegments } from "./segments.ts";
import {
  GROK_TOOL_NAMESPACE,
  SPAWN_SUBAGENT_TOOL,
  subagentFromToolCall,
  type ChildSession
} from "./subagents.ts";
import {
  acpKindFromVendorKind,
  boundRawOutput,
  boundToolContent,
  decideToolEmission,
  extractToolCommand,
  itemTypeFromToolKind,
  normalizeToolKind,
  toolContentText,
  toolProgressLength,
  type ToolCallSnapshot
} from "./tool-output.ts";
import { xaiToolMeta } from "./xai-meta.ts";

export interface ToolTrack extends ToolCallSnapshot {
  readonly toolCallId: string;
  kind?: string;
  rawInput?: unknown;
  itemType: ReturnType<typeof itemTypeFromToolKind>;
  started: boolean;
  lastEmittedProgressLength?: number;
  skippedSinceEmit: number;
  /**
   * The call is the CLI's own `spawn_subagent` (`_meta["x.ai/tool"]` names it
   * in the `grok_build` namespace). Remembered from the frame that said so:
   * the completion drops the vendor block altogether.
   */
  spawnsSubagent: boolean;
  /**
   * A subagent's own call — its child session made it — and the turn it
   * rides: the turn live when its FIRST frame arrived, absent between parent
   * turns, for every row of the call (AGENTS.md, "Agent rows must survive
   * resumes and retention", rule 6). A parent call has neither.
   */
  owned?: { readonly agentId: string; readonly turnId: string | undefined };
}

/**
 * Who wrote a finished call's end: the CLI, or the adapter's own close
 * ({@link GrokNormalizer.failOpenTools}).
 */
export interface FinishedCall {
  readonly itemType: ToolTrack["itemType"];
  readonly by: "cli" | "adapter";
}

const TOOL_STATUS_TO_ITEM_STATUS: Record<ToolCallStatus, RuntimeItemStatus> = {
  pending: "inProgress",
  in_progress: "inProgress",
  completed: "completed",
  failed: "failed"
};

/**
 * How many finished call ids the normaliser remembers, oldest forgotten
 * first. A finished call's track is dropped (a long session would otherwise
 * keep one per call), so this is what tells a late frame of a finished call
 * from a new call's first one. The bound is memory only: a resend arriving a
 * thousand calls later has never been seen.
 */
export const FINISHED_CALLS_REMEMBERED = 1_024;

export function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

export function toolCall(
  state: GrokNormalizerState,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  params: SessionNotification,
  method: string,
  owner?: ChildSession
): RuntimeEvent[] {
  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
    return [];
  }

  const previous = state.tools.get(toolCallId);
  // A frame of a call that already FINISHED has no lifecycle left to report.
  // Emitted, a status-less one opened the call again as a new `item.started`
  // and re-registered it as live, and the exit sweep (`failOpenTools`) then
  // failed a call that had completed; a terminal restatement wrote a second
  // `tool.completed` and closed the open assistant bubble. Both are dropped
  // — except the CLI's own end of a call the ADAPTER closed (a Stop's
  // `failOpenTools`), which is the call's first real end and lands.
  const finished = previous === undefined ? state.finishedCalls.get(toolCallId) : undefined;
  if (finished !== undefined && (finished.by === "cli" || !isTerminalToolStatus(update.status))) {
    return [];
  }
  const vendor = xaiToolMeta(update._meta);
  // Subagents cannot spawn subagents (depth one, the CLI's docs): a child's
  // call is never a launch.
  const spawnsSubagent =
    owner === undefined &&
    (previous?.spawnsSubagent === true ||
      (vendor?.name === SPAWN_SUBAGENT_TOOL && vendor.namespace === GROK_TOOL_NAMESPACE));
  const kind = normalizeToolKind(update.kind) ?? previous?.kind;
  const title = update.title ?? previous?.title;
  const status = (update.status ?? previous?.status ?? (method === "tool_call" ? "pending" : undefined)) as
    | ToolCallStatus
    | undefined;
  const content = update.content === undefined ? previous?.content : boundToolContent(update.content);
  const rawOutput = update.rawOutput === undefined ? previous?.rawOutput : boundRawOutput(update.rawOutput);
  const rawInput = update.rawInput ?? previous?.rawInput;
  const command = extractToolCommand(rawInput, title ?? undefined);
  const contentText = toolContentText(content);
  // On a FAILED call the content is the reason — "User rejected the
  // execution for tool `write`" — and that is what the row must read.
  // Everywhere else the command is the better summary (T3's order).
  const detail =
    status === "failed"
      ? (contentText ?? command ?? title ?? undefined)
      : (command ?? contentText ?? title ?? undefined);

  const next: ToolTrack = {
    toolCallId,
    kind: kind ?? undefined,
    rawInput,
    // `_meta["x.ai/tool"].kind` is Grok's own authoritative discriminant, it
    // is finer-grained than ACP's, and it is present on the FIRST frame of a
    // call where ACP's `kind` is still absent — so it leads. A subagent's
    // launch is an agent launch, as Claude's `Agent` call is.
    itemType:
      finished?.itemType ??
      (spawnsSubagent
        ? "collab_agent_tool_call"
        : itemTypeFromToolKind(acpKindFromVendorKind(vendor?.kind) ?? kind ?? undefined)),
    spawnsSubagent,
    ...(previous?.owned !== undefined
      ? { owned: previous.owned }
      : owner === undefined
        ? {}
        : { owned: { agentId: owner.taskId, turnId: state.deps.activeTurnId() } }),
    started: previous?.started === true,
    title: title ?? undefined,
    status: status ?? undefined,
    detail,
    content,
    rawOutput,
    lastEmittedProgressLength: previous?.lastEmittedProgressLength,
    skippedSinceEmit: previous?.skippedSinceEmit ?? 0
  };

  const decision = decideToolEmission({
    previous,
    next,
    lastEmittedProgressLength: previous?.lastEmittedProgressLength,
    skippedSinceEmit: previous?.skippedSinceEmit ?? 0
  });

  const events: RuntimeEvent[] = [];
  const terminal = status === "completed" || status === "failed";

  if (decision.emit) {
    // A tool call ends its author's current bubble and thinking block.
    events.push(...(owner === undefined ? closeAssistantSegment(state) : closeChildSegments(state, owner)));

    const lifecycle = terminal ? "item.completed" : next.started ? "item.updated" : "item.started";
    next.started = true;
    next.lastEmittedProgressLength = toolProgressLength(next);
    next.skippedSinceEmit = 0;
    const payload = {
      itemType: next.itemType,
      ...(status === undefined ? {} : { status: TOOL_STATUS_TO_ITEM_STATUS[status] }),
      ...(next.title === undefined ? {} : { title: next.title }),
      ...(next.detail === undefined ? {} : { detail: next.detail }),
      ...(next.owned === undefined ? {} : { agentId: next.owned.agentId }),
      data: {
        toolUseId: toolCallId,
        ...(next.kind === undefined ? {} : { kind: next.kind }),
        ...(command === undefined ? {} : { command }),
        ...(vendor === undefined ? {} : { vendorTool: vendor.name, readOnly: vendor.read_only }),
        ...(rawInput === undefined ? {} : { rawInput }),
        ...(rawOutput === undefined ? {} : { rawOutput }),
        ...(content === undefined ? {} : { content }),
        ...(update.locations === undefined || update.locations === null
          ? {}
          : { locations: update.locations })
      }
    };
    const lifecycleRaw: RuntimeEventRaw = {
      source: ACP_RAW_SOURCE,
      method: `session/update:${method}`,
      payload: params
    };
    events.push(
      next.owned === undefined
        ? eventWithItem(state, lifecycle, payload, toolCallId, lifecycleRaw)
        : ownedEvent(state, lifecycle, payload, next.owned.agentId, next.owned.turnId, toolCallId, lifecycleRaw)
    );
  } else {
    next.skippedSinceEmit = decision.skipped;
  }

  if (terminal) {
    state.tools.delete(toolCallId);
    rememberFinishedCall(state, toolCallId, next.itemType, "cli");
  } else {
    state.tools.set(toolCallId, next);
  }

  const raw: RuntimeEventRaw = {
    source: ACP_RAW_SOURCE,
    method: `session/update:${method}`,
    payload: params
  };
  if (owner !== undefined) {
    // A child's plan mode is its own session's; the thread's is the parent's.
    events.push(
      ...backgroundFromToolCall(state, toolCallId, rawInput, rawOutput, status, raw, {
        session: owner.sessionId,
        owner: owner.taskId
      })
    );
    return events;
  }

  // Plan mode is DECLARED, so the flag follows the tool call regardless of
  // whether the row itself was emitted.
  state.planModeActive = nextPlanModeActive(state.planModeActive, {
    title: next.title,
    status: next.status,
    rawInput: update.rawInput,
    meta: update._meta
  });
  if (state.planModeActive) {
    const markdown = planMarkdownFromToolCall(
      { rawInput: update.rawInput, content },
      state.deps.planHost
    );
    if (markdown !== undefined) {
      events.push(...proposePlan(state, markdown, { source: ACP_RAW_SOURCE, method: "session/update", payload: params }));
    }
  }

  events.push(
    ...(spawnsSubagent
      ? subagentFromToolCall(state, toolCallId, rawInput, update, status, raw)
      : backgroundFromToolCall(state, toolCallId, rawInput, rawOutput, status, raw, PARENT_SCOPE))
  );
  return events;
}

/** Oldest first out, so the memory stays within {@link FINISHED_CALLS_REMEMBERED}. */
function rememberFinishedCall(
  state: GrokNormalizerState,
  toolCallId: string,
  itemType: ToolTrack["itemType"],
  by: FinishedCall["by"]
): void {
  state.finishedCalls.delete(toolCallId);
  state.finishedCalls.set(toolCallId, { itemType, by });
  evictOldest(state.finishedCalls, FINISHED_CALLS_REMEMBERED);
}

/**
 * Emit a proposed plan, deduped **per turn**: identical markdown on a later
 * turn must still produce a fresh card, and an empty write only resets the
 * fallback.
 */
function proposePlan(state: GrokNormalizerState, markdown: string, raw: RuntimeEventRaw): RuntimeEvent[] {
  const turnId = state.deps.activeTurnId();
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    state.lastProposedPlan = { markdown: "", turnId };
    return [];
  }
  if (state.lastProposedPlan?.markdown === trimmed && state.lastProposedPlan.turnId === turnId) {
    return [];
  }
  state.lastProposedPlan = { markdown: trimmed, turnId };
  return [event(state, "turn.proposed.completed", { planMarkdown: trimmed }, undefined, raw)];
}

/** One live call, failed by the adapter: its end, and remembered as the adapter's. */
export function failTool(
  state: GrokNormalizerState,
  toolCallId: string,
  track: ToolTrack,
  reason: string
): RuntimeEvent[] {
  state.tools.delete(toolCallId);
  rememberFinishedCall(state, toolCallId, track.itemType, "adapter");
  if (!track.started) {
    return [];
  }
  const payload = {
    itemType: track.itemType,
    status: "failed",
    ...(track.title === undefined ? {} : { title: track.title }),
    detail: reason,
    ...(track.owned === undefined ? {} : { agentId: track.owned.agentId })
  };
  return [
    track.owned === undefined
      ? eventWithItem(state, "item.completed", payload, toolCallId)
      : ownedEvent(state, "item.completed", payload, track.owned.agentId, track.owned.turnId, toolCallId)
  ];
}
