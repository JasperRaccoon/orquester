/**
 * Grok adapter — approvals (spec §4.3, §4.4).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/Layers/GrokAdapter.ts`
 * (`:289-313` `selectGrokPermissionOptionId`, `:1152-1166` the approval hash
 * key) and `packages/shared/src/relaySigning.ts:5-17` (`stableStringify`).
 *
 * **Reality correction to the spec and to T3** (fixtures observation 8): §4.3
 * says Grok "advertises no options" and T3 carries the comment *"Grok 4.6
 * often omits allow_always"*. CLI 1.0.34 advertises **all three**, and
 * `allow_always` is **`options[0]`**:
 *
 * ```json
 * [{"optionId":"allow-edits-session","kind":"allow_always","name":"Yes, allow all edits during this session"},
 *  {"optionId":"allow-once",         "kind":"allow_once", "name":"Yes"},
 *  {"optionId":"reject-once",        "kind":"reject_once","name":"No, and tell Grok what to do differently"}]
 * ```
 *
 * So "pick `options[0]`" is a dangerous default, and selection must key on
 * `kind`, never on index or on `name`. There is still no `reject_always`.
 * The option ids are stable strings, but the adapter echoes back the id it was
 * **given**, never a constant.
 */

import type { ApprovalDecision, CanonicalRequestType } from "@orquester/api/agent-chat";

import type { PermissionOption, RequestPermissionRequest } from "./acp/_generated/schema.ts";
import { extractToolCommand, normalizeToolKind, requestTypeFromToolKind } from "./tool-output.ts";
import { xaiToolMeta } from "./xai-meta.ts";

/**
 * Decision → the `optionId` to echo back, or `undefined` when the agent
 * offered nothing usable — in which case the reply is
 * `{"outcome":{"outcome":"cancelled"}}`, the catch-all for "no option id is
 * expressible", not just for a user cancellation.
 *
 * | decision | first choice | fallback |
 * |---|---|---|
 * | `accept` | `allow_once` | — |
 * | `acceptForSession` | `allow_always` | `allow_once` |
 * | `acceptAlways` | (never surfaced) | `reject_once` |
 * | `decline` | `reject_once` | — |
 * | `cancel` | never calls this | — |
 *
 * `acceptAlways` falls through to `reject_once` exactly as T3 does: there is
 * no permanent grant on this surface, and §4.3's four buttons never offer it.
 */
export function selectPermissionOptionId(
  options: ReadonlyArray<PermissionOption>,
  decision: ApprovalDecision
): string | undefined {
  const byKind = (kind: PermissionOption["kind"]): string | undefined => {
    const id = options.find((option) => option.kind === kind)?.optionId.trim();
    return id !== undefined && id.length > 0 ? id : undefined;
  };

  switch (decision) {
    case "accept":
      return byKind("allow_once");
    case "acceptForSession":
      // `allow_always` IS advertised on 1.0.34; the `allow_once` fallback is
      // kept because a future build may drop it again, and offering "Always
      // allow this session" that silently does nothing is worse than a
      // one-shot allow plus the adapter's own session-scoped grant below.
      return byKind("allow_always") ?? byKind("allow_once");
    case "acceptAlways":
    case "decline":
      return byKind("reject_once");
    case "cancel":
      return undefined;
    default: {
      const exhaustive: never = decision;
      void exhaustive;
      return undefined;
    }
  }
}

/** For `full-access`: the widest grant the request offers. */
export function selectAutoApprovedOptionId(
  options: ReadonlyArray<PermissionOption>
): string | undefined {
  return selectPermissionOptionId(options, "acceptForSession") ?? selectPermissionOptionId(options, "accept");
}

// ---------------------------------------------------------------------------
// The session-scoped grant key (§4.3)
// ---------------------------------------------------------------------------

/**
 * Key order-independent, `undefined` values dropped, array order **kept**
 * (so `locations` ordering is part of the identity).
 *
 * *T3: `packages/shared/src/relaySigning.ts:5-17`.*
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The key a "Always allow this session" grant is remembered under — the
 * **operation**, not the tool call.
 *
 * Three rules, each load-bearing:
 * 1. the hashed object is exactly `{kind, title, command, input, locations}`.
 *    Keying on `toolCallId` would approve nothing (it changes per
 *    invocation); keying on `kind` alone would approve every future command;
 * 2. a Bash `description` is **stripped**. Grok attaches a model-authored
 *    sentence to every `variant:"Bash"` rawInput and it varies run to run for
 *    the same command, so leaving it in makes the key unstable and the grant
 *    silently never fires again;
 * 3. **no key at all** when there is neither a parsed command nor a non-empty
 *    `rawInput`. A generic title like `"Terminal"` cannot identify an
 *    operation, so a grant on it would be a blanket session-wide approval for
 *    an unbounded set of future calls. With no key the grant is not recorded
 *    and the next request asks again.
 */
export function approvalGrantKey(toolCall: RequestPermissionRequest["toolCall"]): string | undefined {
  const rawInput = toolCall.rawInput;
  const title = toolCall.title ?? undefined;
  const kind = toolCall.kind ?? undefined;
  const locations = toolCall.locations ?? undefined;
  const command = extractToolCommand(rawInput, title);

  let operationInput = rawInput;
  if (rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const record = rawInput as Record<string, unknown>;
    if (record["variant"] === "Bash") {
      const { description: _description, ...shellInput } = record;
      void _description;
      operationInput = shellInput;
    }
  }

  const hasInput =
    rawInput !== null &&
    typeof rawInput === "object" &&
    !Array.isArray(rawInput) &&
    Object.keys(rawInput as Record<string, unknown>).length > 0;
  if (command === undefined && !hasInput) {
    return undefined;
  }
  return stableStringify({ kind, title, command, input: operationInput, locations });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The canonical request type of an approval. `_meta["x.ai/tool"].kind` is
 * consulted first because it is Grok's own authoritative discriminant and is
 * finer-grained than ACP's `kind` (which reports a plain `write` as `edit`
 * and an `enter_plan_mode` as `other`).
 */
export function permissionRequestType(toolCall: RequestPermissionRequest["toolCall"]): CanonicalRequestType {
  const meta = xaiToolMeta(toolCall._meta);
  if (meta !== undefined) {
    switch (meta.kind) {
      case "execute":
        return "exec_command_approval";
      case "read":
      case "list":
      case "search":
        return "file_read_approval";
      case "write":
      case "edit":
        return "file_change_approval";
      case "enter_plan":
      case "exit_plan":
        return "permission_approval";
      default:
        break;
    }
  }
  return requestTypeFromToolKind(normalizeToolKind(toolCall.kind));
}

/** True for a tool call an `auto-accept-edits` thread answers itself. */
export function isEditApproval(toolCall: RequestPermissionRequest["toolCall"]): boolean {
  const meta = xaiToolMeta(toolCall._meta);
  if (meta !== undefined) {
    return meta.kind === "write" || meta.kind === "edit";
  }
  const kind = normalizeToolKind(toolCall.kind);
  return kind === "edit" || kind === "delete" || kind === "move";
}

/**
 * A human-readable one-liner for the approval card, from what the request
 * actually carries. Never the raw params — those can be a whole file.
 */
export function permissionDetail(toolCall: RequestPermissionRequest["toolCall"]): string {
  const command = extractToolCommand(toolCall.rawInput, toolCall.title ?? undefined);
  if (command !== undefined) {
    return command;
  }
  const title = toolCall.title?.trim();
  if (title !== undefined && title.length > 0) {
    return title;
  }
  const location = toolCall.locations?.[0]?.path;
  return typeof location === "string" && location.length > 0 ? location : "Tool call";
}
