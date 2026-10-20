/**
 * Oracle Cloud Infrastructure (Core Services API 20160918,
 * https://docs.oracle.com/en-us/iaas/api/#/en/iaas/20160918/). Linux and
 * Windows boxes, commercial realm (`oc1`, `*.oraclecloud.com`) only.
 *
 * - Auth: an API signing key of an IAM user. Every request carries an HTTP
 *   signature (https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm):
 *   RSA-SHA256 over `date (request-target) host`, plus `content-length
 *   content-type x-content-sha256` for POST/PUT/PATCH, signed here with
 *   node:crypto over the exact body string that is sent.
 * - Regions: the configured region only; its availability domains are the
 *   offer "regions" (LaunchInstance needs one, and capacity — A1 above all —
 *   differs per AD). Shapes come per AD from ListShapes.
 * - Sizes: flex shapes only, as a curated set of shape configs whose ids
 *   encode them (`VM.Standard.E5.Flex:2:16` = 2 OCPUs, 16 GB).
 * - Prices: Oracle's public price list API (no auth) per OCPU-hour and
 *   GB-hour, the Windows OS fee per OCPU-hour, and the boot volume (Balanced,
 *   10 VPUs/GB) per GB-month; the bundled table in price-tables.ts when the
 *   price list is unreachable. Ephemeral public IPs are free.
 * - Network: one shared VCN `orquester-boxes` per compartment with an internet
 *   gateway, a 0.0.0.0/0 route and one public regional subnet, found by name
 *   or created on the first create and reused (VCNs cost nothing). Its
 *   security list allows all egress and only ICMP "fragmentation needed"
 *   ingress: orq-agent dials out, nothing dials in. It is never deleted.
 * - Marker: freeform tag `orquester-box=<boxId>`; ListInstances has no tag
 *   filter, so listManaged lists the compartment and filters.
 * - Bootstrap: `metadata.user_data` = base64 cloud-init (Linux, with the
 *   required `ssh_authorized_keys`) or base64 cloudbase-init `#ps1_sysnative`
 *   (OCI's Windows images run cloudbase-init). OCI generates the Windows
 *   `opc` password, readable through GetWindowsInstanceInitialCredentials
 *   only once the instance runs, so create returns none.
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

import type { BoxImageOffer, BoxKind, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

import type {
  BoxProviderAdapter,
  ProviderCallOptions,
  ProviderCreateRequest,
  ProviderCreateResult,
  ProviderCredentials,
  ProviderInstanceRef,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { ProviderHttpError, providerRequest, type ProviderRequest, type ProviderResponse } from "./http.ts";
import { monthlyToHourly, ORACLE_PART_PRICES_USD, roundUsd } from "./price-tables.ts";
import {
  abortableDelay,
  assertKind,
  base64,
  BOX_TAG_KEY,
  isManagedName,
  isNotFound,
  isoOrNull,
  isWindowsKind,
  managedBoxId,
  optionalCredential,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  userDataFor,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Oracle Cloud";
const API_VERSION = "20160918";
const KINDS: readonly BoxKind[] = ["linux", "windows"];
const PRICE_LIST_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";
const PAGE_SIZE = 100;

const NETWORK_NAME = "orquester-boxes";
const VCN_CIDR = "10.77.0.0/16";
const SUBNET_CIDR = "10.77.0.0/20";
/** How long a new VCN, gateway or subnet may take to become AVAILABLE, and how often to look. */
const RESOURCE_WAIT_MS = 120_000;
const RESOURCE_POLL_MS = 2_000;

/** Boot volume sizes create asks for (Windows images need 256 GB), which the price includes. */
const LINUX_BOOT_GB = 50;
const WINDOWS_BOOT_GB = 256;
/** Balanced block volume performance: 10 VPUs per GB. */
const BOOT_VPUS_PER_GB = 10;

const WINDOWS_OS_PART = "B88318";
const BLOCK_STORAGE_PART = "B91961";
const BLOCK_VPU_PART = "B91962";

interface ShapeInfo {
  cpu: string;
  arm: boolean;
  ocpuPart: string;
  memoryPart: string;
}

/** The flex shapes Orquester offers, with their price list part numbers. */
const SHAPES: Readonly<Record<string, ShapeInfo>> = {
  "VM.Standard.E4.Flex": { cpu: "AMD EPYC", arm: false, ocpuPart: "B93113", memoryPart: "B93114" },
  "VM.Standard.E5.Flex": { cpu: "AMD EPYC", arm: false, ocpuPart: "B97384", memoryPart: "B97385" },
  "VM.Standard.E6.Flex": { cpu: "AMD EPYC", arm: false, ocpuPart: "B111129", memoryPart: "B111130" },
  "VM.Standard3.Flex": { cpu: "Intel Xeon", arm: false, ocpuPart: "B94176", memoryPart: "B94177" },
  "VM.Standard.A1.Flex": { cpu: "Ampere Arm", arm: true, ocpuPart: "B93297", memoryPart: "B93298" }
};
const OCPU_CHOICES = [1, 2, 4, 8];
const GB_PER_OCPU_CHOICES = [8, 16];

const DEFAULT_LINUX_IMAGE = "ubuntu-24.04";
const DEFAULT_WINDOWS_IMAGE = "windows-2022";
const UBUNTU_OS = "Canonical Ubuntu";
const WINDOWS_OS = "Windows";

const REGION_PATTERN = /^[a-z]{2,}(?:-[a-z0-9]+)+-\d+$/;
const FINGERPRINT_PATTERN = /^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/;

interface OciShape {
  shape: string;
  isFlexible?: boolean;
  processorDescription?: string;
  ocpuOptions?: { min?: number; max?: number } | null;
  memoryOptions?: {
    minInGBs?: number;
    maxInGBs?: number;
    minPerOcpuInGBs?: number;
    maxPerOcpuInGBs?: number;
  } | null;
}

interface OciImage {
  id: string;
  displayName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  lifecycleState: string;
  timeCreated: string;
}

interface OciInstance {
  id: string;
  displayName: string;
  lifecycleState: string;
  availabilityDomain: string;
  compartmentId: string;
  region?: string;
  shape?: string;
  timeCreated?: string;
  freeformTags?: Record<string, string> | null;
}

interface OciResource {
  id: string;
  lifecycleState: string;
  timeCreated?: string;
}

interface OciVcn extends OciResource {
  defaultRouteTableId: string;
  defaultSecurityListId: string;
}

interface OciPriceItem {
  partNumber: string;
  currencyCodeLocalizations?: Array<{
    currencyCode: string;
    prices?: Array<{ model: string; value: number; rangeMin?: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

export interface OciSigningKey {
  /** `<tenancy OCID>/<user OCID>/<key fingerprint>`. */
  keyId: string;
  privateKey: KeyObject;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * The headers that sign one OCI request (`date`, `authorization`, and for
 * POST/PUT/PATCH the body headers). `body` must be the exact string sent.
 * `host` is signed from the URL and not returned: fetch sends it itself.
 */
export function ociSignedHeaders(
  key: OciSigningKey,
  method: string,
  url: string,
  body: string | null,
  date: string
): Record<string, string> {
  const target = new URL(url);
  const headers: Record<string, string> = { date };
  const names = ["date", "(request-target)", "host"];
  const lines = [`date: ${date}`, `(request-target): ${method.toLowerCase()} ${target.pathname}${target.search}`, `host: ${target.host}`];
  if (BODY_METHODS.has(method.toUpperCase())) {
    const text = body ?? "";
    headers["content-length"] = String(Buffer.byteLength(text, "utf8"));
    headers["content-type"] = "application/json";
    headers["x-content-sha256"] = createHash("sha256").update(text, "utf8").digest("base64");
    for (const name of ["content-length", "content-type", "x-content-sha256"]) {
      names.push(name);
      lines.push(`${name}: ${headers[name]}`);
    }
  }
  const signature = sign("sha256", Buffer.from(lines.join("\n"), "utf8"), key.privateKey).toString("base64");
  headers.authorization =
    `Signature version="1",headers="${names.join(" ")}",keyId="${key.keyId}",algorithm="rsa-sha256",signature="${signature}"`;
  return headers;
}

/**
 * Read the pasted PEM key. Tolerates the console download's trailing
 * `OCI_API_KEY` line, literal `\n`s and newlines flattened to spaces by a
 * single-line input. Never echoes the key in its errors.
 */
function parsePrivateKey(text: string): KeyObject {
  const normalized = text.replace(/\\n/g, "\n");
  if (/ENCRYPTED/.test(normalized)) {
    throw new ProviderInputError(PROVIDER, "the private key is encrypted; paste the unencrypted PEM key");
  }
  const match = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(normalized);
  if (!match) throw new ProviderInputError(PROVIDER, "the private key is not a PEM private key (-----BEGIN PRIVATE KEY-----)");
  const lines = match[2]!.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`, format: "pem" });
  } catch {
    throw new ProviderInputError(PROVIDER, "the private key could not be read");
  }
  if (key.asymmetricKeyType !== "rsa") throw new ProviderInputError(PROVIDER, "the private key must be an RSA key");
  return key;
}

/** OCI's key fingerprint: MD5 of the DER public key, colon-separated hex. */
export function ociKeyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return createHash("md5").update(der).digest("hex").match(/../g)!.join(":");
}

// ---------------------------------------------------------------------------
// Credentials and HTTP
// ---------------------------------------------------------------------------

interface OciContext {
  key: OciSigningKey;
  fingerprint: string;
  tenancyId: string;
  region: string;
  compartmentId: string;
}

function ocid(credentials: ProviderCredentials, id: string, label: string, types: readonly string[]): string {
  const value = requireCredential(PROVIDER, credentials, id, label);
  const match = /^ocid1\.([a-z]+)\.([a-z0-9]+)\.[A-Za-z0-9.-]*$/.exec(value);
  if (!match || !types.includes(match[1]!)) {
    throw new ProviderInputError(PROVIDER, `${label} must be an OCID starting with ocid1.${types[0]}.`);
  }
  if (match[2] !== "oc1") throw new ProviderInputError(PROVIDER, `${label} is not in the commercial realm (oc1)`);
  return value;
}

function regionName(value: string, label: string): string {
  if (!REGION_PATTERN.test(value)) throw new ProviderInputError(PROVIDER, `${label} must be a region identifier like eu-frankfurt-1`);
  return value;
}

function context(credentials: ProviderCredentials): OciContext {
  const tenancyId = ocid(credentials, "tenancyOcid", "Tenancy OCID", ["tenancy"]);
  const userId = ocid(credentials, "userOcid", "User OCID", ["user"]);
  const fingerprint = requireCredential(PROVIDER, credentials, "fingerprint", "Fingerprint").toLowerCase();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new ProviderInputError(PROVIDER, "Fingerprint must look like 12:34:56:…, 16 hex pairs");
  }
  const region = regionName(requireCredential(PROVIDER, credentials, "region", "Region").toLowerCase(), "Region");
  const compartmentId = optionalCredential(credentials, "compartmentOcid")
    ? ocid(credentials, "compartmentOcid", "Compartment OCID", ["compartment", "tenancy"])
    : tenancyId;
  const privateKey = parsePrivateKey(requireCredential(PROVIDER, credentials, "privateKey", "Private key"));
  return { key: { keyId: `${tenancyId}/${userId}/${fingerprint}`, privateKey }, fingerprint, tenancyId, region, compartmentId };
}

function coreUrl(region: string): string {
  return `https://iaas.${region}.oraclecloud.com/${API_VERSION}`;
}

function identityUrl(region: string): string {
  return `https://identity.${region}.oraclecloud.com/${API_VERSION}`;
}

/** `?a=1&b=2`, skipping undefined values, in the order given. */
function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** A signed OCI call. JSON bodies are serialized here so the signature covers the exact bytes sent. */
function ociRequest<T>(
  ctx: OciContext,
  request: Omit<ProviderRequest, "headers" | "body"> & { body?: unknown },
  options: ProviderCallOptions
): Promise<ProviderResponse<T>> {
  const method = request.method ?? "GET";
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers = ociSignedHeaders(ctx.key, method, request.url, body ?? null, new Date().toUTCString());
  return providerRequest<T>(PROVIDER, { ...request, method, headers, body }, options);
}

/** GET every page of an OCI list call (`opc-next-page` → `page`). */
async function listAll<T>(ctx: OciContext, url: string, options: ProviderCallOptions): Promise<T[]> {
  const items: T[] = [];
  let page: string | null = null;
  do {
    const pageUrl: string = page === null ? url : `${url}&page=${encodeURIComponent(page)}`;
    const response: ProviderResponse<T[]> = await ociRequest<T[]>(ctx, { url: pageUrl }, options);
    if (Array.isArray(response.data)) items.push(...response.data);
    page = response.headers.get("opc-next-page");
  } while (page);
  return items;
}

// ---------------------------------------------------------------------------
// Prices, shapes, images
// ---------------------------------------------------------------------------

interface PriceBook {
  prices: Readonly<Record<string, number>>;
  live: boolean;
}

/** The pay-as-you-go USD price of a part; for tiered parts (A1) the paid tier. */
function livePartPrice(item: OciPriceItem): number | null {
  const usd = item.currencyCodeLocalizations?.find((entry) => entry.currencyCode === "USD");
  const tiers = (usd?.prices ?? []).filter((price) => price.model === "PAY_AS_YOU_GO" && Number.isFinite(price.value));
  if (tiers.length === 0) return null;
  tiers.sort((a, b) => (b.rangeMin ?? 0) - (a.rangeMin ?? 0));
  return tiers[0]!.value;
}

/** Live prices for every part Orquester uses; the bundled table for any the price list lacks or when it fails. */
async function loadPrices(options: ProviderCallOptions): Promise<PriceBook> {
  try {
    const { data } = await providerRequest<{ items?: OciPriceItem[] }>(PROVIDER, { url: PRICE_LIST_URL, timeoutMs: 20_000 }, options);
    const byPart = new Map((data.items ?? []).map((item) => [item.partNumber, item]));
    const prices: Record<string, number> = {};
    let live = true;
    for (const [part, tablePrice] of Object.entries(ORACLE_PART_PRICES_USD)) {
      const item = byPart.get(part);
      const price = item ? livePartPrice(item) : null;
      if (price === null) live = false;
      prices[part] = price ?? tablePrice;
    }
    return { prices, live };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return { prices: ORACLE_PART_PRICES_USD, live: false };
  }
}

function hourlyUsd(info: ShapeInfo, ocpus: number, memoryGb: number, windows: boolean, book: PriceBook): number {
  const p = book.prices;
  const compute = ocpus * p[info.ocpuPart]! + memoryGb * p[info.memoryPart]!;
  const licence = windows ? ocpus * p[WINDOWS_OS_PART]! : 0;
  const bootGb = windows ? WINDOWS_BOOT_GB : LINUX_BOOT_GB;
  const boot = monthlyToHourly(bootGb * (p[BLOCK_STORAGE_PART]! + BOOT_VPUS_PER_GB * p[BLOCK_VPU_PART]!));
  return roundUsd(compute + licence + boot);
}

/** The curated configs of a flex shape that its OCPU and memory limits allow. */
function shapeConfigs(shape: OciShape): Array<{ ocpus: number; memoryGb: number }> {
  const ocpu = shape.ocpuOptions ?? {};
  const memory = shape.memoryOptions ?? {};
  const configs: Array<{ ocpus: number; memoryGb: number }> = [];
  for (const ocpus of OCPU_CHOICES) {
    if (ocpus < (ocpu.min ?? 1) || ocpus > (ocpu.max ?? Infinity)) continue;
    for (const perOcpu of GB_PER_OCPU_CHOICES) {
      const memoryGb = ocpus * perOcpu;
      if (perOcpu < (memory.minPerOcpuInGBs ?? 0) || perOcpu > (memory.maxPerOcpuInGBs ?? Infinity)) continue;
      if (memoryGb < (memory.minInGBs ?? 0) || memoryGb > (memory.maxInGBs ?? Infinity)) continue;
      configs.push({ ocpus, memoryGb });
    }
  }
  return configs;
}

/** `VM.Standard.E5.Flex:2:16` → the shape and its config. */
function parseSize(size: string): { shape: string; info: ShapeInfo; ocpus: number; memoryGb: number } {
  const match = /^([A-Za-z0-9.]+):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size);
  const info = match ? SHAPES[match[1]!] : undefined;
  if (!match || !info) throw new ProviderInputError(PROVIDER, `unknown size ${size}`);
  return { shape: match[1]!, info, ocpus: Number(match[2]), memoryGb: Number(match[3]) };
}

/** `Uocm:EU-FRANKFURT-1-AD-1` in eu-frankfurt-1 → `Frankfurt AD-1 (eu-frankfurt-1)`. */
function adLabel(ad: string, region: string): string {
  const number = /-AD-(\d+)$/i.exec(ad)?.[1];
  const city = region
    .split("-")
    .slice(1, -1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${city}${number ? ` AD-${number}` : ""} (${region})`;
}

interface ImageChoice {
  operatingSystem: string;
  version: string;
  label: string;
}

/** Image offer ids → the OS and version ListImages filters on. */
function imageChoice(kind: BoxKind, image: string | null): ImageChoice {
  const windows = isWindowsKind(kind);
  const id = image ?? (windows ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE);
  const ubuntu = /^ubuntu-(\d{2}\.\d{2})$/.exec(id);
  if (ubuntu && !windows) return { operatingSystem: UBUNTU_OS, version: ubuntu[1]!, label: `Ubuntu ${ubuntu[1]} LTS` };
  const server = /^windows-(\d{4})$/.exec(id);
  if (server && windows) {
    return { operatingSystem: WINDOWS_OS, version: `Server ${server[1]} Standard`, label: `Windows Server ${server[1]} Standard` };
  }
  throw new ProviderInputError(PROVIDER, `image ${id} is not offered for ${kind} boxes`);
}

/** The curated image offers among the platform images the region lists. */
function imageOffers(images: OciImage[], windows: boolean): BoxImageOffer[] {
  const ids = new Set<string>();
  for (const image of images) {
    if (image.lifecycleState !== "AVAILABLE") continue;
    if (windows) {
      const year = /^Server (\d{4}) Standard$/.exec(image.operatingSystemVersion)?.[1];
      if (year && Number(year) >= 2019) ids.add(`windows-${year}`);
    } else {
      // LTS releases only (even year, .04); `24.04 Minimal` and the like are skipped.
      const version = /^(\d{2})\.04$/.exec(image.operatingSystemVersion);
      if (version && Number(version[1]) % 2 === 0) ids.add(`ubuntu-${image.operatingSystemVersion}`);
    }
  }
  const preferred = windows ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE;
  return [...ids]
    .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : b.localeCompare(a)))
    .map((id) => ({ id, label: imageChoice(windows ? "windows" : "linux", id).label }));
}

/** The newest platform image of the choice that runs on `shape` (x86 or Arm build). */
async function resolveImage(ctx: OciContext, choice: ImageChoice, shape: string, options: ProviderCallOptions): Promise<OciImage> {
  const url =
    `${coreUrl(ctx.region)}/images` +
    query({
      compartmentId: ctx.compartmentId,
      operatingSystem: choice.operatingSystem,
      operatingSystemVersion: choice.version,
      shape,
      lifecycleState: "AVAILABLE",
      sortBy: "TIMECREATED",
      sortOrder: "DESC",
      limit: PAGE_SIZE
    });
  const { data } = await ociRequest<OciImage[]>(ctx, { url }, options);
  const image = (Array.isArray(data) ? data : []).find((entry) => !/GPU/i.test(entry.displayName));
  if (!image) throw new ProviderInputError(PROVIDER, `no ${choice.label} image runs on ${shape} in ${ctx.region}`);
  return image;
}

// ---------------------------------------------------------------------------
// Shared network
// ---------------------------------------------------------------------------

/** Poll a resource until it is AVAILABLE, within {@link RESOURCE_WAIT_MS}. */
async function waitAvailable<T extends OciResource>(ctx: OciContext, path: string, what: string, options: ProviderCallOptions): Promise<T> {
  const deadline = Date.now() + RESOURCE_WAIT_MS;
  for (;;) {
    const { data } = await ociRequest<T>(ctx, { url: `${coreUrl(ctx.region)}${path}` }, options);
    if (data.lifecycleState === "AVAILABLE") return data;
    if (data.lifecycleState === "TERMINATING" || data.lifecycleState === "TERMINATED") {
      throw new Error(`${PROVIDER}: the ${what} ${NETWORK_NAME} was deleted while it was being set up`);
    }
    if (Date.now() >= deadline) throw new Error(`${PROVIDER}: the ${what} ${NETWORK_NAME} did not become available in time`);
    await abortableDelay(RESOURCE_POLL_MS, options.signal);
  }
}

function live<T extends OciResource>(resources: T[]): T[] {
  return resources
    .filter((resource) => resource.lifecycleState !== "TERMINATING" && resource.lifecycleState !== "TERMINATED")
    .sort((a, b) => (a.timeCreated ?? "").localeCompare(b.timeCreated ?? ""));
}

/**
 * The public subnet boxes launch into: the shared `orquester-boxes` VCN's
 * subnet, created with its gateway, route and security list when missing.
 * A partly set up network (a failed earlier attempt) is completed.
 */
async function ensureSubnet(ctx: OciContext, options: ProviderCallOptions): Promise<string> {
  const core = coreUrl(ctx.region);
  const compartmentId = ctx.compartmentId;
  const vcns = live(
    (await ociRequest<OciVcn[]>(ctx, { url: `${core}/vcns${query({ compartmentId, displayName: NETWORK_NAME, limit: PAGE_SIZE })}` }, options)).data
  );
  let vcn = vcns[0];
  if (!vcn) {
    const { data } = await ociRequest<OciVcn>(
      ctx,
      {
        method: "POST",
        url: `${core}/vcns`,
        attempts: 1,
        body: { compartmentId, cidrBlocks: [VCN_CIDR], displayName: NETWORK_NAME, freeformTags: { "orquester-network": "boxes" } }
      },
      options
    );
    vcn = data;
  }
  if (vcn.lifecycleState !== "AVAILABLE") vcn = await waitAvailable<OciVcn>(ctx, `/vcns/${encodeURIComponent(vcn.id)}`, "VCN", options);

  const subnets = live(
    (
      await ociRequest<OciResource[]>(
        ctx,
        { url: `${core}/subnets${query({ compartmentId, vcnId: vcn.id, displayName: NETWORK_NAME, limit: PAGE_SIZE })}` },
        options
      )
    ).data
  );
  const existing = subnets[0];
  if (existing) {
    if (existing.lifecycleState === "AVAILABLE") return existing.id;
    return (await waitAvailable(ctx, `/subnets/${encodeURIComponent(existing.id)}`, "subnet", options)).id;
  }

  const gateways = live(
    (await ociRequest<OciResource[]>(ctx, { url: `${core}/internetGateways${query({ compartmentId, vcnId: vcn.id })}` }, options)).data
  );
  let gateway = gateways[0];
  if (!gateway) {
    const { data } = await ociRequest<OciResource>(
      ctx,
      { method: "POST", url: `${core}/internetGateways`, attempts: 1, body: { compartmentId, vcnId: vcn.id, isEnabled: true, displayName: NETWORK_NAME } },
      options
    );
    gateway = data;
  }
  if (gateway.lifecycleState !== "AVAILABLE") {
    gateway = await waitAvailable(ctx, `/internetGateways/${encodeURIComponent(gateway.id)}`, "internet gateway", options);
  }

  // The VCN is Orquester's own, so its default route table and security list are replaced outright.
  await ociRequest(
    ctx,
    {
      method: "PUT",
      url: `${core}/routeTables/${encodeURIComponent(vcn.defaultRouteTableId)}`,
      body: { routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: gateway.id }] }
    },
    options
  );
  await ociRequest(
    ctx,
    {
      method: "PUT",
      url: `${core}/securityLists/${encodeURIComponent(vcn.defaultSecurityListId)}`,
      body: {
        egressSecurityRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all", isStateless: false }],
        ingressSecurityRules: [
          { source: "0.0.0.0/0", sourceType: "CIDR_BLOCK", protocol: "1", isStateless: false, icmpOptions: { type: 3, code: 4 } }
        ]
      }
    },
    options
  );
  const { data: subnet } = await ociRequest<OciResource>(
    ctx,
    {
      method: "POST",
      url: `${core}/subnets`,
      attempts: 1,
      body: {
        compartmentId,
        vcnId: vcn.id,
        cidrBlock: SUBNET_CIDR,
        displayName: NETWORK_NAME,
        routeTableId: vcn.defaultRouteTableId,
        securityListIds: [vcn.defaultSecurityListId],
        prohibitPublicIpOnVnic: false
      }
    },
    options
  );
  if (subnet.lifecycleState === "AVAILABLE") return subnet.id;
  return (await waitAvailable(ctx, `/subnets/${encodeURIComponent(subnet.id)}`, "subnet", options)).id;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

function mapState(state: string): ProviderInstanceState {
  switch (state) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STARTING":
    case "CREATING_IMAGE":
    case "MOVING":
      return "pending";
    case "STOPPING":
    case "STOPPED":
      return "stopped";
    case "TERMINATING":
    case "TERMINATED":
      return "gone";
    default:
      return "error";
  }
}

/** The context for a stored ref: its own region and compartment, the credentials' key. */
function refContext(ctx: OciContext, ref: ProviderInstanceRef): OciContext {
  const region = typeof ref.region === "string" && REGION_PATTERN.test(ref.region) ? ref.region : ctx.region;
  const compartmentId = typeof ref.compartmentId === "string" && ref.compartmentId.startsWith("ocid1.") ? ref.compartmentId : ctx.compartmentId;
  return { ...ctx, region, compartmentId };
}

function instanceRef(instance: OciInstance, region: string): ProviderInstanceRef {
  return {
    instanceId: instance.id,
    region: instance.region && REGION_PATTERN.test(instance.region) ? instance.region : region,
    compartmentId: instance.compartmentId,
    availabilityDomain: instance.availabilityDomain
  };
}

async function getInstance(ctx: OciContext, instanceId: string, options: ProviderCallOptions): Promise<OciInstance> {
  const { data } = await ociRequest<OciInstance>(ctx, { url: `${coreUrl(ctx.region)}/instances/${encodeURIComponent(instanceId)}` }, options);
  return data;
}

/** The primary VNIC's public IP; best effort (null on any failure but the caller's abort). */
async function publicIp(ctx: OciContext, instanceId: string, options: ProviderCallOptions): Promise<string | null> {
  try {
    const core = coreUrl(ctx.region);
    const { data: attachments } = await ociRequest<Array<{ vnicId?: string; lifecycleState: string; nicIndex?: number }>>(
      ctx,
      { url: `${core}/vnicAttachments${query({ compartmentId: ctx.compartmentId, instanceId })}` },
      options
    );
    const attached = attachments.filter((entry) => entry.lifecycleState === "ATTACHED" && entry.vnicId);
    attached.sort((a, b) => (a.nicIndex ?? 0) - (b.nicIndex ?? 0));
    for (const attachment of attached) {
      const { data: vnic } = await ociRequest<{ publicIp?: string | null; isPrimary?: boolean }>(
        ctx,
        { url: `${core}/vnics/${encodeURIComponent(attachment.vnicId!)}` },
        options
      );
      if (vnic.publicIp) return vnic.publicIp;
    }
    return null;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return null;
  }
}

export const oracleAdapter: BoxProviderAdapter = {
  id: "oracle",
  label: "Oracle Cloud",
  kinds: KINDS,
  website: "https://www.oracle.com/cloud/compute/",
  credentialsUrl: "https://cloud.oracle.com/identity/domains/my-profile/api-keys",
  credentialFields: [
    {
      id: "tenancyOcid",
      label: "Tenancy OCID",
      secret: false,
      placeholder: "ocid1.tenancy.oc1..aaaa…",
      help: "Profile menu → Tenancy: copy the OCID. Also shown in the configuration preview after adding an API key."
    },
    {
      id: "userOcid",
      label: "User OCID",
      secret: false,
      placeholder: "ocid1.user.oc1..aaaa…",
      help: "Profile menu → My profile: copy the OCID of the user the API key belongs to."
    },
    {
      id: "fingerprint",
      label: "Key fingerprint",
      secret: false,
      placeholder: "12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0",
      help: "My profile → API keys → Add API key (generate a key pair and download the private key); the fingerprint is listed next to the key."
    },
    {
      id: "privateKey",
      label: "Private key (PEM)",
      secret: true,
      placeholder: "-----BEGIN PRIVATE KEY-----",
      help: "The whole unencrypted private key file downloaded when the API key was added, including the BEGIN and END lines."
    },
    {
      id: "region",
      label: "Region",
      secret: false,
      placeholder: "eu-frankfurt-1",
      help: "The region identifier boxes run in (one of the tenancy's subscribed regions), e.g. eu-frankfurt-1 or us-ashburn-1."
    },
    {
      id: "compartmentOcid",
      label: "Compartment OCID",
      secret: false,
      optional: true,
      placeholder: "ocid1.compartment.oc1..aaaa…",
      help: "Where boxes and the shared orquester-boxes network are created. Empty = the tenancy's root compartment. The user needs to manage instances and virtual networks there."
    }
  ],
  accountNote:
    "After the 30-day free trial an Oracle Cloud account can only launch Always Free resources until it is upgraded to Pay As You Go. New tenancies have low compute service limits, and Ampere A1 capacity is often exhausted in popular regions — try another availability domain or shape.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(options, async () => {
      const ctx = context(credentials);
      if (ociKeyFingerprint(ctx.key.privateKey) !== ctx.fingerprint) {
        throw new ProviderInputError(PROVIDER, "the fingerprint does not belong to this private key");
      }
      await ociRequest(ctx, { url: `${coreUrl(ctx.region)}/instances${query({ compartmentId: ctx.compartmentId, limit: 1 })}` }, options);
    });
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const ctx = context(credentials);
    const windows = isWindowsKind(kind);
    const { data: ads } = await ociRequest<Array<{ name: string }>>(
      ctx,
      { url: `${identityUrl(ctx.region)}/availabilityDomains${query({ compartmentId: ctx.tenancyId })}` },
      options
    );
    const [shapesByAd, images, book] = await Promise.all([
      Promise.all(
        ads.map((ad) =>
          listAll<OciShape>(
            ctx,
            `${coreUrl(ctx.region)}/shapes${query({ compartmentId: ctx.compartmentId, availabilityDomain: ad.name, limit: PAGE_SIZE })}`,
            options
          )
        )
      ),
      listAll<OciImage>(
        ctx,
        `${coreUrl(ctx.region)}/images${query({
          compartmentId: ctx.compartmentId,
          operatingSystem: windows ? WINDOWS_OS : UBUNTU_OS,
          lifecycleState: "AVAILABLE",
          sortBy: "TIMECREATED",
          sortOrder: "DESC",
          limit: PAGE_SIZE
        })}`,
        options
      ),
      loadPrices(options)
    ]);

    // One entry per offered shape: its limits (from the first AD listing it) and the ADs that list it.
    const shapes = new Map<string, { shape: OciShape; ads: string[] }>();
    ads.forEach((ad, index) => {
      for (const shape of shapesByAd[index]!) {
        const info = SHAPES[shape.shape];
        if (!info || shape.isFlexible === false || (windows && info.arm)) continue;
        const entry = shapes.get(shape.shape) ?? { shape, ads: [] };
        entry.ads.push(ad.name);
        shapes.set(shape.shape, entry);
      }
    });

    const sizes: BoxSizeOffer[] = [];
    const usedAds = new Set<string>();
    for (const [name, { shape, ads: shapeAds }] of shapes) {
      const info = SHAPES[name]!;
      for (const ad of shapeAds) usedAds.add(ad);
      for (const { ocpus, memoryGb } of shapeConfigs(shape)) {
        const vcpu = info.arm ? ocpus : ocpus * 2;
        sizes.push({
          id: `${name}:${ocpus}:${memoryGb}`,
          label: `${name} — ${ocpus} OCPU (${vcpu} vCPU ${info.cpu}), ${memoryGb} GB`,
          vcpu,
          ramGb: memoryGb,
          diskGb: windows ? WINDOWS_BOOT_GB : LINUX_BOOT_GB,
          gpu: null,
          hourlyUsd: hourlyUsd(info, ocpus, memoryGb, windows, book),
          regions: shapeAds
        });
      }
    }

    const regions: BoxRegionOffer[] = ads
      .filter((ad) => usedAds.has(ad.name))
      .map((ad) => ({ id: ad.name, label: adLabel(ad.name, ctx.region), country: null }));

    return { sizes: sortSizes(sizes), regions, images: imageOffers(images, windows), priceSource: book.live ? "live" : "table" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const ctx = context(credentials);
    const windows = isWindowsKind(request.kind);
    const { shape, info, ocpus, memoryGb } = parseSize(request.size);
    if (windows && info.arm) throw new ProviderInputError(PROVIDER, `${shape} cannot run Windows`);
    if (!request.region) throw new ProviderInputError(PROVIDER, "an availability domain is required");

    // Every read (and the free shared network) before the one billable call.
    const image = await resolveImage(ctx, imageChoice(request.kind, request.image), shape, options);
    const book = await loadPrices(options);
    const subnetId = await ensureSubnet(ctx, options);

    const metadata: Record<string, string> = { user_data: base64(userDataFor(request.kind, request.bootstrap)) };
    if (!windows) metadata.ssh_authorized_keys = request.sshPublicKey;
    const { data } = await ociRequest<OciInstance>(
      ctx,
      {
        method: "POST",
        url: `${coreUrl(ctx.region)}/instances`,
        attempts: 1,
        body: {
          availabilityDomain: request.region,
          compartmentId: ctx.compartmentId,
          displayName: request.name,
          shape,
          shapeConfig: { ocpus, memoryInGBs: memoryGb },
          sourceDetails: { sourceType: "image", imageId: image.id, bootVolumeSizeInGBs: windows ? WINDOWS_BOOT_GB : LINUX_BOOT_GB },
          createVnicDetails: { subnetId, assignPublicIp: true, displayName: request.name },
          metadata,
          freeformTags: request.tags
        }
      },
      options
    );
    return { ref: instanceRef(data, ctx.region), hourlyUsd: hourlyUsd(info, ocpus, memoryGb, windows, book) };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const ctx = refContext(context(credentials), ref);
    let instance: OciInstance;
    try {
      instance = await getInstance(ctx, instanceId, options);
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Oracle Cloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
    const state = mapState(instance.lifecycleState);
    return {
      state,
      detail: state === "running" ? null : `Oracle Cloud reports the instance ${instance.lifecycleState}`,
      publicIp: state === "running" ? await publicIp(ctx, instanceId, options) : null,
      hourlyUsd: null
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const ctx = refContext(context(credentials), ref);
    try {
      await ociRequest(
        ctx,
        {
          method: "DELETE",
          url: `${coreUrl(ctx.region)}/instances/${encodeURIComponent(instanceId)}${query({ preserveBootVolume: "false" })}`,
          okStatuses: [404]
        },
        options
      );
    } catch (error) {
      // A 409 while the instance is already terminating (or gone) is the outcome destroy wants.
      if (!(error instanceof ProviderHttpError) || error.status !== 409) throw error;
      const current = await getInstance(ctx, instanceId, options).catch((readError: unknown) => {
        if (isNotFound(readError)) return null;
        throw readError;
      });
      if (current && mapState(current.lifecycleState) !== "gone") throw error;
    }
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const ctx = context(credentials);
    const instances = await listAll<OciInstance>(
      ctx,
      `${coreUrl(ctx.region)}/instances${query({ compartmentId: ctx.compartmentId, limit: PAGE_SIZE })}`,
      options
    );
    return instances
      .filter((instance) => instance.lifecycleState !== "TERMINATED")
      .filter((instance) => Boolean(instance.freeformTags?.[BOX_TAG_KEY]) || isManagedName(instance.displayName))
      .map((instance) => ({
        ref: instanceRef(instance, ctx.region),
        name: instance.displayName,
        boxId: managedBoxId(instance.freeformTags?.[BOX_TAG_KEY], instance.displayName),
        createdAt: isoOrNull(instance.timeCreated),
        state: mapState(instance.lifecycleState)
      }));
  }
};
