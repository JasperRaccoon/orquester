/**
 * CloudRift — GPU VMs through `https://api.cloudrift.ai/api/v1` (spec
 * `/api-docs/openapi.json`). Every call is a POST with a `{version, data}`
 * envelope; the protocol version is pinned below. Errors come back as plain
 * text — and a 403 for an unknown key quotes the key, so error messages are
 * scrubbed of it before they leave this module.
 *
 * Sizes are instance-type variants (`rtx59-16c-nr.1`), regions are data center
 * names (`us-east-nc-nr-1`) or `any`. VMs boot a CloudRift Ubuntu image with the
 * NVIDIA driver the GPU's kernel modules need (open vs proprietary) and run the
 * bootstrap through `cloudinit_commands` (`detachedStartCommand`: one line that
 * decodes the base64 `posixScript` into a private file and starts it detached;
 * the command is templated into CloudRift's cloud-init `runcmd`, so it must stay
 * one YAML-safe line). The marker is the instance name `orq-<boxId>` plus the tag
 * `orquester-box=<boxId>`. Prices (`cost_per_hour`) are cents.
 */

import type { BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

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
import { detachedStartCommand, gpuSizeLabel, hourly, isoTime, num, requireCredential, str, validateWith } from "./gpu-common.ts";
import { ProviderHttpError, boxIdFromInstanceName, providerRequest } from "./http.ts";
import type { ProviderRequest, ProviderResponse } from "./http.ts";

const PROVIDER = "CloudRift";
const API = "https://api.cloudrift.ai/api/v1";
/** The protocol date this adapter speaks (rent needs ≥ v062, list/terminate ≥ v061). */
export const CLOUDRIFT_PROTOCOL = "2026-10-12";
export const CLOUDRIFT_ANY_REGION = "any";
const TAG_PREFIX = "orquester-box=";
const GIB = 2 ** 30;
const LIVE_STATUSES = ["Initializing", "Active", "Deactivating", "Failed"];

interface CrVariant {
  name: string;
  cpu_count?: number;
  logical_cpu_count?: number;
  gpu_count?: number;
  dram?: number;
  vram?: number;
  disk?: number;
  cost_per_hour?: number;
  available_nodes?: number;
  available_nodes_per_dc?: Record<string, number>;
  ip_availability_per_dc?: Record<string, { public_ips?: boolean }>;
}

interface CrInstanceType {
  name: string;
  brand_short?: string;
  nvidia_kernel_module_support?: "ProprietaryOnly" | "OpenOrProprietary" | "OpenOnly" | "Unknown" | null;
  datacenters?: Array<{ name: string; country_code?: string | null }>;
  variants?: CrVariant[];
}

interface CrRecipe {
  name: string;
  tags?: string[];
  details?: { VirtualMachine?: { image_url?: string } };
}

interface CrInstance {
  id: string;
  instance_name?: string | null;
  tags?: string[];
  status?: string;
  host_address?: string | null;
  created_at?: string;
  resource_info?: { instance_type?: string; cost_per_hour?: number } | null;
  failure?: { user_message?: string | null; cause?: string } | null;
}

function apiKey(credentials: ProviderCredentials): string {
  return requireCredential(credentials, "apiKey", PROVIDER);
}

/** One CloudRift call in its envelope, with the key scrubbed from any error it raises. */
async function call<T>(
  credentials: ProviderCredentials | null,
  path: string,
  data: unknown,
  options: ProviderCallOptions,
  extra: Partial<ProviderRequest> = {}
): Promise<ProviderResponse<{ version?: string; data?: T }>> {
  const key = credentials ? apiKey(credentials) : null;
  try {
    return await providerRequest<{ version?: string; data?: T }>(
      PROVIDER,
      {
        method: "POST",
        url: `${API}${path}`,
        headers: key ? { "X-API-Key": key } : {},
        body: data === undefined ? undefined : { version: CLOUDRIFT_PROTOCOL, data },
        ...extra
      },
      options
    );
  } catch (error) {
    if (key && error instanceof ProviderHttpError && (error.message.includes(key) || JSON.stringify(error.body ?? "").includes(key))) {
      const scrub = (text: string): string => text.split(key).join("…");
      const body = typeof error.body === "string" ? scrub(error.body) : null;
      throw new ProviderHttpError(PROVIDER, error.status, scrub(error.message), body);
    }
    throw error;
  }
}

/** The newest NVIDIA-driver Ubuntu recipe whose kernel modules this GPU type can load. */
export function pickCloudriftImage(recipes: CrRecipe[], support: CrInstanceType["nvidia_kernel_module_support"]): string | null {
  const vm = recipes.filter((recipe) => recipe.tags?.includes("nvidia-driver") && recipe.details?.VirtualMachine?.image_url);
  const proprietary = (recipe: CrRecipe): boolean => recipe.tags?.includes("nvidia-driver-proprietary") === true;
  const allowed = vm.filter((recipe) => (support === "ProprietaryOnly" ? proprietary(recipe) : support === "OpenOnly" ? !proprietary(recipe) : true));
  const score = (recipe: CrRecipe): number => {
    const ubuntu = /Ubuntu (\d+)\.(\d+)/.exec(recipe.name);
    const cuda = /CUDA (\d+)\.(\d+)/.exec(recipe.name);
    return (ubuntu ? Number(ubuntu[1]) * 100 + Number(ubuntu[2]) : 0) * 10_000 + (cuda ? Number(cuda[1]) * 100 + Number(cuda[2]) : 0);
  };
  // Open modules where the GPU accepts either (CloudRift's own default).
  allowed.sort((a, b) => Number(proprietary(a)) - Number(proprietary(b)) || score(b) - score(a));
  return allowed[0]?.details?.VirtualMachine?.image_url ?? null;
}

function instanceState(instance: CrInstance): ProviderInstanceState {
  switch (instance.status) {
    case "Active":
      return "running";
    case "Deactivating":
    case "Inactive":
      return "gone";
    case "Failed":
      return "error";
    default:
      return "pending";
  }
}

function instanceId(ref: ProviderInstanceRef): string {
  const id = ref.instanceId;
  if (typeof id !== "string" || id.length === 0) throw new Error(`${PROVIDER}: the box record has no instance id`);
  return id;
}

function boxIdOf(instance: CrInstance): string | null {
  const tag = instance.tags?.find((candidate) => candidate.startsWith(TAG_PREFIX));
  return tag ? tag.slice(TAG_PREFIX.length) : boxIdFromInstanceName(instance.instance_name ?? "");
}

async function listInstanceTypes(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<CrInstanceType[]> {
  const { data } = await call<{ instance_types?: CrInstanceType[] }>(
    credentials,
    "/instance-types/list",
    { selector: { ByServiceAndLocation: { services: ["vm"], datacenters: null } } },
    options
  );
  return data?.data?.instance_types ?? [];
}

async function findInstance(credentials: ProviderCredentials, id: string, options: ProviderCallOptions): Promise<CrInstance | null> {
  const { data } = await call<{ instances?: CrInstance[] }>(
    credentials,
    "/instances/list",
    { selector: { ById: [id] }, mask: { with_connection_info: true, with_usage_info: false, with_hardware_info: false, with_credentials: false } },
    options
  );
  return data?.data?.instances?.find((instance) => instance.id === id) ?? null;
}

/** Data centers with a free node for this variant. */
function freeDataCenters(variant: CrVariant): string[] {
  return Object.entries(variant.available_nodes_per_dc ?? {})
    .filter(([, free]) => (num(free) ?? 0) > 0)
    .map(([dc]) => dc)
    .sort();
}

export const cloudriftAdapter: BoxProviderAdapter = {
  id: "cloudrift",
  label: "CloudRift",
  kinds: ["linux-gpu"],
  website: "https://www.cloudrift.ai",
  credentialsUrl: "https://console.cloudrift.ai/settings/api-keys",
  credentialFields: [{ id: "apiKey", label: "API key", secret: true, help: "Console → Settings → API keys." }],
  accountNote: null,
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () => call(credentials, "/auth/me", undefined, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const types = await listInstanceTypes(credentials, options);
    const sizes: BoxSizeOffer[] = [];
    const regions = new Map<string, BoxRegionOffer>();
    for (const type of types) {
      for (const variant of type.variants ?? []) {
        const count = num(variant.gpu_count) ?? 0;
        const where = freeDataCenters(variant);
        const price = hourly((num(variant.cost_per_hour) ?? 0) / 100);
        if (count < 1 || where.length === 0 || price === null) continue;
        for (const dc of where) {
          const country = type.datacenters?.find((candidate) => candidate.name === dc)?.country_code ?? null;
          regions.set(dc, { id: dc, label: country ? `${dc} (${country})` : dc, country });
        }
        const vram = num(variant.vram);
        const gpu = { model: type.brand_short ?? type.name, count, vramGb: vram ? Math.round(vram / GIB) : null };
        const vcpu = num(variant.logical_cpu_count) ?? num(variant.cpu_count) ?? 0;
        const ramGb = Math.round((num(variant.dram) ?? 0) / GIB);
        const disk = num(variant.disk);
        sizes.push({
          id: variant.name,
          label: gpuSizeLabel(gpu, { vcpu, ramGb }),
          vcpu,
          ramGb,
          diskGb: disk ? Math.round(disk / GIB) : null,
          gpu,
          hourlyUsd: price,
          regions: [CLOUDRIFT_ANY_REGION, ...where]
        });
      }
    }
    sizes.sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    return {
      sizes,
      regions: [{ id: CLOUDRIFT_ANY_REGION, label: "Any data center", country: null }, ...[...regions.values()].sort((a, b) => a.id.localeCompare(b.id))],
      images: [],
      priceSource: "live"
    };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    const [types, recipesResponse] = await Promise.all([
      listInstanceTypes(credentials, options),
      call<{ groups?: Array<{ recipes?: CrRecipe[] }>; other_recipes?: CrRecipe[] }>(credentials, "/recipes/list", {}, options)
    ]);
    const type = types.find((candidate) => candidate.variants?.some((variant) => variant.name === request.size));
    const variant = type?.variants?.find((candidate) => candidate.name === request.size);
    if (!type || !variant) throw new Error(`${PROVIDER}: unknown instance type ${request.size}`);
    const free = freeDataCenters(variant);
    const datacenters = request.region === CLOUDRIFT_ANY_REGION ? free : free.filter((dc) => dc === request.region);
    if (datacenters.length === 0) throw new Error(`${PROVIDER}: no free ${request.size} node${request.region === CLOUDRIFT_ANY_REGION ? "" : ` in ${request.region}`} right now`);
    const recipes = [...(recipesResponse.data?.data?.groups ?? []).flatMap((group) => group.recipes ?? []), ...(recipesResponse.data?.data?.other_recipes ?? [])];
    const imageUrl = request.image ?? pickCloudriftImage(recipes, type.nvidia_kernel_module_support ?? null);
    if (!imageUrl) throw new Error(`${PROVIDER}: no NVIDIA Ubuntu image fits ${type.name}`);
    // A public IP where every candidate DC has one; outbound works either way.
    const publicIp = datacenters.every((dc) => variant.ip_availability_per_dc?.[dc]?.public_ips === true);
    const boxId = request.tags["orquester-box"] ?? request.boxId;

    // One attempt: rent has no idempotency key, a retry could rent twice.
    const { data } = await call<{ instance_ids?: string[] }>(
      credentials,
      "/instances/rent",
      {
        selector: { ByInstanceTypeAndLocation: { instance_type: request.size, datacenters } },
        config: {
          VirtualMachine: {
            image_url: imageUrl,
            cloudinit_commands: detachedStartCommand(request.bootstrap.posixScript),
            ssh_key: { PublicKeys: [request.sshPublicKey] }
          }
        },
        with_public_ip: publicIp,
        name: request.name,
        tags: [`${TAG_PREFIX}${boxId}`]
      },
      options,
      { attempts: 1, timeoutMs: 90_000 }
    );
    const id = str(data?.data?.instance_ids?.[0]);
    if (!id) throw new Error(`${PROVIDER}: the rent response carried no instance id`);
    return { ref: { instanceId: id, instanceType: request.size }, hourlyUsd: hourly((num(variant.cost_per_hour) ?? 0) / 100) };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instance = await findInstance(credentials, instanceId(ref), options);
    if (!instance) return { state: "gone", detail: "No longer exists in CloudRift", publicIp: null, hourlyUsd: null };
    const state = instanceState(instance);
    return {
      state,
      detail: str(instance.failure?.user_message) ?? str(instance.status),
      publicIp: str(instance.host_address),
      hourlyUsd: null
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const id = instanceId(ref);
    const { data } = await call<{ terminated?: CrInstance[] }>(credentials, "/instances/terminate", { selector: { ById: [id] } }, options);
    if (data?.data?.terminated?.some((instance) => instance.id === id)) return;
    // Not in `terminated`: fine if it is already gone or inactive, a failure otherwise.
    const instance = await findInstance(credentials, id, options);
    if (!instance || instanceState(instance) === "gone") return;
    throw new ProviderHttpError(PROVIDER, 200, `${PROVIDER}: terminate did not stop instance ${id} (${instance.status ?? "unknown"})`, null);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { data } = await call<{ instances?: CrInstance[] }>(
      credentials,
      "/instances/list",
      { selector: { ByStatus: { statuses: LIVE_STATUSES } }, mask: { with_connection_info: false, with_usage_info: false, with_hardware_info: false, with_credentials: false } },
      options
    );
    const managed: ProviderManagedInstance[] = [];
    for (const instance of data?.data?.instances ?? []) {
      const name = instance.instance_name ?? "";
      const boxId = boxIdOf(instance);
      if (!boxId && !name.startsWith("orq-")) continue;
      managed.push({
        ref: { instanceId: instance.id, instanceType: instance.resource_info?.instance_type ?? null },
        name,
        boxId,
        createdAt: isoTime(instance.created_at),
        state: instanceState(instance)
      });
    }
    return managed;
  }
};
