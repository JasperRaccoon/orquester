/**
 * The provider-session binding — `threads/<id>/binding.json` (spec §3.3, §4.1).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/persistence/ProviderSessionRuntime.ts` (the
 * `provider_session_runtime` row) and
 * `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:118-145` (the
 * field-wise upsert whose `undefined` means "unchanged" and whose `null` means
 * "cleared").
 *
 * The binding keeps resume identity outside the head's event-sourced session
 * projection. {@link mergeSessionBinding} merges fields individually, so a
 * status change that omits the cursor cannot erase the provider conversation.
 *
 * Rollback boundary (§8): a missing or undecodable `binding.json` means "use
 * the head's cursor". An older host that never writes one still reads a head
 * written by a newer one, and a newer host reads a thread that has no binding.
 */

import type {
  AgentAdapterId,
  ProviderSessionBinding,
  ProviderSessionBindingPatch
} from "@orquester/api/agent-chat";

/** The file name inside `threads/<threadId>/`. */
export const BINDING_FILE_NAME = "binding.json";

/**
 * Merge a patch onto the binding a thread already has (or onto nothing).
 *
 * The contract, one line per field: a field the patch leaves `undefined` keeps
 * whatever the stored binding had; a field the patch sets to `null` is cleared.
 * `adapter` alone has no `null` form — a binding always names the adapter that
 * owns it — so an omitted `adapter` keeps the existing one and falls back to
 * `fallbackAdapter` when there is no existing binding at all.
 */
export function mergeSessionBinding(input: {
  threadId: string;
  existing: ProviderSessionBinding | null;
  patch: ProviderSessionBindingPatch;
  fallbackAdapter: AgentAdapterId;
  now: string;
}): ProviderSessionBinding {
  const { existing, patch } = input;
  return {
    threadId: input.threadId,
    adapter: patch.adapter ?? existing?.adapter ?? input.fallbackAdapter,
    adapterKey: patch.adapterKey !== undefined ? patch.adapterKey : (existing?.adapterKey ?? null),
    runtimeMode:
      patch.runtimeMode !== undefined ? patch.runtimeMode : (existing?.runtimeMode ?? null),
    providerInstanceId:
      patch.providerInstanceId !== undefined
        ? patch.providerInstanceId
        : (existing?.providerInstanceId ?? null),
    status: patch.status ?? existing?.status ?? "stopped",
    // The field the whole file exists for. `undefined` never reaches disk: an
    // absent cursor is stored as `null` so "no resumable session" and "this
    // write said nothing about the cursor" stay distinguishable.
    resumeCursor:
      patch.resumeCursor !== undefined ? patch.resumeCursor : (existing?.resumeCursor ?? null),
    providerThreadId:
      patch.providerThreadId !== undefined
        ? patch.providerThreadId
        : (existing?.providerThreadId ?? null),
    lastSeenAt: input.now
  };
}

/**
 * The binding's cursor as `startSession` wants it: `undefined` when there is
 * nothing to resume from, because `undefined` is what the adapter seam reads as
 * "start fresh". A stored `null` is exactly that.
 */
export function bindingResumeCursor(binding: ProviderSessionBinding | null): unknown {
  if (binding === null) return undefined;
  return binding.resumeCursor === null ? undefined : binding.resumeCursor;
}
