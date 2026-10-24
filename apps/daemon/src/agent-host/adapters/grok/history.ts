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
 * **What the replay holds.** The session's persisted update log — the
 * `updates.jsonl` the CLI keeps beside each session — with its streamed
 * chunks already coalesced: capture `02` produced 39 events and its
 * `session/load` replayed 5 (README 10), every word of them still there. So a
 * turn comes back as its prompt, its reasoning and answer text in the order
 * they were written, and every tool call — the `tool_call` frame and each of
 * its `tool_call_update`s — which this module folds into one row per call, as
 * the live path does. Token usage is still reported `unavailable` for every
 * projected turn even when a replayed `turn_completed` carries a usage block:
 * the cost line belongs to the turns that ran in this thread.
 */

import {
  GROK_USE_TOOL_NAME,
  HISTORICAL_RAW_SOURCE,
  type ProviderThreadTurnSnapshot,
  type RuntimeEvent,
  type RuntimeEventRaw,
  type ThreadSnapshot,
  type ToolLifecycleItemType
} from "@orquester/api/agent-chat";

import { stripAttachmentPathLines } from "../attachment-lines.ts";
import { stripForkHandoff } from "../../orchestration/fork.ts";
import { isHostRestartPrompt } from "../../orchestration/pending-wake.ts";
import { goalCommandFromReminder } from "./goal.ts";
import { isGrokSessionToolCall } from "./session-tools.ts";
import { taskSnapshotEnd } from "./background-tasks.ts";
import { finishedStatus, GROK_TOOL_NAMESPACE, SPAWN_SUBAGENT_TOOL, subagentAnswerText } from "./subagents.ts";
import {
  acpKindFromVendorKind,
  boundRawOutput,
  boundToolContent,
  extractToolCommand,
  itemTypeFromToolKind,
  normalizeToolKind,
  toolContentText
} from "./tool-output.ts";
import { asRecord } from "./normalizer-state.ts";
import { xaiToolMeta } from "./xai-meta.ts";

/**
 * The method stamped on every projected event's `raw`. The SOURCE is
 * `HISTORICAL_RAW_SOURCE`, which is what a consumer keys on to know the event
 * describes something that already happened — so it never raises attention,
 * never fires a push and never moves a live turn. The method is kept alongside
 * it because it names *which* provider channel the row was reconstructed from,
 * which is the only way to tell a Grok projection from any other once the
 * source is shared.
 */
const GROK_HISTORY_RAW_METHOD = "_x.ai/session/update#replay";

/**
 * One opaque item of a `ThreadSnapshot` turn (§4.1 calls these opaque; this is
 * the shape THIS adapter puts in them).
 */
export type GrokHistoryItem =
  | { readonly kind: "user_message"; readonly text: string }
  | { readonly kind: "assistant_message"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly title?: string;
      /** ACP's `kind`, as the latest frame that named one said it. */
      readonly toolKind?: string;
      readonly status?: string;
      /** `_meta["x.ai/tool"]`: the CLI's own name, kind and namespace for the tool. */
      readonly vendor?: { readonly name: string; readonly kind: string; readonly namespace: string; readonly readOnly: boolean };
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: unknown;
      readonly locations?: unknown;
    }
  /**
   * A background task's end the replay recorded (`subagent_finished`,
   * `task_completed`): the live path's `task.completed` row.
   */
  | {
      readonly kind: "task_completed";
      readonly taskId: string;
      readonly status: "completed" | "failed" | "stopped";
      readonly taskType?: string;
      readonly summary?: string;
      readonly exitCode?: number;
    }
  /** A turn this process observed live; it carries no restorable content. */
  | {
      readonly kind: "observed_turn";
      readonly providerPromptId: string | null;
      readonly stopReason: string | null;
      readonly cancellationCategory?: string;
      readonly errorMessage?: string;
    };

type GrokHistoryToolCall = Extract<GrokHistoryItem, { kind: "tool_call" }>;
type GrokHistoryText = Extract<GrokHistoryItem, { kind: "user_message" | "assistant_message" | "reasoning" }>;

function isGrokHistoryItem(value: unknown): value is GrokHistoryItem {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "user_message" ||
    kind === "assistant_message" ||
    kind === "reasoning" ||
    kind === "tool_call" ||
    kind === "task_completed" ||
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
 * Returns `[]` when there is nothing to project.
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
      case "user_message": {
        if (isHostRestartPrompt(item.text)) {
          // The host's own prompt after a restart: live, no message row.
          break;
        }
        // The replay echoes the text the adapter SENT, with any
        // `Attached files:` block it appended (`attachment-lines.ts`):
        // provider input, not the user's own text. Stripped here, from the
        // whole collected message — a chunk is not a message, and a block
        // can straddle two. A goal's message is replayed as the CLI's ~6 KB
        // goal `<system-reminder>`, never the `/goal …` that was typed, so it
        // reads as that command instead (goals §6.3 item 5).
        const text = stripAttachmentPathLines(
          stripForkHandoff(goalCommandFromReminder(item.text) ?? item.text)
        );
        events.push(
          event(
            "item.completed",
            { itemType: "user_message", status: "completed", detail: text, data: { text } },
            `${turn.id}:user:${index}`
          )
        );
        break;
      }
      case "assistant_message":
        events.push(
          event(
            "item.completed",
            { itemType: "assistant_message", status: "completed", detail: item.text, data: { text: item.text } },
            `${turn.id}:assistant:${index}`
          )
        );
        break;
      case "reasoning":
        // The same reasoning row the live `agent_thought_chunk`s build, as
        // Claude's projection restores its thinking blocks.
        events.push(
          event(
            "item.completed",
            { itemType: "reasoning", status: "completed", detail: item.text, data: { text: item.text } },
            `${turn.id}:reasoning:${index}`
          )
        );
        break;
      case "tool_call":
        events.push(event("item.completed", toolCallPayload(item), item.toolCallId));
        break;
      case "task_completed": {
        const { kind: _kind, ...payload } = item;
        events.push(event("task.completed", payload));
        break;
      }
      default:
        break;
    }
  }

  events.push(
    event("turn.completed", {
      state: "completed",
      stopReason: null,
      // Never `complete`: a replayed `turn_completed`'s usage is the original
      // turn's, and the cost line belongs to the turns that ran here.
      tokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false }
    })
  );
  return events;
}

/**
 * One finished tool call's row: the shape the live path writes for the call's
 * last frame (`tool-calls.ts`), so a replayed shell reads as a command, an
 * edit as a file change, a subagent launch as an agent launch. A call the
 * replay never saw end — its turn was cut short — is closed `failed` rather
 * than left spinning: a historical row must never look live.
 */
function toolCallPayload(item: GrokHistoryToolCall): Record<string, unknown> {
  const spawnsSubagent = item.vendor?.name === SPAWN_SUBAGENT_TOOL && item.vendor.namespace === GROK_TOOL_NAMESPACE;
  // A session tool is an MCP call, as the live path files it (`tool-calls.ts`):
  // by its qualified name, or — reached through `use_tool`, the vendor block
  // remembered across the call's frames — by `rawInput.tool_name`.
  const sessionTool = isGrokSessionToolCall(
    {
      title: item.title ?? null,
      _meta: item.vendor === undefined ? null : { "x.ai/tool": { name: item.vendor.name, namespace: item.vendor.namespace } },
      rawInput: item.rawInput
    },
    { usesTool: item.vendor?.name === GROK_USE_TOOL_NAME && item.vendor.namespace === GROK_TOOL_NAMESPACE }
  );
  const itemType: ToolLifecycleItemType = spawnsSubagent
    ? "collab_agent_tool_call"
    : sessionTool
      ? "mcp_tool_call"
      : itemTypeFromToolKind(acpKindFromVendorKind(item.vendor?.kind) ?? item.toolKind);
  const status = item.status === "completed" ? "completed" : "failed";
  const command = extractToolCommand(item.rawInput, item.title);
  const contentText = toolContentText(item.content);
  // On a FAILED call the content is the reason; everywhere else the command
  // is the better summary — the live path's order.
  const detail =
    status === "failed" ? (contentText ?? command ?? item.title) : (command ?? contentText ?? item.title);
  return {
    itemType,
    status,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(detail === undefined ? {} : { detail }),
    data: {
      toolUseId: item.toolCallId,
      ...(item.toolKind === undefined ? {} : { kind: item.toolKind }),
      ...(command === undefined ? {} : { command }),
      ...(item.vendor === undefined ? {} : { vendorTool: item.vendor.name, readOnly: item.vendor.readOnly }),
      ...(item.rawInput === undefined ? {} : { rawInput: item.rawInput }),
      ...(item.rawOutput === undefined ? {} : { rawOutput: item.rawOutput }),
      ...(item.content === undefined ? {} : { content: item.content }),
      ...(item.locations === undefined ? {} : { locations: item.locations })
    }
  };
}

// ---------------------------------------------------------------------------
// Collecting the replay
// ---------------------------------------------------------------------------

/** The text item a chunk kind accumulates into. */
const TEXT_CHUNK_KINDS: Readonly<Record<string, GrokHistoryText["kind"]>> = {
  user_message_chunk: "user_message",
  agent_message_chunk: "assistant_message",
  agent_thought_chunk: "reasoning"
};

/**
 * Accumulates the frames `session/load` replays into turns.
 *
 * The delimiter is the private channel's `turn_completed`, which names its
 * `prompt_id` — the provider's own turn id. Items keep the order the replay
 * wrote them in: consecutive chunks of one kind are one message, a chunk of
 * another kind or a tool call ends it. A tool call's frames — `tool_call`,
 * then its `tool_call_update`s — fold into the one item its first frame
 * opened. Anything left over at the end is a turn the agent never finished
 * recording, and is kept under a synthetic id so it is not silently lost.
 */
export class GrokHistoryCollector {
  private readonly turns: ProviderThreadTurnSnapshot[] = [];
  private pending: GrokHistoryItem[] = [];
  /** The open turn's calls by id, each at its index in {@link pending}. */
  private calls = new Map<string, number>();
  private segment: { kind: GrokHistoryText["kind"]; text: string } | null = null;

  /** One replayed `session/update` body. */
  observeAcpUpdate(update: Record<string, unknown>): void {
    const kind = update["sessionUpdate"];
    if (typeof kind !== "string") {
      return;
    }
    const textKind = TEXT_CHUNK_KINDS[kind];
    if (textKind === "user_message" && asRecord(update["_meta"])?.["hideFromScrollback"] === true) {
      // A prompt the CLI wrote itself and hides from its own scrollback — a
      // background subagent's or monitor's report that wakes the agent. Live,
      // the wake turn has no user row; the end is its own task row, replayed
      // from `subagent_finished` / `task_completed` ({@link observeXaiUpdate}).
      return;
    }
    if (textKind !== undefined) {
      const text = textOf(update["content"]);
      if (text.length === 0) {
        return;
      }
      if (this.segment?.kind !== textKind) {
        this.flushText();
        this.segment = { kind: textKind, text: "" };
      }
      this.segment.text += text;
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.observeToolCall(update);
    }
  }

  /** One replayed `_x.ai/session/update` body. */
  observeXaiUpdate(update: { sessionUpdate?: unknown; prompt_id?: unknown } & Record<string, unknown>): void {
    if (update.sessionUpdate === "subagent_finished" || update.sessionUpdate === "task_completed") {
      const end = taskEndOf(update);
      if (end !== undefined) {
        this.flushText();
        this.pending.push(end);
      }
      return;
    }
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

  private observeToolCall(update: Record<string, unknown>): void {
    const toolCallId = update["toolCallId"];
    if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
      return;
    }
    const at = this.calls.get(toolCallId);
    const previous = at === undefined ? undefined : (this.pending[at] as GrokHistoryToolCall);
    const vendor = xaiToolMeta(update["_meta"]);
    const title = typeof update["title"] === "string" && update["title"].length > 0 ? update["title"] : previous?.title;
    const toolKind = normalizeToolKind(update["kind"]) ?? previous?.toolKind;
    const status = typeof update["status"] === "string" ? update["status"] : previous?.status;
    const rawInput = update["rawInput"] ?? previous?.rawInput;
    const rawOutput = update["rawOutput"] === undefined || update["rawOutput"] === null
      ? previous?.rawOutput
      : boundRawOutput(update["rawOutput"]);
    const content = update["content"] === undefined || update["content"] === null
      ? previous?.content
      : boundToolContent(update["content"]);
    const locations = update["locations"] ?? previous?.locations;
    const next: GrokHistoryToolCall = {
      kind: "tool_call",
      toolCallId,
      ...(title === undefined ? {} : { title }),
      ...(toolKind === undefined ? {} : { toolKind }),
      ...(status === undefined ? {} : { status }),
      ...(vendor === undefined
        ? previous?.vendor === undefined
          ? {}
          : { vendor: previous.vendor }
        : { vendor: { name: vendor.name, kind: vendor.kind, namespace: vendor.namespace, readOnly: vendor.read_only } }),
      ...(rawInput === undefined || rawInput === null ? {} : { rawInput }),
      ...(rawOutput === undefined ? {} : { rawOutput }),
      ...(content === undefined ? {} : { content }),
      ...(locations === undefined || locations === null ? {} : { locations })
    };
    if (at !== undefined) {
      this.pending[at] = next;
      return;
    }
    // A tool call ends the text before it.
    this.flushText();
    this.calls.set(toolCallId, this.pending.length);
    this.pending.push(next);
  }

  private flushText(): void {
    const segment = this.segment;
    this.segment = null;
    if (segment === null || segment.text.length === 0) {
      return;
    }
    this.pending.push({ kind: segment.kind, text: segment.text });
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
    this.calls = new Map();
  }
}

/**
 * A replayed `subagent_finished` or `task_completed` as the end the live path
 * reports for it (`subagentFinished`, `taskCompleted`), or `undefined` when it
 * names no task.
 */
function taskEndOf(update: Record<string, unknown>): Extract<GrokHistoryItem, { kind: "task_completed" }> | undefined {
  if (update["sessionUpdate"] === "task_completed") {
    const end = taskSnapshotEnd(update);
    if (end === undefined) {
      return undefined;
    }
    const summary = end.output?.trim();
    return {
      kind: "task_completed",
      taskId: end.taskId,
      status: end.status,
      ...(summary === undefined || summary.length === 0 ? {} : { summary }),
      ...(end.exitCode === undefined ? {} : { exitCode: end.exitCode })
    };
  }
  const taskId = typeof update["subagent_id"] === "string" ? update["subagent_id"].trim() : "";
  if (taskId.length === 0) {
    return undefined;
  }
  const status = finishedStatus(update["status"], update["error"]);
  const answer = subagentAnswerText(typeof update["output"] === "string" ? update["output"] : undefined);
  const error = typeof update["error"] === "string" && update["error"].trim().length > 0 ? update["error"].trim() : undefined;
  const summary = status === "completed" ? answer : (error ?? answer);
  return {
    kind: "task_completed",
    taskId,
    status,
    taskType: "subagent",
    ...(summary === undefined ? {} : { summary })
  };
}

function textOf(content: unknown): string {
  if (content === null || typeof content !== "object") {
    return "";
  }
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}
