/**
 * Hyperstack (NexGen Cloud) — GPU VMs through the Infrahub API
 * (`https://infrahub-api.nexgencloud.com/v1`, spec
 * `https://infrahub-api-doc.nexgencloud.com/api.json`). Full VMs with
 * cloud-init: the bootstrap is `BoxBootstrap.cloudInit` as `user_data`.
 *
 * Sizes are flavor names (`n3-RTX-A6000x1`); regions are Hyperstack regions
 * (`CANADA-1`). A VM needs an environment and a key pair: Orquester keeps one
 * environment per region (`orquester-<region>`, created on first use, free) and
 * imports a key pair per box (`orq-<boxId>`, the request's throwaway public key),
 * deleted with the box. The VM gets a public IP so it has a route out (no inbound
 * rules are added; `orq-agent` dials out) and a label `orquester-box=<boxId>`
 * besides the name `orq-<boxId>`. No volumes: the flavor's root disk goes with
 * the VM. Prices come from `/pricebook` (GPU entry × count + the public IP),
 * falling back to the bundled table.
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
import { gpuSizeLabel, hourly, isNotFound, isoTime, num, pollUntil, requireCredential, str, throwIfAborted, validateWith } from "./gpu-common.ts";
import { tableHourlyUsd } from "./gpu-price-tables.ts";
import { ProviderHttpError, boxIdFromInstanceName, providerRequest } from "./http.ts";

const PROVIDER = "Hyperstack";
const API = "https://infrahub-api.nexgencloud.com/v1";
const NAME_MAX = 50;
const LABEL_PREFIX = "orquester-box=";
/** How long destroy waits for a VM that is still being created before it can be deleted. */
const DESTROY_WAIT_MS = 10 * 60_000;

interface HsFlavor {
  id?: number;
  name: string;
  region_name?: string;
  cpu?: number;
  ram?: number;
  disk?: number;
  ephemeral?: number;
  gpu?: string;
  gpu_count?: number;
  stock_available?: boolean;
}

interface HsPrice {
  name?: string;
  value?: number | string;
}

interface HsInstance {
  id: number;
  name?: string;
  status?: string;
  floating_ip?: string | null;
  labels?: string[];
  created_at?: string;
  flavor?: { name?: string; gpu?: string; gpu_count?: number };
  environment?: { name?: string; region?: string };
  keypair?: { name?: string };
}

interface HsImageGroup {
  region_name?: string;
  type?: string;
  images?: Array<{ name?: string; type?: string; version?: string }>;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { api_key: requireCredential(credentials, "apiKey", PROVIDER) };
}

/** Hyperstack limits names to 50 characters; the label carries the full box id either way. */
function hsName(name: string): string {
  return name.slice(0, NAME_MAX);
}

export function hyperstackEnvironmentName(region: string): string {
  return hsName(`orquester-${region.toLowerCase()}`);
}

/** The newest Ubuntu image with a CUDA driver: highest Ubuntu release, then highest CUDA. */
export function pickHyperstackImage(names: string[]): string | null {
  const score = (name: string): [number, number] => {
    const ubuntu = /Ubuntu Server (\d+)\.(\d+)/i.exec(name);
    const cuda = /CUDA (\d+)\.(\d+)/i.exec(name);
    return [ubuntu ? Number(ubuntu[1]) * 100 + Number(ubuntu[2]) : 0, cuda ? Number(cuda[1]) * 100 + Number(cuda[2]) : 0];
  };
  const candidates = names.filter((name) => /ubuntu/i.test(name) && /cuda/i.test(name));
  candidates.sort((a, b) => {
    const [ua, ca] = score(a);
    const [ub, cb] = score(b);
    return ub - ua || cb - ca || a.localeCompare(b);
  });
  return candidates[0] ?? null;
}

function instanceState(status: string | undefined): ProviderInstanceState {
  switch ((status ?? "").toUpperCase()) {
    case "ACTIVE":
      return "running";
    case "SHUTOFF":
    case "STOPPING":
    case "HIBERNATING":
    case "HIBERNATED":
      return "stopped";
    case "DELETING":
    case "DELETED":
      return "gone";
    case "ERROR":
      return "error";
    default:
      // CREATING, BUILD, STARTING, REBOOTING, RESTORING.
      return "pending";
  }
}

function vmId(ref: ProviderInstanceRef): number {
  const id = num(ref.vmId);
  if (id === null) throw new Error(`${PROVIDER}: the box record has no VM id`);
  return id;
}

function boxIdOf(instance: HsInstance): string | null {
  const label = instance.labels?.find((candidate) => candidate.startsWith(LABEL_PREFIX));
  return label ? label.slice(LABEL_PREFIX.length) : boxIdFromInstanceName(instance.name ?? "");
}

async function pricebook(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<Map<string, number>> {
  const { data } = await providerRequest<HsPrice[]>(PROVIDER, { url: `${API}/pricebook`, headers: headers(credentials) }, options);
  const prices = new Map<string, number>();
  for (const entry of Array.isArray(data) ? data : []) {
    const value = num(entry.value);
    if (typeof entry.name === "string" && value !== null) prices.set(entry.name, value);
  }
  return prices;
}

/** Live price of a flavor (GPU × count + public IP), else the bundled table; `source` says which. */
function flavorPrice(flavor: HsFlavor, prices: Map<string, number>): { usd: number | null; source: "live" | "table" } {
  const gpu = flavor.gpu ?? "";
  const count = num(flavor.gpu_count) ?? 0;
  const perGpu = prices.get(gpu);
  if (perGpu !== undefined && perGpu > 0) {
    return { usd: hourly(perGpu * count + (prices.get("PublicIP") ?? 0)), source: "live" };
  }
  return { usd: tableHourlyUsd("hyperstack", gpu, count), source: "table" };
}

async function getVm(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<HsInstance | null> {
  try {
    const { data } = await providerRequest<{ instance?: HsInstance }>(
      PROVIDER,
      { url: `${API}/core/virtual-machines/${id}`, headers: headers(credentials) },
      options
    );
    return data?.instance ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function ensureEnvironment(credentials: ProviderCredentials, region: string, options: ProviderCallOptions): Promise<string> {
  const name = hyperstackEnvironmentName(region);
  // 409 `already_exist`: made by an earlier box.
  await providerRequest(
    PROVIDER,
    { method: "POST", url: `${API}/core/environments`, headers: headers(credentials), body: { name, region }, okStatuses: [409] },
    options
  );
  return name;
}

async function keypairIdByName(credentials: ProviderCredentials, name: string, options: ProviderCallOptions): Promise<number | null> {
  const { data } = await providerRequest<{ keypairs?: Array<{ id?: number; name?: string }> }>(
    PROVIDER,
    { url: `${API}/core/keypairs?search=${encodeURIComponent(name)}`, headers: headers(credentials) },
    options
  );
  return num(data?.keypairs?.find((keypair) => keypair.name === name)?.id);
}

async function deleteKeypair(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${API}/core/keypair/${id}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

export const hyperstackAdapter: BoxProviderAdapter = {
  id: "hyperstack",
  label: "Hyperstack",
  kinds: ["linux-gpu"],
  website: "https://www.hyperstack.cloud",
  credentialsUrl: "https://console.hyperstack.cloud/api-keys",
  credentialFields: [{ id: "apiKey", label: "API key", secret: true, help: "Console → API Keys → Generate." }],
  accountNote: null,
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () =>
      providerRequest(PROVIDER, { url: `${API}/core/environments`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const [flavorResponse, regionResponse, prices] = await Promise.all([
      providerRequest<{ data?: Array<{ flavors?: HsFlavor[] }> }>(PROVIDER, { url: `${API}/core/flavors`, headers: headers(credentials) }, options),
      providerRequest<{ regions?: Array<{ name: string; country?: string | null }> }>(
        PROVIDER,
        { url: `${API}/core/regions`, headers: headers(credentials) },
        options
      ),
      pricebook(credentials, options)
    ]);
    const byName = new Map<string, BoxSizeOffer>();
    let fromTable = false;
    for (const group of flavorResponse.data?.data ?? []) {
      for (const flavor of group.flavors ?? []) {
        const count = num(flavor.gpu_count) ?? 0;
        if (!flavor.gpu || count < 1 || flavor.stock_available !== true || !flavor.region_name) continue;
        const existing = byName.get(flavor.name);
        if (existing) {
          existing.regions.push(flavor.region_name);
          continue;
        }
        const price = flavorPrice(flavor, prices);
        if (price.usd !== null && price.source === "table") fromTable = true;
        const gpu = { model: flavor.gpu, count, vramGb: null };
        const vcpu = num(flavor.cpu) ?? 0;
        const ramGb = num(flavor.ram) ?? 0;
        byName.set(flavor.name, {
          id: flavor.name,
          label: gpuSizeLabel(gpu, { vcpu, ramGb }),
          vcpu,
          ramGb,
          diskGb: (num(flavor.disk) ?? 0) + (num(flavor.ephemeral) ?? 0) || null,
          gpu,
          hourlyUsd: price.usd,
          regions: [flavor.region_name]
        });
      }
    }
    const sizes = [...byName.values()].sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    const used = new Set(sizes.flatMap((size) => size.regions));
    const regions: BoxRegionOffer[] = (regionResponse.data?.regions ?? [])
      .filter((region) => used.has(region.name))
      .map((region) => ({ id: region.name, label: region.name, country: region.country ?? null }));
    return { sizes, regions, images: [], priceSource: fromTable ? "table" : "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    const boxId = request.tags["orquester-box"] ?? request.boxId;
    const [flavorResponse, prices, imageResponse] = await Promise.all([
      providerRequest<{ data?: Array<{ flavors?: HsFlavor[] }> }>(
        PROVIDER,
        { url: `${API}/core/flavors?region=${encodeURIComponent(request.region)}`, headers: headers(credentials) },
        options
      ),
      pricebook(credentials, options),
      request.image
        ? Promise.resolve(null)
        : providerRequest<{ images?: HsImageGroup[] }>(
            PROVIDER,
            { url: `${API}/core/images?region=${encodeURIComponent(request.region)}`, headers: headers(credentials) },
            options
          )
    ]);
    const flavor = (flavorResponse.data?.data ?? []).flatMap((group) => group.flavors ?? []).find((candidate) => candidate.name === request.size);
    if (!flavor) throw new Error(`${PROVIDER}: flavor ${request.size} is not offered in ${request.region}`);
    const imageNames = (imageResponse?.data?.images ?? []).flatMap((group) => (group.images ?? []).map((image) => image.name ?? ""));
    const image = request.image ?? pickHyperstackImage(imageNames);
    if (!image) throw new Error(`${PROVIDER}: no Ubuntu CUDA image in ${request.region}`);

    const environment = await ensureEnvironment(credentials, request.region, options);
    throwIfAborted(options.signal);
    const { status: keyStatus, data: keyData } = await providerRequest<{ keypair?: { id?: number; name?: string } }>(
      PROVIDER,
      {
        method: "POST",
        url: `${API}/core/keypairs`,
        headers: headers(credentials),
        body: { name: hsName(request.name), environment_name: environment, public_key: request.sshPublicKey },
        okStatuses: [409],
        attempts: 1
      },
      options
    );
    const keyName = (keyStatus !== 409 && str(keyData?.keypair?.name)) || hsName(request.name);
    // 409: an earlier attempt for this box imported it already (nobody uses its private half); reuse it.
    const keypairId = keyStatus === 409 ? await keypairIdByName(credentials, keyName, options) : num(keyData?.keypair?.id);

    let vm: HsInstance | undefined;
    try {
      // One attempt: a retried create could start a second VM.
      const { data } = await providerRequest<{ instances?: HsInstance[] }>(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/core/virtual-machines`,
          headers: headers(credentials),
          body: {
            name: hsName(request.name),
            environment_name: environment,
            image_name: image,
            flavor_name: request.size,
            key_name: keyName,
            count: 1,
            assign_floating_ip: true,
            create_bootable_volume: false,
            user_data: request.bootstrap.cloudInit,
            labels: [`${LABEL_PREFIX}${boxId}`]
          },
          attempts: 1,
          timeoutMs: 90_000
        },
        options
      );
      vm = data?.instances?.[0];
    } catch (error) {
      // Nothing billable was accepted with a 4xx: drop the key pair again. Other failures may have
      // created the VM; the key pair stays with it for destroy/the reconciler to remove.
      if (keypairId !== null && error instanceof ProviderHttpError && error.status >= 400 && error.status < 500) {
        await deleteKeypair(credentials, keypairId, options).catch(() => undefined);
      }
      throw error;
    }
    if (!vm || num(vm.id) === null) throw new Error(`${PROVIDER}: the create response carried no VM id`);
    return {
      ref: { vmId: vm.id, region: request.region, environment, keypairId, keyName },
      hourlyUsd: flavorPrice(flavor, prices).usd
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const vm = await getVm(credentials, vmId(ref), options);
    if (!vm) return { state: "gone", detail: "No longer exists in Hyperstack", publicIp: null, hourlyUsd: null };
    return { state: instanceState(vm.status), detail: str(vm.status), publicIp: str(vm.floating_ip), hourlyUsd: null };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const id = vmId(ref);
    const remove = (): Promise<unknown> =>
      providerRequest(
        PROVIDER,
        { method: "DELETE", url: `${API}/core/virtual-machines/${id}`, headers: headers(credentials), okStatuses: [404] },
        options
      );
    try {
      await remove();
    } catch (error) {
      // A VM still being created cannot be deleted yet (400): wait until it leaves CREATING/BUILD.
      if (!(error instanceof ProviderHttpError) || error.status !== 400) throw error;
      const settled = await pollUntil(
        async () => {
          const vm = await getVm(credentials, id, options);
          if (!vm) return "gone";
          const status = (vm.status ?? "").toUpperCase();
          return status === "CREATING" || status === "BUILD" ? null : status;
        },
        { signal: options.signal, deadlineMs: DESTROY_WAIT_MS }
      );
      if (settled === null) throw error;
      if (settled !== "gone") await remove();
    }
    let keypairId = num(ref.keypairId);
    const keyName = str(ref.keyName);
    // Refs from listManaged know the key pair only by name.
    if (keypairId === null && keyName?.startsWith("orq-")) keypairId = await keypairIdByName(credentials, keyName, options);
    if (keypairId !== null) await deleteKeypair(credentials, keypairId, options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const managed: ProviderManagedInstance[] = [];
    const pageSize = 100;
    for (let page = 1; ; page++) {
      throwIfAborted(options.signal);
      const { data } = await providerRequest<{ instances?: HsInstance[]; count?: number }>(
        PROVIDER,
        { url: `${API}/core/virtual-machines?page=${page}&pageSize=${pageSize}`, headers: headers(credentials) },
        options
      );
      const instances = data?.instances ?? [];
      for (const vm of instances) {
        const boxId = boxIdOf(vm);
        const name = vm.name ?? "";
        if (!boxId && !name.startsWith("orq-")) continue;
        managed.push({
          ref: { vmId: vm.id, region: vm.environment?.region ?? null, environment: vm.environment?.name ?? null, keyName: vm.keypair?.name ?? null },
          name,
          boxId,
          createdAt: isoTime(vm.created_at),
          state: instanceState(vm.status)
        });
      }
      const total = num(data?.count);
      if (instances.length < pageSize || (total !== null && page * pageSize >= total)) break;
    }
    return managed;
  }
};
