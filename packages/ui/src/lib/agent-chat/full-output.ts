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
 * The item is handed back as it is: the viewer shows it as it always has
 * (`fullOutputText`, `AgentChatView.tsx`), as does the MCP's
 * `read_tool_output` for anything that is no command's output.
 *
 * No React import.
 */

import {
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
 * host's cap (it is the head) — or the item, shown as it always has been.
 */
export type FullOutput =
  | { kind: "streamed"; text: string; running: boolean; cut: boolean }
  | { kind: "item"; item: ThreadItem };

/**
 * Read a row's whole output for the viewer. A join that answers is shown even
 * when the item would say more about the call: it is the command's output as
 * printed, where the item is its payload. A failed join read is the viewer's
 * error, never a quiet fallback to a payload that holds no output.
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

/** The host's cap on a join, in the unit it is set in. */
const CAP_LABEL = `${THREAD_ITEM_OUTPUT_MAX_BYTES / (1024 * 1024)} MiB`;

/**
 * What the viewer says of the text it shows, above it: a running call's output
 * is what exists now, and a join past the host's cap is its head. An item
 * needs no note.
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
    notes.push(`Only the first ${CAP_LABEL} of this output were kept.`);
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
