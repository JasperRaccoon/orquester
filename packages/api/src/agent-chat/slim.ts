/**
 * Agent chat — activity payload slimming (spec §5.6).
 *
 * **Signature only. Package W2 implements the body.**
 * Ported from T3 Code (MIT): `apps/server/src/orchestration/ActivityPayloadProjection.ts`.
 *
 * The full payload is persisted and this runs before anything goes on the
 * wire — with one exception: a `tool.updated` row is persisted **already
 * slimmed**, because a streaming update's `data` carries the whole tool output
 * accumulated so far and a new row is written per chunk, so persisting it
 * verbatim writes O(N²) bytes for one tool call. The matching `tool.completed`
 * row persists the full payload and is what `GET …/items/:itemId` reads.
 *
 * Rules the implementation owes:
 * - cap any string at {@link SLIM_MAX_STRING_BYTES} on the wire, keeping the
 *   full value on disk, and stamp `truncated: true` so the UI can offer "load
 *   full output";
 * - rebuild `payload.data` from an **allow-list** rather than truncating in
 *   place — the size is in the structure, not in one long string;
 * - an MCP tool call keeps `type, id, tool, server, status, arguments,
 *   appContext, error, durationMs` and nothing else, and its `result` is
 *   reduced to a one-line summary;
 * - tool text output is summarised to the first meaningful line, elided at
 *   {@link SLIM_SUMMARY_ELIDE_CHARS}, or to `"N lines"` when there is no
 *   single renderable line;
 * - changed files are a path list, at most {@link SLIM_MAX_CHANGED_FILES}
 *   entries and {@link SLIM_MAX_CHANGED_FILE_DEPTH} levels deep;
 * - a payload whose top-level `status` is `completed` while its nested item
 *   status is `failed` or `declined` is **re-stamped** with the item status,
 *   so a failed tool never renders as a success.
 */

/** Any string in an activity payload is capped at this on the wire. */
export const SLIM_MAX_STRING_BYTES = 16 * 1024;
/** Tool text output is elided at this many characters. */
export const SLIM_SUMMARY_ELIDE_CHARS = 84;
export const SLIM_MAX_CHANGED_FILES = 12;
export const SLIM_MAX_CHANGED_FILE_DEPTH = 4;

/** Fields an MCP tool call keeps. *T3: `ActivityPayloadProjection.ts:190-207`.* */
export const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs"
] as const;

/**
 * The single choke point every read passes through (§5.6). Returns the value
 * unchanged (same reference) when nothing needed slimming, so a snapshot of
 * small rows costs no allocation.
 */
export function slimActivityPayload(payload: unknown): unknown {
  void payload;
  throw new Error("agent-chat: slimActivityPayload not implemented (package W2)");
}
