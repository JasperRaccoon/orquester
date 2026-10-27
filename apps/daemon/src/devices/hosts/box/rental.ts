/**
 * What renting one more Mac device host means, from Settings → Devices: the provider, size, image
 * and lifetime the box service is asked for, its price, and whether the owner's standing approval
 * ("Rent Mac hosts without asking", up to the monthly cap) covers it.
 */

import type { BoxSizeOffer } from "@orquester/api";
import type { DevicesSettings } from "@orquester/api";

import {
  BLACKSMITH_IMAGES,
  BLACKSMITH_SIZES,
  blacksmithRunnerLabel,
  type BlacksmithImage,
  type BlacksmithSize
} from "../../../boxes/github/workflow-template.ts";

export interface DeviceHostRentalSpec {
  provider: string;
  /** The provider's size id (Blacksmith: `6vcpu`). */
  size: string;
  sizeLabel: string;
  /** The OS image (Blacksmith: `macos-26`); null: the provider's default. */
  image: string | null;
  hourlyUsd: number | null;
  lifetimeMinutes: number;
}

/**
 * `settings.ios.size` names a Blacksmith runner label (`blacksmith-6vcpu-macos-26`) or a provider
 * size id; other providers' labels and prices come from their offers when known.
 */
export function iosRentalSpec(settings: DevicesSettings, offers: readonly BoxSizeOffer[] = []): DeviceHostRentalSpec {
  const { provider, size, lifetimeMinutes } = settings.ios;
  if (provider === "blacksmith") {
    for (const candidate of BLACKSMITH_SIZES) {
      const images: (BlacksmithImage | null)[] = [null, ...BLACKSMITH_IMAGES.map((image) => image.id)];
      for (const image of images) {
        const label = image === null ? candidate.id : blacksmithRunnerLabel(candidate.id as BlacksmithSize, image);
        if (label !== size) continue;
        return {
          provider,
          size: candidate.id,
          sizeLabel: candidate.label,
          image,
          hourlyUsd: Math.round(candidate.perMinuteUsd * 60 * 100) / 100,
          lifetimeMinutes
        };
      }
    }
  }
  const offer = offers.find((entry) => entry.id === size);
  return { provider, size, sizeLabel: offer?.label ?? size, image: null, hourlyUsd: offer?.hourlyUsd ?? null, lifetimeMinutes };
}

/**
 * The owner's standing approval covers a rental when "Rent Mac hosts without asking" is on, the
 * price is known, and this month's device-host spending plus the new host's whole lifetime stays
 * within the monthly cap. Otherwise the requesting chat needs a `spend` card.
 */
export function rentalNeedsApproval(settings: DevicesSettings, spec: Pick<DeviceHostRentalSpec, "hourlyUsd" | "lifetimeMinutes">, monthSpentUsd: number): boolean {
  if (!settings.ios.rentWithoutAsking) return true;
  if (spec.hourlyUsd === null) return true;
  const worstCase = (spec.hourlyUsd * spec.lifetimeMinutes) / 60;
  return monthSpentUsd + worstCase > settings.ios.monthlyCapUsd + 1e-9;
}
