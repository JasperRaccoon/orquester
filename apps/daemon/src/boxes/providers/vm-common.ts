/**
 * Small pieces every VM provider adapter (vm-providers.ts) shares: credential
 * checks, the validate wrapper, user data for Linux and Windows, offer
 * grouping by regional price, and the Orquester marker on listed instances.
 */

import type { BoxKind, BoxSizeOffer } from "@orquester/api";

import type { BoxBootstrap, ProviderCallOptions, ProviderCredentials } from "../contracts.ts";
import { boxIdFromInstanceName, ProviderHttpError } from "./http.ts";
import { roundUsd } from "./price-tables.ts";

/** The tag/label key every Orquester instance carries (value: the box id). */
export const BOX_TAG_KEY = "orquester-box";

/** A credential field the owner left empty, or a request the adapter cannot serve. */
export class ProviderInputError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = "ProviderInputError";
    this.provider = provider;
  }
}

/** The trimmed value of a required credential field; throws {@link ProviderInputError} when empty. */
export function requireCredential(provider: string, credentials: ProviderCredentials, id: string, label: string): string {
  const value = credentials[id]?.trim();
  if (!value) throw new ProviderInputError(provider, `${label} is missing`);
  return value;
}

/** The trimmed value of an optional credential field, or null. */
export function optionalCredential(credentials: ProviderCredentials, id: string): string | null {
  const value = credentials[id]?.trim();
  return value ? value : null;
}

/**
 * Run a cheap authenticated read and turn every failure that is not the
 * caller's abort into `{ ok: false }` with the provider's message: wrong keys,
 * missing fields, unreachable APIs, malformed private keys.
 */
export async function validateWith(
  options: ProviderCallOptions,
  check: () => Promise<unknown>
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await check();
    return { ok: true };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, message: `${error.message} (check the key and its permissions)` };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.status === 404;
}

export function assertKind(provider: string, kinds: readonly BoxKind[], kind: BoxKind): void {
  if (!kinds.includes(kind)) throw new ProviderInputError(provider, `does not rent ${kind} boxes`);
}

export function isWindowsKind(kind: BoxKind): boolean {
  return kind === "windows" || kind === "windows-gpu";
}

export function isGpuKind(kind: BoxKind): boolean {
  return kind === "linux-gpu" || kind === "windows-gpu";
}

/**
 * Windows user data for cloudbase-init (and OCI/Exoscale/OVH/Scaleway images
 * that run it): `#ps1_sysnative` runs the script with the 64-bit PowerShell as
 * LocalSystem on first boot.
 */
export function cloudbaseInitUserData(bootstrap: BoxBootstrap): string {
  return `#ps1_sysnative\r\n${bootstrap.powershellScript}`;
}

/** Linux: cloud-init user data; Windows: cloudbase-init PowerShell user data. */
export function userDataFor(kind: BoxKind, bootstrap: BoxBootstrap): string {
  return isWindowsKind(kind) ? cloudbaseInitUserData(bootstrap) : bootstrap.cloudInit;
}

export function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The box id an instance belongs to: the tag value when present, else parsed from `orq-<boxId>`. */
export function managedBoxId(tagValue: string | null | undefined, name: string): string | null {
  if (typeof tagValue === "string" && tagValue.length > 0) return tagValue;
  return boxIdFromInstanceName(name);
}

/** Whether an instance carries Orquester's marker (the tag, or an `orq-<boxId>` name). */
export function isManagedName(name: string): boolean {
  return boxIdFromInstanceName(name) !== null;
}

/**
 * Sizes whose price differs by region become one offer per price, so the
 * price the UI shows is the price of the region picked. The cheapest group
 * keeps the plain size id; other groups get `<size>@<first region>`, which
 * {@link baseSizeId} strips again before calling the provider.
 */
export function offersByRegionalPrice(
  base: Omit<BoxSizeOffer, "id" | "hourlyUsd" | "regions">,
  sizeId: string,
  prices: ReadonlyMap<string, number | null>
): BoxSizeOffer[] {
  const groups = new Map<string, { hourlyUsd: number | null; regions: string[] }>();
  for (const [region, price] of prices) {
    const rounded = price === null ? null : roundUsd(price);
    const key = rounded === null ? "null" : String(rounded);
    const group = groups.get(key) ?? { hourlyUsd: rounded, regions: [] };
    group.regions.push(region);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
  return sorted.map((group, index) => ({
    ...base,
    id: index === 0 ? sizeId : `${sizeId}@${group.regions[0]}`,
    hourlyUsd: group.hourlyUsd,
    regions: group.regions
  }));
}

/** `cpx11@ash` → `cpx11` (see {@link offersByRegionalPrice}). */
export function baseSizeId(size: string): string {
  const at = size.indexOf("@");
  return at === -1 ? size : size.slice(0, at);
}

/** Cheapest first, then by vCPU and RAM, for stable offer lists. */
export function sortSizes(sizes: BoxSizeOffer[]): BoxSizeOffer[] {
  return sizes.sort(
    (a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity) || a.vcpu - b.vcpu || a.ramGb - b.ramGb || a.id.localeCompare(b.id)
  );
}

/** ISO string or null from a provider timestamp (seconds, milliseconds or a date string). */
export function isoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Wait `ms` between two polls of a provider inside a deadline loop (a create
 * operation, a server that must stop before it can be deleted). Rejects with
 * the signal's reason as soon as the caller aborts.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A required string field of a provider instance ref (persisted `StoredBox.providerRef`). */
export function refString(provider: string, ref: Record<string, unknown>, key: string): string {
  const value = ref[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ProviderInputError(provider, `instance reference has no ${key}`);
}
