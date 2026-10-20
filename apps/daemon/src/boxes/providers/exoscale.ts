/**
 * Exoscale (https://openapi-v2.exoscale.com/). Linux and Windows boxes.
 *
 * - Auth: an IAM API key (`EXO…`) and secret. Every call is signed with
 *   EXO2-HMAC-SHA256 (https://openapi-v2.exoscale.com/#topic-api-request-signature),
 *   implemented here with node:crypto.
 * - The API is per zone (`https://api-<zone>.exoscale.com/v2`): instances live
 *   in one zone, so the ref carries it and listing walks every zone. Instance
 *   types and templates have the same ids in every zone.
 * - Prices: the portal's public price lists (`/api/pricing/opencompute` and
 *   `/api/pricing/licenses`, no auth, the `usd` column) — the instance type,
 *   the root disk per GiB-hour for the disk size Orquester picks, and the
 *   Windows licence (one rate up to 7 vCPUs, another from 8). A public IPv4 is
 *   part of every instance.
 * - Marker: the `orquester-box=<boxId>` label; the instance name is `orq-<boxId>`.
 * - Bootstrap: base64 `user-data` — cloud-init on Linux, cloudbase-init
 *   (`#ps1_sysnative`) on Exoscale's Windows templates.
 * - Create answers with an async operation; the instance id is the
 *   operation's `reference.id`, polled for (with a deadline) when the first
 *   answer does not carry it yet.
 */

import { createHmac } from "node:crypto";

import type { BoxImageOffer, BoxKind, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

import type {
  BoxProviderAdapter,
  ProviderCallOptions,
  ProviderCreateRequest,
  ProviderCreateResult,
  ProviderCredentials,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { providerRequest, type ProviderRequest } from "./http.ts";
import { roundUsd } from "./price-tables.ts";
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
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  userDataFor,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Exoscale";
const KINDS: readonly BoxKind[] = ["linux", "windows"];
/** The zone whose endpoint serves zone, instance-type and template lists (they are global). */
const HOME_ZONE = "ch-gva-2";
const PRICING = "https://portal.exoscale.com/api/pricing";
/** How long a signature stays valid. */
const SIGNATURE_TTL_SECONDS = 600;
const GIB = 1024 ** 3;
const DEFAULT_LINUX_TEMPLATE = "Linux Ubuntu 24.04 LTS 64-bit";
const DEFAULT_WINDOWS_TEMPLATE = "Windows Server 2022";
/** Root disk Orquester gives a box (GiB); Exoscale bills it per GiB-hour. Windows templates are 50 GiB. */
const LINUX_DISK_GB = 40;
const WINDOWS_DISK_GB = 60;
const LINUX_MIN_MEMORY = 1 * GIB;
/** Windows Server with the desktop experience is unusable below 4 GiB (standard.medium). */
const WINDOWS_MIN_MEMORY = 4 * GIB;
/** General-purpose families; GPU and storage-optimized types are not offered. */
const FAMILIES = new Set(["standard", "cpu", "memory"]);
/** Exoscale's base64 `user-data` limit. */
const MAX_USER_DATA = 32_768;
/** Windows licence tiers: up to this many vCPUs uses tier 1. */
const WINDOWS_TIER1_MAX_CPUS = 7;

const ZONE_LABELS: Readonly<Record<string, { city: string; country: string }>> = {
  "ch-gva-2": { city: "Geneva", country: "CH" },
  "ch-dk-2": { city: "Zurich", country: "CH" },
  "de-fra-1": { city: "Frankfurt", country: "DE" },
  "de-muc-1": { city: "Munich", country: "DE" },
  "at-vie-1": { city: "Vienna", country: "AT" },
  "at-vie-2": { city: "Vienna", country: "AT" },
  "bg-sof-1": { city: "Sofia", country: "BG" },
  "hr-zag-1": { city: "Zagreb", country: "HR" }
};

/** Poll timing for the create operation; tests set `pollMs` to 0. */
export const exoscaleTiming = { pollMs: 2_000, operationDeadlineMs: 120_000 };

interface ExoscaleInstanceType {
  id: string;
  family: string;
  size: string;
  cpus: number;
  memory: number;
  gpus?: number;
  authorized?: boolean;
  zones?: string[];
}

interface ExoscaleTemplate {
  id: string;
  name: string;
  family?: string;
  maintainer?: string;
  size?: number;
  visibility?: string;
}

interface ExoscaleInstance {
  id: string;
  name: string;
  state: string;
  "created-at"?: string;
  labels?: Record<string, string>;
  "public-ip"?: string;
  "ipv6-address"?: string;
  "instance-type"?: { id: string };
}

interface ExoscaleOperation {
  id: string;
  state: "pending" | "success" | "failure" | "timeout";
  reason?: string;
  message?: string;
  reference?: { id?: string; link?: string; command?: string };
}

type PriceList = Record<string, string>;

function apiBase(zone: string): string {
  return `https://api-${zone}.exoscale.com/v2`;
}

/**
 * The EXO2-HMAC-SHA256 `Authorization` header for one request: HMAC-SHA256
 * with the secret over `METHOD path`, the body, the query values (sorted by
 * name), the signed header values (none) and the expiry, joined by newlines.
 */
export function exoscaleAuthorization(
  apiKey: string,
  apiSecret: string,
  request: { method: string; url: string; body: string },
  expires: number
): string {
  const url = new URL(request.url);
  const params = new Map<string, string[]>();
  url.searchParams.forEach((value, key) => params.set(key, [...(params.get(key) ?? []), value]));
  // The reference implementations sign single-valued parameters only.
  const names = [...params.keys()].filter((key) => params.get(key)!.length === 1).sort();
  const message = [
    `${request.method} ${url.pathname}`,
    request.body,
    names.map((key) => params.get(key)![0]).join(""),
    "",
    String(expires)
  ].join("\n");
  const signature = createHmac("sha256", apiSecret).update(message, "utf8").digest("base64");
  const pragmas = [`EXO2-HMAC-SHA256 credential=${apiKey}`];
  if (names.length > 0) pragmas.push(`signed-query-args=${names.join(";")}`);
  pragmas.push(`expires=${expires}`, `signature=${signature}`);
  return pragmas.join(",");
}

/** One signed API call. The body is serialized here so the signature covers the exact bytes sent. */
async function exoRequest<T>(
  credentials: ProviderCredentials,
  request: Omit<ProviderRequest, "body" | "headers"> & { body?: unknown },
  options: ProviderCallOptions
): Promise<T> {
  const apiKey = requireCredential(PROVIDER, credentials, "apiKey", "API key");
  const apiSecret = requireCredential(PROVIDER, credentials, "apiSecret", "API secret");
  const method = request.method ?? "GET";
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  const expires = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;
  const headers: Record<string, string> = {
    Authorization: exoscaleAuthorization(apiKey, apiSecret, { method, url: request.url, body }, expires)
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  const { data } = await providerRequest<T>(
    PROVIDER,
    { ...request, method, headers, body: request.body === undefined ? undefined : body },
    options
  );
  return data;
}

async function listZones(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<string[]> {
  const data = await exoRequest<{ zones: Array<{ name: string }> }>(credentials, { url: `${apiBase(HOME_ZONE)}/zone` }, options);
  return data.zones.map((zone) => zone.name);
}

async function listInstanceTypes(credentials: ProviderCredentials, zone: string, options: ProviderCallOptions): Promise<ExoscaleInstanceType[]> {
  const data = await exoRequest<{ "instance-types": ExoscaleInstanceType[] }>(credentials, { url: `${apiBase(zone)}/instance-type` }, options);
  return data["instance-types"];
}

async function listTemplates(credentials: ProviderCredentials, zone: string, options: ProviderCallOptions): Promise<ExoscaleTemplate[]> {
  const data = await exoRequest<{ templates: ExoscaleTemplate[] }>(
    credentials,
    { url: `${apiBase(zone)}/template?visibility=public` },
    options
  );
  return data.templates;
}

/** The two public price lists (USD column): compute/disk prices and licences. */
async function priceLists(options: ProviderCallOptions): Promise<{ compute: PriceList; licenses: PriceList }> {
  const [compute, licenses] = await Promise.all([
    providerRequest<{ usd: PriceList }>(PROVIDER, { url: `${PRICING}/opencompute` }, options),
    providerRequest<{ usd: PriceList }>(PROVIDER, { url: `${PRICING}/licenses` }, options)
  ]);
  return { compute: compute.data.usd, licenses: licenses.data.usd };
}

/** `standard.medium`, as the CLI names instance types. */
function typeId(type: Pick<ExoscaleInstanceType, "family" | "size">): string {
  return `${type.family}.${type.size}`;
}

function diskGbFor(kind: BoxKind): number {
  return isWindowsKind(kind) ? WINDOWS_DISK_GB : LINUX_DISK_GB;
}

/** Hourly USD for a type with `diskGb` of root disk (and the Windows licence), null when the list lacks the type. */
function hourlyUsd(
  type: ExoscaleInstanceType,
  diskGb: number,
  windows: boolean,
  prices: { compute: PriceList; licenses: PriceList }
): number | null {
  const size = type.size.replace(/-/g, "_");
  const key = type.family === "standard" ? `running_${size}` : `running_${type.family}_${size}`;
  const running = Number(prices.compute[key]);
  const volume = Number(prices.compute.volume ?? 0);
  const licence = windows
    ? Number(prices.licenses[type.cpus <= WINDOWS_TIER1_MAX_CPUS ? "license_win_tier1" : "license_win_tier2"])
    : 0;
  if (prices.compute[key] === undefined || !Number.isFinite(running + volume + licence)) return null;
  return roundUsd(running + volume * diskGb + licence);
}

function typeFits(type: ExoscaleInstanceType, windows: boolean): boolean {
  if (!FAMILIES.has(type.family) || type.authorized === false || (type.gpus ?? 0) > 0) return false;
  return type.memory >= (windows ? WINDOWS_MIN_MEMORY : LINUX_MIN_MEMORY);
}

function templateFits(template: ExoscaleTemplate, windows: boolean): boolean {
  if (template.maintainer !== undefined && template.maintainer !== "Exoscale") return false;
  return windows ? template.family === "windows" : template.family === "ubuntu" || template.family === "debian";
}

function mapState(state: string): ProviderInstanceState {
  switch (state) {
    case "running":
      return "running";
    case "starting":
    case "migrating":
      return "pending";
    case "stopping":
    case "stopped":
      return "stopped";
    case "destroying":
    case "destroyed":
    case "expunging":
      return "gone";
    case "error":
      return "error";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

function zoneOffer(zone: string): BoxRegionOffer {
  const known = ZONE_LABELS[zone];
  return known
    ? { id: zone, label: `${known.city} (${zone})`, country: known.country }
    : { id: zone, label: zone, country: zone.slice(0, 2).toUpperCase() };
}

/** The instance id an accepted create operation refers to, polling the operation until it names one. */
async function instanceIdFromOperation(
  credentials: ProviderCredentials,
  zone: string,
  first: ExoscaleOperation,
  options: ProviderCallOptions
): Promise<string> {
  const deadline = Date.now() + exoscaleTiming.operationDeadlineMs;
  let operation = first;
  for (;;) {
    if (operation.state === "failure" || operation.state === "timeout") {
      throw new Error(`${PROVIDER}: creating the instance failed (${operation.message || operation.reason || operation.state})`);
    }
    if (operation.reference?.id) return operation.reference.id;
    if (Date.now() >= deadline) {
      // The instance, if any, carries the name and label, so the reconciler still finds it.
      throw new Error(`${PROVIDER}: the create operation ${operation.id} named no instance in time`);
    }
    await abortableDelay(exoscaleTiming.pollMs, options.signal);
    operation = await exoRequest<ExoscaleOperation>(
      credentials,
      { url: `${apiBase(zone)}/operation/${encodeURIComponent(first.id)}` },
      options
    );
  }
}

export const exoscaleAdapter: BoxProviderAdapter = {
  id: "exoscale",
  label: "Exoscale",
  kinds: KINDS,
  website: "https://www.exoscale.com",
  credentialsUrl: "https://portal.exoscale.com/iam/keys",
  credentialFields: [
    {
      id: "apiKey",
      label: "API key",
      secret: false,
      placeholder: "EXO…",
      help: "In the Exoscale Portal open IAM → Keys and add an API key whose role may manage Compute instances. Boxes are created in that organization."
    },
    {
      id: "apiSecret",
      label: "API secret",
      secret: true,
      help: "Shown once when the key is created."
    }
  ],
  accountNote: null,
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(options, () => exoRequest(credentials, { url: `${apiBase(HOME_ZONE)}/instance` }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const windows = isWindowsKind(kind);
    const [zones, types, templates, prices] = await Promise.all([
      listZones(credentials, options),
      listInstanceTypes(credentials, HOME_ZONE, options),
      listTemplates(credentials, HOME_ZONE, options),
      priceLists(options)
    ]);
    const known = new Set(zones);
    const diskGb = diskGbFor(kind);
    const sizes: BoxSizeOffer[] = types
      .filter((type) => typeFits(type, windows))
      .map((type) => {
        const ramGb = Math.round((type.memory / GIB) * 10) / 10;
        const family = type.family.charAt(0).toUpperCase() + type.family.slice(1);
        return {
          id: typeId(type),
          label: `${family} ${type.size} — ${type.cpus} vCPU, ${ramGb} GB`,
          vcpu: type.cpus,
          ramGb,
          diskGb,
          gpu: null,
          hourlyUsd: hourlyUsd(type, diskGb, windows, prices),
          regions: (type.zones ?? zones).filter((zone) => known.has(zone))
        };
      })
      .filter((size) => size.regions.length > 0);
    const preferred = windows ? DEFAULT_WINDOWS_TEMPLATE : DEFAULT_LINUX_TEMPLATE;
    const images: BoxImageOffer[] = templates
      .filter((template) => templateFits(template, windows))
      .map((template) => ({ id: template.id, label: template.name }))
      .sort((a, b) => (a.label === preferred ? -1 : b.label === preferred ? 1 : b.label.localeCompare(a.label)));
    return { sizes: sortSizes(sizes), regions: zones.map(zoneOffer), images, priceSource: "live" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const windows = isWindowsKind(request.kind);
    const zone = request.region;
    const userData = base64(userDataFor(request.kind, request.bootstrap));
    if (userData.length > MAX_USER_DATA) {
      throw new ProviderInputError(PROVIDER, `the bootstrap is larger than Exoscale's ${MAX_USER_DATA}-byte user-data limit`);
    }

    // Every read happens before the create, so a failed read never follows a billable create.
    const [types, templates] = await Promise.all([
      listInstanceTypes(credentials, zone, options),
      listTemplates(credentials, zone, options)
    ]);
    const type = types.find((entry) => typeId(entry) === request.size && typeFits(entry, windows));
    if (!type) throw new ProviderInputError(PROVIDER, `no instance type ${request.size} for ${request.kind} boxes in ${zone}`);
    const template = request.image
      ? templates.find((entry) => entry.id === request.image)
      : templates.find((entry) => entry.name === (windows ? DEFAULT_WINDOWS_TEMPLATE : DEFAULT_LINUX_TEMPLATE));
    if (!template) throw new ProviderInputError(PROVIDER, `no template ${request.image ?? "for the default image"} in ${zone}`);
    const diskGb = Math.max(diskGbFor(request.kind), Math.ceil((template.size ?? 0) / GIB));
    const prices = await priceLists(options).catch((error: unknown) => {
      if (options.signal.aborted) throw error;
      return null;
    });

    const operation = await exoRequest<ExoscaleOperation>(
      credentials,
      {
        method: "POST",
        url: `${apiBase(zone)}/instance`,
        attempts: 1,
        body: {
          name: request.name,
          "instance-type": { id: type.id },
          template: { id: template.id },
          "disk-size": diskGb,
          "user-data": userData,
          labels: request.tags,
          "public-ip-assignment": "inet4"
        }
      },
      options
    );
    const instanceId = await instanceIdFromOperation(credentials, zone, operation, options);

    const result: ProviderCreateResult = {
      ref: { instanceId, zone },
      hourlyUsd: prices ? hourlyUsd(type, diskGb, windows, prices) : null
    };
    if (windows) {
      // Exoscale keeps the generated Administrator password for 24 hours; fetch it once, it is optional.
      const password = await exoRequest<{ password?: string }>(
        credentials,
        { url: `${apiBase(zone)}/instance/${encodeURIComponent(instanceId)}:password`, attempts: 1 },
        options
      ).catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });
      if (password?.password) result.windowsPassword = password.password;
    }
    return result;
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const zone = refString(PROVIDER, ref, "zone");
    try {
      const instance = await exoRequest<ExoscaleInstance>(
        credentials,
        { url: `${apiBase(zone)}/instance/${encodeURIComponent(instanceId)}` },
        options
      );
      const state = mapState(instance.state);
      return {
        state,
        detail: state === "running" ? null : `Exoscale reports the instance ${instance.state}`,
        publicIp: instance["public-ip"] || instance["ipv6-address"] || null,
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Exoscale", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const zone = refString(PROVIDER, ref, "zone");
    // Nothing else was created: the root disk and public IPv4 belong to the instance.
    await exoRequest(
      credentials,
      { method: "DELETE", url: `${apiBase(zone)}/instance/${encodeURIComponent(instanceId)}`, okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    // The label filter's syntax is undocumented, so every zone's instances are filtered here.
    const zones = await listZones(credentials, options);
    const perZone = await Promise.all(
      zones.map(async (zone) => {
        const data = await exoRequest<{ instances?: ExoscaleInstance[] }>(credentials, { url: `${apiBase(zone)}/instance` }, options);
        return (data.instances ?? []).map((instance) => ({ zone, instance }));
      })
    );
    return perZone
      .flat()
      .filter(({ instance }) => instance.labels?.[BOX_TAG_KEY] !== undefined || isManagedName(instance.name))
      .map(({ zone, instance }) => ({
        ref: { instanceId: instance.id, zone },
        name: instance.name,
        boxId: managedBoxId(instance.labels?.[BOX_TAG_KEY], instance.name),
        createdAt: isoOrNull(instance["created-at"]),
        state: mapState(instance.state)
      }));
  }
};
