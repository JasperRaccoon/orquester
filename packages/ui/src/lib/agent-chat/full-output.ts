/**
 * Agent chat — a row's "Load full output" (spec §5.6, §6.3): what the row
 * offers, what the viewer reads for it, and what the viewer says about it.
 *
 * A call's whole output lives in one of two places. A payload the wire cut
 * (§5.6, `truncated`) is whole in its item, `GET …/items/:itemId`. A
 * command's output that STREAMED — `tool.output` chunks: a Claude background
 * shell's, a Codex command's while it runs, a long one's — is in no item at
 * all: the host joins the chunks from the log (`GET …/items/:itemId/output`),
 * and the retained window may hold only the latest of them (a parent's 500
 * rows, an agent's 200). So a row whose command streamed (`streamedOutput`)
 * reads that join first, whether or not its own payload was cut, and its item
 * where the host has no join to give — a 404: a host from before the route —
 * or the call streamed nothing; never an error. A file change is never read
 * through the join: its chunks are the tool's result text, no command's
 * output, and `streamedOutput` is never set on one.
 *
 * An item is shown by {@link fullOutputText}: a command's output as the
 * command printed it where its own data carries it, anything else as the
 * viewer always showed it — the MCP's `read_tool_output` reads an item the
 * same way.
 *
 * No React import.
 */

import {
  commandOutputText,
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  type ThreadItem,
  type ThreadItemOutputResponse,
  type ThreadItemResponse
} from "@orquester/api/agent-chat";

import type { WorkLogEntry } from "./contracts";

/**
 * Where a row's whole output is read: its item, or — first — its call's
 * streamed output, joined by the host.
 */
export type FullOutputSource = "item" | "streamed";

/**
 * The read a row's "Load full output" makes, or `null` where it offers none:
 * a command whose output streamed reads the join, whether or not its payload
 * was cut; any other row only where the wire cut its payload — the button is
 * a promise that the read really has more.
 */
export function fullOutputSourceOf(
  entry: Pick<WorkLogEntry, "streamedOutput" | "truncated">
): FullOutputSource | null {
  if (entry.streamedOutput === true) {
    return "streamed";
  }
  return entry.truncated === true ? "item" : null;
}

/** The two reads the viewer makes, by the row's item id. */
export interface FullOutputReads {
  /** `GET …/items/:itemId`: the item, unslimmed. */
  item(itemId: string): Promise<ThreadItemResponse>;
  /**
   * `GET …/items/:itemId/output`, read to its end: the call's streamed
   * output, or `null` where the host has none to give (a 404).
   */
  streamedOutput(itemId: string): Promise<ThreadItemOutputResponse | null>;
}

/**
 * What the viewer shows: a call's streamed output — `running` while the call
 * has not completed (it is the output so far), `cut` once the join passed the
 * host's cap (it is the head) — or the item, shown by {@link fullOutputText}.
 */
export type FullOutput =
  | { kind: "streamed"; text: string; running: boolean; cut: boolean }
  | { kind: "item"; item: ThreadItem };

/**
 * Read a row's whole output for the viewer. A join that answers is shown
 * first: it is everything the command printed, where the item holds at most
 * what its provider kept of it. A failed join read is the viewer's error,
 * never a quiet fallback to an item that may hold none of the output.
 */
export async function readFullOutput(
  reads: FullOutputReads,
  itemId: string,
  source: FullOutputSource = "item"
): Promise<FullOutput> {
  if (source === "streamed") {
    const join = await reads.streamedOutput(itemId);
    if (join !== null && join.output !== "") {
      return { kind: "streamed", text: join.output, running: !join.complete, cut: join.truncated };
    }
  }
  const { item } = await reads.item(itemId);
  return { kind: "item", item };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * An item as the viewer shows it: a message's text; a command's output as the
 * command printed it, where the item's own data carries it
 * (`commandOutputText` — Codex's aggregated output, a Claude Bash result's
 * text), exactly as the MCP's `read_tool_output` reads a command item first;
 * else a string payload as it is, the payload as indented JSON, or — nothing
 * to write — the row's summary. The §5.6 allow-list is what the *row*
 * renders; the item is whatever the adapter wrote, shown whole.
 *
 * Never a command's output out of an item stored cut (`payload.truncated`):
 * an update, which ingestion persists already slimmed, or a completion that
 * kept only a head of a long output (Codex's past 64 KiB). Its data holds
 * that preview or head, and reading it as the output would pass a part for
 * the whole; the payload shows instead, as the MCP answers it.
 */
export function fullOutputText(item: ThreadItem): string {
  if (item.kind === "message") {
    return item.text;
  }
  const payload = asRecord(item.payload);
  if (payload?.itemType === "command_execution" && payload.truncated !== true) {
    const output = commandOutputText(payload.data);
    if (output !== undefined) {
      return output;
    }
  }
  if (typeof item.payload === "string") {
    return item.payload;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(item.payload, null, 2);
  } catch {
    json = undefined;
  }
  return json ?? item.summary;
}

/** The host's cap on a join, in the unit it is set in. */
const CAP_LABEL = `${THREAD_ITEM_OUTPUT_MAX_BYTES / (1024 * 1024)} MiB`;

/**
 * What the viewer says of the text it shows, above it: a running call's output
 * is what exists now, and a join past the host's cap is its head — the log
 * keeps every chunk, only this read stops there. An item needs no note.
 */
export function fullOutputNotes(output: FullOutput): string[] {
  const notes: string[] = [];
  if (output.kind !== "streamed") {
    return notes;
  }
  if (output.running) {
    notes.push("Still running — this is its output so far.");
  }
  if (output.cut) {
    notes.push(`Only the first ${CAP_LABEL} of this output can be shown here.`);
  }
  return notes;
}

/** The viewer's reads, one at a time ({@link createViewerReads}). */
export interface ViewerReads {
  /** Retire the read in flight, if any, and start one: its signal. */
  begin(): AbortSignal;
  /** Retire the read in flight, if any: the viewer closed. */
  retire(): void;
}

/**
 * One read at a time for a viewer the user can close or reopen while a read
 * is in flight. A retired read's answer is dropped — never painted over what
 * the user looks at now, nor reopening a viewer they closed — and a streamed
 * output, read window by window, stops asking for the next window.
 */
export function createViewerReads(): ViewerReads {
  let current: AbortController | null = null;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
    retire() {
      current?.abort();
      current = null;
    }
  };
}
