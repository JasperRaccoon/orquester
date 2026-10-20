/**
 * The New project dialog's "Runs on" row (Ephemeral AI VMs spec §8.1): where
 * the new project runs — this host (the default) or a new box of one kind —
 * and, for a box, its provider, size, region / OS image and (macOS) lifetime.
 *
 * A pure reducer plus the selectors the row renders from, so the whole
 * choice can be tested without a DOM. Offers load per provider and kind: the
 * reducer asks for them (`offers.status === "loading"`), the component reads
 * them and dispatches the answer, which the reducer applies only while it is
 * still the provider and kind asked for.
 */

import {
  BOX_KIND_LABELS,
  type BoxImageOffer,
  type BoxKind,
  type BoxKindAvailability,
  type BoxLocationRequest,
  type BoxOffersResponse,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxRegionOffer,
  type BoxSizeOffer
} from "@orquester/api";

import {
  costForMinutes,
  dailyUsd,
  formatHourlyRate,
  formatHourlyUsd,
  formatLifetime,
  formatUsd,
  monthlyUsd
} from "../../../lib/boxes/format";

export type RunsOnOffers =
  | { status: "idle" }
  | { status: "loading"; provider: BoxProviderId; kind: BoxKind }
  | { status: "ready"; offers: BoxOffersResponse }
  | { status: "error"; provider: BoxProviderId; kind: BoxKind; message: string };

export interface RunsOnState {
  /** `host`, or the box kind chosen. */
  choice: "host" | BoxKind;
  provider: BoxProviderId | null;
  offers: RunsOnOffers;
  size: string | null;
  region: string | null;
  image: string | null;
  /** The chosen lifetime (kinds with a provider maximum: macOS). */
  lifetimeMinutes: number | null;
  /** The kind's maximum lifetime among its providers; null = none. */
  maxLifetimeMinutes: number | null;
}

export const RUNS_ON_INITIAL: RunsOnState = {
  choice: "host",
  provider: null,
  offers: { status: "idle" },
  size: null,
  region: null,
  image: null,
  lifetimeMinutes: null,
  maxLifetimeMinutes: null
};

export type RunsOnAction =
  | { type: "host" }
  | { type: "kind"; availability: BoxKindAvailability }
  | { type: "provider"; provider: BoxProviderId }
  | { type: "offers-loaded"; offers: BoxOffersResponse }
  | { type: "offers-failed"; provider: BoxProviderId; kind: BoxKind; message: string }
  | { type: "retry-offers" }
  | { type: "size"; id: string }
  | { type: "region"; id: string }
  | { type: "image"; id: string }
  | { type: "lifetime"; minutes: number }
  /** The kinds the daemon offers changed (a provider was connected or removed). */
  | { type: "kinds"; kinds: readonly BoxKindAvailability[] }
  | { type: "reset" };

/** The shortest lifetime offered (a box needs time to set up and be useful). */
const MIN_LIFETIME_MINUTES = 60;
const LIFETIME_STEPS = [60, 4 * 60, 12 * 60, 24 * 60, 2 * 24 * 60, 3 * 24 * 60, 4 * 24 * 60, 5 * 24 * 60];

/** Whether a kind's card can be chosen: a connected provider and no reason against it. */
export function kindSelectable(availability: BoxKindAvailability): boolean {
  return availability.providers.length > 0 && availability.unavailableReason === null;
}

const byPrice = (a: BoxSizeOffer, b: BoxSizeOffer): number => {
  if (a.hourlyUsd === b.hourlyUsd) return 0;
  if (a.hourlyUsd === null) return 1;
  if (b.hourlyUsd === null) return -1;
  return a.hourlyUsd - b.hourlyUsd;
};

/** A size's regions within an answer (empty list = all of them). */
function regionsOf(offers: BoxOffersResponse, size: BoxSizeOffer | undefined): BoxRegionOffer[] {
  if (!size || size.regions.length === 0) return offers.regions;
  const allowed = new Set(size.regions);
  return offers.regions.filter((region) => allowed.has(region.id));
}

function clampLifetime(minutes: number, max: number | null): number {
  const floor = Math.min(MIN_LIFETIME_MINUTES, max ?? MIN_LIFETIME_MINUTES);
  const rounded = Math.round(minutes);
  return Math.max(floor, max === null ? rounded : Math.min(rounded, max));
}

/** The cheapest size and its first region, the first image. */
function withDefaults(state: RunsOnState, offers: BoxOffersResponse): RunsOnState {
  const size = [...offers.sizes].sort(byPrice)[0];
  const region = regionsOf(offers, size)[0];
  return {
    ...state,
    offers: { status: "ready", offers },
    size: size?.id ?? null,
    region: region?.id ?? null,
    image: offers.images[0]?.id ?? null
  };
}

const loading = (state: RunsOnState, provider: BoxProviderId, kind: BoxKind): RunsOnState => ({
  ...state,
  provider,
  offers: { status: "loading", provider, kind },
  size: null,
  region: null,
  image: null
});

export function runsOnReducer(state: RunsOnState, action: RunsOnAction): RunsOnState {
  switch (action.type) {
    case "reset":
      return RUNS_ON_INITIAL;
    case "host":
      return state.choice === "host" ? state : RUNS_ON_INITIAL;
    case "kind": {
      const { availability } = action;
      if (!kindSelectable(availability)) return state;
      if (state.choice === availability.kind) return state;
      const max = availability.maxLifetimeMinutes;
      return {
        ...loading(RUNS_ON_INITIAL, availability.providers[0], availability.kind),
        choice: availability.kind,
        maxLifetimeMinutes: max,
        lifetimeMinutes: max
      };
    }
    case "provider":
      if (state.choice === "host" || state.provider === action.provider) return state;
      return loading(state, action.provider, state.choice);
    case "offers-loaded": {
      const { offers } = action;
      if (state.offers.status !== "loading") return state;
      if (offers.provider !== state.offers.provider || offers.kind !== state.offers.kind) return state;
      return withDefaults(state, offers);
    }
    case "offers-failed":
      if (state.offers.status !== "loading") return state;
      if (action.provider !== state.offers.provider || action.kind !== state.offers.kind) return state;
      return { ...state, offers: { status: "error", provider: action.provider, kind: action.kind, message: action.message } };
    case "retry-offers":
      if (state.offers.status !== "error") return state;
      return loading(state, state.offers.provider, state.offers.kind);
    case "size": {
      if (state.offers.status !== "ready") return state;
      const offers = state.offers.offers;
      const size = offers.sizes.find((entry) => entry.id === action.id);
      if (!size) return state;
      const regions = regionsOf(offers, size);
      const region = regions.some((entry) => entry.id === state.region) ? state.region : (regions[0]?.id ?? null);
      return { ...state, size: size.id, region };
    }
    case "region": {
      if (state.offers.status !== "ready") return state;
      const offers = state.offers.offers;
      if (!offers.regions.some((entry) => entry.id === action.id)) return state;
      const current = offers.sizes.find((entry) => entry.id === state.size);
      if (current && regionsOf(offers, current).some((entry) => entry.id === action.id)) {
        return { ...state, region: action.id };
      }
      // The size is not rented there: the cheapest one that is.
      const size = [...offers.sizes].sort(byPrice).find((entry) => regionsOf(offers, entry).some((r) => r.id === action.id));
      return size ? { ...state, region: action.id, size: size.id } : state;
    }
    case "image":
      if (state.offers.status !== "ready" || !state.offers.offers.images.some((entry) => entry.id === action.id)) {
        return state;
      }
      return { ...state, image: action.id };
    case "lifetime":
      if (state.choice === "host" || state.maxLifetimeMinutes === null || !Number.isFinite(action.minutes)) return state;
      return { ...state, lifetimeMinutes: clampLifetime(action.minutes, state.maxLifetimeMinutes) };
    case "kinds": {
      if (state.choice === "host") return state;
      const availability = action.kinds.find((entry) => entry.kind === state.choice);
      // The kind went away (its last provider was removed): back to this host.
      if (!availability || !kindSelectable(availability)) return RUNS_ON_INITIAL;
      const max = availability.maxLifetimeMinutes;
      const next: RunsOnState = {
        ...state,
        maxLifetimeMinutes: max,
        lifetimeMinutes: max === null ? null : clampLifetime(state.lifetimeMinutes ?? max, max)
      };
      if (state.provider !== null && availability.providers.includes(state.provider)) return next;
      return loading(next, availability.providers[0], availability.kind);
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The offers to read now, or null. */
export function offersRequest(state: RunsOnState): { provider: BoxProviderId; kind: BoxKind } | null {
  return state.offers.status === "loading" ? { provider: state.offers.provider, kind: state.offers.kind } : null;
}

const readyOffers = (state: RunsOnState): BoxOffersResponse | null =>
  state.offers.status === "ready" ? state.offers.offers : null;

/** Every size, cheapest first (unpriced last). */
export function sizeOptions(state: RunsOnState): BoxSizeOffer[] {
  const offers = readyOffers(state);
  return offers ? [...offers.sizes].sort(byPrice) : [];
}

/** The regions the chosen size is rented in. */
export function regionOptions(state: RunsOnState): BoxRegionOffer[] {
  const offers = readyOffers(state);
  return offers ? regionsOf(offers, offers.sizes.find((size) => size.id === state.size)) : [];
}

export function imageOptions(state: RunsOnState): BoxImageOffer[] {
  return readyOffers(state)?.images ?? [];
}

export function selectedSize(state: RunsOnState): BoxSizeOffer | null {
  return readyOffers(state)?.sizes.find((size) => size.id === state.size) ?? null;
}

/**
 * Which selects the row shows after provider and size: the region; the OS
 * image instead when there is only one region to pick (macOS); both when both
 * are a choice.
 */
export function placementSelects(state: RunsOnState): { region: boolean; image: boolean } {
  const regions = regionOptions(state).length;
  const images = imageOptions(state).length;
  if (images === 0) return { region: true, image: false };
  return { region: regions > 1, image: true };
}

/** The size option's text: its label and price ("CX22 · $0.0119/h"). */
export function sizeOptionLabel(size: BoxSizeOffer): string {
  return size.hourlyUsd === null ? size.label : `${size.label} · ${formatHourlyRate(size.hourlyUsd)}`;
}

/** The size's specs for its tooltip: "2 vCPU · 4 GB RAM · 40 GB disk · 1× RTX 4090 (24 GB)". */
export function sizeSpecs(size: BoxSizeOffer): string {
  return [
    size.vcpu > 0 ? `${size.vcpu} vCPU` : null,
    size.ramGb > 0 ? `${size.ramGb} GB RAM` : null,
    size.diskGb !== null ? `${size.diskGb} GB disk` : null,
    size.gpu ? `${size.gpu.count}× ${size.gpu.model}${size.gpu.vramGb !== null ? ` (${size.gpu.vramGb} GB)` : ""}` : null
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The lifetimes offered up to `max` (the maximum always included). */
export function lifetimeOptions(max: number | null): number[] {
  if (max === null) return [];
  const steps = LIFETIME_STEPS.filter((minutes) => minutes < max);
  return [...steps, max];
}

/**
 * `CreateProjectRequest.location` for the choice: null for this host, and
 * null while a box choice is incomplete (offers loading, no size or region).
 */
export function runsOnLocation(state: RunsOnState): BoxLocationRequest | null {
  if (state.choice === "host" || state.provider === null || state.offers.status !== "ready") return null;
  if (state.size === null || state.region === null) return null;
  const images = state.offers.offers.images;
  if (images.length > 0 && (state.image === null || !images.some((image) => image.id === state.image))) return null;
  return {
    kind: "box",
    boxKind: state.choice,
    provider: state.provider,
    size: state.size,
    region: state.region,
    ...(images.length > 0 && state.image !== null ? { image: state.image } : {}),
    ...(state.maxLifetimeMinutes !== null && state.lifetimeMinutes !== null
      ? { lifetimeMinutes: clampLifetime(state.lifetimeMinutes, state.maxLifetimeMinutes) }
      : {})
  };
}

/** Whether the dialog may submit with this choice. */
export function runsOnReady(state: RunsOnState): boolean {
  return state.choice === "host" || runsOnLocation(state) !== null;
}

/** Whether the choice is a box (the submit button then says so). */
export function runsInBox(state: RunsOnState): boolean {
  return state.choice !== "host";
}

export interface RunsOnSummary {
  tone: "info" | "warn";
  text: string;
}

/** The note under the selects: the price, and what the box does and when it goes. */
export function runsOnSummary(state: RunsOnState): RunsOnSummary | null {
  if (state.choice === "host") return null;
  const size = selectedSize(state);
  if (!size) return null;
  const hourly = size.hourlyUsd;
  if (state.choice === "macos") {
    const lifetime = state.lifetimeMinutes ?? state.maxLifetimeMinutes;
    const limit =
      lifetime === null
        ? "macOS boxes are destroyed automatically when their job's time limit ends"
        : `macOS boxes are destroyed automatically after at most ${formatLifetime(lifetime)}${
            hourly === null ? "" : ` (≈ ${formatUsd(costForMinutes(hourly, lifetime))} if left running)`
          }`;
    const price = hourly === null ? "The price for this size is unknown." : `${formatHourlyRate(hourly)}, about ${formatUsd(dailyUsd(hourly))} a day.`;
    return { tone: "warn", text: `${price} ${limit}. The project row shows a countdown.` };
  }
  const price =
    hourly === null
      ? "The price for this size is unknown."
      : `≈ ${formatHourlyRate(hourly)}, ~${formatUsd(monthlyUsd(hourly))} a month.`;
  return {
    tone: "info",
    text: `${price} The box runs until you delete this project. Setup clones the repo and installs its toolchain.`
  };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export interface RunsOnKindCard {
  kind: BoxKind;
  label: string;
  /** Provider names, cheapest first. */
  providers: string;
  /** "from $0.0119/h", or macOS's "$4.80/h · max 5 days". */
  price: string | null;
  disabled: boolean;
  /** Why it is disabled (the card's tooltip). */
  reason: string | null;
}

/**
 * One card per kind the daemon lists with a connected provider or a reason it
 * is unavailable (a kind with neither is simply not set up: "Set up more…").
 */
export function kindCards(
  kinds: readonly BoxKindAvailability[] | null,
  providers: readonly BoxProviderInfo[] | null
): RunsOnKindCard[] {
  const labels = new Map((providers ?? []).map((provider) => [provider.id, provider.label]));
  return (kinds ?? [])
    .filter((entry) => entry.providers.length > 0 || entry.unavailableReason !== null)
    .map((entry) => {
      const price =
        entry.fromHourlyUsd === null
          ? null
          : entry.kind === "macos" && entry.maxLifetimeMinutes !== null
            ? `${formatHourlyRate(entry.fromHourlyUsd)} · max ${formatLifetime(entry.maxLifetimeMinutes)}`
            : `from ${formatHourlyUsd(entry.fromHourlyUsd)}/h`;
      const disabled = !kindSelectable(entry);
      return {
        kind: entry.kind,
        label: BOX_KIND_LABELS[entry.kind],
        providers: entry.providers.map((id) => labels.get(id) ?? id).join(", "),
        price,
        disabled,
        reason: disabled ? (entry.unavailableReason ?? "No provider for this kind is connected.") : null
      };
    });
}
