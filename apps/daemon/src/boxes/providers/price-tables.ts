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

// ---------------------------------------------------------------------------
// OVHcloud (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * CAD → USD for OVHcloud Canada (`ovh-ca`), whose public catalog is priced in
 * Canadian dollars. Prices themselves come live from the catalog; only the
 * rate is fixed, like {@link EUR_TO_USD}. An approximate rate, rounded, set on
 * 2026-10-19; refresh it with the EUR rate.
 */
export const OVH_CAD_TO_USD = 0.72;

// ---------------------------------------------------------------------------
// Oracle Cloud Infrastructure (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * OCI list prices (USD, pay as you go) by part number, as the public price
 * list API (`https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/`,
 * `lastUpdated` 2026-10-08) reported them on 2026-10-19. The Oracle adapter
 * reads that API live and falls back to this table when it is unreachable.
 * OCI prices are the same in every commercial region. Compute parts are per
 * OCPU-hour or per GB-hour; block volume parts per GB-month. A1 shows the
 * paid tier: the first 3,000 OCPU-hours and 18,000 GB-hours of A1 a month
 * are free per tenancy.
 */
export const ORACLE_PART_PRICES_USD: Readonly<Record<string, number>> = {
  /** Compute - Standard - E4 - OCPU / Memory. */
  B93113: 0.025,
  B93114: 0.0015,
  /** Compute - Standard - E5 - OCPU / Memory. */
  B97384: 0.03,
  B97385: 0.002,
  /** OCI - Compute - Standard - E6 - OCPU / Memory. */
  B111129: 0.03,
  B111130: 0.002,
  /** Compute - Standard - X9 (VM.Standard3.Flex) - OCPU / Memory. */
  B94176: 0.04,
  B94177: 0.0015,
  /** Compute - Standard - A1 (Ampere Arm) - OCPU / Memory, paid tier. */
  B93297: 0.01,
  B93298: 0.0015,
  /** Compute - Windows OS, per OCPU-hour. */
  B88318: 0.092,
  /** Storage - Block Volume - Storage, per GB-month. */
  B91961: 0.0255,
  /** Storage - Block Volume - Performance Units, per VPU per GB-month (Balanced = 10 VPUs). */
  B91962: 0.0017
};

// ---------------------------------------------------------------------------
// Fly.io Machines (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * Fly has no pricing API. These are the constants of the calculator on
 * https://fly.io/docs/about/pricing/: a preset costs its vCPUs plus the RAM
 * above what the preset includes (¼ GB per shared vCPU, 2 GB per performance
 * vCPU), per second while started, at the Ashburn (iad) price; other regions
 * multiply the whole price (below). A started Machine's rootfs is not billed
 * separately (stopped Machines pay $0.15/GB-month for it; boxes never stop).
 */
export const FLY_USD_PER_VCPU_SECOND: Readonly<Record<"shared" | "performance", number>> = {
  shared: 8.465e-7,
  performance: 1.2732e-5
};
export const FLY_INCLUDED_RAM_GB_PER_VCPU: Readonly<Record<"shared" | "performance", number>> = {
  shared: 0.25,
  performance: 2
};
export const FLY_USD_PER_RAM_GB_SECOND = 2.316e-6;

/** Fly's per-region price multiplier (iad and ewr are the 1.0 baseline). */
export const FLY_REGION_PRICE_MULTIPLIERS: Readonly<Record<string, number>> = {
  ams: 1.038461538,
  arn: 1.038461538,
  cdg: 1.134615385,
  dfw: 1.25,
  ewr: 1,
  fra: 1.153846154,
  gru: 1.615384615,
  iad: 1,
  jnb: 1.302884615,
  lax: 1.199519231,
  lhr: 1.134615385,
  nrt: 1.307692308,
  ord: 1.25,
  sin: 1.269230769,
  sjc: 1.192307692,
  syd: 1.269230769,
  yyz: 1.115384615
};

// ---------------------------------------------------------------------------
// Morph Cloud (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * Morph bills Morph Compute Units: one MCU is 1 vCPU-hour, 4 GB RAM-hours or
 * 16 GB disk-hours, and a machine uses max(vCPUs, ⌈RAM / 4 GiB⌉,
 * ⌈disk / 16 GiB⌉) MCUs per hour. The pay-as-you-go rate is $0.05 per MCU;
 * paid plans include MCUs at a discount, which the shown price ignores
 * (https://cloud.morph.so/web/subscribe).
 */
export const MORPH_USD_PER_MCU = 0.05;
export const MORPH_MCU_RAM_GB = 4;
export const MORPH_MCU_DISK_GB = 16;

// ---------------------------------------------------------------------------
// Civo (checked 2026-10-19)
// ---------------------------------------------------------------------------

export type CivoInstanceFamily = "standard" | "cpu" | "performance" | "ram";

/**
 * Civo compute instance list prices, USD per hour, from
 * https://www.civo.com/pricing ("Compute" tables). `/v2/sizes` carries no
 * prices and the page names sizes only by family and vCPU/RAM, so entries are
 * matched on those. Transfer is free and the page lists no IPv4 fee.
 */
export const CIVO_INSTANCE_HOURLY_USD: ReadonlyArray<{ family: CivoInstanceFamily; vcpu: number; ramGb: number; hourlyUsd: number }> = [
  { family: "standard", vcpu: 1, ramGb: 1, hourlyUsd: 0.00744 },
  { family: "standard", vcpu: 1, ramGb: 2, hourlyUsd: 0.014881 },
  { family: "standard", vcpu: 2, ramGb: 4, hourlyUsd: 0.029762 },
  { family: "standard", vcpu: 4, ramGb: 8, hourlyUsd: 0.059524 },
  { family: "standard", vcpu: 6, ramGb: 16, hourlyUsd: 0.119048 },
  { family: "standard", vcpu: 8, ramGb: 32, hourlyUsd: 0.238095 },
  { family: "cpu", vcpu: 8, ramGb: 16, hourlyUsd: 0.190476 },
  { family: "cpu", vcpu: 16, ramGb: 32, hourlyUsd: 0.380952 },
  { family: "cpu", vcpu: 32, ramGb: 64, hourlyUsd: 0.761905 },
  { family: "cpu", vcpu: 64, ramGb: 128, hourlyUsd: 1.52381 },
  { family: "performance", vcpu: 4, ramGb: 16, hourlyUsd: 0.119055 },
  { family: "performance", vcpu: 8, ramGb: 32, hourlyUsd: 0.238096 },
  { family: "performance", vcpu: 16, ramGb: 64, hourlyUsd: 0.476192 },
  { family: "performance", vcpu: 32, ramGb: 128, hourlyUsd: 0.952384 },
  { family: "ram", vcpu: 2, ramGb: 16, hourlyUsd: 0.107137 },
  { family: "ram", vcpu: 4, ramGb: 32, hourlyUsd: 0.214288 },
  { family: "ram", vcpu: 8, ramGb: 64, hourlyUsd: 0.428575 },
  { family: "ram", vcpu: 16, ramGb: 128, hourlyUsd: 0.857137 }
];

// ---------------------------------------------------------------------------
// Scaleway (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * Scaleway's Instance prices (live from `/products/servers`) exclude storage
 * and the public IPv4 (https://www.scaleway.com/en/pricing/virtual-instances/).
 * Boxes boot from a Block Storage volume at the default 5K IOPS class, EUR per
 * GB-hour, Paris list price (https://www.scaleway.com/en/pricing/storage/);
 * other regions are assumed to match.
 */
export const SCALEWAY_BLOCK_EUR_PER_GB_HOUR = 0.00013;

/** One public IPv4 on an Instance, EUR per hour (https://www.scaleway.com/en/pricing/network/). */
export const SCALEWAY_IPV4_EUR_PER_HOUR = 0.005;

// ---------------------------------------------------------------------------
// IONOS Cloud (checked 2026-10-19)
// ---------------------------------------------------------------------------

/**
 * IONOS Cloud has no pricing API. vCPU Server list prices, EUR net, from
 * https://cloud.ionos.de/preise (the same in every location): per vCPU-hour
 * and per GB of RAM-hour, and the BALANCED (formerly "SSD Standard") block
 * storage class per GB per 30 days, billed hourly. The first public IPv4 of a
 * NIC (DHCP) is free. Contracts with IONOS Inc. are billed the USD list on
 * https://cloud.ionos.com/prices instead, within a few percent of these.
 */
export const IONOS_VCPU_EUR_PER_HOUR = 0.012;
export const IONOS_RAM_EUR_PER_GB_HOUR = 0.002;
export const IONOS_BALANCED_EUR_PER_GB_30_DAYS = 0.07;
