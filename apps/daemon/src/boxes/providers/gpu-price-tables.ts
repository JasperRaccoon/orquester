/**
 * Bundled GPU prices (USD per GPU-hour, on demand) for when a provider's live
 * price source has no entry for a GPU or cannot be read. Offers priced from
 * these say `priceSource: "table"`. Refresh them from each `source` page when
 * providers change list prices; the live paths stay authoritative.
 */

import type { BoxProviderId } from "@orquester/api";

export interface GpuPriceTable {
  /** When the figures were copied (ISO date). */
  refreshedAt: string;
  /** The public page they come from. */
  source: string;
  /** Provider GPU key (as its API names the GPU) → USD per GPU-hour. */
  perGpuHourlyUsd: Readonly<Record<string, number>>;
  /** Flat USD per hour added to every box (e.g. a public IP). */
  perBoxHourlyUsd?: number;
}

export const GPU_PRICE_TABLES: Readonly<Partial<Record<BoxProviderId, GpuPriceTable>>> = {
  // Keys are Hyperstack flavor `gpu` names (they double as `/pricebook` entry names).
  hyperstack: {
    refreshedAt: "2026-10-20",
    source: "https://www.hyperstack.cloud/gpu-pricing",
    perGpuHourlyUsd: {
      "RTX-A4000": 0.15,
      "RTX-A6000": 0.5,
      L40: 1.0,
      "A100-80G-PCIe": 1.35,
      "A100-80G-PCIe-NVLink": 1.4,
      "A100-80G-SXM4": 1.6,
      "RTX-PRO-6000-SE": 1.85,
      "H100-80G-PCIe": 2.5,
      "H100-80G-PCIe-NVLink": 2.6,
      "H100-80G-SXM5": 3.2,
      "H200-141G-SXM5": 3.99,
      "B200-180G-SXM6": 6.0,
      "B300-288G-SXM6": 7.4
    },
    // A public IP is attached so the VM can reach the daemon.
    perBoxHourlyUsd: 0.00672
  },
  // Keys are Jarvislabs `gpu_type` values (`/misc/server_meta`).
  jarvislabs: {
    refreshedAt: "2026-10-20",
    source: "https://jarvislabs.ai/pricing",
    perGpuHourlyUsd: {
      A30: 0.41,
      L4: 0.44,
      RTX5000: 0.39,
      A5000: 0.49,
      A6000: 0.79,
      A100: 0.89,
      RTX6000Ada: 0.99,
      "A100-80GB": 1.49,
      "RTX-PRO6000": 2.19,
      H100: 3.49,
      H200: 4.59
    }
  }
};

/** Table price of `count` GPUs of `gpu` (plus the per-box extra), or null when the table has no entry. */
export function tableHourlyUsd(provider: BoxProviderId, gpu: string, count: number): number | null {
  const table = GPU_PRICE_TABLES[provider];
  const perGpu = table?.perGpuHourlyUsd[gpu];
  if (perGpu === undefined) return null;
  return Math.round((perGpu * count + (table!.perBoxHourlyUsd ?? 0)) * 1000) / 1000;
}
