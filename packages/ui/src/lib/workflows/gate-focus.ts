/**
 * "Open the run with the gate selected" (spec 2026-11-10 §6.4): a gate's push
 * notification, a "Needs you" row and a rail card's "Open run" ask for it;
 * the run view showing that run takes the request once it knows the gate's
 * block, selects it, and the request is gone. One per run: the newest wins.
 * Memory only, no React.
 */

export interface GateFocusRequest {
  runId: string;
  gateId: string;
}

const pending = new Map<string, string>();
const listeners = new Set<() => void>();

function tell(): void {
  for (const listener of [...listeners]) listener();
}

/** Ask the run view of `runId` to select the block of gate `gateId`. */
export function requestGateFocus(request: GateFocusRequest): void {
  if (!request.runId || !request.gateId) return;
  pending.set(request.runId, request.gateId);
  tell();
}

/** The gate asked for in `runId`, if any (not taken). */
export function pendingGateFocus(runId: string | null | undefined): string | null {
  return runId ? (pending.get(runId) ?? null) : null;
}

/** Take the request for `runId` (it is acted on once). */
export function takeGateFocus(runId: string): string | null {
  const gateId = pending.get(runId) ?? null;
  if (gateId !== null) {
    pending.delete(runId);
    tell();
  }
  return gateId;
}

export function subscribeGateFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A connection switch or a sign-out. */
export function resetGateFocus(): void {
  if (pending.size === 0) return;
  pending.clear();
  tell();
}
