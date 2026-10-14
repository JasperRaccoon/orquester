/**
 * Agent chat — the thread and delegation session tools' link to the thread
 * they acted on (spec 2026-10-14 §5 "Threads", "Delegation", §6).
 *
 * A call that creates or acts on one chat thread — `delegate_task`,
 * `thread_create`, `thread_fork`, `thread_send`, `task_wait`, … — answers a
 * {@link ThreadToolReference} under {@link THREAD_TOOL_REFERENCE_KEY}. The key
 * is one of the session tools' reference keys (`SESSION_TOOL_REFERENCE_KEYS`),
 * so slimming keeps it on every provider's row and the timeline renders a
 * link that opens that thread without fetching the call's full item.
 *
 * Pure and dependency-free: the daemon writes it, the UI reads it.
 */

import { sessionToolNameOfData, sessionToolReferences } from "./session-tools.ts";

/** The result field the reference travels in; listed in `SESSION_TOOL_REFERENCE_KEYS`. */
export const THREAD_TOOL_REFERENCE_KEY = "threadRef";

/** How the referenced thread relates to the calling one. */
export type ThreadToolRelation = "delegate" | "fork" | "parent" | "thread";

/** The thread a thread or delegation tool acted on, as its row links to it. */
export interface ThreadToolReference {
  /** The thread's session (tab) id. */
  threadId: string;
  /** Its tab title when the call ran. The UI shows the live title while the tab exists. */
  title: string;
  relation: ThreadToolRelation;
}

/** The longest title a reference carries; a longer one is cut. */
export const THREAD_TOOL_REFERENCE_TITLE_MAX = 200;

const RELATIONS: ReadonlySet<string> = new Set<ThreadToolRelation>(["delegate", "fork", "parent", "thread"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A reference built for a result: the title trimmed to its cap. */
export function threadToolReference(threadId: string, title: string, relation: ThreadToolRelation): ThreadToolReference {
  const trimmed = title.trim();
  return {
    threadId,
    title: trimmed.length > THREAD_TOOL_REFERENCE_TITLE_MAX ? `${trimmed.slice(0, THREAD_TOOL_REFERENCE_TITLE_MAX - 1)}…` : trimmed,
    relation
  };
}

/** `value` as a reference, or undefined when it is not one (never trusted as is: it came through a provider). */
export function readThreadToolReference(value: unknown): ThreadToolReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { threadId, title, relation } = record;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 200) return undefined;
  if (typeof relation !== "string" || !RELATIONS.has(relation)) return undefined;
  return {
    threadId,
    title: typeof title === "string" ? title.slice(0, THREAD_TOOL_REFERENCE_TITLE_MAX) : "",
    relation: relation as ThreadToolRelation
  };
}

/**
 * The thread a session-tool row links to, or undefined. Only a row the host's
 * ingestion marked as its own session tool's (`data.sessionTool`) is read, so
 * a user's same-named server never makes a link.
 */
export function threadToolReferenceOfActivityData(data: unknown): ThreadToolReference | undefined {
  const record = asRecord(data);
  if (!record || sessionToolNameOfData(record) === null) return undefined;
  return readThreadToolReference(sessionToolReferences(record, [THREAD_TOOL_REFERENCE_KEY])?.[THREAD_TOOL_REFERENCE_KEY]);
}
