/**
 * What the executor hands a running tool beyond `CallContext` (Task 1's contract), without
 * widening that contract: attached to the context object by the executor, read by the tool through
 * {@link callExtensions}. Pure (types only), so the agent host may load it with the catalog.
 *
 * - `legacy` — the todo and file services the external `/mcp`'s pre-catalog handlers take
 *   (`ToolContext.todos` / `.files`), until Tasks 9 and 12 route them through `DaemonApi`
 *   (deleted with `legacy.ts` in Task 14).
 * - `requestToolsetCard` — the ONE way a tool raises a toolset card (`request_toolset`, spec §9.3):
 *   the executor owns the `ApprovalPort`, so it opens the card for the calling chat, kind and
 *   family `toolset`, no grant options; workflow-owned callers are refused before any card
 *   (§5.4). Absent for external callers.
 */

import type { ApprovalPreviewSection, ToolsetId } from "@orquester/api";

import type { FsTools } from "../fs-tools.ts";
import type { TodoTools } from "../todo-tools.ts";
import type { ApprovalOutcome, CallContext } from "./contract.ts";

export interface LegacyToolServices {
  todos: TodoTools;
  files: FsTools;
}

export interface ToolsetCardInput {
  toolset: ToolsetId;
  /** One line, composed by the tool from structured data ("Claude asks to enable Workflow authoring for this chat"). */
  title: string;
  /** The toolset label, its tools with tiers. */
  sections: ApprovalPreviewSection[];
  /** The agent's reason, shown labelled as its words. */
  reason?: string;
}

export interface CallExtensions {
  legacy?: LegacyToolServices;
  requestToolsetCard?(input: ToolsetCardInput): Promise<ApprovalOutcome>;
}

const extensions = new WeakMap<CallContext, CallExtensions>();

/** Executor only: attach `ext` to `ctx`. */
export function attachCallExtensions(ctx: CallContext, ext: CallExtensions): void {
  extensions.set(ctx, ext);
}

/** What the executor attached to this call's context (empty when none). */
export function callExtensions(ctx: CallContext): CallExtensions {
  return extensions.get(ctx) ?? {};
}
