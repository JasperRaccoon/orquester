/**
 * IONOS Cloud Compute Engine (https://api.ionos.com/docs/cloud/v6/). Linux boxes only.
 *
 * - Auth: an API token from the DCD Token Manager as a bearer token.
 * - Layout: every box is its own virtual data center (VDC) at the chosen
 *   location, named after the box; inside it a public LAN and one vCPU server
 *   whose boot volume and NIC are created with it. Deleting the VDC deletes
 *   everything in it, so destroy is one call.
 * - Prices: no pricing API; vCPU, RAM and BALANCED storage list prices come
 *   from price-tables.ts (`priceSource: "table"`). Sizes are a curated set of
 *   vCPU Server shapes whose ids encode cores and RAM (`vcpu-2-4`).
 * - Marker: the VDC name `orq-<boxId>`, its description and its labels carry
 *   `orquester-box=<boxId>`; listManaged filters VDCs by them.
 * - Bootstrap: cloud-init `userData` (base64) on the boot volume, which IONOS
 *   allows only at creation and only with a cloud-init capable public image.
 * - Writes are asynchronous: a 202 carries a `Location` header with the
 *   request's status URL. Create waits for the VDC and LAN requests before the
 *   server is added; the server request itself is not awaited (status shows it).
 * - Errors come as `{ httpStatus, messages: [{ errorCode, message }] }`, a
 *   shape the shared helper does not read, so this adapter lifts the message.
 */

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
import { ProviderHttpError, providerRequest, type ProviderRequest, type ProviderResponse } from "./http.ts";
import {
  eurToUsd,
  IONOS_BALANCED_EUR_PER_GB_30_DAYS,
  IONOS_RAM_EUR_PER_GB_HOUR,
  IONOS_VCPU_EUR_PER_HOUR,
  roundUsd
} from "./price-tables.ts";
import {
  abortableDelay,
  assertKind,
  base64,
  BOX_TAG_KEY,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "IONOS Cloud";
const API = "https://api.ionos.com/cloudapi/v6";
const KINDS: readonly BoxKind[] = ["linux"];
const PAGE_SIZE = 100;

/**
 * Locations that offer vCPU Servers (IONOS service catalog), with display
 * names; offers keep those the account's `/locations` lists.
 */
const VCPU_LOCATIONS: ReadonlyArray<{ id: string; label: string; country: string }> = [
  { id: "de/fra", label: "Frankfurt", country: "DE" },
  { id: "de/fra/2", label: "Frankfurt 2", country: "DE" },
  { id: "de/txl", label: "Berlin", country: "DE" },
  { id: "gb/lhr", label: "London", country: "GB" },
  { id: "gb/bhx", label: "Worcester", country: "GB" },
  { id: "fr/par", label: "Paris", country: "FR" },
  { id: "es/vit", label: "Logroño", country: "ES" },
  { id: "us/ewr", label: "Newark", country: "US" },
  { id: "us/mci", label: "Lenexa", country: "US" }
];

/** Offered vCPU Server shapes: [vCPUs, GB RAM]. */
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 4],
  [2, 8],
  [4, 8],
  [4, 16],
  [8, 16],
  [8, 32],
  [16, 32],
  [16, 64]
];
const DISK_GB = 30;
/** The current name of the "SSD Standard" storage class. */
const VOLUME_TYPE = "BALANCED";
const DEFAULT_IMAGES = ["ubuntu:24.04", "ubuntu:latest"];

/** Deadline for a VDC or LAN request to finish during create. */
const REQUEST_DEADLINE_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2_000;
/** Cleanup after a failed create runs on its own clock: the caller's signal may be what failed. */
const CLEANUP_TIMEOUT_MS = 60_000;

interface IonosLocation {
  id: string;
  properties?: { name?: string; imageAliases?: string[] };
}

interface IonosDatacenter {
  id: string;
  metadata?: { state?: string; createdDate?: string };
  properties: { name: string; description?: string | null; location: string };
}

interface IonosServer {
  id: string;
  metadata?: { state?: string; createdDate?: string };
  properties?: { name?: string; vmState?: string; cores?: number; ram?: number; type?: string };
  entities?: { nics?: { items?: Array<{ properties?: { ips?: string[] | null } }> } };
}

interface IonosCollection<T> {
  items?: T[];
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "token", "API token")}` };
}

/** IONOS's `messages[0].message`, or null for other bodies. */
function ionosMessage(body: unknown): string | null {
  const messages = (body as { messages?: Array<{ message?: unknown }> } | null)?.messages;
  const message = Array.isArray(messages) ? messages[0]?.message : undefined;
  return typeof message === "string" && message.trim().length > 0 ? message.trim().slice(0, 300) : null;
}

/** `providerRequest` with the token attached and IONOS's error message lifted into the error. */
async function ionos<T>(credentials: ProviderCredentials, request: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  try {
    return await providerRequest<T>(PROVIDER, { ...request, headers: { ...headers(credentials), ...request.headers } }, options);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      const message = ionosMessage(error.body);
      if (message) throw new ProviderHttpError(PROVIDER, error.status, `${PROVIDER}: ${message}`, error.body);
    }
    throw error;
  }
}

/**
 * Wait for an asynchronous request from its `Location` header. Only status
 * URLs on the Cloud API itself are followed, so the token never goes elsewhere.
 */
async function waitForRequest(
  credentials: ProviderCredentials,
  response: ProviderResponse<unknown>,
  what: string,
  options: ProviderCallOptions
): Promise<void> {
  const url = response.headers.get("location");
  if (!url || !url.startsWith(`${API}/requests/`)) return;
  const deadline = Date.now() + REQUEST_DEADLINE_MS;
  for (;;) {
    const { data } = await ionos<{ metadata?: { status?: string; message?: string } }>(credentials, { url }, options);
    const status = data.metadata?.status;
    if (status === "DONE") return;
    if (status === "FAILED") throw new Error(`${PROVIDER}: creating the ${what} failed: ${data.metadata?.message ?? "no reason given"}`);
    if (Date.now() >= deadline) throw new Error(`${PROVIDER}: creating the ${what} did not finish within 10 minutes`);
    await abortableDelay(POLL_INTERVAL_MS, options.signal);
  }
}

/** Every item of a collection that pages with `offset`/`limit`. */
async function listAll<T>(credentials: ProviderCredentials, path: string, options: ProviderCallOptions): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await ionos<IonosCollection<T>>(
      credentials,
      { url: `${API}${path}${separator}offset=${offset}&limit=${PAGE_SIZE}` },
      options
    );
    const page = data.items ?? [];
    items.push(...page);
    if (page.length < PAGE_SIZE) return items;
  }
}

async function locations(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<IonosLocation[]> {
  const { data } = await ionos<IonosCollection<IonosLocation>>(credentials, { url: `${API}/locations?depth=1` }, options);
  return data.items ?? [];
}

function sizeId(cores: number, ramGb: number): string {
  return `vcpu-${cores}-${ramGb}`;
}

function parseSize(size: string): { cores: number; ramGb: number } {
  const match = /^vcpu-(\d+)-(\d+)$/.exec(size);
  const shape = match ? SIZES.find(([cores, ram]) => cores === Number(match[1]) && ram === Number(match[2])) : undefined;
  if (!shape) throw new ProviderInputError(PROVIDER, `unknown size ${size}`);
  return { cores: shape[0], ramGb: shape[1] };
}

function hourlyUsd(cores: number, ramGb: number): number {
  const storage = (DISK_GB * IONOS_BALANCED_EUR_PER_GB_30_DAYS) / (30 * 24);
  return roundUsd(eurToUsd(cores * IONOS_VCPU_EUR_PER_HOUR + ramGb * IONOS_RAM_EUR_PER_GB_HOUR + storage));
}

/** Ubuntu and Debian aliases a volume can be created from (`*_iso` aliases are installer CDs). */
function usableAlias(alias: string): boolean {
  return /^(ubuntu|debian):/.test(alias) && !alias.endsWith("_iso");
}

function aliasLabel(alias: string): string {
  const [os, version] = alias.split(":") as [string, string];
  const name = os.charAt(0).toUpperCase() + os.slice(1);
  return version === "latest" ? `${name} (latest)` : `${name} ${version}`;
}

function mapState(server: IonosServer): ProviderInstanceState {
  switch (server.properties?.vmState) {
    case "RUNNING":
      return "running";
    case "SHUTOFF":
    case "SHUTDOWN":
    case "PAUSED":
    case "SUSPENDED":
      return "stopped";
    case "CRASHED":
      return "error";
  }
  switch (server.metadata?.state) {
    case "FAILED":
      return "error";
    case "INACTIVE":
      return "stopped";
    default:
      // NOSTATE/BLOCKED, or the resource still BUSY/DEPLOYING.
      return "pending";
  }
}

function publicIp(server: IonosServer): string | null {
  for (const nic of server.entities?.nics?.items ?? []) {
    const ip = nic.properties?.ips?.[0];
    if (ip) return ip;
  }
  return null;
}

/** `orquester-box=<boxId>` from a VDC description. */
function boxIdFromDescription(description: string | null | undefined): string | null {
  const match = new RegExp(`(?:^|\\s)${BOX_TAG_KEY}=([A-Za-z0-9-]+)`).exec(description ?? "");
  return match ? match[1]! : null;
}

async function deleteDatacenter(credentials: ProviderCredentials, datacenterId: string, options: ProviderCallOptions): Promise<void> {
  await ionos(credentials, { method: "DELETE", url: `${API}/datacenters/${encodeURIComponent(datacenterId)}`, okStatuses: [404] }, options);
}

export const ionosAdapter: BoxProviderAdapter = {
  id: "ionos",
  label: "IONOS Cloud",
  kinds: KINDS,
  website: "https://cloud.ionos.com/compute",
  credentialsUrl: "https://dcd.ionos.com/latest/",
  credentialFields: [
    {
      id: "token",
      label: "API token",
      secret: true,
      help: "In the Data Center Designer open Menu → Management → Token Manager and generate a token (pick a long TTL; it stops working when it expires). The user needs the Create Data Center privilege; each box is its own virtual data center."
    }
  ],
  accountNote:
    "New IONOS Cloud accounts are checked manually (up to 24 hours) before resources can be created, and each contract has resource limits (cores, RAM, storage) that IONOS support raises on request.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () => ionos(credentials, { url: `${API}/datacenters?depth=0&limit=1` }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const listed = await locations(credentials, options);
    const available = VCPU_LOCATIONS.filter((location) => listed.some((entry) => entry.id === location.id));
    const regions: BoxRegionOffer[] = available.map((location) => ({
      id: location.id,
      label: `${location.label} (${location.id})`,
      country: location.country
    }));
    const regionIds = regions.map((region) => region.id);

    const sizes: BoxSizeOffer[] = SIZES.map(([cores, ramGb]) => ({
      id: sizeId(cores, ramGb),
      label: `vCPU Server — ${cores} vCPU, ${ramGb} GB`,
      vcpu: cores,
      ramGb,
      diskGb: DISK_GB,
      gpu: null,
      hourlyUsd: hourlyUsd(cores, ramGb),
      regions: [...regionIds]
    }));

    const aliases = new Set<string>();
    for (const entry of listed) {
      if (!regionIds.includes(entry.id)) continue;
      for (const alias of entry.properties?.imageAliases ?? []) if (usableAlias(alias)) aliases.add(alias);
    }
    const rank = (alias: string): number => {
      const index = DEFAULT_IMAGES.indexOf(alias);
      return index === -1 ? DEFAULT_IMAGES.length : index;
    };
    const images: BoxImageOffer[] = [...aliases]
      .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a))
      .map((alias) => ({ id: alias, label: aliasLabel(alias) }));

    return { sizes: sortSizes(sizes), regions, images, priceSource: "table" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const { cores, ramGb } = parseSize(request.size);
    if (!VCPU_LOCATIONS.some((location) => location.id === request.region)) {
      throw new ProviderInputError(PROVIDER, `location ${request.region} offers no vCPU Servers`);
    }

    // The image alias is checked against the location before anything is created.
    const location = (await locations(credentials, options)).find((entry) => entry.id === request.region);
    if (!location) throw new ProviderInputError(PROVIDER, `location ${request.region} is not available to this account`);
    const aliases = location.properties?.imageAliases ?? [];
    const image = request.image ?? DEFAULT_IMAGES.find((alias) => aliases.includes(alias)) ?? DEFAULT_IMAGES[0]!;
    if (!aliases.includes(image)) throw new ProviderInputError(PROVIDER, `image ${image} is not available in ${request.region}`);

    const marker = Object.entries(request.tags)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const datacenter = await ionos<IonosDatacenter>(
      credentials,
      {
        method: "POST",
        url: `${API}/datacenters`,
        attempts: 1,
        body: { properties: { name: request.name, description: marker, location: request.region } }
      },
      options
    );
    const datacenterId = datacenter.data.id;
    const dcPath = `${API}/datacenters/${encodeURIComponent(datacenterId)}`;

    let serverId: string;
    try {
      await waitForRequest(credentials, datacenter, "data center", options);
      for (const [key, value] of Object.entries(request.tags)) {
        await ionos(credentials, { method: "POST", url: `${dcPath}/labels`, attempts: 1, body: { properties: { key, value } } }, options);
      }
      const lan = await ionos<{ id: string }>(
        credentials,
        { method: "POST", url: `${dcPath}/lans`, attempts: 1, body: { properties: { name: request.name, public: true } } },
        options
      );
      await waitForRequest(credentials, lan, "public LAN", options);
      const server = await ionos<IonosServer>(
        credentials,
        {
          method: "POST",
          url: `${dcPath}/servers`,
          attempts: 1,
          body: {
            properties: { name: request.name, type: "VCPU", cores, ram: ramGb * 1024, availabilityZone: "AUTO" },
            entities: {
              volumes: {
                items: [
                  {
                    properties: {
                      name: request.name,
                      type: VOLUME_TYPE,
                      size: DISK_GB,
                      imageAlias: image,
                      // Public Linux images require a key or a password; the private key is discarded.
                      sshKeys: [request.sshPublicKey],
                      userData: base64(request.bootstrap.cloudInit)
                    }
                  }
                ]
              },
              nics: { items: [{ properties: { name: request.name, lan: Number(lan.data.id), dhcp: true, firewallActive: false } }] }
            }
          }
        },
        options
      );
      serverId = server.data.id;
    } catch (error) {
      // Nothing billable runs yet; drop the data center. If that fails too, its name marks it for the reconciler.
      await deleteDatacenter(credentials, datacenterId, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }).catch(
        () => undefined
      );
      throw error;
    }

    return { ref: { datacenterId, serverId, location: request.region }, hourlyUsd: hourlyUsd(cores, ramGb) };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const datacenterId = refString(PROVIDER, ref, "datacenterId");
    const gone: ProviderInstanceStatus = { state: "gone", detail: "The server no longer exists in IONOS Cloud", publicIp: null, hourlyUsd: null };
    // A ref from listManaged for a data center whose server never got created (or whose id was
    // never recorded) has the data center only: it is gone with the data center, else its server
    // (if any) tells; an empty data center is a failed box, to be destroyed.
    let serverId = typeof ref.serverId === "string" && ref.serverId.length > 0 ? ref.serverId : null;
    if (serverId === null) {
      let servers: IonosServer[];
      try {
        servers = await listAll<IonosServer>(credentials, `/datacenters/${encodeURIComponent(datacenterId)}/servers?depth=1`, options);
      } catch (error) {
        if (isNotFound(error)) return gone;
        throw error;
      }
      const server = servers[0];
      if (!server) return { state: "error", detail: "The IONOS Cloud data center has no server", publicIp: null, hourlyUsd: null };
      serverId = server.id;
    }
    try {
      const { data } = await ionos<IonosServer>(
        credentials,
        { url: `${API}/datacenters/${encodeURIComponent(datacenterId)}/servers/${encodeURIComponent(serverId)}?depth=2` },
        options
      );
      const state = mapState(data);
      const reported = data.properties?.vmState ?? data.metadata?.state ?? "unknown";
      return {
        state,
        detail: state === "running" ? null : `IONOS Cloud reports the server ${reported}`,
        publicIp: publicIp(data),
        hourlyUsd: null
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    // The server is gone; the box is only once its data center is (its volumes bill until then).
    const { status } = await ionos(credentials, { url: `${API}/datacenters/${encodeURIComponent(datacenterId)}?depth=0`, okStatuses: [404] }, options);
    if (status === 404) return gone;
    return { state: "error", detail: "The server is gone but its IONOS Cloud data center remains", publicIp: null, hourlyUsd: null };
  },

  async destroy(credentials, ref, options): Promise<void> {
    await deleteDatacenter(credentials, refString(PROVIDER, ref, "datacenterId"), options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const datacenters = await listAll<IonosDatacenter>(credentials, "/datacenters?depth=1", options);
    const managed = datacenters.filter(
      (dc) => isManagedName(dc.properties.name) || boxIdFromDescription(dc.properties.description) !== null
    );
    return Promise.all(
      managed.map(async (dc): Promise<ProviderManagedInstance> => {
        const servers = await listAll<IonosServer>(credentials, `/datacenters/${encodeURIComponent(dc.id)}/servers?depth=1`, options);
        const server = servers[0];
        return {
          // A data center whose server never got created still has to be destroyed; destroy needs only its id.
          ref: server
            ? { datacenterId: dc.id, serverId: server.id, location: dc.properties.location }
            : { datacenterId: dc.id, location: dc.properties.location },
          name: dc.properties.name,
          boxId: managedBoxId(boxIdFromDescription(dc.properties.description), dc.properties.name),
          createdAt: isoOrNull(dc.metadata?.createdDate),
          state: server ? mapState(server) : "error"
        };
      })
    );
  }
};
