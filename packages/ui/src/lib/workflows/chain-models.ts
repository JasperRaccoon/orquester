/**
 * Automated workflows — agent chains against the host's live catalogue.
 *
 * Validation matches a chain entry's model by its exact slug, in the daemon
 * and here alike (`workflowAgentCatalogFromSnapshots`). So what this client
 * writes on its own — a starter template, a fresh agent block — names a slug
 * the live catalogue lists: a static slug that is not listed (Claude's
 * catalogue says `opus[1m]`, not `opus`) is resolved to one that is, once, at
 * creation. Nothing here loosens matching; it only picks a listed slug.
 *
 * No React import.
 */

import {
  defaultNodeConfig,
  providerModelsAreLive,
  workflowAgentCatalogFromSnapshots,
  type CreateWorkflowRequest,
  type RegistryEntry,
  type WorkflowAgentCatalog,
  type WorkflowNodeConfig,
  type WorkflowNodeType
} from "@orquester/api";
import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

import { resolveSelectedModel } from "../../components/agent-chat/composer/composer-model";
import { providerForRefId, providersStore } from "../agent-chat/providers";
import { isRecord } from "./sanitize";

/**
 * The catalogue the editor validates chains against, or `undefined` while the
 * registry lists no chat agent (not read yet) — an empty registry would make
 * every chain entry an unknown agent. Providers not `ready` (still loading, or
 * a failed probe's fallback list) list no models: their entries are only
 * warned about.
 */
export function editorAgentCatalog(
  registryAgents: readonly Pick<RegistryEntry, "id" | "enabled" | "chat">[],
  providers: readonly ProviderSnapshot[]
): WorkflowAgentCatalog | undefined {
  if (!registryAgents.some((entry) => typeof entry.chat?.adapter === "string")) return undefined;
  return workflowAgentCatalogFromSnapshots(registryAgents, providers);
}

/** A slug's family: the slug without a trailing `[…]` variant ("opus[1m]" → "opus"). */
function modelFamily(slug: string): string {
  return slug.replace(/\[[^\]]*\]$/, "");
}

/**
 * The slug to write for `model` given a provider's loaded models: the slug
 * itself when listed; else a listed slug of the same family ("opus" →
 * "opus[1m]"); else the provider's default model; else `model` unchanged.
 * Legacy models are passed over — a new chain should not start on one — so a
 * listed legacy slug gives way to the default. No models: unchanged.
 */
function resolveChainModel(model: string, models: readonly ProviderModel[]): string {
  const current = models.filter((candidate) => candidate.isLegacy !== true);
  if (current.some((candidate) => candidate.slug === model)) return model;
  const family = modelFamily(model);
  const sibling = current.find((candidate) => modelFamily(candidate.slug) === family);
  if (sibling) return sibling.slug;
  return resolveSelectedModel(current, null)?.slug ?? model;
}

/**
 * A provider's models while they are its own live list (`providerModelsAreLive`, the rule
 * validation uses); none otherwise — a pending or failed probe may carry a bundled fallback list,
 * and resolving against that would swap a live slug for a stale one.
 */
function loadedModels(providers: readonly ProviderSnapshot[], agent: string): readonly ProviderModel[] {
  const provider = providerForRefId(providers, agent);
  return provider && providerModelsAreLive(provider.status) ? provider.models : [];
}

/** Each entry of an agent chain with its model resolved (`resolveChainModel`); other fields kept. */
function resolveChainModels<T>(chain: readonly T[], providers: readonly ProviderSnapshot[]): T[] {
  return chain.map((entry) => {
    if (!isRecord(entry) || typeof entry.agent !== "string" || typeof entry.model !== "string") return entry;
    const model = resolveChainModel(entry.model, loadedModels(providers, entry.agent));
    return model === entry.model ? entry : ({ ...entry, model } as T);
  });
}

/** An agent node's config with its chain resolved; any other config as is. */
function resolveConfig(config: unknown, providers: readonly ProviderSnapshot[]): unknown {
  if (!isRecord(config) || !Array.isArray(config.chain)) return config;
  const chain = resolveChainModels(config.chain as unknown[], providers);
  return chain.every((entry, index) => entry === (config.chain as unknown[])[index]) ? config : { ...config, chain };
}

/** A create request with every agent block's chain resolved against the live catalogue. */
export function withLiveChainModels(
  request: CreateWorkflowRequest,
  providers: readonly ProviderSnapshot[] = providersStore.getState().providers
): CreateWorkflowRequest {
  if (!request.nodes) return request;
  return {
    ...request,
    nodes: request.nodes.map((node) => {
      if (node.type !== "agent" || node.config === undefined) return node;
      const config = resolveConfig(node.config, providers);
      return config === node.config ? node : { ...node, config };
    })
  };
}

/**
 * A fresh block's config (`defaultNodeConfig`), an agent block's chain
 * resolved against the live catalogue this client holds.
 */
export function liveDefaultNodeConfig<T extends WorkflowNodeType>(
  type: T,
  providers: readonly ProviderSnapshot[] = providersStore.getState().providers
): WorkflowNodeConfig<T> {
  return resolveConfig(defaultNodeConfig(type), providers) as WorkflowNodeConfig<T>;
}
