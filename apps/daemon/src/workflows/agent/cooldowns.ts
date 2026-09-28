// Automated workflows — account cooldowns (spec §5.4 step 1).
//
// An account that hit a usage limit (or failed to sign in) is cooled down in
// `workflow-state.json`, keyed `<family>:<accountId>` (`cooldownKey`), and every workflow's
// selection skips it until then — the same account is not burnt again by the next block or the
// next run. `list()` serves only the active ones; expired ones are pruned on every write.

import type { AccountCooldown } from "@orquester/config";
import type { Clock, CooldownStore } from "../contracts.ts";
import type { WorkflowStateStore } from "../state-store.ts";
import { cooldownKey } from "./families.ts";

/** A provider reset further out than this is not believed (a misparsed or epoch-shifted stamp). */
export const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60_000;
/** No reset known, or an auth failure: try again in an hour. */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

function isActive(cooldown: AccountCooldown, nowMs: number): boolean {
  const until = Date.parse(cooldown.until);
  return Number.isFinite(until) && until > nowMs;
}

export function createCooldownStore(stateStore: WorkflowStateStore, clock: Pick<Clock, "now">): CooldownStore {
  return {
    get(family, accountId) {
      const cooldown = stateStore.get().cooldowns[cooldownKey(family, accountId)];
      return cooldown && isActive(cooldown, clock.now().getTime()) ? cooldown : null;
    },
    set(family, accountId, cooldown) {
      return stateStore.update((draft) => {
        const nowMs = clock.now().getTime();
        for (const [key, existing] of Object.entries(draft.cooldowns)) {
          if (!isActive(existing, nowMs)) delete draft.cooldowns[key];
        }
        draft.cooldowns[cooldownKey(family, accountId)] = cooldown;
      });
    },
    list() {
      const nowMs = clock.now().getTime();
      return Object.fromEntries(Object.entries(stateStore.get().cooldowns).filter(([, cooldown]) => isActive(cooldown, nowMs)));
    }
  };
}

/**
 * Until when an account cools down:
 *   - auth failure: now + 1 h (the account is also unusable for the rest of the run — the engine's
 *     `exclude` set, not this);
 *   - usage limit: the provider's `resetsAt` when it is in the future and at most 8 days out; else
 *     the reset of the account's burnt window from the usage snapshot (`burntWindowResetAt`), under
 *     the same bounds; else now + 1 h.
 */
export function cooldownUntil(input: {
  resetsAt?: string;
  usageResetAt?: string;
  now: Date;
  reason: AccountCooldown["reason"];
}): Date {
  const nowMs = input.now.getTime();
  const fallback = new Date(nowMs + DEFAULT_COOLDOWN_MS);
  if (input.reason === "auth") return fallback;
  for (const stamp of [input.resetsAt, input.usageResetAt]) {
    const t = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(t) && t > nowMs && t - nowMs <= MAX_COOLDOWN_MS) return new Date(t);
  }
  return fallback;
}

/** The record `CooldownStore.set` takes. */
export function buildCooldown(input: {
  resetsAt?: string;
  usageResetAt?: string;
  now: Date;
  reason: AccountCooldown["reason"];
  detail?: string;
}): AccountCooldown {
  return {
    until: cooldownUntil(input).toISOString(),
    reason: input.reason,
    setAt: input.now.toISOString(),
    ...(input.detail ? { detail: input.detail } : {})
  };
}
