/**
 * Scaleway Instances (https://www.scaleway.com/en/developers/api/instance/).
 * Linux and Linux + GPU boxes.
 *
 * - Auth: an IAM API key's secret key in `X-Auth-Token`; resources are created
 *   in the configured Project. The access key is not needed.
 * - Prices: `/products/servers` carries live per-zone hourly prices (EUR);
 *   the root Block Storage volume and the public IPv4 are billed separately
 *   and come from price-tables.ts, so offers say `priceSource: "table"`.
 * - Marker: tags `orquester-box` (the list filter) and `orquester-box=<boxId>`;
 *   the server name is the box name. Every zone is listed: servers are zonal.
 * - Bootstrap: create, then `PATCH /user_data/cloud-init` (raw text), then the
 *   `poweron` action — three calls, so a failure after the create deletes the
 *   stopped server again (it is tagged from the start either way).
 * - Root volume: a Block Storage (`sbs_volume`) volume made from the image.
 *   `terminate` only detaches block volumes, so destroy deletes them through
 *   the Block Storage API once the server is gone. The volume bills on its own,
 *   so a box is gone only once its volumes are too: `status` reads the ref's
 *   volumes after the server has gone, create names and tags the volume like
 *   the server, and `listManaged` lists tagged volumes no server holds (a
 *   destroy cut off between the server and its volume) as instances of their
 *   own (`{ zone, volumeIds }`, no `serverId`), which `destroy` deletes.
 * - Windows is not offered: Scaleway's Windows images run no cloud-init or
 *   cloudbase-init, and their metadata user data is only readable from a
 *   privileged source port, which the images' own PowerShell module documents
 *   as unusable on Windows. Their one automation path is SSH, which Orquester
 *   does not use.
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
import { ProviderHttpError, providerRequest } from "./http.ts";
import { eurToUsd, roundUsd, SCALEWAY_BLOCK_EUR_PER_GB_HOUR, SCALEWAY_IPV4_EUR_PER_HOUR } from "./price-tables.ts";
import {
  abortableDelay,
  assertKind,
  baseSizeId,
  BOX_TAG_KEY,
  isGpuKind,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  offersByRegionalPrice,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Scaleway";
const API = "https://api.scaleway.com";
const KINDS: readonly BoxKind[] = ["linux", "linux-gpu"];
const PAGE_SIZE = 100;
const GIB = 1024 ** 3;

/** Instance zones the API serves, with their display names. */
const ZONES: ReadonlyArray<{ id: string; label: string; country: string }> = [
  { id: "fr-par-1", label: "Paris 1", country: "FR" },
  { id: "fr-par-2", label: "Paris 2", country: "FR" },
  { id: "fr-par-3", label: "Paris 3", country: "FR" },
  { id: "nl-ams-1", label: "Amsterdam 1", country: "NL" },
  { id: "nl-ams-2", label: "Amsterdam 2", country: "NL" },
  { id: "nl-ams-3", label: "Amsterdam 3", country: "NL" },
  { id: "pl-waw-1", label: "Warsaw 1", country: "PL" },
  { id: "pl-waw-2", label: "Warsaw 2", country: "PL" },
  { id: "pl-waw-3", label: "Warsaw 3", country: "PL" },
  { id: "it-mil-1", label: "Milan 1", country: "IT" }
];

/** Root volume sizes: GPU OS images carry the NVIDIA stack and CUDA containers need room. */
const LINUX_ROOT_GB = 20;
const GPU_ROOT_GB = 100;

/** Marketplace image labels offered per kind, in display order; the first is the default. */
const LINUX_IMAGES = ["ubuntu_noble", "ubuntu_resolute", "ubuntu_jammy", "debian_trixie", "debian_bookworm"];
/** GPU OS: Ubuntu 24.04 with the NVIDIA driver, Docker and the NVIDIA container toolkit. */
const GPU_IMAGES = ["ubuntu_noble_gpu_os_13_nvidia", "ubuntu_noble"];

/** Deadline for destroy's wait until the server is gone and its volumes are detached. */
const DESTROY_DEADLINE_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 3_000;
/** Cleanup after a failed create runs on its own clock: the caller's signal may be what failed. */
const CLEANUP_TIMEOUT_MS = 5 * 60_000;

interface ScalewayServerType {
  arch: string;
  ncpus: number;
  ram: number;
  gpu?: number | null;
  gpu_info?: { gpu_manufacturer: string; gpu_name: string; gpu_memory: number } | null;
  hourly_price: number;
  capabilities?: { block_storage?: boolean };
  end_of_service?: boolean;
}

interface ScalewayServerVolume {
  id: string;
  volume_type: string;
}

/** A Block Storage volume (`/block/v1/zones/{zone}/volumes`). */
interface ScalewayBlockVolume {
  id: string;
  name: string;
  status: string;
  tags?: string[];
  zone?: string;
  created_at?: string;
  references?: unknown[];
}

interface ScalewayServerIp {
  address: string;
  family: "inet" | "inet6";
}

interface ScalewayServer {
  id: string;
  name: string;
  state: string;
  state_detail?: string;
  tags: string[];
  zone: string;
  creation_date?: string;
  commercial_type: string;
  allowed_actions?: string[];
  volumes?: Record<string, ScalewayServerVolume>;
  public_ip?: ScalewayServerIp | null;
  public_ips?: ScalewayServerIp[];
}

interface MarketplaceImage {
  label: string;
  name: string;
}

interface MarketplaceLocalImage {
  id: string;
  arch: string;
  zone: string;
  label: string;
  type: string;
  compatible_commercial_types: string[];
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { "X-Auth-Token": requireCredential(PROVIDER, credentials, "secretKey", "Secret key") };
}

function projectId(credentials: ProviderCredentials): string {
  const value = requireCredential(PROVIDER, credentials, "projectId", "Project ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ProviderInputError(PROVIDER, "Project ID must be a UUID (Project settings → Project ID)");
  }
  return value;
}

function zoneUrl(zone: string, path: string): string {
  return `${API}/instance/v1/zones/${encodeURIComponent(zone)}${path}`;
}

function assertZone(zone: string): void {
  if (!ZONES.some((entry) => entry.id === zone)) throw new ProviderInputError(PROVIDER, `unknown zone ${zone}`);
}

/**
 * Every page of a paged endpoint. The Instance API takes `per_page` and
 * reports the total in `X-Total-Count`; the Marketplace API takes `page_size`
 * and reports `total_count` in the body. `merge` adds one page's body and
 * returns how many items it held.
 */
async function forEachPage(
  credentials: ProviderCredentials,
  url: string,
  options: ProviderCallOptions,
  merge: (data: unknown) => number
): Promise<void> {
  const sizeParam = url.startsWith(`${API}/marketplace/`) || url.startsWith(`${API}/block/`) ? "page_size" : "per_page";
  let seen = 0;
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await providerRequest<unknown>(
      PROVIDER,
      { url: `${url}${separator}page=${page}&${sizeParam}=${PAGE_SIZE}`, headers: headers(credentials) },
      options
    );
    const count = merge(response.data);
    seen += count;
    const header = response.headers.get("x-total-count");
    const total = header !== null ? Number(header) : Number((response.data as { total_count?: unknown } | null)?.total_count);
    if (count === 0 || !Number.isFinite(total) || seen >= total) return;
  }
}

/** A zone's server types (the API returns them as a map keyed by commercial type). */
async function serverTypes(
  credentials: ProviderCredentials,
  zone: string,
  options: ProviderCallOptions
): Promise<Map<string, ScalewayServerType>> {
  const types = new Map<string, ScalewayServerType>();
  await forEachPage(credentials, zoneUrl(zone, "/products/servers"), options, (data) => {
    const servers = (data as { servers?: Record<string, ScalewayServerType> }).servers ?? {};
    for (const [name, type] of Object.entries(servers)) types.set(name, type);
    return Object.keys(servers).length;
  });
  return types;
}

/** A zone's stock level per server type (`available`, `scarce`, `shortage`). */
async function availability(credentials: ProviderCredentials, zone: string, options: ProviderCallOptions): Promise<Map<string, string>> {
  const levels = new Map<string, string>();
  await forEachPage(credentials, zoneUrl(zone, "/products/servers/availability"), options, (data) => {
    const servers = (data as { servers?: Record<string, { availability: string }> }).servers ?? {};
    for (const [name, entry] of Object.entries(servers)) levels.set(name, entry.availability);
    return Object.keys(servers).length;
  });
  return levels;
}

async function listServers(
  credentials: ProviderCredentials,
  zone: string,
  query: string,
  options: ProviderCallOptions
): Promise<ScalewayServer[]> {
  const servers: ScalewayServer[] = [];
  await forEachPage(credentials, zoneUrl(zone, `/servers?${query}`), options, (data) => {
    const page = (data as { servers?: ScalewayServer[] }).servers ?? [];
    servers.push(...page);
    return page.length;
  });
  return servers;
}

/** Server types a kind may use: GPU types only for linux-gpu, never the `-WIN` licence types. */
function typeFits(name: string, type: ScalewayServerType, kind: BoxKind): boolean {
  if (type.end_of_service) return false;
  if (name.endsWith("-WIN")) return false;
  if (type.capabilities?.block_storage === false) return false;
  if (type.arch !== "x86_64" && type.arch !== "arm64") return false;
  const gpu = (type.gpu ?? 0) > 0;
  return isGpuKind(kind) ? gpu : !gpu;
}

function rootGb(kind: BoxKind): number {
  return isGpuKind(kind) ? GPU_ROOT_GB : LINUX_ROOT_GB;
}

/** Server plus its root block volume and public IPv4, EUR → USD. */
function hourlyUsd(type: ScalewayServerType, kind: BoxKind): number {
  const eur = type.hourly_price + rootGb(kind) * SCALEWAY_BLOCK_EUR_PER_GB_HOUR + SCALEWAY_IPV4_EUR_PER_HOUR;
  return roundUsd(eurToUsd(eur));
}

function gib(bytes: number): number {
  return Math.round((bytes / GIB) * 10) / 10;
}

function sizeLabel(name: string, type: ScalewayServerType): string {
  const arch = type.arch === "arm64" ? "Arm64" : "x86";
  const gpu = type.gpu_info && type.gpu ? `, ${type.gpu}× ${type.gpu_info.gpu_name}` : "";
  return `${name} — ${type.ncpus} vCPU (${arch}), ${gib(type.ram)} GB${gpu}`;
}

function mapState(state: string): ProviderInstanceState {
  switch (state) {
    case "running":
      return "running";
    case "starting":
    case "locked":
      return "pending";
    case "stopping":
    case "stopped":
    case "stopped in place":
      return "stopped";
    default:
      // `locked` (a Scaleway hold) and unknown states are transient: Scaleway has no failure state.
      return "pending";
  }
}

function publicIp(server: ScalewayServer): string | null {
  const ips = server.public_ips ?? [];
  return ips.find((ip) => ip.family === "inet")?.address ?? ips[0]?.address ?? server.public_ip?.address ?? null;
}

function blockVolumeIds(server: ScalewayServer): string[] {
  return Object.values(server.volumes ?? {})
    .filter((volume) => volume.volume_type === "sbs_volume")
    .map((volume) => volume.id);
}

function boxIdFromTags(tags: string[]): string | null {
  const prefix = `${BOX_TAG_KEY}=`;
  const tag = tags.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function refVolumeIds(ref: ProviderInstanceRef): string[] {
  return Array.isArray(ref.volumeIds) ? ref.volumeIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/**
 * The zone's image id for a marketplace label and server type: the local
 * image built for Block Storage boot volumes that lists the type as compatible.
 */
async function resolveImage(
  credentials: ProviderCredentials,
  zone: string,
  commercialType: string,
  image: string,
  options: ProviderCallOptions
): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image)) return image;
  const query = `image_label=${encodeURIComponent(image)}&zone=${encodeURIComponent(zone)}&type=instance_sbs`;
  const candidates: MarketplaceLocalImage[] = [];
  await forEachPage(credentials, `${API}/marketplace/v2/local-images?${query}`, options, (data) => {
    const page = (data as { local_images?: MarketplaceLocalImage[] }).local_images ?? [];
    candidates.push(...page);
    return page.length;
  });
  const match = candidates.find((entry) => entry.compatible_commercial_types.includes(commercialType));
  if (!match) throw new ProviderInputError(PROVIDER, `image ${image} is not available for ${commercialType} in ${zone}`);
  return match.id;
}

async function getServer(
  credentials: ProviderCredentials,
  zone: string,
  serverId: string,
  options: ProviderCallOptions
): Promise<ScalewayServer | null> {
  try {
    const { data } = await providerRequest<{ server: ScalewayServer }>(
      PROVIDER,
      { url: zoneUrl(zone, `/servers/${encodeURIComponent(serverId)}`), headers: headers(credentials) },
      options
    );
    return data.server;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function blockVolumeUrl(zone: string, volumeId: string): string {
  return `${API}/block/v1/zones/${encodeURIComponent(zone)}/volumes/${encodeURIComponent(volumeId)}`;
}

/** The ref's volumes that still exist (each one bills). */
async function remainingVolumes(credentials: ProviderCredentials, zone: string, volumeIds: string[], options: ProviderCallOptions): Promise<string[]> {
  const remaining: string[] = [];
  for (const volumeId of volumeIds) {
    const { status } = await providerRequest(PROVIDER, { url: blockVolumeUrl(zone, volumeId), headers: headers(credentials), okStatuses: [404] }, options);
    if (status !== 404) remaining.push(volumeId);
  }
  return remaining;
}

/** Tagged volumes in a zone that no server holds: leftovers of a destroy cut off before its volume went. */
async function looseVolumes(credentials: ProviderCredentials, zone: string, options: ProviderCallOptions): Promise<ScalewayBlockVolume[]> {
  const volumes: ScalewayBlockVolume[] = [];
  const query = `project_id=${encodeURIComponent(projectId(credentials))}&tags=${encodeURIComponent(BOX_TAG_KEY)}`;
  await forEachPage(credentials, `${API}/block/v1/zones/${encodeURIComponent(zone)}/volumes?${query}`, options, (data) => {
    const page = (data as { volumes?: ScalewayBlockVolume[] }).volumes ?? [];
    volumes.push(...page);
    return page.length;
  });
  return volumes.filter(
    (volume) =>
      (volume.tags ?? []).includes(BOX_TAG_KEY) &&
      (volume.references ?? []).length === 0 &&
      volume.status !== "in_use" &&
      volume.status !== "deleting" &&
      volume.status !== "deleted"
  );
}

/** Delete a block volume once it is detached; 404 means it is already gone. */
async function deleteBlockVolume(
  credentials: ProviderCredentials,
  zone: string,
  volumeId: string,
  deadline: number,
  options: ProviderCallOptions
): Promise<void> {
  for (;;) {
    try {
      await providerRequest(
        PROVIDER,
        {
          method: "DELETE",
          url: blockVolumeUrl(zone, volumeId),
          headers: headers(credentials),
          okStatuses: [404]
        },
        options
      );
      return;
    } catch (error) {
      // A volume still `in_use` (the detach trails the server's deletion) is refused; wait for it.
      const inUse = error instanceof ProviderHttpError && (error.status === 400 || error.status === 409 || error.status === 412);
      if (!inUse || Date.now() >= deadline) throw error;
    }
    await abortableDelay(POLL_INTERVAL_MS, options.signal);
  }
}

/**
 * Remove the server and the block volumes it had. `terminate` works on a
 * running server; a stopped one is deleted directly; a server in transition is
 * polled until it settles.
 */
async function destroyServer(
  credentials: ProviderCredentials,
  zone: string,
  serverId: string,
  knownVolumeIds: string[],
  options: ProviderCallOptions
): Promise<void> {
  const deadline = Date.now() + DESTROY_DEADLINE_MS;
  const volumeIds = new Set(knownVolumeIds);
  const action = (name: string): Promise<unknown> =>
    providerRequest(
      PROVIDER,
      {
        method: "POST",
        url: zoneUrl(zone, `/servers/${encodeURIComponent(serverId)}/action`),
        headers: headers(credentials),
        body: { action: name },
        okStatuses: [404]
      },
      options
    );
  let requested = false;
  let poweringOff = false;
  for (;;) {
    const server = await getServer(credentials, zone, serverId, options);
    if (!server) break;
    for (const id of blockVolumeIds(server)) volumeIds.add(id);
    if (!requested) {
      if (server.allowed_actions?.includes("terminate")) {
        await action("terminate");
        requested = true;
        continue;
      }
      // "Stopped in place" keeps its hypervisor slot and cannot be deleted; release it first.
      if (server.state === "stopped in place" && !poweringOff && server.allowed_actions?.includes("poweroff")) {
        await action("poweroff");
        poweringOff = true;
        continue;
      }
      if (server.state === "stopped") {
        await providerRequest(
          PROVIDER,
          {
            method: "DELETE",
            url: zoneUrl(zone, `/servers/${encodeURIComponent(serverId)}`),
            headers: headers(credentials),
            okStatuses: [404]
          },
          options
        );
        requested = true;
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`${PROVIDER}: server ${serverId} is still ${server.state} after 10 minutes`);
    await abortableDelay(POLL_INTERVAL_MS, options.signal);
  }
  for (const volumeId of volumeIds) await deleteBlockVolume(credentials, zone, volumeId, deadline, options);
}

export const scalewayAdapter: BoxProviderAdapter = {
  id: "scaleway",
  label: "Scaleway",
  kinds: KINDS,
  website: "https://www.scaleway.com/en/virtual-instances/",
  credentialsUrl: "https://console.scaleway.com/iam/api-keys",
  credentialFields: [
    {
      id: "secretKey",
      label: "Secret key",
      secret: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      help: "IAM → API keys → Generate an API key, and copy the secret key (shown once). The key's user or application needs a policy with InstancesFullAccess and BlockStorageFullAccess on the Project."
    },
    {
      id: "projectId",
      label: "Project ID",
      secret: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      help: "Project settings → Project ID of the Project boxes are created in."
    }
  ],
  accountNote:
    "Scaleway asks for an identity check before most Instance types and every GPU type can be used; after it an account may run one L4-1-24G or L40S-1-48G, while H100 and multi-GPU types need a quota increase from Scaleway support.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, async () => {
      const project = projectId(credentials);
      await providerRequest(
        PROVIDER,
        {
          url: zoneUrl("fr-par-1", `/servers?project=${encodeURIComponent(project)}&per_page=1`),
          headers: headers(credentials)
        },
        options
      );
    });
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const [catalogs, images] = await Promise.all([
      Promise.all(
        ZONES.map(async (zone) => {
          const [types, levels] = await Promise.all([
            serverTypes(credentials, zone.id, options),
            availability(credentials, zone.id, options)
          ]);
          return { zone: zone.id, types, levels };
        })
      ),
      (async () => {
        const all: MarketplaceImage[] = [];
        await forEachPage(credentials, `${API}/marketplace/v2/images?arch=x86_64`, options, (data) => {
          const page = (data as { images?: MarketplaceImage[] }).images ?? [];
          all.push(...page);
          return page.length;
        });
        return all;
      })()
    ]);

    // Per type: the price in each zone that stocks it, and one representative definition.
    const byType = new Map<string, { type: ScalewayServerType; prices: Map<string, number | null> }>();
    for (const { zone, types, levels } of catalogs) {
      for (const [name, type] of types) {
        if (!typeFits(name, type, kind)) continue;
        if ((levels.get(name) ?? "available") === "shortage") continue;
        const entry = byType.get(name) ?? { type, prices: new Map<string, number | null>() };
        entry.prices.set(zone, hourlyUsd(type, kind));
        byType.set(name, entry);
      }
    }

    const sizes: BoxSizeOffer[] = [];
    const usedZones = new Set<string>();
    for (const [name, { type, prices }] of byType) {
      for (const zone of prices.keys()) usedZones.add(zone);
      const gpu =
        type.gpu && type.gpu_info
          ? { model: type.gpu_info.gpu_name, count: type.gpu, vramGb: Math.round(type.gpu_info.gpu_memory / GIB) }
          : null;
      sizes.push(
        ...offersByRegionalPrice(
          { label: sizeLabel(name, type), vcpu: type.ncpus, ramGb: gib(type.ram), diskGb: rootGb(kind), gpu },
          name,
          prices
        )
      );
    }

    const regions: BoxRegionOffer[] = ZONES.filter((zone) => usedZones.has(zone.id)).map((zone) => ({
      id: zone.id,
      label: `${zone.label} (${zone.id})`,
      country: zone.country
    }));

    const wanted = isGpuKind(kind) ? GPU_IMAGES : LINUX_IMAGES;
    const imageOffers: BoxImageOffer[] = wanted.flatMap((label) => {
      const image = images.find((entry) => entry.label === label);
      return image ? [{ id: image.label, label: image.name }] : [];
    });

    return { sizes: sortSizes(sizes), regions, images: imageOffers, priceSource: "table" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    assertZone(request.region);
    const auth = headers(credentials);
    const project = projectId(credentials);
    const zone = request.region;
    const commercialType = baseSizeId(request.size);
    const label = request.image ?? (isGpuKind(request.kind) ? GPU_IMAGES[0]! : LINUX_IMAGES[0]!);

    // Reads that can fail happen before anything billable exists; the price may stay unknown.
    const type = await serverTypes(credentials, zone, options)
      .then((types) => types.get(commercialType) ?? null)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });
    const imageId = await resolveImage(credentials, zone, commercialType, label, options);
    const tags = [BOX_TAG_KEY, ...Object.entries(request.tags).map(([key, value]) => `${key}=${value}`)];

    const { data } = await providerRequest<{ server: ScalewayServer }>(
      PROVIDER,
      {
        method: "POST",
        url: zoneUrl(zone, "/servers"),
        headers: auth,
        attempts: 1,
        body: {
          name: request.name,
          commercial_type: commercialType,
          image: imageId,
          project,
          tags,
          dynamic_ip_required: true,
          volumes: { "0": { size: rootGb(request.kind) * 1_000_000_000, volume_type: "sbs_volume" } },
          protected: false
        }
      },
      options
    );
    const server = data.server;
    const volumeIds = blockVolumeIds(server);

    try {
      await providerRequest(
        PROVIDER,
        {
          method: "PATCH",
          url: zoneUrl(zone, `/servers/${encodeURIComponent(server.id)}/user_data/cloud-init`),
          headers: { ...auth, "Content-Type": "text/plain" },
          body: request.bootstrap.cloudInit
        },
        options
      );
      // The volume carries the box's marker too, so a volume left by a cut-off destroy is found.
      // Best effort: the record's ref names the volume either way.
      for (const volumeId of volumeIds) {
        await providerRequest(
          PROVIDER,
          { method: "PATCH", url: blockVolumeUrl(zone, volumeId), headers: auth, body: { name: request.name, tags } },
          options
        ).catch((error: unknown) => {
          if (options.signal.aborted) throw error;
        });
      }
      await providerRequest(
        PROVIDER,
        {
          method: "POST",
          url: zoneUrl(zone, `/servers/${encodeURIComponent(server.id)}/action`),
          headers: auth,
          body: { action: "poweron" }
        },
        options
      );
    } catch (error) {
      // The server never started: remove it and its volume. If that fails too, its tags let the reconciler find it.
      await destroyServer(credentials, zone, server.id, volumeIds, {
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      }).catch(() => undefined);
      throw error;
    }

    return {
      ref: { serverId: server.id, zone, volumeIds },
      hourlyUsd: type ? hourlyUsd(type, request.kind) : null
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const zone = refString(PROVIDER, ref, "zone");
    // A loose volume's ref (listManaged) has volumes only.
    const serverId = ref.serverId === undefined && refVolumeIds(ref).length > 0 ? null : refString(PROVIDER, ref, "serverId");
    const server = serverId === null ? null : await getServer(credentials, zone, serverId, options);
    if (!server) {
      // The server is gone; its block volumes bill until they are deleted (destroy does that).
      const remaining = await remainingVolumes(credentials, zone, refVolumeIds(ref), options);
      if (remaining.length > 0) {
        return {
          state: "error",
          detail: `The server is gone but its block volume ${remaining.join(", ")} remains in Scaleway`,
          publicIp: null,
          hourlyUsd: null
        };
      }
      return { state: "gone", detail: "The server no longer exists in Scaleway", publicIp: null, hourlyUsd: null };
    }
    const state = mapState(server.state);
    const reason = server.state_detail ? ` (${server.state_detail})` : "";
    return {
      state,
      detail: state === "running" ? null : `Scaleway reports the server ${server.state}${reason}`,
      publicIp: publicIp(server),
      hourlyUsd: null
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const zone = refString(PROVIDER, ref, "zone");
    if (ref.serverId === undefined && refVolumeIds(ref).length > 0) {
      // A loose volume (listManaged): nothing holds it any more.
      const deadline = Date.now() + DESTROY_DEADLINE_MS;
      for (const volumeId of refVolumeIds(ref)) await deleteBlockVolume(credentials, zone, volumeId, deadline, options);
      return;
    }
    await destroyServer(credentials, zone, refString(PROVIDER, ref, "serverId"), refVolumeIds(ref), options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const query = `tags=${encodeURIComponent(BOX_TAG_KEY)}&project=${encodeURIComponent(projectId(credentials))}`;
    const perZone = await Promise.all(
      ZONES.map(async (zone) => ({
        zone: zone.id,
        servers: await listServers(credentials, zone.id, query, options),
        volumes: await looseVolumes(credentials, zone.id, options)
      }))
    );
    const servers: ProviderManagedInstance[] = perZone
      .flatMap((entry) => entry.servers)
      .filter((server) => server.tags.includes(BOX_TAG_KEY) || isManagedName(server.name))
      .map((server) => ({
        ref: { serverId: server.id, zone: server.zone, volumeIds: blockVolumeIds(server) },
        name: server.name,
        boxId: managedBoxId(boxIdFromTags(server.tags), server.name),
        createdAt: isoOrNull(server.creation_date),
        state: mapState(server.state)
      }));
    const held = new Set(servers.flatMap((server) => refVolumeIds(server.ref)));
    const volumes: ProviderManagedInstance[] = perZone.flatMap((entry) =>
      entry.volumes
        .filter((volume) => !held.has(volume.id))
        .map((volume) => ({
          ref: { zone: volume.zone ?? entry.zone, volumeIds: [volume.id] },
          name: volume.name,
          boxId: managedBoxId(boxIdFromTags(volume.tags ?? []), volume.name),
          createdAt: isoOrNull(volume.created_at),
          // Billing with no server: a live record holding it is destroyed, an orphan swept.
          state: "error" as const
        }))
    );
    return [...servers, ...volumes];
  }
};
