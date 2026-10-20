/**
 * GPU marketplaces and GPU clouds (spec §11.1, "Linux + GPU" and TensorDock).
 * `providers/index.ts` merges these with the VM providers and Blacksmith into
 * the registry. Per adapter:
 *
 * | Adapter | Machine | Bootstrap delivery | Marker | Prices |
 * |---|---|---|---|---|
 * | vast.ai | container | `onstart` = `stagedPosixScript` (≤ 4048 chars) + env | label | live (offer search) |
 * | RunPod | container | ENTRYPOINT (`containerCommand`) + env | name + env | live (catalog) |
 * | Hyperstack | VM | cloud-init `user_data` | name + label | live (pricebook), table fallback |
 * | Thunder Compute | container | none possible — no kinds (see `thunder.ts`) | name | live (public pricing) |
 * | CloudRift | VM | `cloudinit_commands` line | name + tag | live (instance types) |
 * | Massed Compute | VM | launch `command` line | name | live (inventory) |
 * | Jarvislabs | container | uploaded startup script | name | live (server meta), table fallback |
 * | TensorDock | VM | cloud-init object | name | live (locations) |
 *
 * Shared helpers: `gpu-common.ts`; bundled prices: `gpu-price-tables.ts`;
 * test doubles: `gpu-testing.ts`; recorded fixtures: `fixtures/<id>/`.
 */

import type { BoxProviderAdapter } from "../contracts.ts";
import { cloudriftAdapter } from "./cloudrift.ts";
import { hyperstackAdapter } from "./hyperstack.ts";
import { jarvislabsAdapter } from "./jarvislabs.ts";
import { massedAdapter } from "./massed.ts";
import { runpodAdapter } from "./runpod.ts";
import { tensordockAdapter } from "./tensordock.ts";
import { thunderAdapter } from "./thunder.ts";
import { vastaiAdapter } from "./vastai.ts";

export const GPU_PROVIDER_ADAPTERS: readonly BoxProviderAdapter[] = [
  vastaiAdapter,
  runpodAdapter,
  hyperstackAdapter,
  thunderAdapter,
  cloudriftAdapter,
  massedAdapter,
  jarvislabsAdapter,
  tensordockAdapter
];
