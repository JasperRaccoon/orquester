/**
 * UpCloud (https://developers.upcloud.com/1.3/). Linux boxes only.
 *
 * - Auth: an API token (`ucat_…`) as a bearer token, or the username and
 *   password of an API subaccount (HTTP Basic; UpCloud discourages it and
 *   needs API access enabled for that account).
 * - Prices: `/1.3/price` lists per-zone hourly prices in cents of the account
 *   currency (EUR or USD); `server_plan_<plan>` covers CPU, RAM, the plan's
 *   storage and one public IPv4. Cloud Native plans include no storage, so the
 *   root disk Orquester gives them is added at the `storage_maxiops` rate.
 * - Marker: the `orquester-box=<boxId>` label (`?label=orquester-box` lists
 *   them); title and hostname are `orq-<boxId>`.
 * - Bootstrap: cloud-init `user_data` with the metadata service on, which
 *   UpCloud's cloud-init templates require (as they require an SSH key — the
 *   request's throwaway public key).
 * - Windows is not offered: UpCloud ignores `user_data` and `login_user` on
 *   non-Linux templates and runs no first-boot script on its Windows
 *   templates, and custom Windows images need UpCloud's approval, so there is
 *   no unattended way to start `orq-agent` there.
 * - Destroy: a server must be stopped before it can be deleted; destroy hard
 *   stops it, polls until it is stopped (with a deadline), then deletes it
 *   together with its storage (`storages=1&backups=delete`).
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
import { providerRequest, ProviderHttpError, type ProviderRequest } from "./http.ts";
import { eurToUsd, roundUsd } from "./price-tables.ts";
import {
  abortableDelay,
  assertKind,
  baseSizeId,
  BOX_TAG_KEY,
  isNotFound,
  isoOrNull,
  managedBoxId,
  offersByRegionalPrice,
  optionalCredential,
  ProviderInputError,
  refString,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "UpCloud";
const API = "https://api.upcloud.com/1.3";
const KINDS: readonly BoxKind[] = ["linux"];
const PAGE_SIZE = 100;
const MIN_MEMORY_MB = 1024;
/** Root disk for Cloud Native plans, which include none (GiB). */
const CLOUD_NATIVE_DISK_GB = 40;
const CLOUD_NATIVE_TIER = "maxiops";
const DEFAULT_IMAGE_PREFIX = "Ubuntu Server 24.04";
const IMAGE_PREFIXES = ["Ubuntu Server", "Debian GNU/Linux"];

/** Poll timing for destroy's stop-then-delete; tests set `pollMs` to 0. */
export const upcloudTiming = { pollMs: 3_000, destroyDeadlineMs: 300_000 };

interface UpcloudPlan {
  name: string;
  core_number: number;
  memory_amount: number;
  storage_size?: number;
  storage_tier?: string | null;
  family?: string;
  current_offering?: "yes" | "no";
  gpu_amount?: number;
}

interface UpcloudPrice {
  amount: number;
  price: number;
}

type UpcloudZonePrices = { name: string; items?: Record<string, UpcloudPrice> } & Record<string, unknown>;

interface UpcloudPriceList {
  prices: { currency?: string; zone: UpcloudZonePrices[] };
}

interface UpcloudZone {
  id: string;
  description: string;
  public: "yes" | "no";
}

interface UpcloudTemplate {
  uuid: string;
  title: string;
  access?: string;
  type?: string;
  template_type?: string;
  size?: number;
}

interface UpcloudServer {
  uuid: string;
  title: string;
  hostname?: string;
  state: string;
  zone: string;
  plan?: string;
  created?: number;
  labels?: { label?: Array<{ key: string; value: string }> };
  ip_addresses?: { ip_address?: Array<{ access: string; address: string; family: string }> };
}

/** Prices in one zone: hourly cents of the account currency per `amount` units. */
type ZonePrices = ReadonlyMap<string, UpcloudPrice>;

function headers(credentials: ProviderCredentials): Record<string, string> {
  const token = optionalCredential(credentials, "token");
  if (token) return { Authorization: `Bearer ${token}` };
  const username = optionalCredential(credentials, "username");
  const password = optionalCredential(credentials, "password");
  if (!username || !password) throw new ProviderInputError(PROVIDER, "an API token, or a username and password, is missing");
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

/**
 * One API call. UpCloud's general errors are `{"error": {"error_code",
 * "error_message"}}`, which the shared helper does not read, so the message
 * is lifted here.
 */
async function upRequest<T>(
  credentials: ProviderCredentials,
  request: Omit<ProviderRequest, "headers">,
  options: ProviderCallOptions
): Promise<T> {
  try {
    const { data } = await providerRequest<T>(PROVIDER, { ...request, headers: headers(credentials) }, options);
    return data;
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      const detail = (error.body as { error?: { error_message?: unknown; error_code?: unknown } } | null)?.error;
      if (typeof detail?.error_message === "string" && detail.error_message.trim()) {
        throw new ProviderHttpError(PROVIDER, error.status, `${PROVIDER}: ${detail.error_message.trim().slice(0, 300)}`, error.body);
      }
    }
    throw error;
  }
}

async function listPlans(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<UpcloudPlan[]> {
  const data = await upRequest<{ plans: { plan: UpcloudPlan[] } }>(credentials, { url: `${API}/plan` }, options);
  return data.plans.plan;
}

async function listTemplates(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<UpcloudTemplate[]> {
  const data = await upRequest<{ storages: { storage: UpcloudTemplate[] } }>(credentials, { url: `${API}/storage/template` }, options);
  return data.storages.storage;
}

/** Per-zone price maps and the account currency. */
async function priceList(
  credentials: ProviderCredentials,
  zone: string | null,
  options: ProviderCallOptions
): Promise<{ currency: string; zones: Map<string, ZonePrices> }> {
  const url = zone === null ? `${API}/price` : `${API}/price?zone=${encodeURIComponent(zone)}`;
  const data = await upRequest<UpcloudPriceList>(credentials, { url }, options);
  const zones = new Map<string, ZonePrices>();
  for (const entry of data.prices.zone) {
    // The 1.3 docs put the price entries beside `name`; the OpenAPI schema nests them under `items`.
    const source: Record<string, unknown> = entry.items ?? entry;
    const prices = new Map<string, UpcloudPrice>();
    for (const [key, value] of Object.entries(source)) {
      const price = value as Partial<UpcloudPrice> | null;
      if (typeof price?.price === "number" && typeof price.amount === "number" && price.amount > 0) {
        prices.set(key, { amount: price.amount, price: price.price });
      }
    }
    zones.set(entry.name, prices);
  }
  // Accounts bill in EUR unless set up otherwise; older answers carry no currency.
  return { currency: data.prices.currency ?? "EUR", zones };
}

function isCloudNative(plan: UpcloudPlan): boolean {
  return plan.family === "cloud_native" || !plan.storage_size;
}

function diskGb(plan: UpcloudPlan): number {
  return isCloudNative(plan) ? CLOUD_NATIVE_DISK_GB : plan.storage_size!;
}

/** Hourly USD of a plan in one zone (plus its root disk on Cloud Native), null when the zone does not price it. */
function planHourly(plan: UpcloudPlan, prices: ZonePrices | undefined, currency: string): number | null {
  const server = prices?.get(`server_plan_${plan.name}`);
  if (!server) return null;
  let cents = server.price / server.amount;
  if (isCloudNative(plan)) {
    const storage = prices!.get(`storage_${CLOUD_NATIVE_TIER}`);
    if (!storage) return null;
    cents += (storage.price / storage.amount) * CLOUD_NATIVE_DISK_GB;
  }
  const amount = cents / 100;
  if (currency === "USD") return roundUsd(amount);
  if (currency === "EUR") return roundUsd(eurToUsd(amount));
  return null;
}

function planFits(plan: UpcloudPlan): boolean {
  if (plan.current_offering === "no" || plan.family === "gpu" || (plan.gpu_amount ?? 0) > 0) return false;
  return plan.memory_amount >= MIN_MEMORY_MB;
}

function templateFits(template: UpcloudTemplate): boolean {
  if (template.access !== undefined && template.access !== "public") return false;
  if (template.template_type !== "cloud-init") return false;
  if (/nvidia|cuda|gpu/i.test(template.title)) return false;
  return IMAGE_PREFIXES.some((prefix) => template.title.startsWith(prefix));
}

function mapState(state: string): ProviderInstanceState {
  switch (state) {
    case "started":
      return "running";
    case "maintenance":
      return "pending";
    case "stopped":
      return "stopped";
    case "pending_delete":
      return "gone";
    case "error":
      return "error";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

function zoneOffer(zone: UpcloudZone): BoxRegionOffer {
  const prefix = zone.id.slice(0, 2).toUpperCase();
  return { id: zone.id, label: `${zone.description} (${zone.id})`, country: prefix === "UK" ? "GB" : prefix };
}

function publicIp(server: UpcloudServer): string | null {
  const addresses = server.ip_addresses?.ip_address?.filter((entry) => entry.access === "public") ?? [];
  return (addresses.find((entry) => entry.family === "IPv4") ?? addresses.find((entry) => entry.family === "IPv6"))?.address ?? null;
}

function boxIdLabel(server: UpcloudServer): string | null {
  return server.labels?.label?.find((entry) => entry.key === BOX_TAG_KEY)?.value ?? null;
}

async function getServer(credentials: ProviderCredentials, uuid: string, options: ProviderCallOptions): Promise<UpcloudServer> {
  const data = await upRequest<{ server: UpcloudServer }>(credentials, { url: `${API}/server/${encodeURIComponent(uuid)}` }, options);
  return data.server;
}

export const upcloudAdapter: BoxProviderAdapter = {
  id: "upcloud",
  label: "UpCloud",
  kinds: KINDS,
  website: "https://upcloud.com",
  credentialsUrl: "https://hub.upcloud.com/account/api-tokens",
  credentialFields: [
    {
      id: "token",
      label: "API token",
      secret: true,
      optional: true,
      placeholder: "ucat_…",
      help: "In the UpCloud Control Panel open Account → API Tokens and create a token (shown once). Or leave this empty and enter an API subaccount's username and password."
    },
    {
      id: "username",
      label: "Username",
      secret: false,
      optional: true,
      help: "Only without a token: an API subaccount (People page) with API access enabled."
    },
    {
      id: "password",
      label: "Password",
      secret: true,
      optional: true,
      help: "Only without a token: the subaccount's password."
    }
  ],
  accountNote: "UpCloud API tokens expire (365 days at most); save a new token here when the old one runs out.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () => upRequest(credentials, { url: `${API}/account` }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const [plans, prices, zonesData, templates] = await Promise.all([
      listPlans(credentials, options),
      priceList(credentials, null, options),
      upRequest<{ zones: { zone: UpcloudZone[] } }>(credentials, { url: `${API}/zone` }, options),
      listTemplates(credentials, options)
    ]);
    const zones = zonesData.zones.zone.filter((zone) => zone.public === "yes");
    const used = new Set<string>();
    const sizes: BoxSizeOffer[] = [];
    for (const plan of plans.filter(planFits)) {
      // A zone that has no price for the plan does not sell it.
      const zonePrices = new Map<string, number | null>();
      for (const zone of zones) {
        if (!prices.zones.get(zone.id)?.has(`server_plan_${plan.name}`)) continue;
        zonePrices.set(zone.id, planHourly(plan, prices.zones.get(zone.id), prices.currency));
        used.add(zone.id);
      }
      if (zonePrices.size === 0) continue;
      const ramGb = Math.round((plan.memory_amount / 1024) * 10) / 10;
      const family = isCloudNative(plan) ? " Cloud Native" : "";
      sizes.push(
        ...offersByRegionalPrice(
          { label: `${plan.name}${family} — ${plan.core_number} vCPU, ${ramGb} GB`, vcpu: plan.core_number, ramGb, diskGb: diskGb(plan), gpu: null },
          plan.name,
          zonePrices
        )
      );
    }
    const images: BoxImageOffer[] = templates
      .filter(templateFits)
      .map((template) => ({ id: template.uuid, label: template.title }))
      .sort((a, b) => {
        const aDefault = a.label.startsWith(DEFAULT_IMAGE_PREFIX);
        const bDefault = b.label.startsWith(DEFAULT_IMAGE_PREFIX);
        return aDefault !== bDefault ? (aDefault ? -1 : 1) : b.label.localeCompare(a.label);
      });
    return {
      sizes: sortSizes(sizes),
      regions: zones.filter((zone) => used.has(zone.id)).map(zoneOffer),
      images,
      priceSource: "live"
    };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const planName = baseSizeId(request.size);
    // Every read happens before the create, so a failed read never follows a billable create.
    const [plans, templates] = await Promise.all([listPlans(credentials, options), listTemplates(credentials, options)]);
    const plan = plans.find((entry) => entry.name === planName && planFits(entry));
    if (!plan) throw new ProviderInputError(PROVIDER, `no plan ${planName}`);
    const template = request.image
      ? templates.find((entry) => entry.uuid === request.image && templateFits(entry))
      : templates.find((entry) => templateFits(entry) && entry.title.startsWith(DEFAULT_IMAGE_PREFIX));
    if (!template) throw new ProviderInputError(PROVIDER, `no Linux template ${request.image ?? DEFAULT_IMAGE_PREFIX}`);
    const prices = await priceList(credentials, request.region, options).catch((error: unknown) => {
      if (options.signal.aborted) throw error;
      return null;
    });

    const storage: Record<string, unknown> = {
      action: "clone",
      storage: template.uuid,
      title: `${request.name}-disk`,
      size: Math.max(diskGb(plan), template.size ?? 0)
    };
    if (isCloudNative(plan)) storage.tier = CLOUD_NATIVE_TIER;
    const data = await upRequest<{ server: UpcloudServer }>(
      credentials,
      {
        method: "POST",
        url: `${API}/server`,
        attempts: 1,
        body: {
          server: {
            zone: request.region,
            title: request.name,
            hostname: request.name,
            plan: plan.name,
            labels: { label: Object.entries(request.tags).map(([key, value]) => ({ key, value })) },
            metadata: "yes",
            user_data: request.bootstrap.cloudInit,
            login_user: { create_password: "no", ssh_keys: { ssh_key: [request.sshPublicKey] } },
            password_delivery: "none",
            simple_backup: "no",
            storage_devices: { storage_device: [storage] },
            networking: {
              interfaces: {
                interface: [
                  { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
                  { type: "public", ip_addresses: { ip_address: [{ family: "IPv6" }] } }
                ]
              }
            }
          }
        }
      },
      options
    );
    return {
      ref: { serverUuid: data.server.uuid, zone: request.region },
      hourlyUsd: prices ? planHourly(plan, prices.zones.get(request.region), prices.currency) : null
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const uuid = refString(PROVIDER, ref, "serverUuid");
    try {
      const server = await getServer(credentials, uuid, options);
      const state = mapState(server.state);
      return {
        state,
        detail: state === "running" ? null : `UpCloud reports the server ${server.state}`,
        publicIp: publicIp(server),
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The server no longer exists in UpCloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const uuid = refString(PROVIDER, ref, "serverUuid");
    const deadline = Date.now() + upcloudTiming.destroyDeadlineMs;
    for (;;) {
      let server: UpcloudServer;
      try {
        server = await getServer(credentials, uuid, options);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      if (server.state === "stopped" || server.state === "error") {
        // `storages=1` deletes the cloned disk with the server; there is nothing else to clean up.
        await upRequest(
          credentials,
          { method: "DELETE", url: `${API}/server/${encodeURIComponent(uuid)}?storages=1&backups=delete`, okStatuses: [404] },
          options
        );
        return;
      }
      if (server.state === "started") {
        try {
          await upRequest(
            credentials,
            { method: "POST", url: `${API}/server/${encodeURIComponent(uuid)}/stop`, body: { stop_server: { stop_type: "hard" } } },
            options
          );
        } catch (error) {
          if (isNotFound(error)) return;
          // 409: already stopping, or in maintenance; the next poll sees where it went.
          if (!(error instanceof ProviderHttpError && error.status === 409)) throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`${PROVIDER}: the server ${uuid} did not stop in time (state ${server.state})`);
      }
      await abortableDelay(upcloudTiming.pollMs, options.signal);
    }
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const servers: UpcloudServer[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const data = await upRequest<{ servers: { server?: UpcloudServer[] } }>(
        credentials,
        { url: `${API}/server?label=${encodeURIComponent(BOX_TAG_KEY)}&limit=${PAGE_SIZE}&offset=${offset}` },
        options
      );
      const page = data.servers.server ?? [];
      servers.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return servers.map((server) => ({
      ref: { serverUuid: server.uuid, zone: server.zone },
      name: server.title,
      boxId: managedBoxId(boxIdLabel(server), server.title),
      createdAt: isoOrNull(server.created),
      state: mapState(server.state)
    }));
  }
};
