/**
 * Where a new box goes: provider, size, region, image and lifetime, checked against the provider's
 * live offers (spec §8.1, §13.1). Project boxes name everything; temporary boxes may leave the
 * provider, size and region to the cheapest offer.
 */

import { BOX_KIND_LABELS, isBoxKind, type BoxKind, type BoxRegionOffer, type BoxSizeOffer } from "@orquester/api";

import type { BoxProviderAdapter } from "../contracts.ts";
import { BoxError } from "./errors.ts";
import type { BoxSettings } from "./settings.ts";

export interface PlacementRequest {
  kind: unknown;
  provider?: unknown;
  size?: unknown;
  region?: unknown;
  image?: unknown;
  lifetimeMinutes?: unknown;
  /** Project boxes must name provider, size and region. */
  explicit: boolean;
  /** Required for temporary boxes; project boxes default to the provider's maximum (macOS) or none. */
  lifetimeRequired: boolean;
}

export interface Placement {
  adapter: BoxProviderAdapter;
  kind: BoxKind;
  size: BoxSizeOffer;
  region: BoxRegionOffer;
  image: string | null;
  lifetimeMinutes: number | null;
}

function invalid(message: string): BoxError {
  return new BoxError(400, "BOX_INVALID_REQUEST", message);
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw invalid(`\`${name}\` must be an id from the provider's offers.`);
  return value;
}

/** Cheapest priced size first; sizes without a price last. */
function bySizePrice(a: BoxSizeOffer, b: BoxSizeOffer): number {
  return (a.hourlyUsd ?? Number.POSITIVE_INFINITY) - (b.hourlyUsd ?? Number.POSITIVE_INFINITY) || a.vcpu - b.vcpu || a.ramGb - b.ramGb;
}

export async function resolvePlacement(settings: BoxSettings, request: PlacementRequest): Promise<Placement> {
  if (!isBoxKind(request.kind)) throw invalid("`kind` must be a box kind.");
  const kind = request.kind;
  const providerId = optionalId(request.provider, "provider");
  const sizeId = optionalId(request.size, "size");
  const regionId = optionalId(request.region, "region");
  const imageId = optionalId(request.image, "image");
  if (request.explicit && (!providerId || !sizeId || !regionId)) throw invalid("Choose a provider, a size and a region.");

  let adapter: BoxProviderAdapter;
  if (providerId) {
    try {
      adapter = settings.adapter(providerId);
    } catch {
      throw invalid(`No box provider "${providerId.slice(0, 64)}".`);
    }
    if (!adapter.kinds.includes(kind)) throw new BoxError(400, "BOX_UNSUPPORTED", `${adapter.label} does not rent ${BOX_KIND_LABELS[kind]} boxes.`);
    if (!settings.configured(adapter.id)) throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", `${adapter.label} is not connected.`);
    const blocker = settings.kindBlocker(adapter, kind);
    if (blocker) throw new BoxError(409, "BOX_UNSUPPORTED", blocker);
  } else {
    const kinds = await settings.kinds();
    const available = kinds.find((entry) => entry.kind === kind);
    const first = available?.providers[0];
    if (!first) {
      throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", available?.unavailableReason ?? `No connected provider rents ${BOX_KIND_LABELS[kind]} boxes.`);
    }
    adapter = settings.adapter(first);
  }
  // No route to this daemon: nothing would ever connect.
  settings.route(adapter.id);

  const offers = await settings.offers(adapter.id, kind);
  let size: BoxSizeOffer | undefined;
  if (sizeId) {
    size = offers.sizes.find((candidate) => candidate.id === sizeId);
    if (!size) throw invalid(`${adapter.label} does not offer the size "${sizeId}" for ${BOX_KIND_LABELS[kind]} boxes.`);
  } else {
    size = [...offers.sizes].sort(bySizePrice)[0];
    if (!size) throw new BoxError(409, "BOX_PROVIDER_ERROR", `${adapter.label} offers no ${BOX_KIND_LABELS[kind]} size right now.`);
  }
  const inSize = (id: string) => size!.regions.length === 0 || size!.regions.includes(id);
  let region: BoxRegionOffer | undefined;
  if (regionId) {
    region = offers.regions.find((candidate) => candidate.id === regionId);
    if (!region) throw invalid(`${adapter.label} has no region "${regionId}".`);
    if (!inSize(region.id)) throw invalid(`${size.label} is not available in ${region.label}.`);
  } else {
    region = offers.regions.find((candidate) => inSize(candidate.id));
    if (!region) throw new BoxError(409, "BOX_PROVIDER_ERROR", `${size.label} is not available in any region right now.`);
  }

  let image: string | null = settings.windowsImageId(adapter, kind);
  if (image === null) {
    if (imageId) {
      if (!offers.images.some((candidate) => candidate.id === imageId)) throw invalid(`${adapter.label} has no image "${imageId}".`);
      image = imageId;
    } else {
      image = offers.images[0]?.id ?? null;
    }
  }

  const max = adapter.maxLifetimeMinutes;
  let lifetimeMinutes: number | null;
  if (request.lifetimeMinutes === undefined || request.lifetimeMinutes === null) {
    if (request.lifetimeRequired) throw invalid("`lifetimeMinutes` is required.");
    lifetimeMinutes = max;
  } else {
    const value = request.lifetimeMinutes;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid("`lifetimeMinutes` must be a whole number of minutes.");
    if (max !== null && value > max) throw invalid(`${adapter.label} boxes live at most ${max} minutes.`);
    lifetimeMinutes = value;
  }
  return { adapter, kind, size, region, image, lifetimeMinutes };
}
