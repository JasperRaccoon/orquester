/**
 * Massed Compute — GPU VMs through `https://vm.massedcompute.com/api/v1` (spec
 * `vm-docs.massedcompute.com/api/v1`; not `api.massedcompute.com`).
 *
 * Sizes are inventory product names (`gpu_1x_l40`), regions are region names
 * (`us-central-3`) or `any`, images are Massed `vm_image_id`s. Launch takes SSH
 * keys by registered name, so each box imports its throwaway public key as
 * `orq-<boxId>` and deletes it on destroy. The bootstrap runs from the launch
 * `command` ("the command you want to run on startup") as one detached line
 * (`detachedStartCommand`). There are no tags: the marker is the instance name
 * `orq-<boxId>`. Prices are the inventory's `price_cents_per_hour`.
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
import { detachedStartCommand, gpuSizeLabel, hourly, isNotFound, isoTime, num, requireCredential, str, validateWith } from "./gpu-common.ts";
import { ProviderHttpError, boxIdFromInstanceName, providerRequest } from "./http.ts";

const PROVIDER = "Massed Compute";
const API = "https://vm.massedcompute.com/api/v1";
export const MASSED_ANY_REGION = "any";

interface MassedProduct {
  instance_type?: {
    name?: string;
    description?: string;
    price_cents_per_hour?: number;
    specs?: { vcpu_count?: number; memory_gib?: number; storage_gb?: number };
  };
  regions_with_capacity_available?: Array<{ name?: string; description?: string }>;
  capacity_available?: number;
}

interface MassedImage {
  vm_image_id?: number;
  vm_image_name?: string;
  vm_image_description?: string;
}

interface MassedInstance {
  uuid: string;
  name?: string;
  ip?: string | null;
  status?: string;
  os_booted?: number | boolean;
  created?: string;
  product?: { name?: string; price_hr?: string | number };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

/** `gpu_2x_h100_sxm5` / "2x H100 SXM5" → model and count. */
export function massedGpu(name: string, description: string | undefined): { model: string; count: number } | null {
  const fromName = /^gpu_(\d+)x_(.+)$/.exec(name);
  if (!fromName) return null;
  const fromDescription = /^(\d+)x\s+(.+)$/.exec(description ?? "");
  return { count: Number(fromName[1]), model: fromDescription ? fromDescription[2]!.trim() : fromName[2]!.replace(/_/g, " ").toUpperCase() };
}

/** The newest Ubuntu image: highest version in the name, else the first image. */
export function pickMassedImage(images: MassedImage[]): number | null {
  const version = (image: MassedImage): number => {
    const match = /Ubuntu\s*(\d+)\.(\d+)/i.exec(`${image.vm_image_name ?? ""} ${image.vm_image_description ?? ""}`);
    return match ? Number(match[1]) * 100 + Number(match[2]) : -1;
  };
  const sorted = images.filter((image) => num(image.vm_image_id) !== null).sort((a, b) => version(b) - version(a));
  return num(sorted[0]?.vm_image_id);
}

/** Massed documents `rented`, `booting`, `terminated`; the dashboard shows Running/Initializing/Stopped. */
function instanceState(instance: MassedInstance): ProviderInstanceState {
  const status = (instance.status ?? "").toLowerCase();
  if (status === "terminated" || status === "deleted") return "gone";
  if (status === "stopped") return "stopped";
  if (status.includes("error") || status.includes("fail")) return "error";
  if ((status === "rented" || status === "running") && (instance.os_booted === 1 || instance.os_booted === true)) return "running";
  return "pending";
}

function instanceUuid(ref: ProviderInstanceRef): string {
  const id = ref.uuid;
  if (typeof id !== "string" || id.length === 0) throw new Error(`${PROVIDER}: the box record has no instance id`);
  return id;
}

async function inventory(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<Record<string, MassedProduct>> {
  const { data } = await providerRequest<{ gpu_inventory?: Record<string, MassedProduct> }>(
    PROVIDER,
    { url: `${API}/gpu-inventory`, headers: headers(credentials) },
    options
  );
  return data?.gpu_inventory ?? {};
}

async function images(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<MassedImage[]> {
  const { data } = await providerRequest<{ images?: MassedImage[] }>(PROVIDER, { url: `${API}/images`, headers: headers(credentials) }, options);
  return data?.images ?? [];
}

async function getInstance(credentials: ProviderCredentials, uuid: string, options: ProviderCallOptions): Promise<MassedInstance | null> {
  try {
    const { data } = await providerRequest<{ runningInstance?: MassedInstance | null }>(
      PROVIDER,
      { url: `${API}/instance/${encodeURIComponent(uuid)}`, headers: headers(credentials) },
      options
    );
    return data?.runningInstance ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function deleteSshKey(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${API}/ssh-keys/${id}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

export const massedAdapter: BoxProviderAdapter = {
  id: "massed",
  label: "Massed Compute",
  kinds: ["linux-gpu"],
  website: "https://massedcompute.com",
  credentialsUrl: "https://vm.massedcompute.com/settings/api",
  credentialFields: [
    { id: "apiKey", label: "API token", secret: true, help: "Settings → API → create a token with Full access (launch and terminate)." }
  ],
  accountNote: "Launching needs a billing method with auto-recharge set up in the Massed Compute dashboard; the recharge amount also caps how many instances can run.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () =>
      providerRequest(PROVIDER, { method: "POST", url: `${API}/account/token/validation`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const [products, imageList] = await Promise.all([inventory(credentials, options), images(credentials, options)]);
    const sizes: BoxSizeOffer[] = [];
    const regions = new Map<string, BoxRegionOffer>();
    for (const [key, product] of Object.entries(products)) {
      const type = product.instance_type ?? {};
      const name = type.name ?? key;
      const gpu = massedGpu(name, type.description);
      const where = (product.regions_with_capacity_available ?? []).filter((region) => typeof region.name === "string");
      const price = hourly((num(type.price_cents_per_hour) ?? 0) / 100);
      if (!gpu || (num(product.capacity_available) ?? 0) < 1 || where.length === 0 || price === null) continue;
      for (const region of where) {
        regions.set(region.name!, { id: region.name!, label: region.description ? `${region.description} (${region.name})` : region.name!, country: null });
      }
      const info = { ...gpu, vramGb: null };
      const vcpu = num(type.specs?.vcpu_count) ?? 0;
      const ramGb = num(type.specs?.memory_gib) ?? 0;
      sizes.push({
        id: name,
        label: gpuSizeLabel(info, { vcpu, ramGb }),
        vcpu,
        ramGb,
        diskGb: num(type.specs?.storage_gb),
        gpu: info,
        hourlyUsd: price,
        regions: [MASSED_ANY_REGION, ...where.map((region) => region.name!)]
      });
    }
    sizes.sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    const imageOffers: BoxImageOffer[] = imageList
      .filter((image) => num(image.vm_image_id) !== null)
      .map((image) => ({ id: String(image.vm_image_id), label: image.vm_image_name ?? `Image ${image.vm_image_id}` }));
    return {
      sizes,
      regions: [{ id: MASSED_ANY_REGION, label: "Any region", country: null }, ...[...regions.values()].sort((a, b) => a.id.localeCompare(b.id))],
      images: imageOffers,
      priceSource: "live"
    };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    const [products, imageList] = await Promise.all([inventory(credentials, options), request.image ? Promise.resolve([]) : images(credentials, options)]);
    const product = Object.entries(products).find(([key, candidate]) => (candidate.instance_type?.name ?? key) === request.size)?.[1];
    if (!product) throw new Error(`${PROVIDER}: unknown product ${request.size}`);
    const imageId = request.image ? num(request.image) : pickMassedImage(imageList);
    if (imageId === null) throw new Error(`${PROVIDER}: no VM image to launch`);

    const { data: keyData } = await providerRequest<{ sshKey?: { id?: number; name?: string } }>(
      PROVIDER,
      { method: "POST", url: `${API}/ssh-keys`, headers: headers(credentials), body: { name: request.name, publicKey: request.sshPublicKey }, attempts: 1 },
      options
    );
    const sshKeyId = num(keyData?.sshKey?.id);
    const keyName = str(keyData?.sshKey?.name) ?? request.name;

    let uuid: string | null = null;
    try {
      // One attempt: launch has no idempotency key.
      const { data } = await providerRequest<{ response?: string; warning?: string }>(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/instance/launch`,
          headers: headers(credentials),
          body: {
            imageId,
            productName: request.size,
            regionName: request.region || MASSED_ANY_REGION,
            instanceName: request.name,
            command: detachedStartCommand(request.bootstrap.posixScript),
            sshKeys: [keyName]
          },
          attempts: 1,
          timeoutMs: 90_000
        },
        options
      );
      uuid = str(data?.response);
    } catch (error) {
      // A 4xx launched nothing: drop the key again. Anything else may have launched; destroy removes it.
      if (sshKeyId !== null && error instanceof ProviderHttpError && error.status >= 400 && error.status < 500) {
        await deleteSshKey(credentials, sshKeyId, options).catch(() => undefined);
      }
      throw error;
    }
    if (!uuid) throw new Error(`${PROVIDER}: the launch response carried no instance id`);
    return {
      ref: { uuid, sshKeyId, product: request.size },
      hourlyUsd: hourly((num(product.instance_type?.price_cents_per_hour) ?? 0) / 100)
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instance = await getInstance(credentials, instanceUuid(ref), options);
    if (!instance) return { state: "gone", detail: "No longer exists in Massed Compute", publicIp: null, hourlyUsd: null };
    return {
      state: instanceState(instance),
      detail: str(instance.status),
      publicIp: str(instance.ip),
      hourlyUsd: hourly(num(instance.product?.price_hr))
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const uuid = instanceUuid(ref);
    try {
      await providerRequest(
        PROVIDER,
        { method: "POST", url: `${API}/instance/terminate`, headers: headers(credentials), body: { instanceUuids: [uuid] }, okStatuses: [404] },
        options
      );
    } catch (error) {
      // Terminating an instance that is already gone is refused; that is the outcome destroy wants.
      if (!(error instanceof ProviderHttpError) || error.status >= 500) throw error;
      const instance = await getInstance(credentials, uuid, options);
      if (instance && instanceState(instance) !== "gone") throw error;
    }
    let sshKeyId = num(ref.sshKeyId);
    const keyName = str(ref.keyName);
    if (sshKeyId === null && keyName?.startsWith("orq-")) {
      // Refs from listManaged know the key only by its name (= the instance name).
      const { data } = await providerRequest<{ sshKeys?: Array<{ id?: number; name?: string }> }>(
        PROVIDER,
        { url: `${API}/ssh-keys`, headers: headers(credentials) },
        options
      );
      sshKeyId = num(data?.sshKeys?.find((key) => key.name === keyName)?.id);
    }
    if (sshKeyId !== null) await deleteSshKey(credentials, sshKeyId, options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { data } = await providerRequest<{ runningInstances?: MassedInstance[] }>(
      PROVIDER,
      { url: `${API}/instance`, headers: headers(credentials) },
      options
    );
    return (data?.runningInstances ?? [])
      .filter((instance) => typeof instance.name === "string" && instance.name.startsWith("orq-"))
      .map((instance) => ({
        ref: { uuid: instance.uuid, product: instance.product?.name ?? null, keyName: instance.name },
        name: instance.name!,
        boxId: boxIdFromInstanceName(instance.name!),
        createdAt: isoTime(instance.created),
        state: instanceState(instance)
      }));
  }
};
