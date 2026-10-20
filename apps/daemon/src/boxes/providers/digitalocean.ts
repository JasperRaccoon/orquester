/**
 * DigitalOcean (https://docs.digitalocean.com/reference/api/digitalocean/).
 * Linux and Linux + GPU Droplets.
 *
 * - Auth: a personal access token as a bearer token. Custom scopes need
 *   droplet create/read/delete, ssh_key create/read/delete, tag create/read,
 *   sizes, regions and image read.
 * - Prices: `/v2/sizes` carries live hourly USD prices and the regions each
 *   size can be created in.
 * - Marker: tags `orquester-box` (the list filter, `tag_name=`) and
 *   `orquester-box:<boxId>` (DO tag names allow only letters, digits, `:`,
 *   `-` and `_`, so the value follows a colon instead of `=`).
 * - Bootstrap: cloud-init `user_data` (plain text, ≤ 64 KiB).
 * - SSH key: a Droplet created without one gets a root password that DO
 *   emails to the account owner, once per box. To avoid that mail the box's
 *   throwaway public key is registered as an account key named after the box
 *   and deleted with it.
 * - GPU Droplets boot DO's AI/ML-ready image (drivers and CUDA preinstalled);
 *   its slug depends on the plan (single NVIDIA GPU, 8 NVIDIA GPUs, AMD), so
 *   the offered image is a virtual id resolved per size at create.
 */

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
import { providerRequest } from "./http.ts";
import { roundUsd } from "./price-tables.ts";
import {
  assertKind,
  BOX_TAG_KEY,
  isGpuKind,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "DigitalOcean";
const API = "https://api.digitalocean.com/v2";
const KINDS: readonly BoxKind[] = ["linux", "linux-gpu"];
const PAGE_SIZE = 200;
const LINUX_MIN_MEMORY_MB = 1024;
/** Virtual image id for GPU plans: DO's AI/ML-ready image matching the plan (see {@link gpuImageSlug}). */
const GPU_IMAGE = "gpu-ai-ml-ready";

const LINUX_IMAGES: readonly BoxImageOffer[] = [
  { id: "ubuntu-24-04-x64", label: "Ubuntu 24.04 LTS" },
  { id: "ubuntu-22-04-x64", label: "Ubuntu 22.04 LTS" },
  { id: "debian-12-x64", label: "Debian 12" }
];
const GPU_IMAGES: readonly BoxImageOffer[] = [{ id: GPU_IMAGE, label: "AI/ML-ready Ubuntu (GPU drivers and CUDA)" }];

/** Region slug prefix → ISO country; DO's region objects carry only a display name. */
const REGION_COUNTRIES: Readonly<Record<string, string>> = {
  nyc: "US",
  sfo: "US",
  atl: "US",
  ric: "US",
  tor: "CA",
  lon: "GB",
  ams: "NL",
  fra: "DE",
  sgp: "SG",
  blr: "IN",
  syd: "AU"
};

interface DoGpuInfo {
  count: number;
  model: string;
  vram?: { amount: number; unit: string };
}

interface DoSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_hourly: number;
  regions: string[];
  available: boolean;
  description: string;
  gpu_info?: DoGpuInfo | null;
}

interface DoRegion {
  slug: string;
  name: string;
  available: boolean;
}

interface DoNetwork {
  ip_address: string;
  type: "public" | "private";
}

interface DoDroplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  tags?: string[];
  networks?: { v4?: DoNetwork[]; v6?: DoNetwork[] };
  region?: { slug: string } | null;
  size?: { price_hourly?: number } | null;
}

interface DoSshKey {
  id: number;
  name: string;
  fingerprint: string;
}

interface DoLinks {
  links?: { pages?: { next?: string } };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "token", "API token")}` };
}

/** GET every page of a list endpoint (`links.pages.next` marks a further page). */
async function listAll<T>(credentials: ProviderCredentials, path: string, key: string, options: ProviderCallOptions): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await providerRequest<DoLinks & Record<string, unknown>>(
      PROVIDER,
      { url: `${API}${path}${separator}page=${page}&per_page=${PAGE_SIZE}`, headers: headers(credentials) },
      options
    );
    items.push(...((data[key] as T[] | undefined) ?? []));
    if (!data.links?.pages?.next) return items;
  }
}

function mapState(status: string): ProviderInstanceState {
  switch (status) {
    case "active":
      return "running";
    case "new":
      return "pending";
    case "off":
      return "stopped";
    case "archive":
      return "gone";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

function publicIp(droplet: DoDroplet): string | null {
  const v4 = droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address;
  if (v4) return v4;
  return droplet.networks?.v6?.find((network) => network.type === "public")?.ip_address ?? null;
}

function isGpuSize(size: DoSize): boolean {
  return Boolean(size.gpu_info && size.gpu_info.count > 0) || size.slug.startsWith("gpu-");
}

/** `nvidia_rtx_4000_ada` → `NVIDIA RTX 4000 ADA`. */
function gpuModel(model: string): string {
  return model
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.toUpperCase())
    .join(" ");
}

function gpuInfo(size: DoSize): BoxGpuInfo | null {
  const info = size.gpu_info;
  if (!info || info.count <= 0) return null;
  const vram = info.vram;
  let vramGb = vram && Number.isFinite(vram.amount) ? (/^mi?b$/i.test(vram.unit) ? Math.round(vram.amount / 1024) : vram.amount) : null;
  // Multi-GPU plans may report the plan's total (the `-640gb` of `gpu-h100x8-640gb`); offers show VRAM per GPU.
  const slugTotal = Number(/-(\d+)gb$/.exec(size.slug)?.[1]);
  if (vramGb !== null && info.count > 1 && vramGb === slugTotal) vramGb = Math.round(vramGb / info.count);
  return { model: gpuModel(info.model), count: info.count, vramGb };
}

/**
 * The AI/ML-ready image for a GPU plan, per DO's recommended GPU setup:
 * `gpu-amd-base` for AMD GPUs, `gpu-h100x8-base` for 8-GPU NVIDIA plans and
 * `gpu-h100x1-base` for every single-GPU NVIDIA plan (whatever the GPU model).
 */
export function gpuImageSlug(size: Pick<DoSize, "slug" | "gpu_info">): string {
  const model = size.gpu_info?.model ?? "";
  if (/^amd/i.test(model) || /^gpu-mi\d/.test(size.slug)) return "gpu-amd-base";
  const count = size.gpu_info?.count ?? (/x8-/.test(size.slug) ? 8 : 1);
  return count >= 8 ? "gpu-h100x8-base" : "gpu-h100x1-base";
}

function sizeLabel(size: DoSize, gpu: BoxGpuInfo | null): string {
  const ramGb = Math.round((size.memory / 1024) * 10) / 10;
  const gpuText = gpu ? `, ${gpu.count}× ${gpu.model}${gpu.vramGb ? ` ${gpu.vramGb} GB` : ""}` : "";
  return `${size.slug} — ${size.description}, ${size.vcpus} vCPU, ${ramGb} GB${gpuText}`;
}

function sizeFits(size: DoSize, gpu: boolean): boolean {
  if (!size.available || size.regions.length === 0) return false;
  if (isGpuSize(size) !== gpu) return false;
  return gpu || size.memory >= LINUX_MIN_MEMORY_MB;
}

function boxIdFromTags(tags: string[] | undefined): string | null {
  const prefix = `${BOX_TAG_KEY}:`;
  const tag = tags?.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function tagsFor(request: ProviderCreateRequest): string[] {
  return [BOX_TAG_KEY, ...Object.entries(request.tags).map(([key, value]) => `${key}:${value}`)];
}

async function deleteSshKey(credentials: ProviderCredentials, keyId: string, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${API}/account/keys/${encodeURIComponent(keyId)}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

export const digitaloceanAdapter: BoxProviderAdapter = {
  id: "digitalocean",
  label: "DigitalOcean",
  kinds: KINDS,
  website: "https://www.digitalocean.com",
  credentialsUrl: "https://cloud.digitalocean.com/account/api/tokens",
  credentialFields: [
    {
      id: "token",
      label: "API token",
      secret: true,
      placeholder: "dop_v1_…",
      help:
        "API → Tokens → Generate New Token. Full Access works; with custom scopes grant droplet (create, read, delete), " +
        "ssh_key (create, read, delete), tag (create, read), sizes, regions and image read. Boxes go into the team's default project."
    }
  ],
  accountNote:
    "GPU Droplets depend on the account's resource tier (new accounts may have a GPU limit of 0): request an increase " +
    "in the control panel, and ask support for access before using AMD GPUs.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(options, () =>
      providerRequest(PROVIDER, { url: `${API}/droplets?per_page=1`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const gpu = isGpuKind(kind);
    const [sizes, regions] = await Promise.all([
      listAll<DoSize>(credentials, "/sizes", "sizes", options),
      listAll<DoRegion>(credentials, "/regions", "regions", options)
    ]);
    const open = new Set(regions.filter((region) => region.available).map((region) => region.slug));
    const used = new Set<string>();
    const offers: BoxSizeOffer[] = [];
    for (const size of sizes) {
      if (!sizeFits(size, gpu)) continue;
      const sizeRegions = size.regions.filter((region) => open.has(region));
      if (sizeRegions.length === 0) continue;
      for (const region of sizeRegions) used.add(region);
      const info = gpuInfo(size);
      offers.push({
        id: size.slug,
        label: sizeLabel(size, info),
        vcpu: size.vcpus,
        ramGb: Math.round((size.memory / 1024) * 10) / 10,
        diskGb: size.disk,
        gpu: info,
        hourlyUsd: Number.isFinite(size.price_hourly) ? roundUsd(size.price_hourly) : null,
        regions: sizeRegions
      });
    }
    const regionOffers: BoxRegionOffer[] = regions
      .filter((region) => used.has(region.slug))
      .map((region) => ({
        id: region.slug,
        label: `${region.name} (${region.slug})`,
        country: REGION_COUNTRIES[region.slug.replace(/\d+$/, "")] ?? null
      }));
    return { sizes: sortSizes(offers), regions: regionOffers, images: [...(gpu ? GPU_IMAGES : LINUX_IMAGES)], priceSource: "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const gpu = isGpuKind(request.kind);
    const auth = headers(credentials);
    // Read before anything billable exists: the price, and for GPU plans the image matching the plan.
    const size = await listAll<DoSize>(credentials, "/sizes", "sizes", options)
      .then((sizes) => sizes.find((entry) => entry.slug === request.size) ?? null)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });
    let image = request.image ?? (gpu ? GPU_IMAGE : LINUX_IMAGES[0]!.id);
    if (image === GPU_IMAGE) image = gpuImageSlug(size ?? { slug: request.size, gpu_info: null });

    const { data: keyData } = await providerRequest<{ ssh_key: DoSshKey }>(
      PROVIDER,
      { method: "POST", url: `${API}/account/keys`, headers: auth, attempts: 1, body: { name: request.name, public_key: request.sshPublicKey } },
      options
    );
    const sshKeyId = String(keyData.ssh_key.id);

    let droplet: DoDroplet;
    try {
      const { data } = await providerRequest<{ droplet: DoDroplet }>(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/droplets`,
          headers: auth,
          attempts: 1,
          body: {
            name: request.name,
            region: request.region,
            size: request.size,
            image,
            ssh_keys: [keyData.ssh_key.id],
            user_data: request.bootstrap.cloudInit,
            tags: tagsFor(request),
            ipv6: true,
            monitoring: false,
            backups: false
          }
        },
        options
      );
      droplet = data.droplet;
    } catch (error) {
      // No Droplet means nothing uses the key; leave nothing behind.
      await deleteSshKey(credentials, sshKeyId, { ...options, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }

    const hourly = size?.price_hourly ?? droplet.size?.price_hourly;
    return {
      ref: { dropletId: droplet.id, region: request.region, sshKeyId },
      hourlyUsd: typeof hourly === "number" && Number.isFinite(hourly) ? roundUsd(hourly) : null
    };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const dropletId = refString(PROVIDER, ref, "dropletId");
    try {
      const { data } = await providerRequest<{ droplet: DoDroplet }>(
        PROVIDER,
        { url: `${API}/droplets/${encodeURIComponent(dropletId)}`, headers: headers(credentials) },
        options
      );
      const state = mapState(data.droplet.status);
      return {
        state,
        detail: state === "running" ? null : `DigitalOcean reports the Droplet ${data.droplet.status}`,
        publicIp: publicIp(data.droplet),
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The Droplet no longer exists in DigitalOcean", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const dropletId = refString(PROVIDER, ref, "dropletId");
    await providerRequest(
      PROVIDER,
      { method: "DELETE", url: `${API}/droplets/${encodeURIComponent(dropletId)}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
    // The key only matters at create; it can go whether or not the Droplet is fully deleted yet.
    if (typeof ref.sshKeyId === "string" && ref.sshKeyId.length > 0) {
      await deleteSshKey(credentials, ref.sshKeyId, options);
      return;
    }
    // Instances found by the reconciler carry the box name instead: delete every key registered under it.
    if (typeof ref.sshKeyName === "string" && isManagedName(ref.sshKeyName)) {
      const keys = await listAll<DoSshKey>(credentials, "/account/keys", "ssh_keys", options);
      for (const key of keys.filter((entry) => entry.name === ref.sshKeyName)) await deleteSshKey(credentials, String(key.id), options);
    }
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const droplets = await listAll<DoDroplet>(credentials, `/droplets?tag_name=${encodeURIComponent(BOX_TAG_KEY)}`, "droplets", options);
    return droplets.map((droplet) => ({
      ref: { dropletId: droplet.id, region: droplet.region?.slug ?? null, sshKeyName: droplet.name },
      name: droplet.name,
      boxId: managedBoxId(boxIdFromTags(droplet.tags), droplet.name),
      createdAt: isoOrNull(droplet.created_at),
      state: mapState(droplet.status)
    }));
  }
};
