import { z } from "zod";
import { agentChatRoutes, commandOutputText, type ThreadItem, type ThreadItemOutputResponse, type ThreadItemResponse } from "@orquester/api/agent-chat";
import type { DaemonApi } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { requireChatSession } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes, utf8SequenceLength } from "../result.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

/** A window's default size, in UTF-8 bytes of the text. */
export const DEFAULT_OUTPUT_BYTES = 40_000;
/** The largest window one call takes: 5 000 under ok()'s 60 000-byte cap (result.ts), as read_transcript's maxChars is. */
export const MAX_OUTPUT_BYTES = 55_000;

/** What the text is: a command's output, a message's text, or the item's payload. */
type ToolOutputKind = "command-output" | "message" | "payload";

/**
 * The text an item answers, and — for a call's streamed output — the two things the host's join says about it: the
 * call has not completed (`running`: the text is its output so far), and the join passed the host's cap
 * (`truncated`: the text is its head, `THREAD_ITEM_OUTPUT_MAX_BYTES`).
 */
interface ItemOutput { kind: ToolOutputKind; text: string; running?: true; truncated?: true }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A thread item as far as this tool reads one: a message with its text, or an activity with its summary. */
function isThreadItem(value: unknown): value is ThreadItem {
  const item = asRecord(value);
  return item?.kind === "message" ? typeof item.text === "string" : item?.kind === "activity" && typeof item.summary === "string";
}

/**
 * The streamed output of the call `itemId` belongs to, as the host joins it from the log
 * (`GET /api/sessions/:id/items/:itemId/output`), or null when there is none to read. A 404 is never an error: it is the
 * host's own `ITEM_NOT_FOUND`, or — until its drain-restart after a deploy — a host that predates the route answering
 * its generic route miss (`THREAD_NOT_FOUND` "No route for GET …"), and the item's own text answers instead. Any other
 * failure keeps its code (`daemonError`).
 */
async function streamedOutput(api: DaemonApi, sessionId: string, itemId: string): Promise<ThreadItemOutputResponse | null> {
  const res = await api.request("GET", agentChatRoutes.itemOutput(sessionId, itemId));
  if (res.status === 404) return null;
  if (res.status >= 400) throw daemonError(res);
  const body = asRecord(res.body);
  if (typeof body?.output !== "string" || typeof body.complete !== "boolean" || typeof body.truncated !== "boolean") {
    throw new ToolError("INTERNAL", "Expected a tool call's streamed output.");
  }
  return body as unknown as ThreadItemOutputResponse;
}

/**
 * An item's whole text, as the GUI's "Load full output" viewer reads it (`fullOutputText`, AgentChatView.tsx) — except a
 * command's output, which an agent reads as text rather than as escaped JSON. In this order:
 *
 * 1. a `command_execution` activity whose own data carries output answers it whole (`commandOutputText`: the first place,
 *    in the preview's reading order, that holds output in the unslimmed item) — unless the item is stored slimmed
 *    (`payload.truncated`: an update, persisted already cut, §5.6), whose data holds only the preview;
 * 2. else a command's row naming its call (`payload.toolUseId`) — a `command_execution` activity, or a `tool.output`
 *    chunk of `command_output` — answers the call's streamed output, which is in no item's data at all (a Claude
 *    background shell's, a running command's so far), joined by the host, when the call streamed any. Never a file
 *    change: Claude streams an Edit's or a Write's result text too (`file_change_output`, "File created successfully
 *    at: …"), which is no command's output, and its payload — the edit — is what the GUI's viewer shows;
 * 3. else a message's text, a string payload as it is, else the payload as indented JSON, else — no payload to write —
 *    the row's summary.
 */
async function itemOutput(api: DaemonApi, sessionId: string, item: ThreadItem): Promise<ItemOutput> {
  if (item.kind === "message") return { kind: "message", text: item.text };
  const payload = asRecord(item.payload);
  if (payload?.itemType === "command_execution" && payload.truncated !== true) {
    const output = commandOutputText(payload.data);
    if (output !== undefined) return { kind: "command-output", text: output };
  }
  const command = payload?.itemType === "command_execution" || (item.activityKind === "tool.output" && payload?.streamKind === "command_output");
  if (command && item.activityKind.startsWith("tool.") && typeof payload?.toolUseId === "string" && payload.toolUseId !== "") {
    const streamed = await streamedOutput(api, sessionId, item.id);
    if (streamed !== null && streamed.output !== "") {
      return { kind: "command-output", text: streamed.output, ...(streamed.complete ? {} : { running: true as const }), ...(streamed.truncated ? { truncated: true as const } : {}) };
    }
  }
  if (typeof item.payload === "string") return { kind: "payload", text: item.payload };
  let json: string | undefined;
  try {
    json = JSON.stringify(item.payload, null, 2);
  } catch {
    json = undefined;
  }
  return { kind: "payload", text: json ?? item.summary };
}

/** One ASCII byte's size once JSON.stringify has escaped it: `\"`, `\\` and `\b \t \n \f \r` take 2, any other control byte 6 (`\u00XX`). */
function asciiJsonBytes(byte: number): number {
  if (byte === 0x22 || byte === 0x5c) return 2;
  if (byte >= 0x20) return 1;
  return byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d ? 2 : 6;
}

/** Where the character holding byte `offset` starts: `offset` itself, unless that is a continuation byte (10xxxxxx). */
function characterStart(bytes: Uint8Array, offset: number): number {
  let start = offset;
  // A character's lead byte is at most 3 bytes before any of its continuation bytes.
  while (start > 0 && start < bytes.length && offset - start < 3 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  return start;
}

/**
 * Where the window from `start` (a character boundary) ends: after the most whole characters that fit in `maxBytes`
 * bytes and whose JSON text — escaped as ok() writes it — fits in `room` bytes. The first character is taken whatever its
 * size (up to 4 bytes, or 6 escaped), so a window narrower than it still advances. Linear: each character is costed once.
 */
function windowEnd(bytes: Uint8Array, start: number, maxBytes: number, room: number): number {
  let end = start;
  let json = 0;
  while (end < bytes.length) {
    const lead = bytes[end]!;
    const size = Math.min(utf8SequenceLength(lead), bytes.length - end);
    // A character past ASCII is written as it is: JSON.stringify escapes only lone surrogates, and UTF-8 has none.
    const cost = lead < 0x80 ? asciiJsonBytes(lead) : size;
    if (end > start && (end + size - start > maxBytes || json + cost > room)) break;
    end += size;
    json += cost;
  }
  return end;
}

const readToolOutput = defineTool({
  name: "read_tool_output",
  title: "Read a tool's full output",
  description: "The whole output of a tool call, as the GUI's \"Load full output\" reads it: pass a tool row's outputItemId from read_transcript as itemId. kind says what text is: command-output (a command's output — so far, if running is true), message (a message's text) or payload (the item's payload as JSON). Read in UTF-8 byte windows: while nextOffset is present, call again with offset = nextOffset.",
  input: {
    sessionId: z.string().min(1).describe("The session id from list_sessions."),
    itemId: z.string().min(1).describe("The item to read: a tool row's outputItemId from read_transcript."),
    offset: z.number().int().min(0).default(0).describe("UTF-8 byte offset to start at: 0, or the previous result's nextOffset. An offset inside a character starts at that character."),
    maxBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES).default(DEFAULT_OUTPUT_BYTES).describe(`Most bytes of text to return (max ${MAX_OUTPUT_BYTES}), or one whole character when maxBytes is smaller than it; fewer come back when one result cannot hold them.`)
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    // The unslimmed item (§5.6), the GUI's "Load full output" read: `GET /api/sessions/:id/items/:itemId`.
    const res = await api.request("GET", agentChatRoutes.item(args.sessionId, args.itemId));
    if (res.status === 404) {
      throw new ToolError("NOT_FOUND", `No item "${clipText(args.itemId, MAX_ECHO_CHARS)}" in this session: it is gone, or it never existed. Item ids come from read_transcript — a tool row's outputItemId.`);
    }
    if (res.status >= 400) throw daemonError(res);
    const item = (res.body as Partial<ThreadItemResponse> | null)?.item;
    if (!isThreadItem(item)) throw new ToolError("INTERNAL", "Expected a thread item.");
    const { kind, text, ...flags } = await itemOutput(api, args.sessionId, item);
    // The text's UTF-8, which every offset counts in (a lone surrogate, which UTF-8 cannot hold, reads as U+FFFD).
    const bytes = Buffer.from(text, "utf8");
    const totalBytes = bytes.length;
    if (args.offset > totalBytes) {
      throw new ToolError("INVALID_ARGUMENT", `offset ${args.offset} is past the end: this output is ${totalBytes} bytes (totalBytes). Start at 0, or at the last result's nextOffset.`);
    }
    const start = characterStart(bytes, args.offset);
    // The text's room: the cap less the answer around it, with nextOffset at its widest (it never passes totalBytes).
    const frame = resultBytes({ itemId: args.itemId, kind, text: "", offset: start, totalBytes, nextOffset: totalBytes, ...flags });
    const end = windowEnd(bytes, start, args.maxBytes, MAX_RESULT_BYTES - frame);
    return { itemId: args.itemId, kind, text: bytes.toString("utf8", start, end), offset: start, totalBytes, ...(end < totalBytes ? { nextOffset: end } : {}), ...flags };
  }
});

export const outputTools: ToolDef[] = [readToolOutput] as ToolDef[];
