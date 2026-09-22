/**
 * Agent host — the PENDING provider snapshot (spec §3.2, §4.1).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/makeManagedServerProvider.ts:69-73`
 * (`initialSnapshot(settings)`, resolved synchronously at construction, before
 * any probe is forked) and
 * `apps/server/src/provider/Layers/ClaudeProvider.ts:595-640`
 * (`makePendingClaudeProvider`: `installed:false`, `auth:{status:"unknown"}`,
 * the "has not been checked in this session yet" message — **and the full
 * bundled model catalog**).
 *
 * Why this exists: a snapshot registry that starts empty answers
 * `GET /api/agent/providers` with `[]`, and every launcher then shows "Still
 * loading this agent's models" with nothing to launch. T3 never has that
 * window because a provider is *born* holding a snapshot; the probe only ever
 * replaces it. Layer one of three (pending seed → correlated disk cache →
 * forced boot probe).
 *
 * **Three rules a pending snapshot must keep.**
 *
 * 1. **Synchronous, no I/O.** It is built at construction, before any adapter
 *    exists and before the cache file is read, so it cannot await anything.
 * 2. **Never `status: "error"`.** The client's `authErrorMessage`
 *    (`packages/ui/src/lib/agent-chat/providers.ts`) raises the "sign in
 *    again" toast for `auth.status === "unauthenticated"` **or** for
 *    `status === "error"` with non-authenticated auth. A pending snapshot
 *    claims no verdict at all — `status:"unknown"` + `auth:{status:"unknown"}`
 *    — so it reaches neither arm. T3 spells this `status:"warning"`; Orquester's
 *    enum has no such member and `"unknown"` is its closest.
 * 3. **The best catalog it can give without probing.** A pending snapshot with
 *    no model is still unlaunchable, which is most of the bug. Claude ships a
 *    bundled fallback catalog; Grok a two-model one; Codex and OpenCode
 *    enumerate nothing statically (both read their catalog from a live server)
 *    and answer `[]` — for them the boot probe of layer three, not the pending
 *    seed, is what closes the window.
 */

/** The sentence's invariant tail — the part that does not vary by provider. */
const PENDING_MESSAGE_SUFFIX = "provider status has not been checked in this session yet.";

/** T3's exact sentence, per provider. *T3: `ClaudeProvider.ts:634`.* */
export function pendingStatusMessage(label: string): string {
  return `${label} ${PENDING_MESSAGE_SUFFIX}`;
}

/**
 * True for a snapshot that has never been probed in this host process.
 *
 * Derived rather than stored as its own flag: the snapshot crosses the socket
 * as `ProviderSnapshot`, and a new field would have to be threaded through the
 * wire contract, the cache file and every client fold for a fact these four
 * already carry between them.
 *
 * **The message is part of the test, not decoration.** `status:"unknown"` +
 * `auth:{status:"unknown"}` + `installed:false` is also exactly what
 * `opencode/snapshot.ts`'s `unusableSnapshot` produces for a host with no
 * `opencode` on PATH — a real, probed verdict that must still be cached and
 * still counts as probed. The sentence is what only a pending seed writes.
 */
export function isPendingSnapshot(snapshot: {
  status: string;
  auth: { status: string };
  installed: boolean;
  message?: string | undefined;
}): boolean {
  return (
    snapshot.status === "unknown" &&
    snapshot.auth.status === "unknown" &&
    snapshot.installed === false &&
    snapshot.message?.endsWith(PENDING_MESSAGE_SUFFIX) === true
  );
}
