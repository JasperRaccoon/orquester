/**
 * Codex adapter — `codex app-server` notification → `RuntimeEvent` (spec §4.2,
 * §4.5 Codex "Notifications").
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexAdapter.ts:1304-2223`.
 *
 * The switch over `ServerNotificationMethod` is **exhaustive and ends in
 * `satisfies never`** (§4.2): a protocol release that adds a notification is a
 * typecheck error here, and at runtime a method this build has never heard of
 * emits `runtime.warning` rather than being dropped by a catch-all (§10). A
 * warning never ends an active turn.
 *
 * Everything in this module is pure over its own state, so `raw.ndjson` can be
 * replayed straight back through it in a test (§9).
 */

import type {
  CanonicalRequestType,
  RuntimeContentStreamKind,
  RuntimeErrorClass,
  RuntimeEvent,
  RuntimeEventRaw,
  RuntimeTurnState
} from "@orquester/api/agent-chat";

import type { CodexProtocol, ServerNotificationMethod } from "./_generated/index.ts";
import { classifyItem, type CodexThreadItem } from "./items.ts";
import { usageWindowsFromRateLimits, CodexUsageTracker } from "./usage.ts";

/**
 * An event before the session stamps `eventId`, `threadId` and `createdAt`.
 * Keeping the envelope out of this module is what makes a replay test
 * byte-stable against an injected {@link import("../../adapter.ts").IdGen}.
 */
export type RuntimeEventDraft = {
  [T in RuntimeEvent as T["type"]]: Omit<T, "eventId" | "threadId" | "createdAt">;
}[RuntimeEvent["type"]];

/** Codex's two raw sources (§4.2 `RuntimeEventRawSource`). */
export const CODEX_RAW_NOTIFICATION = "codex.app-server.notification" as const;
export const CODEX_RAW_REQUEST = "codex.app-server.request" as const;

export interface CodexNormaliserOptions {
  usage: CodexUsageTracker;
}

/** Per-session normalisation state. */
export class CodexNormaliser {
  private readonly usage: CodexUsageTracker;
  /** `turn/diff/updated` is cumulative and repeats; de-duplicate on content. */
  private lastDiff: string | null = null;
  /** itemId → whether the item is still `inProgress`, for `tool.progress`. */
  private readonly openItems = new Map<string, string>();
  /** Set while a turn is live, so `turn.completed` can carry the usage. */
  private activeTurnId: string | null = null;
  private turnModel: string | null = null;
  private turnEffort: string | null = null;
  /** The last error notification of the active turn, for its `errorMessage`. */
  private lastTurnError: string | null = null;
  /** Agent paths seen, so the `/root` trap never registers the root as a child. */
  private readonly knownAgentPaths = new Set<string>();

  constructor(options: CodexNormaliserOptions) {
    this.usage = options.usage;
  }

  get currentTurnId(): string | null {
    return this.activeTurnId;
  }

  /** Called by the session when it starts a turn, before any notification. */
  noteTurnStarted(turnId: string, model?: string, effort?: string): void {
    this.activeTurnId = turnId;
    this.turnModel = model ?? null;
    this.turnEffort = effort ?? null;
    this.lastTurnError = null;
    this.usage.beginTurn(turnId);
  }

  /** Called when the session settles a turn outside the protocol (child death). */
  noteTurnSettled(): void {
    this.activeTurnId = null;
    this.lastTurnError = null;
  }

  /** Item ids still `inProgress`, used to close them when a child dies. */
  openItemIds(): string[] {
    return [...this.openItems.keys()];
  }

  /**
   * Translate one server notification.
   *
   * Returns `[]` for a notification that is deliberately not represented in the
   * §4.2 union — those are listed explicitly in the switch, never reached by a
   * default arm.
   */
  notification<TMethod extends ServerNotificationMethod>(
    method: TMethod,
    params: unknown
  ): RuntimeEventDraft[] {
    const raw = (): RuntimeEventRaw => ({
      source: CODEX_RAW_NOTIFICATION,
      method,
      payload: params
    });

    switch (method) {
      // ---------------------------------------------------------------- thread
      case "thread/started": {
        const p = params as CodexProtocol.v2.ThreadStartedNotification;
        return [
          { type: "thread.started", payload: { providerThreadId: p.thread.id }, raw: raw() }
        ];
      }
      case "thread/status/changed": {
        const p = params as CodexProtocol.v2.ThreadStatusChangedNotification;
        // `activeFlags: ["waitingOnApproval"]` IS emitted on this CLI, contrary
        // to §4.2's "waiting is never emitted". `waiting` has no arm in
        // `RuntimeThreadState`, so the flag is carried as state `active` — the
        // host still derives "waiting on you" from the open request, and this
        // must not choke (SEAMS, Codex cross-cutting note).
        return [{ type: "thread.state.changed", payload: { state: threadState(p.status) }, raw: raw() }];
      }
      case "thread/archived":
        return [{ type: "thread.state.changed", payload: { state: "archived" }, raw: raw() }];
      case "thread/closed":
      case "thread/deleted":
        return [{ type: "thread.state.changed", payload: { state: "closed" }, raw: raw() }];
      case "thread/unarchived":
        return [{ type: "thread.state.changed", payload: { state: "active" }, raw: raw() }];
      case "thread/name/updated": {
        const p = params as CodexProtocol.v2.ThreadNameUpdatedNotification;
        return [
          {
            type: "thread.metadata.updated",
            payload: { ...(p.threadName !== undefined ? { name: p.threadName } : {}) },
            raw: raw()
          }
        ];
      }
      case "thread/tokenUsage/updated": {
        const p = params as CodexProtocol.v2.ThreadTokenUsageUpdatedNotification;
        return [
          {
            type: "thread.token-usage.updated",
            payload: { usage: this.usage.observe(p) },
            ...(p.turnId.length > 0 ? { turnId: p.turnId } : {}),
            raw: raw()
          }
        ];
      }
      case "thread/compacted": {
        // Never observed on 0.154.0 — the signal is the `contextCompaction`
        // ITEM (fixtures README observation 8). Handled anyway so an older or
        // newer server that does emit it is not a warning.
        const usage = this.usage.threadUsage();
        return [
          {
            type: "thread.state.changed",
            payload: { state: "compacted", afterTokens: usage.usedTokens },
            raw: raw()
          }
        ];
      }

      // ------------------------------------------------------------------ turn
      case "turn/started": {
        const p = params as CodexProtocol.v2.TurnStartedNotification;
        this.activeTurnId = p.turn.id;
        this.usage.beginTurn(p.turn.id);
        return [
          {
            type: "turn.started",
            payload: {
              ...(this.turnModel !== null ? { model: this.turnModel } : {}),
              ...(this.turnEffort !== null ? { effort: this.turnEffort } : {})
            },
            turnId: p.turn.id,
            providerRefs: { providerTurnId: p.turn.id },
            raw: raw()
          }
        ];
      }
      case "turn/completed": {
        const p = params as CodexProtocol.v2.TurnCompletedNotification;
        const state = turnState(p.turn.status);
        const interrupted = state === "interrupted" || state === "cancelled";
        // NOTE: `p.turn.items` is `[]` with `itemsView:"notLoaded"` on an
        // interrupted turn — a fold that trusts it erases the turn (fixtures
        // README observation 3). Nothing here reads it.
        const tokenUsage = this.usage.completeTurn(p.turn.id, {
          interrupted,
          hasSubagents: this.knownAgentPaths.size > 0
        });
        const errorMessage = p.turn.error?.message ?? this.lastTurnError ?? undefined;
        if (this.activeTurnId === p.turn.id) {
          this.activeTurnId = null;
        }
        this.lastTurnError = null;
        return [
          {
            type: "turn.completed",
            payload: {
              state,
              tokenUsage,
              ...(errorMessage !== undefined ? { errorMessage: presentableError(errorMessage) } : {})
            },
            turnId: p.turn.id,
            providerRefs: { providerTurnId: p.turn.id },
            raw: raw()
          }
        ];
      }
      case "turn/diff/updated": {
        const p = params as CodexProtocol.v2.TurnDiffUpdatedNotification;
        // Cumulative and repeated — five notifications for two distinct diffs
        // in `11-…`. De-duplicate on CONTENT, not on arrival.
        if (p.diff === this.lastDiff) {
          return [];
        }
        this.lastDiff = p.diff;
        return [
          {
            type: "turn.diff.updated",
            payload: { unifiedDiff: p.diff },
            turnId: p.turnId,
            providerRefs: { providerTurnId: p.turnId },
            raw: raw()
          }
        ];
      }
      case "turn/plan/updated": {
        const p = params as CodexProtocol.v2.TurnPlanUpdatedNotification;
        return [
          {
            type: "turn.plan.updated",
            payload: {
              explanation: p.explanation,
              plan: p.plan.map((step) => ({ step: step.step, status: step.status }))
            },
            turnId: p.turnId,
            providerRefs: { providerTurnId: p.turnId },
            raw: raw()
          }
        ];
      }

      // ----------------------------------------------------------------- items
      case "item/started":
      case "item/completed": {
        const p = params as
          | CodexProtocol.v2.ItemStartedNotification
          | CodexProtocol.v2.ItemCompletedNotification;
        return this.itemLifecycle(method === "item/started" ? "started" : "completed", p, raw());
      }
      case "item/fileChange/patchUpdated": {
        const p = params as CodexProtocol.v2.FileChangePatchUpdatedNotification;
        return [
          {
            type: "item.updated",
            payload: { itemType: "file_change", status: "inProgress", data: p },
            turnId: p.turnId,
            itemId: p.itemId,
            providerRefs: { providerTurnId: p.turnId, providerItemId: p.itemId },
            raw: raw()
          }
        ];
      }
      case "item/mcpToolCall/progress": {
        const p = params as CodexProtocol.v2.McpToolCallProgressNotification;
        return [
          {
            type: "tool.progress",
            payload: {
              toolUseId: p.itemId,
              ...(typeof p.message === "string" && p.message.length > 0
                ? { summary: p.message }
                : {})
            },
            turnId: p.turnId,
            itemId: p.itemId,
            providerRefs: { providerTurnId: p.turnId, providerItemId: p.itemId },
            raw: raw()
          }
        ];
      }

      // --------------------------------------------------------------- content
      case "item/agentMessage/delta": {
        const p = params as CodexProtocol.v2.AgentMessageDeltaNotification;
        return [this.contentDelta("assistant_text", p.delta, p.turnId, p.itemId, raw())];
      }
      case "item/reasoning/textDelta": {
        const p = params as CodexProtocol.v2.ReasoningTextDeltaNotification;
        return [this.contentDelta("reasoning_text", p.delta, p.turnId, p.itemId, raw())];
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as CodexProtocol.v2.ReasoningSummaryTextDeltaNotification;
        return [this.contentDelta("reasoning_summary_text", p.delta, p.turnId, p.itemId, raw())];
      }
      case "item/commandExecution/outputDelta": {
        // Never fired in the captures — short commands deliver their whole
        // output in `item/completed.aggregatedOutput` instead, which is why
        // `content.delta {command_output}` cannot be the only path to command
        // output (fixtures README observation 18).
        const p = params as CodexProtocol.v2.CommandExecutionOutputDeltaNotification;
        return [this.contentDelta("command_output", p.delta, p.turnId, p.itemId, raw())];
      }
      case "item/fileChange/outputDelta": {
        const p = params as CodexProtocol.v2.FileChangeOutputDeltaNotification;
        return [this.contentDelta("file_change_output", p.delta, p.turnId, p.itemId, raw())];
      }
      case "item/plan/delta": {
        const p = params as CodexProtocol.v2.PlanDeltaNotification;
        return [
          {
            type: "turn.proposed.delta",
            payload: { delta: p.delta },
            turnId: p.turnId,
            itemId: p.itemId,
            providerRefs: { providerTurnId: p.turnId, providerItemId: p.itemId },
            raw: raw()
          }
        ];
      }

      // ----------------------------------------------------------------- hooks
      // §4.2 marks the hook group "Claude only" — it is a Codex notification
      // too, and on an Orquester host it is ALWAYS present because the daemon
      // installs its own agent hooks: 140 started + 140 completed across the
      // captures (fixtures README observation 18).
      case "hook/started": {
        const p = params as CodexProtocol.v2.HookStartedNotification;
        return [
          {
            type: "hook.started",
            payload: {
              hookId: p.run.id,
              hookName: hookName(p.run),
              hookEvent: p.run.eventName
            },
            ...(p.turnId !== null ? { turnId: p.turnId } : {}),
            raw: raw()
          }
        ];
      }
      case "hook/completed": {
        const p = params as CodexProtocol.v2.HookCompletedNotification;
        const stderr = hookStderr(p.run);
        return [
          {
            type: "hook.completed",
            payload: {
              hookId: p.run.id,
              outcome: hookOutcome(p.run.status),
              ...(stderr !== undefined ? { stderr } : {})
            },
            ...(p.turnId !== null ? { turnId: p.turnId } : {}),
            raw: raw()
          }
        ];
      }

      // -------------------------------------------------------------- warnings
      case "error": {
        const p = params as CodexProtocol.v2.ErrorNotification;
        const message = presentableError(p.error.message);
        this.lastTurnError = p.error.message;
        // `willRetry` maps DIRECTLY onto §10's "retryable provider errors are
        // runtime.warning, terminal ones runtime.error" — no heuristic needed
        // (fixtures README observation 13).
        if (p.willRetry) {
          return [
            {
              type: "runtime.warning",
              payload: { message, detail: { codexErrorInfo: p.error.codexErrorInfo } },
              ...(p.turnId.length > 0 ? { turnId: p.turnId } : {}),
              raw: raw()
            }
          ];
        }
        return [
          {
            type: "runtime.error",
            payload: {
              message,
              class: errorClassOf(p.error.codexErrorInfo),
              detail: { codexErrorInfo: p.error.codexErrorInfo }
            },
            ...(p.turnId.length > 0 ? { turnId: p.turnId } : {}),
            raw: raw()
          }
        ];
      }
      case "warning": {
        const p = params as CodexProtocol.v2.WarningNotification;
        return [{ type: "runtime.warning", payload: { message: p.message }, raw: raw() }];
      }
      case "guardianWarning": {
        const p = params as CodexProtocol.v2.GuardianWarningNotification;
        return [{ type: "runtime.warning", payload: { message: p.message }, raw: raw() }];
      }
      case "configWarning": {
        // §4.2 deliberately has no `config.warning` arm; surfacing it as a
        // runtime warning is what keeps §10's "never dropped by a catch-all".
        // It arrives BEFORE the first request, so the session must already be
        // listening (fixtures README observation 18) — on this host it is
        // always the bubblewrap notice.
        const p = params as CodexProtocol.v2.ConfigWarningNotification;
        return [
          {
            type: "runtime.warning",
            payload: {
              message: p.summary,
              ...(p.details !== null ? { detail: p.details } : {})
            },
            raw: raw()
          }
        ];
      }
      case "deprecationNotice": {
        const p = params as CodexProtocol.v2.DeprecationNoticeNotification;
        return [
          {
            type: "runtime.warning",
            payload: {
              message: p.summary,
              ...(p.details !== null ? { detail: p.details } : {})
            },
            raw: raw()
          }
        ];
      }
      case "windows/worldWritableWarning": {
        const p = params as CodexProtocol.v2.WindowsWorldWritableWarningNotification;
        return [{ type: "runtime.warning", payload: { message: JSON.stringify(p) }, raw: raw() }];
      }

      // --------------------------------------------------------------- account
      case "account/rateLimits/updated": {
        const p = params as CodexProtocol.v2.AccountRateLimitsUpdatedNotification;
        return [
          {
            type: "account.rate-limits.updated",
            payload: { limits: { windows: usageWindowsFromRateLimits(p.rateLimits) } },
            raw: raw()
          }
        ];
      }
      case "account/login/completed": {
        const p = params as CodexProtocol.v2.AccountLoginCompletedNotification;
        return [
          {
            type: "auth.status",
            payload: {
              isAuthenticating: false,
              ...(p.error !== null ? { error: p.error } : {})
            },
            raw: raw()
          }
        ];
      }
      case "modelProvider/authRecoveryStarted":
        return [{ type: "auth.status", payload: { isAuthenticating: true }, raw: raw() }];
      case "modelProvider/authRecoveryCompleted":
        return [{ type: "auth.status", payload: { isAuthenticating: false }, raw: raw() }];

      // ----------------------------------------------------------------- model
      case "model/rerouted": {
        const p = params as CodexProtocol.v2.ModelReroutedNotification;
        return [
          {
            type: "model.rerouted",
            payload: { fromModel: p.fromModel, toModel: p.toModel, reason: p.reason },
            turnId: p.turnId,
            providerRefs: { providerTurnId: p.turnId },
            raw: raw()
          }
        ];
      }

      // ------------------------------------------------------- handled, no arm
      //
      // Every method below is KNOWN and deliberately produces no runtime event.
      // Listing them one by one rather than letting a default arm swallow them
      // is the whole point of §10: adding a notification to the protocol
      // breaks this switch instead of silently disappearing.
      case "thread/settings/updated": // sticky thread config; read by the session, not the timeline
      case "thread/reverted": // §5.5 revert is host-orchestrated; the ack adds nothing
      case "thread/goal/updated":
      case "thread/goal/cleared": // arrives unprompted after every resume
      case "thread/queue/changed":
      case "thread/project/updated":
      case "thread/environment/connected":
      case "thread/environment/disconnected":
      case "project/changed":
      case "skills/changed": // a probe-refresh signal, not a timeline row
      case "fs/changed":
      case "serverRequest/resolved": // our own answer's ack; request.resolved is emitted by the handler
      case "item/reasoning/summaryPartAdded":
      case "item/commandExecution/terminalInteraction":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "autoApprovalReview/strictReviewRequired":
      case "rawResponseItem/completed":
      case "rawResponse/completed":
      case "command/exec/outputDelta": // the standalone exec API, not a thread item
      case "process/outputDelta":
      case "process/exited":
      case "mcpServer/startupStatus/updated": // 190 across the captures; pure noise
      case "mcpServer/oauthLogin/completed": // §4.2 excludes `mcp.oauth.completed`
      case "mcpServer/event/stream/notification":
      case "account/updated": // §4.2 excludes `account.updated`
      case "app/list/updated":
      case "remoteControl/status/changed":
      case "externalAgentConfig/import/progress":
      case "externalAgentConfig/import/completed":
      case "model/verification":
      case "model/safetyBuffering/updated":
      case "turn/moderationMetadata":
      case "fuzzyFileSearch/sessionUpdated":
      case "fuzzyFileSearch/sessionCompleted":
      case "windowsSandbox/setupCompleted":
      // §4.2 excludes every `thread.realtime.*`; voice mode is out of scope (§2).
      case "thread/realtime/started":
      case "thread/realtime/itemAdded":
      case "thread/realtime/item/started":
      case "thread/realtime/item/transcript/delta":
      case "thread/realtime/item/completed":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/error":
      case "thread/realtime/closed":
        return [];

      default: {
        // A method the generated catalogue does not contain. The `never` proves
        // every catalogued method is handled above; the runtime arm surfaces
        // the unknown one as a warning (§10) and NEVER ends the turn.
        const exhaustive: never = method;
        return [
          {
            type: "runtime.warning",
            payload: {
              message: `Unrecognised codex notification: ${String(exhaustive)}`,
              detail: params
            },
            raw: raw()
          }
        ];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private itemLifecycle(
    phase: "started" | "completed",
    p: CodexProtocol.v2.ItemStartedNotification | CodexProtocol.v2.ItemCompletedNotification,
    raw: RuntimeEventRaw
  ): RuntimeEventDraft[] {
    const item = p.item as CodexThreadItem;
    const classified = classifyItem(item);
    const events: RuntimeEventDraft[] = [];

    if (classified.unknownType !== undefined) {
      events.push({
        type: "runtime.warning",
        payload: {
          message: `Unrecognised codex item type: ${classified.unknownType}`,
          detail: { itemId: item.id }
        },
        turnId: p.threadId.length > 0 ? p.turnId : undefined,
        raw
      });
    }

    if (phase === "started") {
      this.openItems.set(item.id, classified.itemType);
    } else {
      this.openItems.delete(item.id);
    }

    const base = {
      turnId: p.turnId,
      itemId: item.id,
      providerRefs: { providerTurnId: p.turnId, providerItemId: item.id }
    } as const;

    events.push({
      type: phase === "started" ? "item.started" : "item.completed",
      payload: {
        itemType: classified.itemType,
        ...(classified.status !== undefined ? { status: classified.status } : {}),
        ...(classified.title !== undefined ? { title: classified.title } : {}),
        ...(classified.detail !== undefined ? { detail: classified.detail } : {}),
        ...(classified.data !== undefined ? { data: classified.data } : {})
      },
      ...base,
      raw
    });

    // The plan item's completed text is the proposal §4.2 shows as a plan card;
    // `item/plan/delta` streamed it, and this is the authoritative final form.
    if (phase === "completed" && item.type === "plan") {
      events.push({
        type: "turn.proposed.completed",
        payload: { planMarkdown: item.text },
        ...base,
        raw
      });
    }

    // Compaction on this CLI is a whole extra turn signalled by this item
    // (fixtures README observation 8), so the §4.2 `compacted` thread state has
    // to be synthesised here.
    if (phase === "completed" && item.type === "contextCompaction") {
      events.push({
        type: "thread.state.changed",
        payload: { state: "compacted", afterTokens: this.usage.threadUsage().usedTokens },
        ...base,
        raw
      });
    }

    if (item.type === "subAgentActivity") {
      events.push(...this.subAgentActivity(item, p.turnId, raw));
    }

    return events;
  }

  /**
   * `subAgentActivity` → the §4.2 task events.
   *
   * **The trap (§4.5).** Codex emits `subAgentActivity {agentPath:"/root"}`
   * *about the root thread*; registering that as its own child made threads
   * hang "working" forever. The root path is therefore never a task.
   */
  private subAgentActivity(
    item: Extract<CodexThreadItem, { type: "subAgentActivity" }>,
    turnId: string,
    raw: RuntimeEventRaw
  ): RuntimeEventDraft[] {
    if (isRootAgentPath(item.agentPath)) {
      return [];
    }
    const linkage = {
      taskType: "subagent",
      agentKind: "agent" as const,
      agentId: item.agentThreadId,
      agentPath: item.agentPath,
      title: agentNameFromPath(item.agentPath)
    };
    const base = {
      turnId,
      itemId: item.id,
      agentId: item.agentThreadId,
      providerRefs: { providerTurnId: turnId, providerItemId: item.id }
    } as const;

    switch (item.kind) {
      case "started":
        this.knownAgentPaths.add(item.agentPath);
        return [
          {
            type: "task.started",
            payload: { taskId: item.agentThreadId, description: linkage.title, ...linkage },
            ...base,
            raw
          }
        ];
      case "interacted":
        return [
          {
            type: "task.progress",
            payload: {
              taskId: item.agentThreadId,
              description: linkage.title,
              status: "running",
              ...linkage
            },
            ...base,
            raw
          }
        ];
      case "interrupted":
        this.knownAgentPaths.delete(item.agentPath);
        return [
          {
            type: "task.completed",
            payload: { taskId: item.agentThreadId, status: "stopped", ...linkage },
            ...base,
            raw
          }
        ];
      case "completed":
        this.knownAgentPaths.delete(item.agentPath);
        return [
          {
            type: "task.completed",
            payload: { taskId: item.agentThreadId, status: "completed", ...linkage },
            ...base,
            raw
          }
        ];
      default: {
        const exhaustive: never = item.kind;
        return [
          {
            type: "runtime.warning",
            payload: { message: `Unrecognised subAgentActivity kind: ${String(exhaustive)}` },
            ...base,
            raw
          }
        ];
      }
    }
  }

  private contentDelta(
    streamKind: RuntimeContentStreamKind,
    delta: string,
    turnId: string,
    itemId: string,
    raw: RuntimeEventRaw
  ): RuntimeEventDraft {
    return {
      type: "content.delta",
      payload: { streamKind, delta },
      turnId,
      itemId,
      providerRefs: { providerTurnId: turnId, providerItemId: itemId },
      raw
    };
  }
}

// ---------------------------------------------------------------------------
// Request classification (§4.3)
// ---------------------------------------------------------------------------

/** Server→client request method → §4.3's canonical request type. */
export function canonicalRequestType(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation_approval";
    case "item/permissions/requestApproval":
      return "permission_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    default:
      return "unknown";
  }
}

/** `ProviderRequestKind` (§5.1), the coarser bucket the persisted row carries. */
export function providerRequestKind(
  requestType: CanonicalRequestType
): "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission" {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return "permission";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function threadState(
  status: CodexProtocol.v2.ThreadStatus
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    case "notLoaded":
    case "active":
      return "active";
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return "active";
    }
  }
}

function turnState(status: CodexProtocol.v2.TurnStatus): RuntimeTurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "inProgress":
      // A `turn/completed` that still claims `inProgress` is a protocol
      // contradiction; settle it rather than leaving the turn live for ever.
      return "completed";
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return "completed";
    }
  }
}

/**
 * Codex's error `message` is frequently a **JSON string**, not prose
 * (fixtures README observation 13), so it needs a second parse before it is
 * presentable — and it may not be JSON at all.
 */
export function presentableError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return truncate(trimmed);
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const inner = extractMessage(parsed);
    return truncate(inner ?? trimmed);
  } catch {
    return truncate(trimmed);
  }
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }
  if (typeof record.error === "object" && record.error !== null) {
    return extractMessage(record.error);
  }
  return undefined;
}

/**
 * The unknown-method error enumerates the entire ~8 KB client-request
 * catalogue; never log or surface one verbatim (fixtures README observation 13).
 */
const MAX_ERROR_CHARS = 600;

function truncate(value: string): string {
  return value.length <= MAX_ERROR_CHARS ? value : `${value.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function errorClassOf(info: CodexProtocol.v2.CodexErrorInfo | null): RuntimeErrorClass {
  if (info === null) {
    return "unknown";
  }
  if (typeof info !== "string") {
    if ("httpConnectionFailed" in info || "responseStreamConnectionFailed" in info) {
      return "transport_error";
    }
    if ("responseStreamDisconnected" in info || "responseTooManyFailedAttempts" in info) {
      return "transport_error";
    }
    return "provider_error";
  }
  switch (info) {
    case "unauthorized":
      return "permission_error";
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
    case "sandboxError":
      return "permission_error";
    case "badRequest":
      return "validation_error";
    case "internalServerError":
    case "serverOverloaded":
    case "rateLimitExceeded":
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
    case "contextWindowExceeded":
    case "threadRollbackFailed":
      return "provider_error";
    case "other":
      return "unknown";
    default:
      return "provider_error";
  }
}

/**
 * The root thread's own path. `subAgentActivity {agentPath:"/root"}` is ABOUT
 * the root thread and must never become a child task (§4.5 "Trap").
 */
function isRootAgentPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed === "" || trimmed === "/" || trimmed === "/root";
}

function agentNameFromPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** A hook has no name field; its source path is what identifies it to a user. */
function hookName(run: CodexProtocol.v2.HookRunSummary): string {
  const file = run.sourcePath.split("/").filter((part) => part.length > 0).at(-1);
  return file !== undefined && file.length > 0 ? file : run.handlerType;
}

function hookOutcome(status: CodexProtocol.v2.HookRunStatus): "success" | "error" | "cancelled" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "blocked":
      return "error";
    case "stopped":
      return "cancelled";
    case "running":
      // A completion notification that still says `running` is a
      // contradiction; treat it as success rather than leaving the row live.
      return "success";
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return "success";
    }
  }
}

function hookStderr(run: CodexProtocol.v2.HookRunSummary): string | undefined {
  const lines = run.entries
    .filter((entry) => entry.kind === "error" || entry.kind === "warning")
    .map((entry) => entry.text)
    .filter((text) => text.length > 0);
  if (lines.length === 0) {
    return run.statusMessage !== null && run.statusMessage.length > 0
      ? run.statusMessage
      : undefined;
  }
  return lines.join("\n");
}
