/**
 * Agent host — keeping session-tool secrets out of everything the host
 * persists (design `2026-10-14-agent-visuals-and-session-tools-design.md` §5
 * "Secrets"; where the value goes: `@orquester/api` `secret-requests.ts`).
 *
 * A tool whose definition names `secretResultKeys` (`request_secret`) hands
 * the agent a value it must use and the thread must never keep. The value
 * reaches the provider through this host, and comes back through it: the
 * provider records the result in its conversation and reports the call, and
 * an agent may repeat the value later (a command line, a message, streamed
 * output). So before any of a thread's events reaches the store — and so
 * `events.ndjson`, the item and tool-output reads, the SQLite index and
 * search, the external `/mcp` transcript, every client stream — and before
 * any of its frames reaches `raw.ndjson`:
 *
 * - **by shape**: `stripSecretRequestValues` drops the value from any
 *   `request_secret` result in an MCP call row or a raw frame — no memory
 *   needed, so it holds across a host restart too;
 * - **by value**: the values handed to the thread in this host process are
 *   held in memory (until the thread is released or the host exits) and
 *   masked wherever they occur exactly. The policy ({@link
 *   isDistinctiveSecret}): any value is masked inside MCP call rows (they are
 *   about the secret); only a DISTINCTIVE value — at least
 *   {@link SECRET_SCRUB_MIN_CHARS} characters of two or more character
 *   classes, or {@link SECRET_SCRUB_LONG_CHARS} of any — is masked elsewhere:
 *   in other runtime events, in raw frames, and in streamed text. A short or
 *   plain-word value ("password1" is distinctive, "password" is not) would
 *   shred the transcript wherever the word appears; such values rely on the
 *   shape strip alone. Masking replaces exact occurrences only, so nothing a
 *   user wrote is touched unless it holds the exact value;
 * - **streamed text** — assistant and reasoning deltas, tool output — is
 *   masked AFTER ingestion joins the chunks into the rows it writes
 *   ({@link SessionSecretRedactor.maskOutgoing}), holding back the tail that
 *   could still begin a value until the next chunk, the stream's end or the
 *   thread's flush, so a value split across chunks or flushes is caught.
 *
 * Every path fails closed: an MCP call row or a raw frame that cannot be
 * walked is replaced by {@link SECRET_REDACTED_TEXT}, never kept.
 *
 * An MCP call is any MCP tool's row — `mcp_tool_call`, and a Grok `use_tool`
 * call of a third-party server (`data.vendorTool: "use_tool"`, `rawOutput.type
 * "MCP"`), which is where an MCP App's call lands. An MCP App's snapshot
 * ({@link SessionSecretRedactor.maskText}) and its proxied requests' answers
 * ({@link SessionSecretRedactor.maskValue}) are masked too.
 *
 * Thread lineage (spec §6): a fork's child is LINKED to its parent
 * ({@link SessionSecretRedactor.link}): it never holds the parent's values
 * itself, but its rows are masked with the parent's while the host holds
 * them, so the conversation it carries over (a native fork replays the
 * parent's turns from the provider's own transcript) reads as the parent's
 * masked records do.
 */

import {
  SECRET_REDACTED_TEXT,
  stripSecretRequestValues,
  type RuntimeEvent,
  type ThreadActivityItem
} from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";

/** A value at least this long, of two or more character classes, is masked everywhere. */
export const SECRET_SCRUB_MIN_CHARS = 8;
/** A value at least this long is masked everywhere whatever its characters. */
export const SECRET_SCRUB_LONG_CHARS = 16;

/** The by-value policy: is this value safe to mask wherever it occurs in a thread? */
export function isDistinctiveSecret(value: string): boolean {
  if (value.length >= SECRET_SCRUB_LONG_CHARS) return true;
  if (value.length < SECRET_SCRUB_MIN_CHARS) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes >= 2;
}

const MAX_DEPTH = 64;

/** Thrown past the depth bound: the caller fails closed. */
class TooDeep extends Error {}

function replaceAll(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) {
      out = out.split(value).join(SECRET_REDACTED_TEXT);
    }
  }
  return out;
}

/**
 * `value` with every occurrence of `values` in its strings masked; the same
 * reference when none occurs. Throws past the depth bound (callers fail closed).
 */
export function maskSecretValues<T>(value: T, values: readonly string[]): T {
  if (values.length === 0) return value;
  return mask(value, values, 0) as T;
}

function mask(value: unknown, values: readonly string[], depth: number): unknown {
  if (typeof value === "string") {
    return replaceAll(value, values);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > MAX_DEPTH) {
    throw new TooDeep();
  }
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      const next = mask(entry, values, depth + 1);
      if (next !== entry) {
        out ??= value.slice();
        out[index] = next;
      }
    }
    return out ?? value;
  }
  let out: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = mask(entry, values, depth + 1);
    if (next !== entry) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}

function isMcpCallEvent(event: RuntimeEvent): boolean {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return false;
  }
  if (event.payload?.itemType === "mcp_tool_call") return true;
  // Grok reaches every MCP tool through `use_tool`; a third-party server's
  // call (an MCP App's included) keeps its vendor kind, not `mcp_tool_call`.
  const data = event.payload?.data as { vendorTool?: unknown; rawOutput?: { type?: unknown } } | undefined;
  return data?.vendorTool === "use_tool" || data?.rawOutput?.type === "MCP";
}

/** One stream's held-back tail and the last row it came in, to release it as. */
interface Carry {
  text: string;
  template: AppendableDomainEvent;
}

type MessageEvent = Extract<AppendableDomainEvent, { type: "thread.message-sent" }>;
type ActivityEvent = Extract<AppendableDomainEvent, { type: "thread.activity-appended" }>;

/**
 * A call's output stream, by its call alone: a call whose output arrives
 * under two stream kinds (a command's output and its file-change output, say)
 * can split one value across them, so the held tail joins whichever chunk of
 * the call comes next, and is released as that chunk's row.
 */
function outputKey(activity: ThreadActivityItem): string | null {
  if (activity.activityKind !== "tool.output") return null;
  const payload = activity.payload as { toolUseId?: unknown; delta?: unknown };
  if (typeof payload.delta !== "string" || typeof payload.toolUseId !== "string") return null;
  return outputKeyOf(payload.toolUseId);
}

function outputKeyOf(toolUseId: string): string {
  return `o:${toolUseId}`;
}

function toolUseIdOf(activity: ThreadActivityItem): string | null {
  const id = (activity.payload as { toolUseId?: unknown } | null)?.toolUseId;
  return typeof id === "string" ? id : null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "declined"]);

/**
 * The row that ENDS a call's output stream: its `tool.completed`, a denial,
 * or any lifecycle row carrying a terminal status. A running call's
 * `tool.updated` / `tool.progress` rows interleave with its output chunks
 * (OpenCode sends one per running frame, Codex a `patchUpdated`, Grok an
 * `item.updated`) and must NOT release the held tail: the next chunk may
 * complete the value.
 */
function endsToolStream(activity: ThreadActivityItem): boolean {
  if (activity.activityKind === "tool.completed" || activity.activityKind === "tool.denied") return true;
  if (!activity.activityKind.startsWith("tool.")) return false;
  const status = (activity.payload as { status?: unknown } | null)?.status;
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

/**
 * Fail closed for an event too deep to walk: top-level text is masked, every
 * nested value is replaced — nothing unchecked is kept.
 */
function closedPayload(payload: unknown, values: readonly string[]): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return SECRET_REDACTED_TEXT;
  }
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, entry]) => [
      key,
      typeof entry === "string"
        ? replaceAll(entry, values)
        : entry !== null && typeof entry === "object"
          ? SECRET_REDACTED_TEXT
          : entry
    ])
  );
}

export class SessionSecretRedactor {
  private readonly byThread = new Map<string, Set<string>>();
  private readonly carries = new Map<string, Map<string, Carry>>();
  /** A fork's child → its parent ({@link link}). */
  private readonly parents = new Map<string, string>();

  /** Remember values handed to `threadId` — call BEFORE the provider can see them. */
  remember(threadId: string, values: readonly string[]): void {
    const kept = values.filter((value) => typeof value === "string" && value.trim().length > 0);
    if (kept.length === 0) return;
    let set = this.byThread.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.byThread.set(threadId, set);
    }
    for (const value of kept) {
      set.add(value);
      // A pasted value may carry stray spaces the agent will not repeat.
      const trimmed = value.trim();
      if (trimmed !== value) set.add(trimmed);
    }
  }

  /** Drop what `threadId` holds (the thread was released or deleted), held-back tails and its link included. */
  forget(threadId: string): void {
    this.byThread.delete(threadId);
    this.carries.delete(threadId);
    this.parents.delete(threadId);
  }

  /**
   * `threadId` is a fork of `parentThreadId`: its rows are masked with the
   * parent's values (and its ancestors'), read live — never copied into the
   * child, which holds only what a tool hands it. Call before the child's
   * first event (its history replay).
   */
  link(threadId: string, parentThreadId: string): void {
    if (threadId !== parentThreadId) this.parents.set(threadId, parentThreadId);
  }

  /** True while `threadId` itself has a value to mask (tests). */
  holds(threadId: string): boolean {
    return (this.byThread.get(threadId)?.size ?? 0) > 0;
  }

  private valuesFor(threadId: string, everyValue: boolean): string[] {
    const all = new Set<string>();
    const seen = new Set<string>();
    // The thread's own values, then each ancestor's (a cycle or a long chain stops the walk).
    for (let id: string | undefined = threadId; id !== undefined && !seen.has(id) && seen.size < 32; id = this.parents.get(id)) {
      seen.add(id);
      for (const value of this.byThread.get(id) ?? []) all.add(value);
    }
    if (all.size === 0) return [];
    // Longest first, so a value that contains another is masked whole.
    return [...all]
      .filter((value) => everyValue || isDistinctiveSecret(value))
      .sort((a, b) => b.length - a.length);
  }

  /**
   * An MCP answer bound for one of the thread's MCP Apps (a proxied tool call
   * or resource read): every value masked, as in an MCP call row, and a
   * `request_secret` result stripped. Never throws; fails closed.
   */
  maskValue(threadId: string, value: unknown): unknown {
    try {
      return stripSecretRequestValues(maskSecretValues(value, this.valuesFor(threadId, true)));
    } catch {
      return SECRET_REDACTED_TEXT;
    }
  }

  /**
   * A document the thread stores outside its events (an MCP App's snapshot):
   * its distinctive values masked, as in a raw frame. Never throws.
   */
  maskText(threadId: string, text: string): string {
    return replaceAll(text, this.valuesFor(threadId, false));
  }

  /** A runtime event as ingestion may see it. Never throws; the same reference when nothing changed. */
  redactEvent(event: RuntimeEvent): RuntimeEvent {
    if (event === null || typeof event !== "object" || typeof event.threadId !== "string") {
      return event;
    }
    const mcpCall = isMcpCallEvent(event);
    const values = this.valuesFor(event.threadId, mcpCall);
    try {
      let out = maskSecretValues(event, values);
      if (mcpCall) {
        out = stripSecretRequestValues(out);
      }
      return out;
    } catch {
      // Fail closed: an event that cannot be checked — any event of a thread
      // holding a value (masking is the only walk that throws) or an MCP row —
      // keeps its identity and top-level text, masked; nothing nested.
      return { ...event, payload: closedPayload(event.payload, values) } as RuntimeEvent;
    }
  }

  /** A provider frame as `raw.ndjson` may keep it. Never throws; fails closed. */
  redactFrame(threadId: string, frame: unknown): unknown {
    try {
      return stripSecretRequestValues(maskSecretValues(frame, this.valuesFor(threadId, false)));
    } catch {
      return SECRET_REDACTED_TEXT;
    }
  }

  /**
   * The rows ingestion is about to write, with streamed text masked across
   * chunks: each assistant/reasoning message and each tool's output stream is
   * joined with the tail held back from its previous chunk, masked, and
   * written up to the longest tail that could still begin a value. A tail is
   * released when its stream ends (the message's closing row, the tool's next
   * non-output row) or, with `final`, at the thread's flush. `mintId` names a
   * release row. Never throws: a row it cannot handle is passed on masked
   * whole.
   */
  maskOutgoing(
    threadId: string,
    events: readonly AppendableDomainEvent[],
    mintId: () => string,
    final = false
  ): AppendableDomainEvent[] {
    const values = this.valuesFor(threadId, false);
    const carries = this.carries.get(threadId);
    if (values.length === 0 && (carries === undefined || carries.size === 0)) {
      return [...events];
    }
    const held = carries ?? new Map<string, Carry>();
    this.carries.set(threadId, held);
    const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
    const out: AppendableDomainEvent[] = [];

    /** Join, mask, and split off the tail that could still begin a value. */
    const step = (key: string, text: string, template: AppendableDomainEvent): string => {
      const masked = replaceAll((held.get(key)?.text ?? "") + text, values);
      let hold = "";
      for (let length = Math.min(longest - 1, masked.length); length > 0; length -= 1) {
        const suffix = masked.slice(masked.length - length);
        if (values.some((value) => value.startsWith(suffix))) {
          hold = suffix;
          break;
        }
      }
      if (hold.length > 0) held.set(key, { text: hold, template });
      else held.delete(key);
      return masked.slice(0, masked.length - hold.length);
    };
    const releaseRow = (key: string): AppendableDomainEvent | null => {
      const carry = held.get(key);
      held.delete(key);
      if (carry === undefined || carry.text.length === 0) return null;
      const template = carry.template;
      if (template.type === "thread.message-sent") {
        return { ...template, eventId: mintId(), payload: { ...template.payload, text: carry.text, streaming: true } };
      }
      if (template.type === "thread.activity-appended") {
        const activity = template.payload.activity;
        return {
          ...template,
          eventId: mintId(),
          payload: {
            ...template.payload,
            activity: { ...activity, id: mintId(), payload: { ...(activity.payload as object), delta: carry.text } } as ThreadActivityItem
          }
        };
      }
      return null;
    };
    const release = (key: string) => {
      const row = releaseRow(key);
      if (row !== null) out.push(row);
    };

    for (const event of events) {
      try {
        if (event.type === "thread.message-sent") {
          const message = event as MessageEvent;
          const key = `m:${message.payload.messageId}`;
          const text = message.payload.text ?? "";
          if (message.payload.streaming) {
            const kept = step(key, text, message);
            // A row whose whole text is held back waits for the next; an empty row passes as it was.
            if (kept.length > 0 || text.length === 0) out.push({ ...message, payload: { ...message.payload, text: kept } });
          } else {
            release(key);
            out.push(text.length > 0 ? { ...message, payload: { ...message.payload, text: replaceAll(text, values) } } : message);
          }
          continue;
        }
        if (event.type === "thread.activity-appended") {
          const appended = event as ActivityEvent;
          const activity = appended.payload.activity;
          const key = outputKey(activity);
          if (key !== null) {
            const kept = step(key, (activity.payload as { delta: string }).delta, appended);
            if (kept.length > 0) {
              out.push({
                ...appended,
                payload: { ...appended.payload, activity: { ...activity, payload: { ...(activity.payload as object), delta: kept } } as ThreadActivityItem }
              });
            }
            continue;
          }
          const toolUseId = toolUseIdOf(activity);
          if (toolUseId !== null && endsToolStream(activity)) {
            release(outputKeyOf(toolUseId));
          }
        }
        out.push(event);
      } catch {
        // Unexpected shape: pass the row on masked whole rather than skip it.
        try {
          out.push(maskSecretValues(event, values));
        } catch {
          // Too deep to check: nothing of it is kept.
        }
      }
    }
    if (final) {
      for (const key of [...held.keys()]) release(key);
    }
    if (held.size === 0) this.carries.delete(threadId);
    return out;
  }
}
