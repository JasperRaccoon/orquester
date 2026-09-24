// Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:400-1012
/**
 * The pure half of ingestion: one {@link RuntimeEvent} in, zero or more
 * {@link ThreadActivityItem} rows out (spec §5.1 "Ingestion rules").
 *
 * Nothing here touches state, time or the sink, so every rule in §5.1 is one
 * table-driven test case. The stateful half — message buffering, segmenting,
 * session status, coalescing — lives in `index.ts`.
 *
 * The rules enforced here, once, so no adapter decides them:
 * - `request.opened` / `request.resolved` become `approval.requested` /
 *   `approval.resolved`, **except** `tool_user_input`, which is dropped
 *   because it is a question, not an approval; the native request type is
 *   rewritten to the canonical kind and **both** are persisted;
 * - item lifecycle rows exist only for the tool-shaped item types
 *   ({@link isToolLifecycleItemType}), so `review_entered` / `review_exited`,
 *   `assistant_message`, `reasoning`, `plan`, `context_compaction`, `error`
 *   and `unknown` are dropped from the activity path;
 * - `thread.token-usage.updated` becomes `context-window.updated`, dropped
 *   when `usedTokens` is negative;
 * - `task.*` rows carry the whole linkage bundle on **every** row, with
 *   `agentKind` stamped once here;
 * - `thread.goal.updated` becomes one `goal.updated` row carrying its payload
 *   verbatim — a hidden `progress` tick under one stable id per thread,
 *   replaced in place — and a goal event replayed from history becomes none
 *   (goals §4.3);
 * - `auth.status` and `account.rate-limits.updated` are not thread facts and
 *   produce nothing (§6.3 updates the provider snapshot instead).
 */

import {
  GOAL_ACTIVITY_KIND,
  classifyTaskAgentKind,
  goalActivitySummary,
  isHiddenGoalChange,
  isHistoricalRuntimeEvent,
  isToolLifecycleItemType,
  type ProviderRequestKind,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadActivityTone
} from "@orquester/api/agent-chat";

import {
  goalProgressActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
  toolProgressActivityId
} from "./message-ids.ts";
import { truncateDetail } from "./text-boundary.ts";

/**
 * Rewrite a provider's native request type to the canonical approval kind
 * (§5.1). Deliberately NOT `requestKindFromRequestType` from
 * `@orquester/api/agent-chat`: that one is the *client-side* reader, which
 * additionally folds `dynamic_tool_call` into `command` so older rows
 * classify. At ingestion T3 keeps `dynamic_tool_call` unmapped, and the spec's
 * rewrite list does too.
 *
 * *T3: `ProviderRuntimeIngestion.ts:400-419` vs
 * `packages/client-runtime/src/pendingRequests.ts:48-65`.*
 */
export function requestKindFromCanonicalRequestType(
  requestType: string | undefined
): ProviderRequestKind | undefined {
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
    case "permission_approval":
      return "permission";
    default:
      return undefined;
  }
}

function approvalSummary(requestKind: ProviderRequestKind | undefined): string {
  switch (requestKind) {
    case "command":
      return "Command approval requested";
    case "file-read":
      return "File-read approval requested";
    case "file-change":
      return "File-change approval requested";
    case "mcp-elicitation":
      return "App access approval requested";
    case "permission":
      return "App permission approval requested";
    default:
      return "Approval requested";
  }
}

/**
 * The optional `TaskAgentLinkage` bundle, copied onto every task row so a
 * client fold can rebuild an agent whose `task.started` row aged out of
 * activity retention (§4.2). `agentKind` is stamped here and ONLY here:
 * persisted rows are self-describing and clients trust the stamp instead of
 * re-deriving agent-vs-background from task-type denylists.
 */
const TASK_LINKAGE_KEYS = [
  "taskType",
  "agentId",
  "title",
  "role",
  "model",
  "effort",
  "toolUseId",
  "parentAgentId",
  "workflowName",
  "agentIndex",
  "phaseIndex",
  "phaseTitle",
  "phases",
  "attempt",
  "runHandles",
  "outputFile",
  "agentPath",
  "timelineBypass",
  "status",
  "error"
] as const;

export function taskLinkageActivityFields(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined
    })
  };
  for (const key of TASK_LINKAGE_KEYS) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

interface ActivityInit {
  id: string;
  tone: ThreadActivityTone;
  activityKind: string;
  summary: string;
  payload: Record<string, unknown>;
  agentId?: string;
  parentToolUseId?: string;
  status?: ThreadActivityItem["status"];
}

function makeActivity(event: RuntimeEvent, init: ActivityInit): ThreadActivityItem {
  return {
    kind: "activity",
    id: init.id,
    tone: init.tone,
    activityKind: init.activityKind,
    summary: init.summary,
    payload: init.payload,
    turnId: event.turnId !== undefined ? String(event.turnId) : null,
    ...(init.agentId !== undefined ? { agentId: init.agentId } : {}),
    ...(init.parentToolUseId !== undefined ? { parentToolUseId: init.parentToolUseId } : {}),
    ...(init.status !== undefined ? { status: init.status } : {}),
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };
}

/**
 * Item-lifecycle rows share one payload shape. `toolUseId` is the runtime item
 * id and is **stable across a call's whole lifecycle** — it is what the §7.3
 * resolver groups on and what the §5.6 coalescer keys on.
 */
function toolLifecyclePayload(
  event: Extract<RuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }>
): Record<string, unknown> {
  const p = event.payload;
  return {
    itemType: p.itemType,
    ...(event.itemId !== undefined ? { toolUseId: event.itemId } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.detail !== undefined ? { detail: truncateDetail(p.detail) } : {}),
    ...(p.data !== undefined ? { data: p.data } : {}),
    ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
    ...(p.parentToolUseId !== undefined ? { parentToolUseId: p.parentToolUseId } : {})
  };
}

/**
 * Translate one runtime event into the activity rows it produces. Pure: the
 * caller supplies everything that is not on the event itself.
 *
 * `taskTitle` is the remembered description for a `task.completed` row — task
 * names arrive on `task.started`/`task.progress` but not on the completion.
 */
export function runtimeEventToActivities(
  event: RuntimeEvent,
  options: { readonly taskTitle?: string } = {}
): ThreadActivityItem[] {
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "approval",
          activityKind: "approval.requested",
          summary: approvalSummary(requestKind),
          payload: {
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(requestKind !== undefined ? { requestKind } : {}),
            requestType: event.payload.requestType,
            dismissible: event.payload.dismissible,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
            ...(event.payload.appName !== undefined ? { appName: event.payload.appName } : {}),
            ...(event.payload.options !== undefined ? { options: event.payload.options } : {}),
            ...(event.payload.args !== undefined ? { args: event.payload.args } : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "approval",
          activityKind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(requestKind !== undefined ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision !== undefined
              ? { decision: event.payload.decision }
              : {}),
            ...(event.payload.resolution !== undefined
              ? { resolution: event.payload.resolution }
              : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "user-input.requested": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            dismissible: event.payload.dismissible,
            ...(event.payload.responseMode !== undefined
              ? { responseMode: event.payload.responseMode }
              : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "user-input.resolved": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            answers: event.payload.answers
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "runtime.error": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "error",
          activityKind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
            class: event.payload.class,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "runtime.warning": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "runtime.warning",
          // The adapter-supplied message is the row label, so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "tool.denied": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "error",
          activityKind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId !== undefined
              ? { toolUseId: event.payload.toolUseId }
              : {}),
            ...(event.payload.reason !== undefined
              ? { detail: truncateDetail(event.payload.reason) }
              : {}),
            ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
          },
          ...(event.payload.agentId !== undefined
            ? { agentId: event.payload.agentId }
            : event.agentId !== undefined
              ? { agentId: event.agentId }
              : {})
        })
      ];
    }

    case "model.rerouted": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "model.rerouted",
          summary: `Model rerouted to ${event.payload.toModel}`,
          payload: {
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            reason: truncateDetail(event.payload.reason)
          }
        })
      ];
    }

    case "turn.plan.updated": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined && event.payload.explanation !== null
              ? { explanation: event.payload.explanation }
              : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "hook.started": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "hook.started",
          summary: `Hook ${event.payload.hookName} started`,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent: event.payload.hookEvent
          }
        })
      ];
    }

    case "hook.progress": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "hook.progress",
          summary: "Hook progress",
          payload: {
            hookId: event.payload.hookId,
            ...(event.payload.stdout !== undefined ? { stdout: event.payload.stdout } : {}),
            ...(event.payload.stderr !== undefined ? { stderr: event.payload.stderr } : {})
          }
        })
      ];
    }

    case "hook.completed": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: event.payload.outcome === "error" ? "error" : "info",
          activityKind: "hook.completed",
          summary:
            event.payload.outcome === "error"
              ? "Hook failed"
              : event.payload.outcome === "cancelled"
                ? "Hook cancelled"
                : "Hook completed",
          payload: {
            hookId: event.payload.hookId,
            outcome: event.payload.outcome,
            ...(event.payload.stdout !== undefined ? { stdout: event.payload.stdout } : {}),
            ...(event.payload.stderr !== undefined ? { stderr: event.payload.stderr } : {}),
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {})
          }
        })
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral — item lifecycle already covers it.
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        makeActivity(event, {
          // Same stable-id treatment as task.progress: a heartbeat is "what is
          // this agent doing right now", so one row per task.
          id: toolProgressActivityId(event.threadId, event.payload.taskId),
          tone: "info",
          activityKind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            toolUseId: event.payload.toolUseId,
            ...(event.payload.toolName !== undefined
              ? { toolName: event.payload.toolName }
              : {}),
            ...(event.payload.summary !== undefined
              ? { summary: truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {})
          },
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {})
        })
      ];
    }

    case "task.started": {
      const linkage = taskLinkageActivityFields(event.payload as unknown as Record<string, unknown>);
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType !== undefined
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description !== undefined
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...linkage
          },
          ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
        })
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as unknown as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Separate
      // stable ids stop a reasoning update from replacing the last known token
      // count, and a usage-only tick from blanking the last meaningful line.
      const identityLinkage = { ...linkage };
      delete identityLinkage.status;
      delete identityLinkage.error;
      const description = event.payload.description ?? "";
      const title =
        description.trim().length > 0 ? { title: truncateDetail(description, 120) } : {};
      // T3 gates this on `typedUsage`, a field it carries beside `usage`; our
      // §4.2 payload has one `usage`, so the same intent reads: always a
      // progress row when there is no usage at all, and a progress row beside
      // the usage row whenever the tick also carries real progress content. A
      // usage-only tick produces the usage row alone, which is what stops it
      // blanking the last meaningful activity line.
      const hasProgressState =
        event.payload.usage === undefined ||
        description.trim().length > 0 ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      const rows: ThreadActivityItem[] = [];
      if (hasProgressState) {
        rows.push(
          makeActivity(event, {
            // Stable per-task id: activity is "latest state", not history, so
            // each meaningful tick replaces the last. This bounds a large
            // fleet to one activity row per task.
            id: taskProgressActivityId(event.threadId, event.payload.taskId),
            tone: "info",
            activityKind: "task.progress",
            summary:
              description.trim().length > 0
                ? truncateDetail(description, 120)
                : "Reasoning update",
            payload: {
              taskId: event.payload.taskId,
              ...title,
              detail: truncateDetail(event.payload.summary ?? description),
              ...(event.payload.summary !== undefined
                ? { summary: truncateDetail(event.payload.summary) }
                : {}),
              ...(event.payload.lastToolName !== undefined
                ? { lastToolName: event.payload.lastToolName }
                : {}),
              ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
              ...(event.payload.error !== undefined ? { error: event.payload.error } : {}),
              ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
              ...identityLinkage
            },
            ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
          })
        );
      }
      if (event.payload.usage !== undefined) {
        rows.push(
          makeActivity(event, {
            id: taskUsageActivityId(event.threadId, event.payload.taskId),
            tone: "info",
            activityKind: "task.progress",
            summary: "Task usage updated",
            payload: {
              taskId: event.payload.taskId,
              ...title,
              ...identityLinkage,
              usageSnapshot: true,
              usage: event.payload.usage
            },
            ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
          })
        );
      }
      return rows;
    }

    case "task.updated": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: event.payload.status === "failed" ? "error" : "info",
          activityKind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status !== undefined
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description !== undefined
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt !== undefined ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as unknown as Record<string, unknown>)
          },
          ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
        })
      ];
    }

    case "task.completed": {
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: event.payload.status === "failed" ? "error" : "info",
          activityKind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(options.taskTitle !== undefined
              ? { title: truncateDetail(options.taskTitle, 120) }
              : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary !== undefined
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary)
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as unknown as Record<string, unknown>)
          },
          ...(event.payload.agentId !== undefined ? { agentId: event.payload.agentId } : {})
        })
      ];
    }

    case "thread.state.changed": {
      // Only a compaction is a timeline fact; every other thread state is
      // already carried by the session status. All three of its phases are
      // ONE activity kind — the client renders on `payload.state`, so the
      // in-flight row and its outcome stay the same row shape.
      const { beforeTokens, afterTokens, error, summary } = event.payload;
      const requestId =
        event.requestId !== undefined ? { requestId: event.requestId } : {};
      switch (event.payload.state) {
        case "compacting":
          return [
            makeActivity(event, {
              id: event.eventId,
              tone: "info",
              activityKind: "context-compaction",
              summary: "Compacting context",
              payload: { state: event.payload.state, ...requestId }
            })
          ];
        case "compaction-failed":
          return [
            makeActivity(event, {
              id: event.eventId,
              tone: "error",
              activityKind: "context-compaction",
              summary: "Context compaction failed",
              payload: {
                state: event.payload.state,
                ...(error !== undefined ? { error } : {}),
                ...requestId
              }
            })
          ];
        case "compacted":
          return [
            makeActivity(event, {
              id: event.eventId,
              tone: "info",
              activityKind: "context-compaction",
              // differs from T3, which bakes the token counts into the label
              // server-side: §7.3 formats them client-side from these fields.
              summary: "Context compacted",
              payload: {
                state: event.payload.state,
                ...(beforeTokens !== undefined ? { beforeTokens } : {}),
                ...(afterTokens !== undefined ? { afterTokens } : {}),
                // NOT truncated here, unlike a task's summary: this is the
                // agent's whole memory of everything the compaction dropped,
                // and the only copy of it. §5.6's wire cap still applies on
                // the way out, and `GET …/items/:itemId` serves the rest.
                ...(summary !== undefined ? { summary } : {}),
                ...requestId
              }
            })
          ];
        default:
          return [];
      }
    }

    case "thread.token-usage.updated": {
      const usage = event.payload.usage;
      if (usage === undefined || usage === null || usage.usedTokens < 0) {
        return [];
      }
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "info",
          activityKind: "context-window.updated",
          summary: "Context window updated",
          payload: { ...usage }
        })
      ];
    }

    case "thread.goal.updated": {
      // Never projected from history (goals §4.3): a replayed goal is the
      // past, and the fold would take it for the provider's current state.
      // The adapters already hold replayed goals back (goals §6); this is the
      // second guard.
      if (isHistoricalRuntimeEvent(event)) {
        return [];
      }
      const { goal, change, previous } = event.payload;
      return [
        makeActivity(event, {
          // A hidden `progress` tick is the goal's latest state, not history:
          // one stable id per thread, so the fold replaces the row in place
          // (the `task-progress:` rule). Every other change is a row of its own.
          id: isHiddenGoalChange(change) ? goalProgressActivityId(event.threadId) : event.eventId,
          tone: change === "failed" ? "error" : "info",
          activityKind: GOAL_ACTIVITY_KIND,
          summary: goalActivitySummary(event.payload),
          // Verbatim: the fold derives the thread's goal from exactly this, and
          // the summary alone is shortened. No `agentId` — a goal is the
          // thread's, never a subagent's.
          payload: { goal, change, ...(previous !== undefined ? { previous } : {}) }
        })
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "tool",
          activityKind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: toolLifecyclePayload(event),
          ...(event.payload.agentId !== undefined
            ? { agentId: event.payload.agentId }
            : event.agentId !== undefined
              ? { agentId: event.agentId }
              : {}),
          ...(event.payload.parentToolUseId !== undefined
            ? { parentToolUseId: event.payload.parentToolUseId }
            : {}),
          ...(event.payload.status !== undefined ? { status: event.payload.status } : {})
        })
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // The caller slims this row BEFORE persisting it (§5.6): a streaming
      // update's `data` carries the whole tool output accumulated so far and a
      // new row is written per chunk, so persisting it verbatim writes O(N²)
      // bytes for one tool call. `item.completed` still persists in full.
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "tool",
          activityKind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: toolLifecyclePayload(event),
          ...(event.payload.agentId !== undefined
            ? { agentId: event.payload.agentId }
            : event.agentId !== undefined
              ? { agentId: event.agentId }
              : {}),
          ...(event.payload.parentToolUseId !== undefined
            ? { parentToolUseId: event.payload.parentToolUseId }
            : {}),
          ...(event.payload.status !== undefined ? { status: event.payload.status } : {})
        })
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        makeActivity(event, {
          id: event.eventId,
          tone: "tool",
          activityKind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: toolLifecyclePayload(event),
          ...(event.payload.agentId !== undefined
            ? { agentId: event.payload.agentId }
            : event.agentId !== undefined
              ? { agentId: event.agentId }
              : {}),
          ...(event.payload.parentToolUseId !== undefined
            ? { parentToolUseId: event.payload.parentToolUseId }
            : {}),
          ...(event.payload.status !== undefined ? { status: event.payload.status } : {})
        })
      ];
    }

    // Messages, session/turn lifecycle, buffered streams and the two account
    // events produce no activity row of their own. They are handled by the
    // stateful half (`index.ts`) or, for `auth.status` /
    // `account.rate-limits.updated`, by the provider snapshot (§6.3) — they
    // are not thread facts.
    case "session.started":
    case "session.state.changed":
    case "session.exited":
    case "thread.started":
    case "thread.metadata.updated":
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
    case "turn.diff.updated":
    case "content.delta":
    case "auth.status":
    case "account.rate-limits.updated":
      return [];

    default: {
      // §10: an unknown frame is surfaced, never dropped by a catch-all.
      const exhaustive: never = event;
      void exhaustive;
      return [];
    }
  }
}
