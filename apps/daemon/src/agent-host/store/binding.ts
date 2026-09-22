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
 * **Why a second file rather than a field on the head.** The head's `session`
 * block is a projection of `thread.session-set`, and a `session-set` names the
 * whole block: one that omitted `resumeCursor` — a turn settling to `ready`, a
 * stop — replaced the block wholesale and the head lost its cursor. After the
 * next drain-restart the orchestrator started a FRESH provider session and the
 * conversation's context was gone (2026-09-22, thread c8979f6a). The fold now
 * carries the cursor forward, but an event-sourced field can always be replaced
 * by the next event that names it, so that is a belt, not a fix. Nothing
 * replaces this file whole: {@link mergeSessionBinding} is the only writer and
 * it merges field by field.
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
