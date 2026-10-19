/**
 * TensorDock — GPU VMs through the v2 API (`https://dashboard.tensordock.com/api/v2`,
 * docs `/api/docs/*`). Full VMs with cloud-init, so the bootstrap is cloud-init.
 *
 * Linux + GPU only. TensorDock's one Windows image (`windows10`) runs no
 * first-boot script: `cloud_init` is Linux cloud-config only, the Windows deploy
 * takes nothing but an administrator password, and there is no snapshot API to
 * build a prepared image (spec §11.1, spike 6). Without an unattended way to
 * start `orq-agent`, Windows + GPU stays with OVHcloud.
 *
 * Sizes: one per GPU model (`v0Name`, e.g. `geforcertx4090-pcie-24gb`), always
 * 1 GPU with {@link TENSORDOCK_VCPU} vCPU, {@link TENSORDOCK_RAM_GB} GB RAM and
 * {@link TENSORDOCK_STORAGE_GB} GB disk (TensorDock's minimum), priced from the
 * live per-location rates. Regions are location ids, or `any` for the cheapest
 * location with that GPU at create time. Instances carry no tags: the marker is
 * the instance name `orq-<boxId>`.
 */

import type { BoxImageOffer, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

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
import { gpuSizeLabel, hourly, isNotFound, num, requireCredential, str, validateWith } from "./gpu-common.ts";
import { boxIdFromInstanceName, providerRequest } from "./http.ts";

const PROVIDER = "TensorDock";
const API = "https://dashboard.tensordock.com/api/v2";
export const TENSORDOCK_ANY_REGION = "any";
export const TENSORDOCK_VCPU = 8;
export const TENSORDOCK_RAM_GB = 32;
export const TENSORDOCK_STORAGE_GB = 100;
/** Where cloud-init writes the bootstrap; root-only. */
const BOOTSTRAP_PATH = "/root/.orq-bootstrap.sh";

const TENSORDOCK_IMAGES: readonly BoxImageOffer[] = [
  { id: "ubuntu2404", label: "Ubuntu 24.04" },
  { id: "ubuntu2204", label: "Ubuntu 22.04" },
  { id: "ubuntu2404_ml_pytorch", label: "Ubuntu 24.04 + PyTorch" }
];
export const TENSORDOCK_DEFAULT_IMAGE = TENSORDOCK_IMAGES[0]!.id;

interface TdLocationGpu {
  v0Name: string;
  displayName?: string;
  max_count?: number;
  price_per_hr?: number;
  resources?: { max_vcpus?: number; max_ram_gb?: number; max_storage_gb?: number };
  pricing?: { per_vcpu_hr?: number; per_gb_ram_hr?: number; per_gb_storage_hr?: number };
}

interface TdLocation {
  id: string;
  city?: string;
  stateprovince?: string;
  country?: string;
  tier?: number;
  gpus?: TdLocationGpu[];
}

interface TdInstance {
  type?: string;
  id: string;
  name?: string;
  status?: string;
  ipAddress?: string | null;
  rateHourly?: number | null;
  attributes?: { name?: string; status?: string };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

/** Whether a location can host the fixed box size with this GPU. */
function fits(gpu: TdLocationGpu): boolean {
  const max = gpu.resources ?? {};
  return (
    (num(gpu.max_count) ?? 0) >= 1 &&
    (num(max.max_vcpus) ?? Infinity) >= TENSORDOCK_VCPU &&
    (num(max.max_ram_gb) ?? Infinity) >= TENSORDOCK_RAM_GB &&
    (num(max.max_storage_gb) ?? Infinity) >= TENSORDOCK_STORAGE_GB
  );
}

/** Hourly USD of the fixed size on this location: GPU + vCPU + RAM + storage rates. */
export function tensordockHourly(gpu: TdLocationGpu): number | null {
  const gpuPrice = num(gpu.price_per_hr);
  if (gpuPrice === null) return null;
  const rates = gpu.pricing ?? {};
  return hourly(
    gpuPrice +
      TENSORDOCK_VCPU * (num(rates.per_vcpu_hr) ?? 0) +
      TENSORDOCK_RAM_GB * (num(rates.per_gb_ram_hr) ?? 0) +
      TENSORDOCK_STORAGE_GB * (num(rates.per_gb_storage_hr) ?? 0)
  );
}

async function listLocations(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<TdLocation[]> {
  const { data } = await providerRequest<{ data?: { locations?: TdLocation[] } }>(
    PROVIDER,
    { url: `${API}/locations`, headers: headers(credentials) },
    options
  );
  return (data?.data?.locations ?? []).filter((location) => typeof location.id === "string");
}

function locationLabel(location: TdLocation): string {
  return [location.city, location.stateprovince, location.country].filter((part) => typeof part === "string" && part).join(", ") || location.id;
}

/** TensorDock's status words vary in case (`running`, `Running`, `StoppedDisassociated`). */
function instanceState(status: string | undefined): ProviderInstanceState {
  const value = (status ?? "").toLowerCase();
  if (value === "running") return "running";
  if (value.startsWith("stopped")) return "stopped";
  if (value === "deleted" || value === "terminated") return "gone";
  if (value.includes("error") || value.includes("fail")) return "error";
  return "pending";
}

function instanceId(ref: ProviderInstanceRef): string {
  const id = ref.instanceId;
  if (typeof id !== "string" || id.length === 0) throw new Error(`${PROVIDER}: the box record has no instance id`);
  return id;
}

/** The two list shapes the docs show: `data.instances[]` and `data.attributes.instances[]`. */
function listedInstances(body: unknown): TdInstance[] {
  const data = (body as { data?: { instances?: unknown; attributes?: { instances?: unknown } } } | null)?.data;
  const list = Array.isArray(data?.instances) ? data.instances : Array.isArray(data?.attributes?.instances) ? data.attributes.instances : [];
  return (list as TdInstance[]).filter((instance) => instance && typeof instance.id === "string");
}

/** cloud-init as TensorDock's object form: write the bootstrap root-only, start it detached. */
export function tensordockCloudInit(posixScript: string): Record<string, unknown> {
  return {
    write_files: [{ path: BOOTSTRAP_PATH, content: posixScript, owner: "root:root", permissions: "0700" }],
    runcmd: [`nohup sh ${BOOTSTRAP_PATH} >/var/log/orq-bootstrap.log 2>&1 &`]
  };
}

export const tensordockAdapter: BoxProviderAdapter = {
  id: "tensordock",
  label: "TensorDock",
  kinds: ["linux-gpu"],
  website: "https://tensordock.com",
  credentialsUrl: "https://dashboard.tensordock.com/developers",
  credentialFields: [{ id: "apiKey", label: "API token", secret: true, help: "Developers → API tokens." }],
  accountNote:
    "Linux + GPU only: TensorDock's Windows 10 image runs no first-boot script, so Orquester cannot start a Windows box unattended (Windows + GPU uses OVHcloud). Deploys need at least $1 of balance.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    // `/locations` answers 200 even without a token; `/instances` checks it.
    return validateWith(PROVIDER, options.signal, () =>
      providerRequest(PROVIDER, { url: `${API}/instances`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const locations = await listLocations(credentials, options);
    const byGpu = new Map<string, { gpu: TdLocationGpu; price: number; regions: string[] }>();
    const regions: BoxRegionOffer[] = [{ id: TENSORDOCK_ANY_REGION, label: "Cheapest location", country: null }];
    for (const location of locations) {
      let used = false;
      for (const gpu of location.gpus ?? []) {
        if (typeof gpu.v0Name !== "string" || !fits(gpu)) continue;
        const price = tensordockHourly(gpu);
        if (price === null) continue;
        used = true;
        const entry = byGpu.get(gpu.v0Name);
        if (!entry) byGpu.set(gpu.v0Name, { gpu, price, regions: [location.id] });
        else {
          entry.regions.push(location.id);
          if (price < entry.price) Object.assign(entry, { gpu, price });
        }
      }
      if (used) regions.push({ id: location.id, label: locationLabel(location), country: location.country ?? null });
    }
    const sizes: BoxSizeOffer[] = [...byGpu.entries()].map(([v0Name, { gpu, price, regions: where }]) => {
      const vram = /(\d+)gb$/i.exec(v0Name);
      const info = { model: gpu.displayName ?? v0Name, count: 1, vramGb: vram ? Number(vram[1]) : null };
      return {
        id: v0Name,
        label: gpuSizeLabel({ ...info, vramGb: null }, { vcpu: TENSORDOCK_VCPU, ramGb: TENSORDOCK_RAM_GB }),
        vcpu: TENSORDOCK_VCPU,
        ramGb: TENSORDOCK_RAM_GB,
        diskGb: TENSORDOCK_STORAGE_GB,
        gpu: info,
        hourlyUsd: price,
        regions: [TENSORDOCK_ANY_REGION, ...where]
      };
    });
    sizes.sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    return { sizes, regions, images: [...TENSORDOCK_IMAGES], priceSource: "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    if (request.kind !== "linux-gpu") throw new Error(`${PROVIDER}: only Linux + GPU boxes are supported`);
    if (!request.sshPublicKey) throw new Error(`${PROVIDER}: Ubuntu instances need an SSH public key`);
    // Price (and, for `any`, place) the box from the live location rates.
    const locations = await listLocations(credentials, options);
    let best: { location: TdLocation; price: number } | null = null;
    for (const location of locations) {
      if (request.region !== TENSORDOCK_ANY_REGION && location.id !== request.region) continue;
      const gpu = location.gpus?.find((candidate) => candidate.v0Name === request.size && fits(candidate));
      const price = gpu ? tensordockHourly(gpu) : null;
      if (price !== null && (!best || price < best.price)) best = { location, price };
    }
    if (!best) throw new Error(`${PROVIDER}: ${request.size} is not available${request.region === TENSORDOCK_ANY_REGION ? "" : " in that location"} right now`);

    const body = {
      data: {
        type: "virtualmachine",
        attributes: {
          name: request.name,
          type: "virtualmachine",
          image: request.image ?? TENSORDOCK_DEFAULT_IMAGE,
          resources: {
            vcpu_count: TENSORDOCK_VCPU,
            ram_gb: TENSORDOCK_RAM_GB,
            storage_gb: TENSORDOCK_STORAGE_GB,
            gpus: { [request.size]: { count: 1 } }
          },
          location_id: best.location.id,
          // TensorDock needs a dedicated IP or at least one forward; orq-agent dials out, so only the
          // key-only SSH port is forwarded (its private key was discarded).
          port_forwards: [{ internal_port: 22, external_port: 0 }],
          ssh_key: request.sshPublicKey,
          cloud_init: tensordockCloudInit(request.bootstrap.posixScript)
        }
      }
    };
    // One attempt: a retried create could rent a second VM.
    const { data } = await providerRequest<{ data?: { id?: string; name?: string; status?: string } }>(
      PROVIDER,
      { method: "POST", url: `${API}/instances`, headers: headers(credentials), body, attempts: 1, timeoutMs: 90_000 },
      options
    );
    const id = str(data?.data?.id);
    if (!id) throw new Error(`${PROVIDER}: the create response carried no instance id`);
    return { ref: { instanceId: id, locationId: best.location.id, gpu: request.size }, hourlyUsd: best.price };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    try {
      const { data } = await providerRequest<TdInstance | { data?: TdInstance }>(
        PROVIDER,
        { url: `${API}/instances/${encodeURIComponent(instanceId(ref))}`, headers: headers(credentials) },
        options
      );
      // The docs show this one without the `data` wrapper; accept both.
      const instance = ((data as { data?: TdInstance })?.data ?? data) as TdInstance;
      const raw = instance?.status ?? instance?.attributes?.status;
      const state = instanceState(raw);
      return {
        state,
        detail: str(raw),
        publicIp: str(instance?.ipAddress),
        hourlyUsd: hourly(num(instance?.rateHourly))
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "No longer exists in TensorDock", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    // Deleting the VM deletes its disk; nothing else is created. 404 = already gone.
    await providerRequest(
      PROVIDER,
      { method: "DELETE", url: `${API}/instances/${encodeURIComponent(instanceId(ref))}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { data } = await providerRequest(PROVIDER, { url: `${API}/instances`, headers: headers(credentials) }, options);
    const managed: ProviderManagedInstance[] = [];
    for (const instance of listedInstances(data)) {
      const name = instance.attributes?.name ?? instance.name;
      if (typeof name !== "string" || !name.startsWith("orq-")) continue;
      managed.push({
        ref: { instanceId: instance.id },
        name,
        boxId: boxIdFromInstanceName(name),
        createdAt: null,
        state: instanceState(instance.attributes?.status ?? instance.status)
      });
    }
    return managed;
  }
};
