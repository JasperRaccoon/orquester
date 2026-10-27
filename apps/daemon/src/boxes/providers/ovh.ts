/**
 * OVHcloud Public Cloud (https://eu.api.ovh.com/console/, `/cloud` section).
 * Linux, Linux + GPU, Windows and Windows + GPU boxes, billed hourly.
 *
 * - Auth: an application key/secret and a consumer key, signed per request
 *   (https://help.ovhcloud.com/csm/en-gb-api-getting-started-ovhcloud-api):
 *   `X-Ovh-Signature = "$1$" + sha1(AS+CK+METHOD+URL+BODY+TIMESTAMP joined by "+")`
 *   with the timestamp taken from the API's clock (`GET /auth/time`, once per
 *   adapter call). Three API endpoints: ovh-eu, ovh-ca, ovh-us.
 * - Prices: flavors carry `planCodes.hourly` (and, for third-generation Windows
 *   flavors, `planCodes.license`, a per-vCore licence); the unsigned public
 *   catalog `/order/catalog/public/cloud` prices them in 10⁻⁸ of the
 *   subsidiary's currency, before VAT (EUR for ovh-eu, CAD for ovh-ca, USD for
 *   ovh-us). Older `win-*` flavors include the licence in their own plan price.
 * - Flavors and images exist once per region with per-region ids: size ids are
 *   flavor names and image ids are image names, resolved to ids at create.
 * - Marker: instances carry no tags or metadata in this API, so the `orq-<boxId>`
 *   name is the marker.
 * - Bootstrap: raw (not base64) `userData` — cloud-init on Linux images,
 *   cloudbase-init `#ps1_sysnative` on Windows images. Linux images need an SSH
 *   key: one is registered per box under the box's name and deleted with it.
 */

import { createHash } from "node:crypto";

import type { BoxGpuInfo, BoxImageOffer, BoxKind, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

import type {
  BoxProviderAdapter,
  ProviderCallOptions,
  ProviderCreateResult,
  ProviderCredentials,
  ProviderInstanceRef,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { providerRequest } from "./http.ts";
import { eurToUsd, OVH_CAD_TO_USD, roundUsd } from "./price-tables.ts";
import {
  assertKind,
  baseSizeId,
  cloudbaseInitUserData,
  isGpuKind,
  isManagedName,
  isNotFound,
  isoOrNull,
  isWindowsKind,
  managedBoxId,
  offersByRegionalPrice,
  optionalCredential,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "OVHcloud";
const KINDS: readonly BoxKind[] = ["linux", "linux-gpu", "windows", "windows-gpu"];
const DEFAULT_LINUX_IMAGE = "Ubuntu 24.04";
const DEFAULT_WINDOWS_IMAGE = "Windows Server 2022 Standard (Desktop)";
/** The public catalog is several megabytes. */
const CATALOG_TIMEOUT_MS = 60_000;

type OvhEndpointId = "ovh-eu" | "ovh-ca" | "ovh-us";

interface OvhEndpoint {
  api: string;
  /** The subsidiary whose public catalog prices this endpoint's accounts. */
  subsidiary: string;
}

const ENDPOINTS: Readonly<Record<OvhEndpointId, OvhEndpoint>> = {
  "ovh-eu": { api: "https://eu.api.ovh.com/1.0", subsidiary: "FR" },
  "ovh-ca": { api: "https://ca.api.ovh.com/1.0", subsidiary: "CA" },
  "ovh-us": { api: "https://api.us.ovhcloud.com/1.0", subsidiary: "US" }
};

/** Flavors whose name says GPU, for catalogs that lack the GPU description. */
const GPU_FLAVOR = /^(?:win-)?(t1|t2|l4|l40s|a10|a100|h100|h200|rtx5000)-/;

/** Region name prefix → site, most specific first. Unknown regions keep their name. */
const REGION_SITES: ReadonlyArray<readonly [prefix: string, city: string, country: string]> = [
  ["AP-SOUTHEAST-SIN", "Singapore", "SG"],
  ["AP-SOUTHEAST-SYD", "Sydney", "AU"],
  ["AP-SOUTH-MUM", "Mumbai", "IN"],
  ["CA-EAST-TOR", "Toronto", "CA"],
  ["EU-SOUTH-MIL", "Milan", "IT"],
  ["EU-WEST-PAR", "Paris", "FR"],
  ["US-EAST-VA", "Vint Hill", "US"],
  ["US-WEST-OR", "Hillsboro", "US"],
  ["GRA", "Gravelines", "FR"],
  ["SBG", "Strasbourg", "FR"],
  ["RBX", "Roubaix", "FR"],
  ["BHS", "Beauharnois", "CA"],
  ["WAW", "Warsaw", "PL"],
  ["SGP", "Singapore", "SG"],
  ["SYD", "Sydney", "AU"],
  ["DE", "Frankfurt", "DE"],
  ["UK", "London", "GB"]
];

interface OvhFlavor {
  id: string;
  name: string;
  region: string;
  vcpus: number;
  /** MB (OVH reports 7000 for its 7 GB flavors). */
  ram: number;
  /** GB. */
  disk: number;
  type: string;
  osType: string;
  available: boolean;
  quota?: number;
  planCodes?: { hourly?: string | null; monthly?: string | null; license?: string | null };
}

interface OvhImage {
  id: string;
  name: string;
  region: string;
  type: string;
  status: string;
  flavorType?: string | null;
}

interface OvhInstance {
  id: string;
  name: string;
  region: string;
  status: string;
  created: string;
  sshKeyId?: string | null;
  ipAddresses?: Array<{ ip: string; type: string; version: number }>;
}

interface OvhCatalogAddon {
  planCode: string;
  pricings?: Array<{ price: number; capacities?: string[]; type?: string }>;
  blobs?: { technical?: { gpu?: { model?: string; number?: number; memory?: { size?: number } } } };
}

interface OvhCatalog {
  locale?: { currencyCode?: string };
  addons?: OvhCatalogAddon[];
}

/** Catalog plan code → hourly USD (null when the currency is unknown) and GPU description. */
type OvhPrices = Map<string, { usd: number | null; gpu: BoxGpuInfo | null }>;

/**
 * The `X-Ovh-Signature` header: `$1$` + hex SHA-1 of the application secret,
 * consumer key, method, full URL (query included), body (exactly as sent, ""
 * when none) and timestamp, joined by `+`.
 */
export function ovhSignature(input: {
  applicationSecret: string;
  consumerKey: string;
  method: string;
  url: string;
  body: string;
  timestamp: string;
}): string {
  const payload = [input.applicationSecret, input.consumerKey, input.method, input.url, input.body, input.timestamp].join("+");
  return `$1$${createHash("sha1").update(payload, "utf8").digest("hex")}`;
}

function endpointFor(credentials: ProviderCredentials): OvhEndpoint {
  const id = optionalCredential(credentials, "endpoint")?.toLowerCase() ?? "ovh-eu";
  if (!Object.hasOwn(ENDPOINTS, id)) throw new ProviderInputError(PROVIDER, "API endpoint must be ovh-eu, ovh-ca or ovh-us");
  return ENDPOINTS[id as OvhEndpointId];
}

interface OvhCall {
  method?: "GET" | "POST" | "DELETE";
  /** Path below the endpoint's `/1.0`, query included. */
  path: string;
  body?: unknown;
  okStatuses?: readonly number[];
  attempts?: number;
}

interface OvhClient {
  endpoint: OvhEndpoint;
  call<T>(request: OvhCall, options?: ProviderCallOptions): Promise<T>;
}

/**
 * Check the credentials are present, read the API clock once, and return a
 * client that signs every request with it. Retries inside `providerRequest`
 * reuse the signed timestamp, which stays within OVH's accepted drift.
 */
async function connect(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<OvhClient> {
  const endpoint = endpointFor(credentials);
  const applicationKey = requireCredential(PROVIDER, credentials, "applicationKey", "Application key");
  const applicationSecret = requireCredential(PROVIDER, credentials, "applicationSecret", "Application secret");
  const consumerKey = requireCredential(PROVIDER, credentials, "consumerKey", "Consumer key");

  const { data } = await providerRequest<unknown>(PROVIDER, { url: `${endpoint.api}/auth/time` }, options);
  const serverTime = Number(data);
  if (!Number.isFinite(serverTime)) throw new Error(`${PROVIDER}: /auth/time returned no timestamp`);
  const delta = Math.floor(serverTime) - Math.floor(Date.now() / 1000);

  return {
    endpoint,
    async call<T>(request: OvhCall, callOptions: ProviderCallOptions = options): Promise<T> {
      const method = request.method ?? "GET";
      const url = `${endpoint.api}${request.path}`;
      const body = request.body === undefined ? "" : JSON.stringify(request.body);
      const timestamp = String(Math.floor(Date.now() / 1000) + delta);
      const headers: Record<string, string> = {
        "X-Ovh-Application": applicationKey,
        "X-Ovh-Consumer": consumerKey,
        "X-Ovh-Timestamp": timestamp,
        "X-Ovh-Signature": ovhSignature({ applicationSecret, consumerKey, method, url, body, timestamp })
      };
      if (body) headers["Content-Type"] = "application/json";
      const response = await providerRequest<T>(
        PROVIDER,
        {
          method,
          url,
          headers,
          // The exact string that was signed.
          body: body || undefined,
          okStatuses: request.okStatuses,
          attempts: request.attempts
        },
        callOptions
      );
      return response.data;
    }
  };
}

/** The configured project, or the account's only one. */
async function resolveProject(client: OvhClient, credentials: ProviderCredentials): Promise<string> {
  const configured = optionalCredential(credentials, "projectId");
  if (configured) return configured;
  const projects = await client.call<string[]>({ path: "/cloud/project" });
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) throw new ProviderInputError(PROVIDER, "the account has no Public Cloud project");
  throw new ProviderInputError(PROVIDER, `the account has ${projects.length} Public Cloud projects: enter the project ID`);
}

function projectPath(projectId: string, rest = ""): string {
  return `/cloud/project/${encodeURIComponent(projectId)}${rest}`;
}

function toUsd(currency: string | undefined, amount: number): number | null {
  switch (currency) {
    case "USD":
      return amount;
    case "EUR":
      return eurToUsd(amount);
    case "CAD":
      return amount * OVH_CAD_TO_USD;
    default:
      return null;
  }
}

async function catalogPrices(endpoint: OvhEndpoint, options: ProviderCallOptions): Promise<OvhPrices> {
  const { data } = await providerRequest<OvhCatalog>(
    PROVIDER,
    {
      url: `${endpoint.api}/order/catalog/public/cloud?ovhSubsidiary=${endpoint.subsidiary}`,
      timeoutMs: CATALOG_TIMEOUT_MS
    },
    options
  );
  const currency = data.locale?.currencyCode;
  const prices: OvhPrices = new Map();
  for (const addon of data.addons ?? []) {
    const pricing =
      addon.pricings?.find((entry) => entry.capacities?.includes("consumption") || entry.type === "consumption") ?? addon.pricings?.[0];
    const usd = pricing && Number.isFinite(pricing.price) ? toUsd(currency, pricing.price / 1e8) : null;
    const gpu = addon.blobs?.technical?.gpu;
    prices.set(addon.planCode, {
      usd,
      gpu: gpu?.model ? { model: gpu.model, count: gpu.number ?? 1, vramGb: gpu.memory?.size ?? null } : null
    });
  }
  return prices;
}

/** Plan price plus, for Windows, the per-vCore licence the flavor names. Null when either is unknown. */
function flavorHourly(flavor: OvhFlavor, prices: OvhPrices | null, windows: boolean): number | null {
  const plan = flavor.planCodes?.hourly;
  const base = plan ? prices?.get(plan)?.usd : null;
  if (base === null || base === undefined) return null;
  let total = base;
  const licence = flavor.planCodes?.license;
  if (windows && licence) {
    const perVcore = prices?.get(licence)?.usd;
    if (perVcore === null || perVcore === undefined) return null;
    total += perVcore * flavor.vcpus;
  }
  return roundUsd(total);
}

function gpuOf(flavor: OvhFlavor, prices: OvhPrices | null): BoxGpuInfo | null {
  const plan = flavor.planCodes?.hourly;
  const described = plan ? prices?.get(plan)?.gpu : null;
  if (described) return described;
  const family = GPU_FLAVOR.exec(flavor.name)?.[1];
  if (family || flavor.type.includes("gpu")) return { model: (family ?? flavor.name).toUpperCase(), count: 1, vramGb: null };
  return null;
}

function ramGb(flavor: OvhFlavor): number {
  // MB in practice; tolerate a GB figure should the API start reporting one.
  return flavor.ram >= 256 ? Math.round((flavor.ram / 1000) * 10) / 10 : flavor.ram;
}

function regionOffer(region: string): BoxRegionOffer {
  const upper = region.toUpperCase();
  const site = REGION_SITES.find(([prefix]) => upper.startsWith(prefix));
  return site ? { id: region, label: `${site[1]} (${region})`, country: site[2] } : { id: region, label: region, country: null };
}

function osTypeFor(kind: BoxKind): "linux" | "windows" {
  return isWindowsKind(kind) ? "windows" : "linux";
}

/** Curated images: Ubuntu LTS (even-year .04) and Debian on Linux, Windows Server Standard on Windows; one entry per name. */
function imageOffers(images: OvhImage[], windows: boolean): BoxImageOffer[] {
  const wanted = windows ? /^Windows Server 20\d\d Standard \((?:Desktop|Core)\)$/ : /^(?:Ubuntu \d[02468]\.04|Debian \d+)$/;
  const preferred = windows ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE;
  const names = new Set(images.filter((image) => image.status === "active" && wanted.test(image.name)).map((image) => image.name));
  return [...names]
    .map((name) => ({ id: name, label: name }))
    .sort((a, b) => {
      if (a.id === preferred) return -1;
      if (b.id === preferred) return 1;
      const ubuntu = Number(b.id.startsWith("Ubuntu")) - Number(a.id.startsWith("Ubuntu"));
      return ubuntu || b.id.localeCompare(a.id, "en", { numeric: true });
    });
}

function mapState(status: string): ProviderInstanceState {
  switch (status) {
    case "ACTIVE":
    case "SNAPSHOTTING":
      return "running";
    case "BUILD":
    case "BUILDING":
    case "REBOOT":
    case "HARD_REBOOT":
    case "REBUILD":
    case "MIGRATING":
    case "PASSWORD":
    case "RESIZE":
    case "RESIZED":
    case "VERIFY_RESIZE":
    case "REVERT_RESIZE":
    case "RESUMING":
    case "UNSHELVING":
    case "UNRESCUING":
      return "pending";
    case "SHUTOFF":
    case "STOPPED":
    case "PAUSED":
    case "SUSPENDED":
    case "SHELVING":
    case "SHELVED":
    case "SHELVED_OFFLOADED":
    case "RESCUING":
    case "RESCUE":
    case "RESCUED":
      return "stopped";
    case "DELETING":
    case "DELETED":
    case "SOFT_DELETED":
      return "gone";
    case "ERROR":
      return "error";
    default:
      // UNKNOWN and states this adapter does not know are transient: only ERROR destroys a box.
      return "pending";
  }
}

function publicIp(instance: OvhInstance): string | null {
  const publicAddresses = (instance.ipAddresses ?? []).filter((address) => address.type === "public");
  return publicAddresses.find((address) => address.version === 4)?.ip ?? publicAddresses.find((address) => address.version === 6)?.ip ?? null;
}

function instanceRef(projectId: string, instance: OvhInstance, sshKeyId: string | null): ProviderInstanceRef {
  const ref: ProviderInstanceRef = { projectId, instanceId: instance.id, region: instance.region };
  if (sshKeyId) ref.sshKeyId = sshKeyId;
  return ref;
}

async function deleteSshKey(client: OvhClient, projectId: string, keyId: string, options?: ProviderCallOptions): Promise<void> {
  await client.call(
    { method: "DELETE", path: projectPath(projectId, `/sshkey/${encodeURIComponent(keyId)}`), okStatuses: [404] },
    options
  );
}

export const ovhAdapter: BoxProviderAdapter = {
  id: "ovh",
  label: "OVHcloud Public Cloud",
  kinds: KINDS,
  website: "https://www.ovhcloud.com/en/public-cloud/",
  credentialsUrl: "https://eu.api.ovh.com/createToken/",
  credentialFields: [
    {
      id: "endpoint",
      label: "API endpoint",
      secret: false,
      optional: true,
      placeholder: "ovh-eu",
      help: "ovh-eu (OVHcloud Europe, the default), ovh-ca (OVHcloud Canada and Asia-Pacific) or ovh-us (OVHcloud US)."
    },
    {
      id: "applicationKey",
      label: "Application key",
      secret: false,
      help:
        "Create the keys at https://eu.api.ovh.com/createToken/ (ca.api.ovh.com/createToken/ or api.us.ovhcloud.com/createToken/ for those endpoints) " +
        "with the rights GET, POST, PUT and DELETE on /cloud/project/* (and GET on /cloud/project when the project ID is left empty), validity Unlimited."
    },
    { id: "applicationSecret", label: "Application secret", secret: true },
    { id: "consumerKey", label: "Consumer key", secret: true },
    {
      id: "projectId",
      label: "Project ID",
      secret: false,
      optional: true,
      placeholder: "32 hexadecimal characters",
      help: "The Public Cloud project boxes are created in (shown under the project name in the Control Panel). Leave empty when the account has exactly one project."
    }
  ],
  accountNote:
    "New Public Cloud projects start with small quotas; GPU flavors in particular may need a quota increase in the Control Panel before they are offered.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, async () => {
      const client = await connect(credentials, options);
      const projectId = await resolveProject(client, credentials);
      await client.call({ path: projectPath(projectId) });
    });
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const windows = isWindowsKind(kind);
    const gpu = isGpuKind(kind);
    const osType = osTypeFor(kind);
    const client = await connect(credentials, options);
    const projectId = await resolveProject(client, credentials);
    const [flavors, images, prices] = await Promise.all([
      client.call<OvhFlavor[]>({ path: projectPath(projectId, "/flavor") }),
      client.call<OvhImage[]>({ path: projectPath(projectId, `/image?osType=${osType}`) }),
      catalogPrices(client.endpoint, options)
    ]);

    // Hourly flavors of the kind's OS that can be created now (in stock, quota left).
    const byName = new Map<string, OvhFlavor[]>();
    for (const flavor of flavors) {
      if (flavor.osType !== osType || !flavor.available || flavor.quota === 0 || !flavor.planCodes?.hourly) continue;
      if ((gpuOf(flavor, prices) !== null) !== gpu) continue;
      byName.set(flavor.name, [...(byName.get(flavor.name) ?? []), flavor]);
    }

    const sizes: BoxSizeOffer[] = [];
    const usedRegions = new Set<string>();
    for (const [name, regional] of byName) {
      const first = regional[0]!;
      const gpuInfo = gpuOf(first, prices);
      const regionalPrices = new Map<string, number | null>();
      for (const flavor of regional) {
        regionalPrices.set(flavor.region, flavorHourly(flavor, prices, windows));
        usedRegions.add(flavor.region);
      }
      const ram = ramGb(first);
      const gpuLabel = gpuInfo ? `, ${gpuInfo.count}× ${gpuInfo.model}${gpuInfo.vramGb ? ` ${gpuInfo.vramGb} GB` : ""}` : "";
      sizes.push(
        ...offersByRegionalPrice(
          { label: `${name} — ${first.vcpus} vCPU, ${ram} GB${gpuLabel}`, vcpu: first.vcpus, ramGb: ram, diskGb: first.disk || null, gpu: gpuInfo },
          name,
          regionalPrices
        )
      );
    }

    const regions = [...usedRegions].sort().map(regionOffer);
    return { sizes: sortSizes(sizes), regions, images: imageOffers(images, windows), priceSource: "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const windows = isWindowsKind(request.kind);
    const osType = osTypeFor(request.kind);
    const sizeName = baseSizeId(request.size);
    const region = encodeURIComponent(request.region);
    const client = await connect(credentials, options);
    const projectId = await resolveProject(client, credentials);

    // Every read happens before anything billable exists; a price failure just leaves it unknown.
    const [flavors, images, prices] = await Promise.all([
      client.call<OvhFlavor[]>({ path: projectPath(projectId, `/flavor?region=${region}`) }),
      client.call<OvhImage[]>({ path: projectPath(projectId, `/image?osType=${osType}&region=${region}`) }),
      catalogPrices(client.endpoint, options).catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      })
    ]);
    const flavor = flavors.find((entry) => entry.name === sizeName && entry.osType === osType && entry.region === request.region);
    if (!flavor) throw new ProviderInputError(PROVIDER, `size ${sizeName} is not offered for ${osType} in ${request.region}`);
    if (!flavor.available) throw new ProviderInputError(PROVIDER, `size ${sizeName} is out of stock in ${request.region}`);

    const imageName = request.image ?? (windows ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE);
    // Images built for one flavor type (flavorType set) only boot that type; prefer an exact match.
    const candidates = images.filter(
      (image) => image.name === imageName && image.status === "active" && (!image.flavorType || image.flavorType === flavor.type)
    );
    const image = candidates.find((entry) => entry.flavorType === flavor.type) ?? candidates[0];
    if (!image) throw new ProviderInputError(PROVIDER, `no image named ${imageName} for ${sizeName} in ${request.region}`);

    let sshKeyId: string | null = null;
    if (!windows) {
      const key = await client.call<{ id: string }>({
        method: "POST",
        path: projectPath(projectId, "/sshkey"),
        attempts: 1,
        body: { name: request.name, publicKey: request.sshPublicKey }
      });
      sshKeyId = key.id;
    }

    const body: Record<string, unknown> = {
      name: request.name,
      flavorId: flavor.id,
      imageId: image.id,
      region: request.region,
      monthlyBilling: false,
      userData: windows ? cloudbaseInitUserData(request.bootstrap) : request.bootstrap.cloudInit
    };
    if (sshKeyId) body.sshKeyId = sshKeyId;

    let instance: OvhInstance;
    try {
      instance = await client.call<OvhInstance>({ method: "POST", path: projectPath(projectId, "/instance"), attempts: 1, body });
    } catch (error) {
      // No instance means nothing uses the key; leave nothing behind.
      if (sshKeyId) {
        await deleteSshKey(client, projectId, sshKeyId, { ...options, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      }
      throw error;
    }

    return { ref: instanceRef(projectId, { ...instance, region: instance.region || request.region }, sshKeyId), hourlyUsd: flavorHourly(flavor, prices, windows) };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const projectId = refString(PROVIDER, ref, "projectId");
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const client = await connect(credentials, options);
    try {
      const instance = await client.call<OvhInstance>({ path: projectPath(projectId, `/instance/${encodeURIComponent(instanceId)}`) });
      const state = mapState(instance.status);
      return {
        state,
        detail: state === "running" ? null : `OVHcloud reports the instance ${instance.status}`,
        publicIp: publicIp(instance),
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in OVHcloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const projectId = refString(PROVIDER, ref, "projectId");
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const client = await connect(credentials, options);
    await client.call({ method: "DELETE", path: projectPath(projectId, `/instance/${encodeURIComponent(instanceId)}`), okStatuses: [404] });
    // A key pair is only read at boot, so it can go while the instance is still being deleted.
    const sshKeyId = ref.sshKeyId;
    if (typeof sshKeyId === "string" && sshKeyId.length > 0) await deleteSshKey(client, projectId, sshKeyId);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const client = await connect(credentials, options);
    const projectId = await resolveProject(client, credentials);
    const instances = await client.call<OvhInstance[]>({ path: projectPath(projectId, "/instance") });
    // No tags in this API: the `orq-<boxId>` name is the marker, and every such key pair is the box's own.
    return instances
      .filter((instance) => isManagedName(instance.name))
      .map((instance) => ({
        ref: instanceRef(projectId, instance, instance.sshKeyId ?? null),
        name: instance.name,
        boxId: managedBoxId(null, instance.name),
        createdAt: isoOrNull(instance.created),
        state: mapState(instance.status)
      }));
  }
};
