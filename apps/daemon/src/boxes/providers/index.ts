/**
 * The provider registry: every `BoxProviderAdapter` by id (spec §11). The adapters live in
 * `vm-providers.ts` (`VM_PROVIDER_ADAPTERS`), `gpu-providers.ts` (`GPU_PROVIDER_ADAPTERS`) and
 * `blacksmith.ts` (`BLACKSMITH_ADAPTER`); {@link BOX_PROVIDERS} is the daemon's registry of all of them.
 */

import { BOX_PROVIDER_IDS, type BoxProviderId } from "@orquester/api";

import type { BoxProviderAdapter, BoxProviderRegistry } from "../contracts.ts";
import { BLACKSMITH_ADAPTER } from "./blacksmith.ts";
import { GPU_PROVIDER_ADAPTERS } from "./gpu-providers.ts";
import { VM_PROVIDER_ADAPTERS } from "./vm-providers.ts";

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

/** Every provider this build rents boxes from (adapters with `kinds: []` stay registered but are not offered). */
export const BOX_PROVIDERS: BoxProviderRegistry = createProviderRegistry([...VM_PROVIDER_ADAPTERS, ...GPU_PROVIDER_ADAPTERS, BLACKSMITH_ADAPTER]);
