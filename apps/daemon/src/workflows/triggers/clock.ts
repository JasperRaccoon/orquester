// Wall clock for workflow triggers; timers do not keep the daemon alive.

import type { Clock } from "../contracts.ts";

/** Wall clock with unref'd timers. */
export const systemTriggerClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }
};
