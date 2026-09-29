// Automated workflows — the agent catalogue validation checks chains against (`unknown_agent` /
// `unknown_model`, spec §7.2).
//
// Validation is synchronous (the store validates on every write and every summary), the catalogue
// is not: it is the registry's chat agents plus the provider snapshots' models, read through the
// daemon's own REST (`loadAgents`, the very read an agent block's run-time check makes). So it is
// cached: `current()` answers the last reading (and refreshes it in the background once stale),
// and a write route awaits `ready()` first — a bounded refresh — so a save is judged against a
// catalogue no older than `ttlMs`. Without a reading (no API attached yet, the registry unreadable)
// nothing is checked: an unknown catalogue never refuses a definition. A failed read is not retried
// for `ttlMs` either (the last reading, if any, stays), so a broken registry costs one read per
// window, not one per request; a registry or provider change (`expire`) asks again at once.

import { toWorkflowAgentCatalog, type WorkflowAgentCatalog } from "@orquester/api";
import { loadAgents, type AgentView, type DaemonApi } from "../../chat-client/index.ts";

export const VALIDATION_CATALOG_TTL_MS = 30_000;
export const VALIDATION_CATALOG_WAIT_MS = 3_000;

/**
 * The catalogue as validation reads it — `toWorkflowAgentCatalog`, the rule the editor applies to
 * the same registry and snapshots: a provider's models count as LOADED only while it is `ready`
 * (a pending or failed probe may carry a bundled fallback list, not the provider's own).
 */
export function toValidationCatalog(agents: readonly AgentView[]): WorkflowAgentCatalog {
  return toWorkflowAgentCatalog(agents);
}

export interface ValidationCatalog {
  /** The latest reading, or undefined; a stale one starts a refresh in the background. */
  current(): WorkflowAgentCatalog | undefined;
  /** Refresh when stale, waiting at most `waitMs`; never rejects. */
  ready(waitMs?: number): Promise<void>;
  /** Drop the reading. */
  invalidate(): void;
  /**
   * The host's catalogue changed (a registry entry, a provider snapshot): the next `current()` /
   * `ready()` reads again — even inside a failed read's backoff — while the last reading still
   * answers until then, so nothing flips to "unchecked" in between.
   */
  expire(): void;
}

export function createValidationCatalog(opts: {
  api: () => DaemonApi | null;
  now?: () => number;
  ttlMs?: number;
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void };
}): ValidationCatalog {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? VALIDATION_CATALOG_TTL_MS;
  let value: WorkflowAgentCatalog | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  /** After a failed read: no new read before this. */
  let retryAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let generation = 0;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const api = opts.api();
    if (!api) return Promise.resolve();
    const mine = generation;
    inFlight = loadAgents(api, { includeLegacyModels: true })
      .then((agents) => {
        if (mine !== generation) return;
        value = toValidationCatalog(agents);
        readAt = now();
        retryAt = Number.NEGATIVE_INFINITY;
      })
      .catch((error: unknown) => {
        if (mine === generation) retryAt = now() + ttl;
        opts.logger?.debug("workflow validation catalogue read failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const stale = (): boolean => {
    const at = now();
    return at - readAt >= ttl && at >= retryAt;
  };

  return {
    current() {
      if (stale()) void refresh();
      return value;
    },
    async ready(waitMs = VALIDATION_CATALOG_WAIT_MS) {
      if (!stale()) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        refresh(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        })
      ]);
      if (timer) clearTimeout(timer);
    },
    invalidate() {
      generation += 1;
      value = undefined;
      readAt = Number.NEGATIVE_INFINITY;
      retryAt = Number.NEGATIVE_INFINITY;
      inFlight = null;
    },
    expire() {
      // A read already in flight may predate the change: its answer is dropped, a new read starts.
      generation += 1;
      readAt = Number.NEGATIVE_INFINITY;
      retryAt = Number.NEGATIVE_INFINITY;
      inFlight = null;
    }
  };
}
