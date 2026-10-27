/**
 * Akamai Cloud / Linode (https://techdocs.akamai.com/linode-api/reference/api).
 * Linux and Linux + GPU instances.
 *
 * - Auth: a personal access token (Linodes: Read/Write) as a bearer token.
 * - Prices: `/v4/linode/types` carries live hourly USD prices; `region_prices`
 *   overrides the default price in some regions (Jakarta, São Paulo…), so a
 *   type becomes one offer per price.
 * - Availability: user data needs the Metadata service, so only core regions
 *   with the `Metadata` capability are offered. GPU plans also need
 *   `GPU Linodes`, premium plans `Premium Plans`; `/v4/regions/availability`
 *   marks plans sold out in a region.
 * - Marker: tags `orquester-box` (the `X-Filter` on the list) and
 *   `orquester-box=<boxId>`; the label is the instance name.
 * - Bootstrap: cloud-init in `metadata.user_data` (base64). A root password
 *   is mandatory when deploying an image: a random one is generated, sent once
 *   and never kept; the box's throwaway public key goes in `authorized_keys`.
 * - Errors come as `{ errors: [{ field?, reason }] }`; the reasons become the
 *   error message.
 */

import { randomBytes } from "node:crypto";

import type { BoxGpuInfo, BoxImageOffer, BoxKind, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

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
import { providerRequest, ProviderHttpError, type ProviderRequest, type ProviderResponse } from "./http.ts";
import { roundUsd } from "./price-tables.ts";
import {
  assertKind,
  base64,
  BOX_TAG_KEY,
  baseSizeId,
  isGpuKind,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  offersByRegionalPrice,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Linode";
const API = "https://api.linode.com/v4";
const KINDS: readonly BoxKind[] = ["linux", "linux-gpu"];
const PAGE_SIZE = 500;
const DEFAULT_IMAGE = "linode/ubuntu24.04";
const IMAGES: readonly BoxImageOffer[] = [
  { id: DEFAULT_IMAGE, label: "Ubuntu 24.04 LTS" },
  { id: "linode/ubuntu22.04", label: "Ubuntu 22.04 LTS" },
  { id: "linode/debian12", label: "Debian 12" }
];
/** Classes offered for plain Linux boxes; `accelerated` (NETINT VPUs) is neither CPU nor GPU. */
const LINUX_CLASSES = new Set(["nanode", "standard", "dedicated", "premium", "highmem"]);
/** Region capability a class needs beyond `Linodes` and `Metadata`. */
const CLASS_CAPABILITY: Readonly<Record<string, string>> = { gpu: "GPU Linodes", premium: "Premium Plans" };

interface LinodePrice {
  hourly: number | null;
  monthly: number | null;
}

interface LinodeType {
  id: string;
  label: string;
  class: string;
  disk: number;
  memory: number;
  vcpus: number;
  gpus: number;
  price: LinodePrice;
  region_prices?: Array<LinodePrice & { id: string }>;
}

interface LinodeRegion {
  id: string;
  label: string;
  country: string;
  capabilities: string[];
  status: string;
  site_type?: string;
}

interface LinodeAvailability {
  region: string;
  plan: string;
  available: boolean;
}

interface LinodeInstance {
  id: number;
  label: string;
  status: string;
  created: string;
  region: string;
  type: string | null;
  tags: string[];
  ipv4: string[];
  ipv6: string | null;
}

interface LinodePage {
  data: unknown[];
  page: number;
  pages: number;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "token", "API token")}` };
}

/** Linode's `{ errors: [{ field, reason }] }` as one line, or null for other bodies. */
function errorReasons(body: unknown): string | null {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return null;
  const reasons = errors
    .map((entry: { field?: unknown; reason?: unknown }) =>
      typeof entry?.reason === "string" ? (typeof entry.field === "string" && entry.field ? `${entry.field}: ${entry.reason}` : entry.reason) : null
    )
    .filter((reason): reason is string => reason !== null);
  return reasons.length > 0 ? reasons.join("; ").slice(0, 300) : null;
}

/** {@link providerRequest} with Linode's error reasons as the message. */
async function linodeRequest<T>(req: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  try {
    return await providerRequest<T>(PROVIDER, req, options);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      const reasons = errorReasons(error.body);
      if (reasons) throw new ProviderHttpError(PROVIDER, error.status, `${PROVIDER}: ${reasons}`, error.body);
    }
    throw error;
  }
}

/** GET every page of a list endpoint. */
async function listAll<T>(
  credentials: ProviderCredentials,
  path: string,
  options: ProviderCallOptions,
  extraHeaders: Record<string, string> = {}
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await linodeRequest<LinodePage>(
      { url: `${API}${path}${separator}page=${page}&page_size=${PAGE_SIZE}`, headers: { ...headers(credentials), ...extraHeaders } },
      options
    );
    items.push(...((data.data as T[] | undefined) ?? []));
    if (page >= (data.pages ?? 1)) return items;
  }
}

function mapState(status: string): ProviderInstanceState {
  switch (status) {
    case "running":
      return "running";
    case "provisioning":
    case "booting":
    case "rebooting":
    case "busy":
    case "migrating":
    case "rebuilding":
    case "cloning":
    case "restoring":
      return "pending";
    case "offline":
    case "shutting_down":
    case "stopped":
      return "stopped";
    case "deleting":
      return "gone";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

function isPrivateIpv4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function publicIp(instance: LinodeInstance): string | null {
  const v4 = instance.ipv4?.find((ip) => !isPrivateIpv4(ip));
  if (v4) return v4;
  return instance.ipv6 ? instance.ipv6.replace(/\/\d+$/, "") : null;
}

function hourlyIn(type: LinodeType, region: string): number | null {
  const regional = type.region_prices?.find((entry) => entry.id === region)?.hourly;
  const hourly = regional ?? type.price.hourly;
  return typeof hourly === "number" && Number.isFinite(hourly) ? roundUsd(hourly) : null;
}

/** Linode reports only a GPU count; the model comes from the plan's id and label. */
function gpuInfo(type: LinodeType): BoxGpuInfo | null {
  if (!(type.gpus > 0)) return null;
  const text = `${type.id} ${type.label}`;
  if (/rtx\s?4000\s?a(da)?|rtx4000a/i.test(text)) return { model: "NVIDIA RTX 4000 Ada", count: type.gpus, vramGb: 20 };
  if (/rtx\s?6000/i.test(text)) return { model: "NVIDIA Quadro RTX 6000", count: type.gpus, vramGb: 24 };
  return { model: "NVIDIA GPU", count: type.gpus, vramGb: null };
}

function typeFits(type: LinodeType, gpu: boolean): boolean {
  return gpu ? type.class === "gpu" && type.gpus > 0 : LINUX_CLASSES.has(type.class) && !(type.gpus > 0);
}

/** Core regions that can run cloud-init user data (the Metadata service) and are not in an outage. */
function eligibleRegion(region: LinodeRegion): boolean {
  return (
    region.capabilities.includes("Linodes") &&
    region.capabilities.includes("Metadata") &&
    (region.site_type ?? "core") === "core" &&
    region.status !== "outage"
  );
}

/** Linode timestamps are UTC without a zone suffix (`2026-10-19T23:00:37`). */
function createdAt(value: string | undefined): string | null {
  if (!value) return null;
  return isoOrNull(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
}

function boxIdFromTags(tags: string[] | undefined): string | null {
  const prefix = `${BOX_TAG_KEY}=`;
  const tag = tags?.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function tagsFor(request: ProviderCreateRequest): string[] {
  return [BOX_TAG_KEY, ...Object.entries(request.tags).map(([key, value]) => `${key}=${value}`)];
}

/** Required by the API when deploying an image; nobody logs in with it, so it is never stored. */
function throwawayRootPassword(): string {
  return `${randomBytes(30).toString("base64url")}-Aa9`;
}

export const linodeAdapter: BoxProviderAdapter = {
  id: "linode",
  label: "Akamai Cloud (Linode)",
  kinds: KINDS,
  website: "https://www.linode.com",
  credentialsUrl: "https://cloud.linode.com/profile/tokens",
  credentialFields: [
    {
      id: "token",
      label: "Personal access token",
      secret: true,
      help: "Profile → API Tokens → Create a Personal Access Token with Linodes set to Read/Write (everything else may stay No Access)."
    }
  ],
  accountNote: "GPU plans need a one-time account review: open a support ticket asking for GPU access before renting a Linux + GPU box.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () => linodeRequest({ url: `${API}/linode/instances?page=1&page_size=25`, headers: headers(credentials) }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const gpu = isGpuKind(kind);
    const [types, regions, availability] = await Promise.all([
      listAll<LinodeType>(credentials, "/linode/types", options),
      listAll<LinodeRegion>(credentials, "/regions", options),
      listAll<LinodeAvailability>(credentials, "/regions/availability", options)
    ]);
    const eligible = regions.filter(eligibleRegion);
    const soldOut = new Set(availability.filter((entry) => !entry.available).map((entry) => `${entry.plan}|${entry.region}`));

    const sizes: BoxSizeOffer[] = [];
    const used = new Set<string>();
    for (const type of types) {
      if (!typeFits(type, gpu)) continue;
      const capability = CLASS_CAPABILITY[type.class];
      const prices = new Map<string, number | null>();
      for (const region of eligible) {
        if (capability && !region.capabilities.includes(capability)) continue;
        if (soldOut.has(`${type.id}|${region.id}`)) continue;
        prices.set(region.id, hourlyIn(type, region.id));
        used.add(region.id);
      }
      if (prices.size === 0) continue;
      const gpuDetail = gpuInfo(type);
      sizes.push(
        ...offersByRegionalPrice(
          {
            label: `${type.label} — ${type.vcpus} vCPU, ${Math.round((type.memory / 1024) * 10) / 10} GB${gpuDetail ? `, ${gpuDetail.count}× ${gpuDetail.model}` : ""}`,
            vcpu: type.vcpus,
            ramGb: Math.round((type.memory / 1024) * 10) / 10,
            diskGb: Math.round(type.disk / 1024),
            gpu: gpuDetail
          },
          type.id,
          prices
        )
      );
    }
    const regionOffers: BoxRegionOffer[] = eligible
      .filter((region) => used.has(region.id))
      .map((region) => ({ id: region.id, label: `${region.label} (${region.id})`, country: region.country ? region.country.toUpperCase() : null }));
    return { sizes: sortSizes(sizes), regions: regionOffers, images: [...IMAGES], priceSource: "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const typeId = baseSizeId(request.size);
    // The price is read before anything billable exists; a failure here just leaves it unknown.
    const type = await linodeRequest<LinodeType>({ url: `${API}/linode/types/${encodeURIComponent(typeId)}`, headers: headers(credentials) }, options)
      .then((response) => response.data)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });
    const { data } = await linodeRequest<LinodeInstance>(
      {
        method: "POST",
        url: `${API}/linode/instances`,
        headers: headers(credentials),
        attempts: 1,
        body: {
          label: request.name,
          type: typeId,
          region: request.region,
          image: request.image ?? DEFAULT_IMAGE,
          root_pass: throwawayRootPassword(),
          authorized_keys: [request.sshPublicKey],
          tags: tagsFor(request),
          metadata: { user_data: base64(request.bootstrap.cloudInit) },
          booted: true,
          backups_enabled: false
        }
      },
      options
    );
    return { ref: { linodeId: data.id, region: request.region }, hourlyUsd: type ? hourlyIn(type, request.region) : null };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const linodeId = refString(PROVIDER, ref, "linodeId");
    try {
      const { data } = await linodeRequest<LinodeInstance>(
        { url: `${API}/linode/instances/${encodeURIComponent(linodeId)}`, headers: headers(credentials) },
        options
      );
      const state = mapState(data.status);
      return {
        state,
        detail: state === "running" ? null : `Linode reports the instance ${data.status.replace(/_/g, " ")}`,
        publicIp: publicIp(data),
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Akamai Cloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const linodeId = refString(PROVIDER, ref, "linodeId");
    await linodeRequest(
      { method: "DELETE", url: `${API}/linode/instances/${encodeURIComponent(linodeId)}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const instances = await listAll<LinodeInstance>(credentials, "/linode/instances", options, {
      "X-Filter": JSON.stringify({ tags: BOX_TAG_KEY })
    });
    // The server-side filter narrows the list; the marker check here keeps the result exact either way.
    return instances
      .filter((instance) => instance.tags?.includes(BOX_TAG_KEY) || isManagedName(instance.label))
      .map((instance) => ({
        ref: { linodeId: instance.id, region: instance.region },
        name: instance.label,
        boxId: managedBoxId(boxIdFromTags(instance.tags), instance.label),
        createdAt: createdAt(instance.created),
        state: mapState(instance.status)
      }));
  }
};
