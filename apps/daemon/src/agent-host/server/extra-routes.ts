/**
 * Agent host — the two host-local routes the shared `agentHostRoutes` table
 * does not carry (spec §5.1 attachments, §6.4 derived summary fields).
 *
 * They live here rather than in `host-protocol.ts` because that file is the
 * foundation package's and changes to it are additive-only and shared; these
 * are host↔daemon internals that no client ever sees. **W10**: import the path
 * builders from here rather than hand-writing the strings.
 */

import type {
  AccountHomeKind,
  AgentChatSessionSummaryFields,
  ProviderUsageWindow
} from "@orquester/api/agent-chat";

const thread = (threadId: string): string => `/threads/${encodeURIComponent(threadId)}`;

export const agentHostExtraRoutes = {
  /**
   * `POST` the file bytes as `application/octet-stream` with `name` and
   * optional `type` in the query string — the same shape
   * `POST /api/sessions/:id/upload` already uses (AGENTS.md: uploads are raw
   * binary streams, never base64 JSON). The host claims the file into the
   * thread's attachment namespace and answers the {@link AttachmentRef}
   * together with its absolute `path` (§7.4).
   */
  putAttachment: (threadId: string): string => `${thread(threadId)}/attachments`,

  /** Resolve an attachment id to its absolute host path. */
  attachment: (threadId: string, attachmentId: string): string =>
    `${thread(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,

  /**
   * The seven derived `SessionSummary` fields of §6.4 (goals §4.7 added
   * `goal`). `backgroundLiveness` is in-memory in the host, so the daemon
   * cannot compute it from the log.
   */
  summary: (threadId: string): string => `${thread(threadId)}/summary`
} as const;

/**
 * One open request, as `GET …/summary` reports it. The daemon publishes
 * `agentChat.pending {id, requestId, kind, title, open}` from this (§6.4); the
 * booleans on {@link AgentChatSessionSummaryFields} say *that* something is
 * pending, not *which*, and a coarse bus event needs the id and a label.
 */
export interface AgentHostPendingRequest {
  requestId: string;
  kind: "approval" | "question";
  /** A short label for the notification. Never the full tool payload. */
  title: string;
}

/**
 * `GET …/summary`. The seven §6.4 fields the daemon hangs on `SessionSummary`,
 * plus the open requests behind two of those booleans.
 */
export interface AgentHostThreadSummary extends AgentChatSessionSummaryFields {
  pendingRequests: AgentHostPendingRequest[];
  /**
   * The account usage this thread's provider reported last, live, off its own
   * API responses (Claude's `rate_limit_event.unifiedWindows`), under the
   * account the thread ran as when it was reported. The daemon feeds it to its
   * usage service for that account, so usage moves with every model response
   * instead of waiting on the rate-limited usage endpoint. Absent from a host
   * older than the field, and until the thread's provider reports one.
   */
  usageLimits?: AgentHostThreadUsageLimits | null;
}

/** One thread's latest live account usage (see {@link AgentHostThreadSummary.usageLimits}). */
export interface AgentHostThreadUsageLimits {
  /** When the host received the reading (ISO). */
  observedAt: string;
  /** The home and account the thread ran under when the reading arrived. */
  home: AccountHomeKind;
  accountId: string;
  /** Merged by window id across the thread's readings. */
  windows: ProviderUsageWindow[];
}

/** Response of `GET …/attachments/:id`. */
export interface AttachmentPathResponse {
  /** Absolute host path. The daemon streams it with its own download route. */
  path: string;
}
