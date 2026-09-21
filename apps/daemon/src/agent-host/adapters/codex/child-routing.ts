/**
 * Codex adapter — routing notifications that belong to a COLLAB CHILD thread
 * (spec §4.5 Codex "Trap"; R3 finding 2).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts:1080-1131`
 * (`routeCodexChildNotification`).
 *
 * Codex runs collab children as **separate threads on the same `app-server`
 * connection**. Every notification therefore carries a `threadId`, and one that
 * is not ours must never be folded into our own turn: a child's `turn/started`
 * would overwrite `activeTurnId` and reset the usage baseline, its
 * `turn/completed` would settle the parent's live turn, and its
 * `thread/compacted` / `thread/archived` / repeat `thread/started` would
 * rewrite the parent's thread state.
 *
 * The spec's own warning is why the default is `"parent"` and not `"drop"`:
 *
 * > *Unknown child methods default to "pass to parent", not "drop" — two
 * > shipped bugs came from a catch-all.*
 */

/**
 * What to do with a notification whose `threadId` is not the session's own.
 *
 * - `agent-event` — the child's own lifecycle; becomes `task.*` rows on the
 *   child's agent id, never the parent's turn.
 * - `drop` — child chatter that would rewrite parent state if forwarded.
 * - `parent` — parent-owned or unknown; forwarded unchanged.
 */
export type CodexChildNotificationRoute = "agent-event" | "parent" | "drop";

/** The child's own lifecycle. *T3: `CodexSessionRuntime.ts:1084-1095`.* */
export const CHILD_AGENT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/settings/updated",
  "model/rerouted",
  "item/started",
  "item/completed",
  "thread/closed",
  "error"
]);

/**
 * Child chatter. The three `thread/*` lifecycle entries and the repeat
 * `thread/started` are the load-bearing ones: the parent adapter maps them onto
 * the PARENT thread, so a child compacting would rewrite the parent's state.
 *
 * *T3: `CodexSessionRuntime.ts:1097-1119`.*
 */
export const CHILD_CHATTER_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/name/updated",
  "rawResponseItem/completed",
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  "thread/started"
]);

export function routeCodexChildNotification(method: string): CodexChildNotificationRoute {
  if (CHILD_AGENT_EVENT_METHODS.has(method)) {
    return "agent-event";
  }
  if (CHILD_CHATTER_METHODS.has(method)) {
    return "drop";
  }
  // Unknown, or parent-owned (`serverRequest/resolved`, approvals, …).
  return "parent";
}

/**
 * The `threadId` a notification is about, or `null` when the shape carries
 * none.
 *
 * Two arms need special handling: `thread/started` nests it under `thread.id`
 * (fixtures README obs. 1), and `account/rateLimits/updated` is
 * connection-scoped rather than thread-scoped so it has none at all — a `null`
 * here means "not thread-scoped", which the caller treats as ours.
 */
export function notificationThreadId(method: string, params: unknown): string | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const record = params as Record<string, unknown>;
  if (method === "thread/started") {
    const thread = record.thread;
    if (typeof thread === "object" && thread !== null) {
      const id = (thread as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? id : null;
    }
    return null;
  }
  const threadId = record.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}
