/**
 * What a file-change approval card actually shows (E2E E7, spec §4.3/§7.5).
 *
 * **Approving a write you cannot see is the failure this exists to prevent.**
 * The command card renders the full command; the file-change card used to
 * render the literal string "File change approval" as its own body, because
 * nothing joined the request to the tool call it is gating.
 *
 * Two sources, in order:
 *
 *  1. `approval.detail` — what the adapter put on `request.opened` (W7 is
 *     filling this with the path list and the diff). Always preferred: the
 *     adapter knows what it is about to write.
 *  2. The **joined `item.started` activity**, matched by `toolUseId`. An
 *     approval and the tool call it gates share that id by construction
 *     (§5.1: "stable across the in-progress and completed updates of ONE
 *     call"), and `toolUseId`, `changedFiles`, `command` and `detail` all
 *     survive §5.6's slimming, so the join works on the wire payload.
 *
 * When neither yields anything the card says so in words, rather than echoing
 * its own title — "no detail" is information; a repeated label is not.
 */

import type { PendingApproval, ThreadItem } from "@orquester/api/agent-chat";

/** The allow-listed payload fields this module reads (§5.6). */
interface JoinablePayload {
  itemType?: unknown;
  toolUseId?: unknown;
  title?: unknown;
  detail?: unknown;
  command?: unknown;
  changedFiles?: unknown;
}

function payloadOf(item: ThreadItem): JoinablePayload {
  if (item.kind !== "activity") return {};
  const payload = item.payload;
  return typeof payload === "object" && payload !== null ? (payload as JoinablePayload) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The tool-call activity an approval is gating, or `null`.
 *
 * Matched on `toolUseId` only. There is deliberately **no positional
 * heuristic** ("the most recent file write"): with two writes in flight a
 * guess shows the user one path and writes another, which is worse than
 * showing nothing — this card exists so the user can see what they approve.
 */
export function findApprovalItem(
  approval: Pick<PendingApproval, "toolUseId">,
  entries: readonly ThreadItem[]
): ThreadItem | null {
  const toolUseId = approval.toolUseId;
  if (!toolUseId) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== "activity") continue;
    if (asString(payloadOf(entry).toolUseId) === toolUseId) return entry;
  }
  return null;
}

/** A path list plus whatever body the item carries, as one mono block. */
function detailFromItem(item: ThreadItem): string | null {
  const payload = payloadOf(item);
  const changed = asStringArray(payload.changedFiles);
  const body = asString(payload.detail) ?? asString(payload.command);
  const title = asString(payload.title);

  const parts: string[] = [];
  if (changed.length > 0) parts.push(changed.join("\n"));
  else if (title) parts.push(title);
  if (body) parts.push(body);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export interface ResolvedApprovalDetail {
  /** The block to render, or `null` when genuinely nothing is known. */
  text: string | null;
  /** Where it came from, for the card's own wording and for tests. */
  source: "request" | "item" | "none";
  /** Render with diff colouring: the body has unified-diff lines. */
  isDiff: boolean;
}

/** `+`/`-` at line starts, but not a `+++`/`---` file header alone. */
export function looksLikeDiff(text: string): boolean {
  let added = false;
  let removed = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) return true;
    if (line.startsWith("+")) added = true;
    else if (line.startsWith("-")) removed = true;
    if (added && removed) return true;
  }
  return added || removed;
}

export function resolveApprovalDetail(
  approval: Pick<PendingApproval, "detail" | "toolUseId">,
  entries: readonly ThreadItem[] = []
): ResolvedApprovalDetail {
  const fromRequest = asString(approval.detail);
  if (fromRequest) {
    return { text: fromRequest, source: "request", isDiff: looksLikeDiff(fromRequest) };
  }
  const item = findApprovalItem(approval, entries);
  const fromItem = item ? detailFromItem(item) : null;
  if (fromItem) {
    return { text: fromItem, source: "item", isDiff: looksLikeDiff(fromItem) };
  }
  return { text: null, source: "none", isDiff: false };
}

/**
 * What the body says when nothing is known. Never the card's own title: the
 * user must be able to tell "this writes something I cannot see" from "this
 * writes the file named in the heading".
 */
export const APPROVAL_DETAIL_UNAVAILABLE =
  "This request arrived without any detail. Decline it unless you know what it does.";

/** One unified-diff line's tone, for the card's per-line colouring. */
export type DiffLineTone = "added" | "removed" | "meta" | "context";

export function diffLineTone(line: string): DiffLineTone {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}
