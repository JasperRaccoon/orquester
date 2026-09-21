/**
 * Agent host — the session restart policy (spec §3.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:752-779`
 * (`runtimeModeChanged` / `cwdChanged` / `instanceChanged` /
 * `shouldRestartForModelChange` / `shouldRestartForModelSelectionChange`).
 *
 * This lives in orchestration, not in an adapter: a thread's session restarts,
 * carrying its resume cursor, when any of runtime mode, cwd, account or (Claude
 * only) the whole model-selection object changed. A model change on an adapter
 * declaring `sessionModelSwitch: "in-session"` is applied live, and plan mode
 * is a per-turn field that never restarts anything.
 */

import type {
  AdapterCapabilities,
  AgentAdapterId,
  ModelSelection,
  ProviderSession,
  RuntimeMode
} from "@orquester/api/agent-chat";

/** What the thread now wants, as the head records it. */
export interface DesiredSessionShape {
  adapter: AgentAdapterId;
  runtimeMode: RuntimeMode;
  cwd: string;
  accountKey: string;
  modelSelection: ModelSelection;
}

/** What the live session was started with. */
export interface BoundSessionShape {
  adapter: AgentAdapterId;
  runtimeMode: RuntimeMode;
  cwd: string;
  accountKey: string;
  modelSelection: ModelSelection;
  session: ProviderSession;
}

export interface RestartDecision {
  restart: boolean;
  /** Every trigger that fired, for the log and for the tests. */
  reasons: string[];
  /**
   * False when the model itself changed on an adapter that cannot switch in
   * session — the cursor is dropped so the provider starts a clean thread.
   * *T3: `ProviderCommandReactor.ts:781-784`.*
   */
  carryResumeCursor: boolean;
}

/** Deep structural equality over a `ModelSelection`, option order included. */
export function modelSelectionEquals(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.model !== right.model) return false;
  if ((left.instanceId ?? null) !== (right.instanceId ?? null)) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  for (let index = 0; index < leftOptions.length; index += 1) {
    const a = leftOptions[index]!;
    const b = rightOptions[index]!;
    if (a.id !== b.id || a.value !== b.value) return false;
  }
  return true;
}

/**
 * §3.4. A restart is a no-op when nothing changed, so the common case costs one
 * comparison.
 */
export function decideSessionRestart(input: {
  desired: DesiredSessionShape;
  bound: BoundSessionShape;
  capabilities: AdapterCapabilities;
}): RestartDecision {
  const { desired, bound, capabilities } = input;
  const reasons: string[] = [];

  if (desired.adapter !== bound.adapter) reasons.push("adapter");
  if (desired.runtimeMode !== bound.runtimeMode) reasons.push("runtimeMode");
  if (desired.cwd !== bound.cwd) reasons.push("cwd");
  if (desired.accountKey !== bound.accountKey) reasons.push("account");

  const modelChanged = desired.modelSelection.model !== bound.modelSelection.model;
  const modelRestart = modelChanged && capabilities.sessionModelSwitch === "unsupported";
  if (modelRestart) reasons.push("model");

  // Claude only, and compared by deep equality on the WHOLE selection object —
  // thinking level and fast mode are launch configuration there.
  const selectionRestart =
    desired.adapter === "claude" &&
    !modelSelectionEquals(desired.modelSelection, bound.modelSelection);
  if (selectionRestart && !modelRestart) reasons.push("modelSelection");

  return {
    restart: reasons.length > 0,
    reasons,
    carryResumeCursor: !modelRestart
  };
}
