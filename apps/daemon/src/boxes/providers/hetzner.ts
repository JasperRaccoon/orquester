/**
 * Hetzner Cloud (https://docs.hetzner.cloud/reference/cloud). Linux boxes only.
 *
 * - Auth: a project API token (Read & Write) as a bearer token.
 * - Prices: `/server_types` carries per-location prices and `/pricing` the
 *   primary IPv4 price, both in EUR (`gross` = what the account pays).
 * - Marker: the `orquester-box=<boxId>` label; `label_selector` lists them.
 * - Bootstrap: cloud-init `user_data`. The primary IPs a create allocates are
 *   `auto_delete`, so deleting the server releases them too.
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
import { providerRequest } from "./http.ts";
import { eurToUsd, roundUsd } from "./price-tables.ts";
import {
  assertKind,
  BOX_TAG_KEY,
  baseSizeId,
  isNotFound,
  isoOrNull,
  managedBoxId,
  offersByRegionalPrice,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Hetzner";
const API = "https://api.hetzner.cloud/v1";
const KINDS: readonly BoxKind[] = ["linux"];
const DEFAULT_IMAGE = "ubuntu-24.04";
const PAGE_SIZE = 50;

interface HetznerPrice {
  location: string;
  price_hourly: { gross: string; net: string };
}

interface HetznerServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type: "shared" | "dedicated";
  architecture: "x86" | "arm";
  deprecation: unknown | null;
  prices: HetznerPrice[];
  /** Newer API versions: per-location availability. */
  locations?: Array<{ name: string; available?: boolean; deprecation?: unknown | null }>;
}

interface HetznerLocation {
  name: string;
  description: string;
  city: string;
  country: string;
}

interface HetznerImage {
  name: string | null;
  description: string;
  os_flavor: string;
  architecture: string;
  deprecated: string | null;
  status: string;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string;
  labels: Record<string, string>;
  public_net?: { ipv4?: { ip: string } | null; ipv6?: { ip: string } | null };
  server_type?: { name: string; prices?: HetznerPrice[] };
  location?: { name: string } | null;
  /** Deprecated by Hetzner in favour of `location`; read as a fallback. */
  datacenter?: { location?: { name: string } } | null;
}

interface HetznerPagination {
  meta?: { pagination?: { next_page: number | null } };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "token", "API token")}` };
}

/** GET every page of a list endpoint. */
async function listAll<T>(
  credentials: ProviderCredentials,
  path: string,
  key: string,
  options: ProviderCallOptions
): Promise<T[]> {
  const items: T[] = [];
  let page: number | null = 1;
  while (page !== null) {
    const separator = path.includes("?") ? "&" : "?";
    const response: { data: HetznerPagination & Record<string, unknown> } = await providerRequest(
      PROVIDER,
      { url: `${API}${path}${separator}page=${page}&per_page=${PAGE_SIZE}`, headers: headers(credentials) },
      options
    );
    items.push(...((response.data[key] as T[] | undefined) ?? []));
    page = response.data.meta?.pagination?.next_page ?? null;
  }
  return items;
}

function mapState(status: string): ProviderInstanceState {
  switch (status) {
    case "running":
      return "running";
    case "initializing":
    case "starting":
    case "rebuilding":
    case "migrating":
      return "pending";
    case "stopping":
    case "off":
      return "stopped";
    case "deleting":
      return "gone";
    default:
      // `unknown` and states this adapter does not know are transient: Hetzner has no failure state.
      return "pending";
  }
}

/** Primary IPv4 hourly price (EUR) per location, from `/pricing`. */
async function ipv4Prices(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<Map<string, number>> {
  const { data } = await providerRequest<{
    pricing: { primary_ips?: Array<{ type: string; prices: HetznerPrice[] }> };
  }>(PROVIDER, { url: `${API}/pricing`, headers: headers(credentials) }, options);
  const prices = new Map<string, number>();
  const ipv4 = data.pricing.primary_ips?.find((entry) => entry.type === "ipv4");
  for (const price of ipv4?.prices ?? []) prices.set(price.location, Number(price.price_hourly.gross));
  return prices;
}

function hourlyUsd(prices: HetznerPrice[] | undefined, location: string, ipv4: Map<string, number>): number | null {
  const price = prices?.find((entry) => entry.location === location);
  if (!price) return null;
  const eur = Number(price.price_hourly.gross) + (ipv4.get(location) ?? 0);
  return Number.isFinite(eur) ? roundUsd(eurToUsd(eur)) : null;
}

/** IPv4, else the server's IPv6 address (Hetzner reports its /64; the server holds `::1`). */
function publicIp(server: HetznerServer): string | null {
  if (server.public_net?.ipv4?.ip) return server.public_net.ipv4.ip;
  const ipv6 = server.public_net?.ipv6?.ip;
  return ipv6 ? ipv6.replace(/::\/\d+$/, "::1") : null;
}

function availableLocations(type: HetznerServerType): string[] {
  if (type.locations) {
    return type.locations.filter((entry) => entry.available !== false && !entry.deprecation).map((entry) => entry.name);
  }
  return type.prices.map((price) => price.location);
}

export const hetznerAdapter: BoxProviderAdapter = {
  id: "hetzner",
  label: "Hetzner Cloud",
  kinds: KINDS,
  website: "https://www.hetzner.com/cloud",
  credentialsUrl: "https://console.hetzner.cloud/projects",
  credentialFields: [
    {
      id: "token",
      label: "API token",
      secret: true,
      help: "In the Hetzner Console open a project → Security → API tokens and generate a Read & Write token. Boxes are created in that project."
    }
  ],
  accountNote: "New Hetzner accounts may be asked for an ID check before the first server can be created.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () =>
      providerRequest(PROVIDER, { url: `${API}/servers?per_page=1`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const [types, locations, images, ipv4] = await Promise.all([
      listAll<HetznerServerType>(credentials, "/server_types", "server_types", options),
      listAll<HetznerLocation>(credentials, "/locations", "locations", options),
      listAll<HetznerImage>(credentials, "/images?type=system&status=available", "images", options),
      ipv4Prices(credentials, options)
    ]);

    const sizes: BoxSizeOffer[] = [];
    const usedLocations = new Set<string>();
    for (const type of types) {
      if (type.deprecation) continue;
      const available = availableLocations(type);
      if (available.length === 0) continue;
      const prices = new Map<string, number | null>();
      for (const location of available) {
        prices.set(location, hourlyUsd(type.prices, location, ipv4));
        usedLocations.add(location);
      }
      const arch = type.architecture === "arm" ? "Arm64" : "x86";
      sizes.push(
        ...offersByRegionalPrice(
          {
            label: `${type.name.toUpperCase()} — ${type.cores} ${type.cpu_type} vCPU (${arch}), ${type.memory} GB`,
            vcpu: type.cores,
            ramGb: type.memory,
            diskGb: type.disk,
            gpu: null
          },
          type.name,
          prices
        )
      );
    }

    const regions: BoxRegionOffer[] = locations
      .filter((location) => usedLocations.has(location.name))
      .map((location) => ({ id: location.name, label: `${location.city} (${location.name})`, country: location.country }));

    // System images exist once per architecture under the same name, which is what create sends.
    const seen = new Set<string>();
    const imageOffers: BoxImageOffer[] = [];
    for (const image of images) {
      if (!image.name || image.deprecated || seen.has(image.name)) continue;
      if (image.os_flavor !== "ubuntu" && image.os_flavor !== "debian") continue;
      seen.add(image.name);
      imageOffers.push({ id: image.name, label: image.description });
    }
    imageOffers.sort((a, b) => (a.id === DEFAULT_IMAGE ? -1 : b.id === DEFAULT_IMAGE ? 1 : b.id.localeCompare(a.id)));

    return { sizes: sortSizes(sizes), regions, images: imageOffers, priceSource: "live" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const auth = headers(credentials);
    // Read before the create so a pricing failure can never follow a billable create.
    const ipv4 = await ipv4Prices(credentials, options).catch((error: unknown) => {
      if (options.signal.aborted) throw error;
      return new Map<string, number>();
    });
    const { data } = await providerRequest<{ server: HetznerServer }>(
      PROVIDER,
      {
        method: "POST",
        url: `${API}/servers`,
        headers: auth,
        attempts: 1,
        body: {
          name: request.name,
          server_type: baseSizeId(request.size),
          location: request.region,
          image: request.image ?? DEFAULT_IMAGE,
          user_data: request.bootstrap.cloudInit,
          labels: request.tags,
          start_after_create: true,
          public_net: { enable_ipv4: true, enable_ipv6: true }
        }
      },
      options
    );
    // The response's root_password (set because no SSH key is attached) is dropped: no one logs in.
    return {
      ref: { serverId: data.server.id, location: request.region },
      hourlyUsd: hourlyUsd(data.server.server_type?.prices, request.region, ipv4)
    };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const serverId = refString(PROVIDER, ref, "serverId");
    try {
      const { data } = await providerRequest<{ server: HetznerServer }>(
        PROVIDER,
        { url: `${API}/servers/${encodeURIComponent(serverId)}`, headers: headers(credentials) },
        options
      );
      const state = mapState(data.server.status);
      return {
        state,
        detail: state === "running" ? null : `Hetzner reports the server ${data.server.status}`,
        publicIp: publicIp(data.server),
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The server no longer exists in Hetzner Cloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const serverId = refString(PROVIDER, ref, "serverId");
    await providerRequest(
      PROVIDER,
      { method: "DELETE", url: `${API}/servers/${encodeURIComponent(serverId)}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const servers = await listAll<HetznerServer>(
      credentials,
      `/servers?label_selector=${encodeURIComponent(BOX_TAG_KEY)}`,
      "servers",
      options
    );
    return servers.map((server) => ({
      ref: { serverId: server.id, location: server.location?.name ?? server.datacenter?.location?.name ?? null },
      name: server.name,
      boxId: managedBoxId(server.labels[BOX_TAG_KEY], server.name),
      createdAt: isoOrNull(server.created),
      state: mapState(server.status)
    }));
  }
};
