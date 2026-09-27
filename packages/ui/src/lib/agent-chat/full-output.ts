/**
 * Agent chat — a row's "Load full output" (spec §5.6, §6.3): what the row
 * offers, what the viewer reads for it, and what the viewer says about it.
 *
 * A call's whole output lives in its item or in its streamed chunks. A
 * payload the wire cut (§5.6, `truncated` on the row) is whole in its item,
 * `GET …/items/:itemId` — unless the item is stored cut too
 * (`payload.truncated` at rest): an update, which ingestion persists already
 * slimmed, or a completion that holds only part of a long output — Codex's
 * first 64 KiB, the end OpenCode's `bash` tool kept behind its "output
 * truncated" note, or the head OpenCode's generic cut kept of another
 * command-named tool's. A command's output that STREAMED — `tool.output`
 * chunks: a Claude background shell's, a Codex command's while it runs, a
 * long one's — is in no item at all: the host joins the chunks from the log
 * (`GET …/items/:itemId/output`), and the retained window may hold only the
 * latest of them (a parent's 500 rows, an agent's 200) or none. So a row
 * whose command streamed (`streamedOutput`) reads that join first, whether or
 * not its own payload was cut; a command item stored cut reads it next, the
 * MCP's order; and only where the host has no join to give — an empty one,
 * or a 404: a host from before the route — does the item answer: the part a
 * completion kept as text, saying it is only part of the output
 * (`storedCommandOutput`, the one rule `read_tool_output` follows too), and
 * anything else by {@link fullOutputText}. Never an error for either. A file
 * change is never read through the join: its chunks are the tool's result
 * text, no command's output, and `streamedOutput` is never set on one.
 *
 * No React import.
 */

import {
  storedCommandOutput,
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  type ThreadItem,
  type ThreadItemOutputResponse,
  type ThreadItemResponse
} from "@orquester/api/agent-chat";

import type { WorkLogEntry } from "./contracts";

/**
 * Where a row's whole output is read: its item, or — first — its call's
 * streamed output, joined by the host. `prompt` reads an agent's launch
 * prompt (a drill-in's prompt row): its item, shown as the prompt it holds
 * (`fullOutputText`), in a viewer titled for a prompt
 * ({@link fullOutputViewerCopy}).
 */
export type FullOutputSource = "item" | "streamed" | "prompt";

/** What the viewer calls what it reads, and says when the read finds nothing. */
export function fullOutputViewerCopy(source: FullOutputSource | undefined): { title: string; missing: string } {
  return source === "prompt"
    ? { title: "Prompt", missing: "That prompt is no longer available." }
    : { title: "Full output", missing: "That output is no longer available." };
}

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
 * host's cap (it is the head) — or the part a completion's item kept of a
 * long output, as the command printed it (`kept`: Codex's head, OpenCode's
 * end behind its note), or the item, shown by {@link fullOutputText}.
 */
export type FullOutput =
  | { kind: "streamed"; text: string; running: boolean; cut: boolean }
  | { kind: "kept"; text: string }
  | { kind: "item"; item: ThreadItem };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The host's join as the viewer shows it, or `null` when it holds nothing to show. */
function streamedFrom(join: ThreadItemOutputResponse | null): FullOutput | null {
  return join !== null && join.output !== ""
    ? { kind: "streamed", text: join.output, running: !join.complete, cut: join.truncated }
    : null;
}

/**
 * A command row naming its call whose item is stored cut (`payload.truncated`
 * at rest): an update, persisted already slimmed, or a completion that kept
 * only part of its output. Its data holds no whole output, so the call's join
 * is read before it — `read_tool_output`'s order (step 2 before the payload).
 */
function isCutCommandCall(item: ThreadItem): boolean {
  if (item.kind !== "activity" || !item.activityKind.startsWith("tool.")) {
    return false;
  }
  const payload = asRecord(item.payload);
  return (
    payload?.itemType === "command_execution" &&
    payload.truncated === true &&
    typeof payload.toolUseId === "string" &&
    payload.toolUseId !== ""
  );
}

/**
 * Read a row's whole output for the viewer. A join that answers is shown
 * first: it is everything the command printed, where the item holds at most
 * what its provider kept of it. A row whose command streamed asks for it
 * before its item; a command item stored cut, after (never twice). Where no
 * join answers, a completion stored cut shows the part it kept, as text —
 * never its payload as JSON, and never as the whole output — and any other
 * item shows as it always has. A failed join read is the viewer's error,
 * never a quiet fallback to an item that may hold none of the output.
 */
export async function readFullOutput(
  reads: FullOutputReads,
  itemId: string,
  source: FullOutputSource = "item"
): Promise<FullOutput> {
  const joinAsked = source === "streamed";
  if (joinAsked) {
    const streamed = streamedFrom(await reads.streamedOutput(itemId));
    if (streamed !== null) {
      return streamed;
    }
  }
  const { item } = await reads.item(itemId);
  if (!joinAsked && isCutCommandCall(item)) {
    const streamed = streamedFrom(await reads.streamedOutput(itemId));
    if (streamed !== null) {
      return streamed;
    }
  }
  const stored =
    item.kind === "activity" ? storedCommandOutput(item.activityKind, item.payload) : undefined;
  if (stored !== undefined && !stored.whole) {
    return { kind: "kept", text: stored.text };
  }
  return { kind: "item", item };
}

/**
 * An item as the viewer shows it: a message's text; a command's output as the
 * command printed it, where the item's own data carries it whole
 * (`storedCommandOutput` — Codex's aggregated output, a Claude Bash result's
 * text, an OpenCode command's final output), exactly as the MCP's
 * `read_tool_output` reads a command item first; else a string payload as it
 * is, the payload as indented JSON, or — nothing to write — the row's summary.
 * The §5.6 allow-list is what the *row* renders; the item is whatever the
 * adapter wrote, shown whole.
 *
 * Never a command's output out of an item stored cut (`payload.truncated`):
 * an update's data is a one-line preview, and the part a completion kept is
 * {@link readFullOutput}'s to show, saying it is only part — here it would
 * pass a part for the whole.
 */
export function fullOutputText(item: ThreadItem): string {
  if (item.kind === "message") {
    return item.text;
  }
  // An agent's launch: its prompt is what the drill-in's "Load the full
  // prompt" asked for, never the row it rides as JSON (§7.6).
  const prompt = launchPrompt(item);
  if (prompt !== null) {
    return prompt.text;
  }
  const stored = storedCommandOutput(item.activityKind, item.payload);
  if (stored?.whole === true) {
    return stored.text;
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

/** An agent's launch prompt (`task.started`'s `payload.prompt`), and whether it was cut at rest. */
function launchPrompt(item: ThreadItem): { text: string; cutAtRest: boolean } | null {
  if (item.kind !== "activity" || item.activityKind !== "task.started") {
    return null;
  }
  const payload = asRecord(item.payload);
  return typeof payload?.prompt === "string"
    ? { text: payload.prompt, cutAtRest: payload.promptTruncated === true }
    : null;
}

/** The host's cap on a join, in the unit it is set in. */
const CAP_LABEL = `${THREAD_ITEM_OUTPUT_MAX_BYTES / (1024 * 1024)} MiB`;

/**
 * What the viewer says of the text it shows, above it: a running call's output
 * is what exists now, and a join past the host's cap is its head — the log
 * keeps every chunk, only this read stops there. What a completion kept is
 * only part of its output: Codex's first 64 KiB, the end OpenCode's `bash`
 * tool kept behind its own note (which names the file holding the rest), the
 * head its generic cut kept before its note, or the one-line preview a first
 * load's closer copied from an update — which
 * part, and how much, the viewer cannot tell, so the note says neither. An
 * item needs no note, but an agent's launch prompt ingestion cut at rest:
 * only its start was ever kept, and the viewer says so.
 */
export function fullOutputNotes(output: FullOutput): string[] {
  const notes: string[] = [];
  if (output.kind === "item") {
    // A prompt ingestion cut at rest: no read holds the rest.
    if (launchPrompt(output.item)?.cutAtRest === true) {
      notes.push("Only the start of this prompt was kept.");
    }
    return notes;
  }
  if (output.kind === "kept") {
    notes.push("Only part of this output was kept.");
    return notes;
  }
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
