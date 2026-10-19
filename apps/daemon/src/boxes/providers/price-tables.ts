/**
 * Bundled prices for the VM providers whose APIs expose no prices (or not the
 * part we need, like Windows licence fees). Offers built from these tables say
 * `priceSource: "table"`. Every figure is the provider's public list price,
 * USD per hour unless the constant says otherwise, checked on the date in the
 * table's comment; refresh them when a provider changes its price list.
 */

/**
 * EUR → USD for providers that bill in euros (Hetzner, IONOS, OVH, Scaleway,
 * Exoscale, UpCloud). A constant on purpose: prices are estimates shown before
 * renting, and a fixed rate keeps them stable between page loads. ECB reference
 * rate, rounded, as of 2026-10-19.
 */
export const EUR_TO_USD = 1.16;

/** Hours in a billing month, for providers that publish monthly prices and bill hourly up to a cap. */
export const HOURS_PER_MONTH = 730;

export function eurToUsd(eur: number): number {
  return eur * EUR_TO_USD;
}

/** Round a price to 4 decimals (sub-cent hourly prices stay visible). */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function monthlyToHourly(monthly: number): number {
  return monthly / HOURS_PER_MONTH;
}

// ---------------------------------------------------------------------------
// Vultr (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * Vultr bills Windows Server licences on top of the plan: $16 per vCPU per
 * month, prorated hourly like the plan itself. `/v2/plans` and `/v2/os` do not
 * carry it.
 */
export const VULTR_WINDOWS_LICENCE_USD_PER_VCPU_MONTH = 16;
