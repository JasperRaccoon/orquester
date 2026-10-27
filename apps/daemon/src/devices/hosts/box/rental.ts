/**
 * What renting one more Mac device host means, from Settings → Devices: the provider, size, image
 * and lifetime the box service is asked for, its price, and whether the owner's standing approval
 * covers it — "Rent device hosts without asking" (`pool.rentWithoutAsking`, the one switch for every
 * platform) up to `pool.monthlyCapUsd`, counting what device hosts spent this month AND what the
 * running ones are committed to until their time limit ({@link deviceHostSpend}).
 */

import type { BoxSizeOffer } from "@orquester/api";
import type { DevicesSettings } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import { monthCostUsd } from "../../../boxes/service/summary.ts";

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

/** Device-host spend (USD): today and this month so far (UTC), and what running hosts are committed to until their time limit. */
export interface DeviceHostSpend {
  todayUsd: number;
  monthUsd: number;
  committedUsd: number;
}

const HOUR_MS = 3_600_000;

/**
 * Spend on device-host boxes from their records — the one source the box factory's approval and
 * the device pool both read. `committedUsd`: every live device-host box's $/h until its deadline
 * (a running Mac bills until it is destroyed or its time limit ends).
 */
export function deviceHostSpend(records: readonly StoredBox[], now: number): DeviceHostSpend {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let todayUsd = 0;
  let monthUsd = 0;
  let committedUsd = 0;
  for (const record of records) {
    if (record.purpose !== "device-host") continue;
    const month = monthCostUsd(record, now);
    monthUsd += month;
    // The month's cost up to midnight (midnight is never before the month's start).
    todayUsd += Math.max(0, month - monthCostUsd(record, dayStart));
    const live = record.state !== "destroyed" && !record.destroyedAt;
    const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : NaN;
    if (live && typeof record.hourlyUsd === "number" && Number.isFinite(deadline) && deadline > now) committedUsd += (record.hourlyUsd * (deadline - now)) / HOUR_MS;
  }
  return { todayUsd, monthUsd, committedUsd };
}

/**
 * The owner's standing approval covers a rental when "Rent device hosts without asking"
 * (`pool.rentWithoutAsking`) is on, the price is known, and this month's device-host spending,
 * plus what running hosts are committed to, plus the new host's whole lifetime stays within
 * `pool.monthlyCapUsd`. Otherwise the requesting chat needs a `spend` card.
 */
export function rentalNeedsApproval(settings: DevicesSettings, spec: Pick<DeviceHostRentalSpec, "hourlyUsd" | "lifetimeMinutes">, spend: number | Pick<DeviceHostSpend, "monthUsd" | "committedUsd">): boolean {
  if (!settings.pool.rentWithoutAsking) return true;
  if (spec.hourlyUsd === null) return true;
  const spent = typeof spend === "number" ? spend : spend.monthUsd + spend.committedUsd;
  const worstCase = (spec.hourlyUsd * spec.lifetimeMinutes) / 60;
  return spent + worstCase > settings.pool.monthlyCapUsd + 1e-9;
}
