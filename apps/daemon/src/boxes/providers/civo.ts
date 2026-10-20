/**
 * Civo (https://www.civo.com/api). Linux boxes only.
 *
 * - Auth: the account API key as a bearer token. Every resource lives in a
 *   region, passed as `region` (query string for reads and deletes, body for
 *   the create).
 * - Prices: `/v2/sizes` has none; the hourly list prices come from
 *   price-tables.ts, matched by size family and vCPU/RAM.
 * - Marker: tags `orquester-box` and `orquester-box=<boxId>` (the create
 *   takes them as one space-separated string); the hostname is the instance
 *   name. Instances are listed per region and filtered here.
 * - Bootstrap: Civo's `script` is a shell script written to
 *   `/usr/local/bin/civo-user-init-script` and run as root at the end of
 *   cloud-init, so it carries `posixScript`, not cloud-config YAML.
 * - Network: the region's default network and default firewall (open to
 *   all); `public_ip: "create"` assigns an ephemeral public IPv4 that Civo
 *   releases with the instance. The root password Civo generates when no SSH
 *   key is given is dropped (no one logs in).
 * - Disk image ids differ per region, so offers name images by their name
 *   (`ubuntu-noble`…) and create resolves the id in the chosen region.
 * - Errors come as `{ code, reason, details? }`; the reason is the message.
 */

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
import { providerRequest, ProviderHttpError, type ProviderRequest, type ProviderResponse } from "./http.ts";
import { CIVO_INSTANCE_HOURLY_USD, roundUsd, type CivoInstanceFamily } from "./price-tables.ts";
import {
  assertKind,
  BOX_TAG_KEY,
  isManagedName,
  isoOrNull,
  managedBoxId,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Civo";
const API = "https://api.civo.com/v2";
const KINDS: readonly BoxKind[] = ["linux"];
const PAGE_SIZE = 100;
const LINUX_MIN_RAM_MB = 1024;
/** The image create picks when none was chosen: Ubuntu 24.04 LTS, whatever Civo names it. */
const DEFAULT_DISTRIBUTION = { distribution: "ubuntu", version: "24.04" };
const INITIAL_USER = "civo";

interface CivoRegion {
  code: string;
  name: string;
  country: string;
  out_of_capacity: boolean;
  default: boolean;
  features?: { iaas?: boolean };
}

interface CivoSize {
  type: string;
  name: string;
  nice_name: string;
  cpu_cores: number;
  gpu_count?: number;
  ram_mb: number;
  disk_gb: number;
  selectable: boolean;
}

interface CivoDiskImage {
  id: string;
  name: string;
  version: string;
  state: string;
  distribution: string;
  label?: string | null;
}

interface CivoNetwork {
  id: string;
  label?: string;
  default: boolean;
}

interface CivoInstance {
  id: string;
  hostname: string;
  status: string;
  public_ip?: string | null;
  ipv6?: string | null;
  tags?: string[] | null;
  region?: string;
  created_at?: string;
}

interface CivoPage {
  page: number;
  pages: number;
  items: CivoInstance[] | null;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "apiKey", "API key")}` };
}

/** Civo's `{ code, reason, details }` (or `{ result }`) as one line, or null for other bodies. */
function errorReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.reason === "string" && record.reason.length > 0) {
    const details = typeof record.details === "string" && record.details.length > 0 ? `, ${record.details}` : "";
    return `${record.reason}${details}`.slice(0, 300);
  }
  return typeof record.result === "string" && record.result.length > 0 ? record.result.replace(/_/g, " ") : null;
}

/** {@link providerRequest} with Civo's error reason as the message. */
async function civoRequest<T>(req: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  try {
    return await providerRequest<T>(PROVIDER, req, options);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      const reason = errorReason(error.body);
      if (reason) throw new ProviderHttpError(PROVIDER, error.status, `${PROVIDER}: ${reason}`, error.body);
    }
    throw error;
  }
}

/** A missing instance: HTTP 404, or Civo's own not-found code under another status. */
function isInstanceNotFound(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  const code = (error.body as { code?: unknown } | null)?.code;
  return error.status === 404 || code === "database_instance_not_found";
}

async function get<T>(credentials: ProviderCredentials, path: string, options: ProviderCallOptions): Promise<T> {
  const { data } = await civoRequest<T>({ url: `${API}${path}`, headers: headers(credentials) }, options);
  return data;
}

function q(region: string): string {
  return `region=${encodeURIComponent(region)}`;
}

function mapState(status: string): ProviderInstanceState {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "running";
    case "BUILDING":
    case "BUILD":
    case "BUILD_PENDING":
    case "PENDING":
    case "STARTING":
    case "REBOOTING":
    case "HARD_REBOOTING":
    case "REBUILDING":
    case "RESIZING":
    case "MIGRATING":
    case "RESTORING":
      return "pending";
    case "SHUTOFF":
    case "STOPPED":
    case "STOPPING":
    case "SHUTTING_DOWN":
      return "stopped";
    case "DELETING":
    case "DELETED":
      return "gone";
    default:
      return "error";
  }
}

/** `g3.small` → standard, `g4c.large` → CPU-optimised, `g4m.*` → RAM-optimised, `g4p.*` → performance. */
function sizeFamily(name: string): CivoInstanceFamily {
  const letter = /^g\d+([a-z])?\./.exec(name)?.[1];
  if (letter === "c") return "cpu";
  if (letter === "m") return "ram";
  if (letter === "p") return "performance";
  return "standard";
}

function sizeHourly(size: CivoSize): number | null {
  const family = sizeFamily(size.name);
  const ramGb = size.ram_mb / 1024;
  const entry = CIVO_INSTANCE_HOURLY_USD.find((row) => row.family === family && row.vcpu === size.cpu_cores && row.ramGb === ramGb);
  return entry ? roundUsd(entry.hourlyUsd) : null;
}

function sizeFits(size: CivoSize): boolean {
  return size.type.toLowerCase() === "instance" && size.selectable !== false && !(size.gpu_count && size.gpu_count > 0) && size.ram_mb >= LINUX_MIN_RAM_MB;
}

function openRegions(regions: CivoRegion[]): CivoRegion[] {
  return regions.filter((region) => region.features?.iaas !== false && !region.out_of_capacity);
}

function country(region: CivoRegion): string | null {
  if (!region.country) return null;
  const code = region.country.toUpperCase();
  return code === "UK" ? "GB" : code;
}

function isDefaultImage(image: CivoDiskImage): boolean {
  return image.distribution === DEFAULT_DISTRIBUTION.distribution && image.version === DEFAULT_DISTRIBUTION.version;
}

function imageLabel(image: CivoDiskImage): string {
  if (image.label) return image.label;
  const distribution = image.distribution.charAt(0).toUpperCase() + image.distribution.slice(1);
  return `${distribution} ${image.version}${image.distribution === "ubuntu" && /^\d\d\.04$/.test(image.version) ? " LTS" : ""}`;
}

function linuxImages(images: CivoDiskImage[]): CivoDiskImage[] {
  return images.filter((image) => image.state === "available" && (image.distribution === "ubuntu" || image.distribution === "debian"));
}

/** The disk image id in `region` for an offered image name (or an id passed through). */
async function resolveImageId(credentials: ProviderCredentials, request: ProviderCreateRequest, options: ProviderCallOptions): Promise<string> {
  const images = await get<CivoDiskImage[]>(credentials, `/disk_images?${q(request.region)}`, options);
  const available = images.filter((image) => image.state === "available");
  const match = request.image
    ? available.find((image) => image.name === request.image || image.id === request.image)
    : available.find(isDefaultImage);
  if (!match) throw new ProviderInputError(PROVIDER, `no disk image ${request.image ?? "for Ubuntu 24.04"} in ${request.region}`);
  return match.id;
}

async function defaultNetworkId(credentials: ProviderCredentials, region: string, options: ProviderCallOptions): Promise<string> {
  const networks = await get<CivoNetwork[]>(credentials, `/networks?${q(region)}`, options);
  const network = networks.find((entry) => entry.default);
  if (!network) throw new ProviderInputError(PROVIDER, `no default network in ${region}`);
  return network.id;
}

function tagsFor(request: ProviderCreateRequest): string {
  return [BOX_TAG_KEY, ...Object.entries(request.tags).map(([key, value]) => `${key}=${value}`)].join(" ");
}

function boxIdFromTags(tags: string[] | null | undefined): string | null {
  const prefix = `${BOX_TAG_KEY}=`;
  const tag = tags?.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

async function listInstances(credentials: ProviderCredentials, region: string, options: ProviderCallOptions): Promise<CivoInstance[]> {
  const items: CivoInstance[] = [];
  for (let page = 1; ; page++) {
    const data = await get<CivoPage>(credentials, `/instances?${q(region)}&page=${page}&per_page=${PAGE_SIZE}`, options);
    items.push(...(data.items ?? []));
    if (page >= (data.pages ?? 1)) return items;
  }
}

export const civoAdapter: BoxProviderAdapter = {
  id: "civo",
  label: "Civo",
  kinds: KINDS,
  website: "https://www.civo.com",
  credentialsUrl: "https://dashboard.civo.com/security",
  credentialFields: [
    {
      id: "apiKey",
      label: "API key",
      secret: true,
      help: "In the Civo dashboard open Settings → Profile → Security and copy the API key (regenerate it there if it leaks)."
    }
  ],
  accountNote: null,
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(options, () => get(credentials, "/instances?page=1&per_page=1", options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const [regions, sizes] = await Promise.all([
      get<CivoRegion[]>(credentials, "/regions", options),
      get<CivoSize[]>(credentials, "/sizes", options)
    ]);
    const open = openRegions(regions);
    // Image names are the same in every region; the account's default region is asked for them.
    const imageRegion = open.find((region) => region.default) ?? open[0];
    const images = imageRegion ? await get<CivoDiskImage[]>(credentials, `/disk_images?${q(imageRegion.code)}`, options) : [];

    const sizeOffers: BoxSizeOffer[] = sizes.filter(sizeFits).map((size) => {
      const ramGb = Math.round((size.ram_mb / 1024) * 10) / 10;
      return {
        id: size.name,
        label: `${size.name} — ${size.nice_name}, ${size.cpu_cores} vCPU, ${ramGb} GB`,
        vcpu: size.cpu_cores,
        ramGb,
        diskGb: size.disk_gb,
        gpu: null,
        hourlyUsd: sizeHourly(size),
        // Civo does not say which sizes each region sells: every open region.
        regions: []
      };
    });
    const regionOffers: BoxRegionOffer[] = open.map((region) => ({ id: region.code, label: `${region.name} (${region.code})`, country: country(region) }));
    const seen = new Set<string>();
    const imageOffers: BoxImageOffer[] = [];
    for (const image of linuxImages(images)) {
      if (seen.has(image.name)) continue;
      seen.add(image.name);
      imageOffers.push({ id: image.name, label: imageLabel(image) });
    }
    const defaultName = linuxImages(images).find(isDefaultImage)?.name;
    imageOffers.sort((a, b) => (a.id === defaultName ? -1 : b.id === defaultName ? 1 : b.label.localeCompare(a.label)));
    return { sizes: sortSizes(sizeOffers), regions: regionOffers, images: imageOffers, priceSource: "table" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    // Every read happens before the create: the image id and network for the region, and the price.
    const templateId = await resolveImageId(credentials, request, options);
    const networkId = await defaultNetworkId(credentials, request.region, options);
    const size = await get<CivoSize[]>(credentials, "/sizes", options)
      .then((sizes) => sizes.find((entry) => entry.name === request.size) ?? null)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });

    const { data } = await civoRequest<CivoInstance>(
      {
        method: "POST",
        url: `${API}/instances`,
        headers: headers(credentials),
        attempts: 1,
        body: {
          hostname: request.name,
          size: request.size,
          region: request.region,
          count: 1,
          template_id: templateId,
          network_id: networkId,
          public_ip: "create",
          initial_user: INITIAL_USER,
          script: request.bootstrap.posixScript,
          tags: tagsFor(request)
        }
      },
      options
    );
    // The response's initial_password is dropped: no one logs in.
    return { ref: { instanceId: data.id, region: request.region }, hourlyUsd: size ? sizeHourly(size) : null };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const region = refString(PROVIDER, ref, "region");
    try {
      const instance = await get<CivoInstance>(credentials, `/instances/${encodeURIComponent(instanceId)}?${q(region)}`, options);
      const state = mapState(instance.status);
      return {
        state,
        detail: state === "running" ? null : `Civo reports the instance ${instance.status}`,
        publicIp: instance.public_ip || instance.ipv6 || null,
        hourlyUsd: null
      };
    } catch (error) {
      if (isInstanceNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Civo", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    const region = refString(PROVIDER, ref, "region");
    try {
      await civoRequest(
        {
          method: "DELETE",
          url: `${API}/instances/${encodeURIComponent(instanceId)}?${q(region)}`,
          headers: headers(credentials),
          okStatuses: [404]
        },
        options
      );
    } catch (error) {
      if (!isInstanceNotFound(error)) throw error;
    }
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    // Regions out of capacity for new instances can still hold boxes.
    const regions = (await get<CivoRegion[]>(credentials, "/regions", options)).filter((region) => region.features?.iaas !== false);
    const managed: ProviderManagedInstance[] = [];
    for (const region of regions) {
      for (const instance of await listInstances(credentials, region.code, options)) {
        if (!instance.tags?.includes(BOX_TAG_KEY) && !isManagedName(instance.hostname)) continue;
        managed.push({
          ref: { instanceId: instance.id, region: region.code },
          name: instance.hostname,
          boxId: managedBoxId(boxIdFromTags(instance.tags), instance.hostname),
          createdAt: isoOrNull(instance.created_at),
          state: mapState(instance.status)
        });
      }
    }
    return managed;
  }
};
