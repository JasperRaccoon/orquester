/**
 * A tool call's streamed output, joined from its thread's log — the answer of
 * `GET …/items/:itemId/output` ({@link ThreadItemOutputResponse}).
 *
 * Some output exists only as `tool.output` chunks: ingestion's §5.6
 * command-output buffer writes a row per flush, `payload.delta` carrying the
 * text and `payload.toolUseId` the call's item id — a Claude background
 * shell's output, tailed from the file the CLI writes (≤ 1 MiB per shell plus
 * one notice, `support/tail-file.ts`), and a running command's output so far.
 * The GUI joins the chunks onto the call's row (`joinLifecycleDetails`); the
 * snapshot cannot give them back whole (per-agent windows evict chunks, the
 * wire caps every string, history pages are slimmed), so the log is read.
 *
 * Pure over the decoded events: the store runs it after its one `readLog`, the
 * orchestrator over `readAll` for a store without it.
 *
 * It reads the RAW log, and a `thread.reverted` does not filter it: a chunk
 * written in a turn a rewind later removed is still joined. Chunks written
 * before a rewind are what the command printed, and a rewind unprints nothing
 * (a Claude rewind restarts the session, which closes an open shell first, so
 * no shell prints on through one); the log is the one place that output
 * survives. The join is by call, not by stream: a file change's
 * `file_change_output` chunks are joined as a command's `command_output` are,
 * and the reader decides what the text is (the MCP's `read_tool_output`
 * answers only a command's as its output).
 */

import {
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  type DomainEvent,
  type ThreadItemOutputResponse
} from "@orquester/api/agent-chat";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The call an item belongs to: its NEWEST write's `payload.toolUseId`, as
 * `readItem` reads the newest write as the item. Undefined for a message, for a
 * row that names no call, and for an id the log never wrote.
 */
function callOf(events: readonly DomainEvent[], itemId: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "thread.activity-appended") {
      if (event.payload.activity.id !== itemId) continue;
      const toolUseId = asRecord(event.payload.activity.payload)?.toolUseId;
      return typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : undefined;
    }
    if (event.type === "thread.message-sent" && event.payload.messageId === itemId) {
      return undefined;
    }
  }
  return undefined;
}

/** The UTF-8 size of one code point (a lone surrogate encodes as U+FFFD: 3). */
const utf8Size = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The longest head of `text` whose UTF-8 fits `budget` bytes, in whole code points. */
function utf8Head(text: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Size(char.codePointAt(0)!);
    if (bytes > budget) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The streamed output of the call `itemId` belongs to: the `payload.delta` of
 * every `tool.output` row with that `toolUseId`, joined verbatim in log order
 * (never trimmed — a command's output is its whitespace, and the GUI's join
 * keeps it too), and `complete` once a `tool.completed` row of the call exists.
 * Past `maxBytes` of UTF-8 the join stops on a character boundary and says
 * `truncated`; the scan still runs to the end for the completion. Null when the
 * item names no call ({@link callOf}).
 */
export function joinToolOutput(
  events: readonly DomainEvent[],
  itemId: string,
  maxBytes: number = THREAD_ITEM_OUTPUT_MAX_BYTES
): ThreadItemOutputResponse | null {
  const toolUseId = callOf(events, itemId);
  if (toolUseId === undefined) {
    return null;
  }
  const chunks: string[] = [];
  let bytes = 0;
  let complete = false;
  let truncated = false;
  for (const event of events) {
    if (event.type !== "thread.activity-appended") continue;
    const { activity } = event.payload;
    const payload = asRecord(activity.payload);
    if (payload?.toolUseId !== toolUseId) continue;
    if (activity.activityKind === "tool.completed") {
      complete = true;
      continue;
    }
    const delta = payload.delta;
    if (activity.activityKind !== "tool.output" || truncated || typeof delta !== "string") continue;
    const size = Buffer.byteLength(delta, "utf8");
    if (bytes + size <= maxBytes) {
      chunks.push(delta);
      bytes += size;
    } else {
      chunks.push(utf8Head(delta, maxBytes - bytes));
      truncated = true;
    }
  }
  return { toolUseId, output: chunks.join(""), complete, truncated };
}
