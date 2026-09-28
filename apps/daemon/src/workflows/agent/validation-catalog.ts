// Automated workflows — the agent catalogue validation checks chains against (`unknown_agent` /
// `unknown_model`, spec §7.2).
//
// Validation is synchronous (the store validates on every write and every summary), the catalogue
// is not: it is the registry's chat agents plus the provider snapshots' models, read through the
// daemon's own REST (`loadAgents`, the very read an agent block's run-time check makes). So it is
// cached: `current()` answers the last reading (and refreshes it in the background once stale),
// and a write route awaits `ready()` first — a bounded refresh — so a save is judged against a
// catalogue no older than `ttlMs`. Without a reading (no API attached yet, the registry unreadable)
// nothing is checked: an unknown catalogue never refuses a definition.

import type { WorkflowAgentCatalog } from "@orquester/api";
import { launchesProxyModel, loadAgents, type AgentView, type DaemonApi } from "../../chat-client/index.ts";

export const VALIDATION_CATALOG_TTL_MS = 30_000;
export const VALIDATION_CATALOG_WAIT_MS = 3_000;

/**
 * The catalogue as validation reads it. A provider's models count as LOADED only once it has been
 * probed (a pending snapshot — status `unknown` — carries a fallback list, not the provider's own);
 * claudex's models are the proxy's list, loaded when it lists any.
 */
export function toValidationCatalog(agents: readonly AgentView[]): WorkflowAgentCatalog {
  return {
    agents: agents.map((agent) => {
      const loaded = agent.models.length > 0 && (launchesProxyModel(agent.id) || agent.status !== "unknown");
      return { id: agent.id, enabled: agent.enabled, models: loaded ? agent.models.map((model) => model.slug) : null };
    })
  };
}

export interface ValidationCatalog {
  /** The latest reading, or undefined; a stale one starts a refresh in the background. */
  current(): WorkflowAgentCatalog | undefined;
  /** Refresh when stale, waiting at most `waitMs`; never rejects. */
  ready(waitMs?: number): Promise<void>;
  /** Drop the reading (a registry or provider change). */
  invalidate(): void;
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
      })
      .catch((error: unknown) => {
        opts.logger?.debug("workflow validation catalogue read failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const stale = (): boolean => now() - readAt >= ttl;

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
      inFlight = null;
    }
  };
}
