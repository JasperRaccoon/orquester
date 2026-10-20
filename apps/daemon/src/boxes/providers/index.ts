/**
 * The provider registry: every `BoxProviderAdapter` by id (spec §11). The adapters live in
 * `vm-providers.ts` (`VM_PROVIDER_ADAPTERS`), `gpu-providers.ts` (`GPU_PROVIDER_ADAPTERS`) and
 * `blacksmith.ts` (`BLACKSMITH_ADAPTER`); the daemon builds its registry with
 * `createProviderRegistry([...VM_PROVIDER_ADAPTERS, ...GPU_PROVIDER_ADAPTERS, BLACKSMITH_ADAPTER])`.
 */

import { BOX_PROVIDER_IDS, type BoxProviderId } from "@orquester/api";

import type { BoxProviderAdapter, BoxProviderRegistry } from "../contracts.ts";

/**
 * A registry over `adapters`, in `BOX_PROVIDER_IDS` order (the order the plugin page lists them).
 * Two adapters with one id, or an id this build does not know, are programming errors and throw.
 */
export function createProviderRegistry(adapters: readonly BoxProviderAdapter[]): BoxProviderRegistry {
  const byId = new Map<BoxProviderId, BoxProviderAdapter>();
  for (const adapter of adapters) {
    if (!(BOX_PROVIDER_IDS as readonly string[]).includes(adapter.id)) {
      throw new Error(`Unknown box provider id "${adapter.id}"`);
    }
    if (byId.has(adapter.id)) {
      throw new Error(`Two box provider adapters claim "${adapter.id}"`);
    }
    byId.set(adapter.id, adapter);
  }
  const ordered = new Map<BoxProviderId, BoxProviderAdapter>();
  for (const id of BOX_PROVIDER_IDS) {
    const adapter = byId.get(id);
    if (adapter) ordered.set(id, adapter);
  }
  return ordered;
}
