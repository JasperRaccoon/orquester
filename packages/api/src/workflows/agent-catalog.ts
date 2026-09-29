// Automated workflows — the agent catalogue validation checks chains against (`unknown_agent` /
// `unknown_model`, spec §7.2), built from what the host reports: the registry's chat agents and the
// provider snapshots' models.
//
// ONE rule for the daemon (its store, its write routes) and the editor (live), so both judge a chain
// alike: an agent's models count as LOADED only while its provider is `ready` — probed, and the
// probe read. Any other status may carry an adapter's bundled fallback list instead of the
// provider's own (a pending snapshot, `unknown`; Claude's or Grok's after a failed probe,
// `degraded` / `error`), and a live slug missing from that list (`opus[1m]`) must not refuse
// enabling: those models read as not known (null: a chain naming one is only warned about). An
// older snapshot carries the same statuses, so nothing new is needed from the host. The run gate
// does not use this rule — it checks against whatever the host resolves at run time. Legacy models
// are listed: a definition saved against one still runs. Matching stays exact (`validateWorkflow`).
//
// The inputs are structural, so a caller passes its own shapes (the daemon's `AgentView`, the
// client's `RegistryEntry` and `ProviderSnapshot`) without a conversion.

import type { WorkflowAgentCatalog } from "./validate.ts";

/** One chat agent as the catalogue reads it. */
export interface WorkflowCatalogAgentSource {
  /** Registry refId (claude, codex, grok, opencode). */
  id: string;
  /** The registry's: false when the agent's CLI was not found on this host. */
  enabled?: boolean;
  /** Its provider snapshot's status; only `ready` makes its models count (absent: no snapshot). */
  status?: string | null;
  /** Its provider's models (legacy ones included); absent reads as none. */
  models?: ReadonlyArray<{ slug: string }> | null;
}

/**
 * True when a provider's model list is its own, live one — its snapshot is `ready`. Anything else
 * (pending, degraded, errored, absent, a status this build does not know) may be a fallback list.
 */
export function providerModelsAreLive(status: string | null | undefined): boolean {
  return status === "ready";
}

/** The catalogue of `agents`, by the rule above. */
export function toWorkflowAgentCatalog(agents: readonly WorkflowCatalogAgentSource[]): WorkflowAgentCatalog {
  return {
    agents: agents.map((agent) => {
      const models = (agent.models ?? []).map((model) => model.slug).filter((slug) => typeof slug === "string" && slug !== "");
      const loaded = models.length > 0 && providerModelsAreLive(agent.status);
      return { id: agent.id, ...(agent.enabled !== undefined ? { enabled: agent.enabled } : {}), models: loaded ? models : null };
    })
  };
}

/** A registry entry as the join reads it: only one with a chat adapter is a chat agent. */
export interface WorkflowCatalogRegistryEntry {
  id: string;
  enabled: boolean;
  chat?: { adapter: string } | null;
}

/** A provider snapshot as the join reads it. */
export interface WorkflowCatalogProviderSnapshot {
  /** Adapter id. */
  id: string;
  /** Registry ids the adapter serves. */
  refIds?: readonly string[];
  status?: string | null;
  models?: ReadonlyArray<{ slug: string }> | null;
}

/**
 * The catalogue from the registry's entries and the provider snapshots: each chat agent (an entry
 * with a chat adapter) with its adapter's snapshot — the one whose id is the entry's adapter, else
 * one that lists the entry among its refIds. The same join the daemon's `loadAgents` makes.
 */
export function workflowAgentCatalogFromSnapshots(
  registryAgents: readonly WorkflowCatalogRegistryEntry[],
  providers: readonly WorkflowCatalogProviderSnapshot[]
): WorkflowAgentCatalog {
  const sources: WorkflowCatalogAgentSource[] = [];
  for (const entry of registryAgents) {
    const adapter = entry.chat?.adapter;
    if (typeof adapter !== "string" || adapter === "") continue;
    const snapshot =
      providers.find((provider) => provider.id === adapter) ??
      providers.find((provider) => Array.isArray(provider.refIds) && provider.refIds.includes(entry.id));
    sources.push({ id: entry.id, enabled: entry.enabled, status: snapshot?.status ?? "unknown", models: snapshot?.models ?? [] });
  }
  return toWorkflowAgentCatalog(sources);
}

/**
 * A stable fingerprint of a catalogue (or of none), for caches keyed on what validation reads:
 * agents by id, each with its enabled flag and its models in order ("?" while not loaded).
 */
export function workflowAgentCatalogKey(catalog: WorkflowAgentCatalog | undefined): string {
  if (catalog === undefined) return "-";
  return [...catalog.agents]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((agent) => [agent.id, agent.enabled === false ? "off" : "on", agent.models === null ? "?" : agent.models.join("\u0003")].join("\u0002"))
    .join("\u0001");
}
