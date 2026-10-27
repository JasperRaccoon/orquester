/**
 * Thunder Compute — GPU instances through `https://api.thundercompute.com:8443`
 * (spec `/openapi.json`; the `tnr` CLI uses the same calls).
 *
 * Thunder cannot host boxes yet, so `kinds` is empty: its create call takes
 * only CPU/GPU/disk, a template and a public key — no startup script, user
 * data, cloud-init, env or name — and templates' startup commands are
 * Thunder-defined. The only way to run anything on a new instance is SSH,
 * which Orquester does not use to reach a box (and without a name or tag the
 * instance would carry no Orquester marker either). The rest of the adapter is
 * complete so the provider can be connected, priced and cleaned up: `offers()`
 * reads the public pricing, specs and stock endpoints, and `status`, `destroy`
 * and `listManaged` work on instances (the reconciler finds any `orq-` named
 * one). Sizes are spec keys (`a100xl_x1`): the smallest vCPU option, the
 * included 100 GB disk per GPU.
 */

import type { BoxSizeOffer } from "@orquester/api";

import type {
  BoxProviderAdapter,
  ProviderCallOptions,
  ProviderCredentials,
  ProviderInstanceRef,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { gpuSizeLabel, hourly, isoTime, num, providerRequestWorded, requireCredential, str, validateWith } from "./gpu-common.ts";
import { boxIdFromInstanceName } from "./http.ts";

const PROVIDER = "Thunder Compute";
const API = "https://api.thundercompute.com:8443";
export const THUNDER_REGION = "us";
export const THUNDER_UNSUPPORTED =
  "Thunder Compute instances cannot run a startup script (no user data, cloud-init or start command), so Orquester cannot start orq-agent in them without SSH";

interface ThunderSpec {
  displayName?: string;
  vramGB?: number;
  gpuCount?: number;
  vcpuOptions?: number[];
  ramPerVCPUGiB?: number;
  ramCapGiB?: number;
  storageGB?: { min?: number; max?: number };
}

interface ThunderInstance {
  uuid?: string;
  name?: string;
  status?: string;
  ip?: string | null;
  createdAt?: string;
  gpuType?: string;
  numGpus?: string | number;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

function instanceState(status: string | undefined): ProviderInstanceState {
  switch ((status ?? "").toUpperCase()) {
    case "RUNNING":
      return "running";
    case "STOPPED":
    case "STOPPING":
      return "stopped";
    case "DELETING":
    case "DELETED":
      return "gone";
    case "ERROR":
    case "FAILED":
      return "error";
    default:
      // PROVISIONING, QUEUED, STARTING, PENDING, UNKNOWN, MODIFYING, SNAPPING, RESTORING, MIGRATING, STAGING.
      return "pending";
  }
}

/** `GET /instances/list` is a map keyed by the instance index (the id the other instance calls take). */
async function listInstances(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<Array<[string, ThunderInstance]>> {
  const { data } = await providerRequestWorded<Record<string, ThunderInstance> | null>(
    PROVIDER,
    { url: `${API}/v1/instances/list`, headers: headers(credentials) },
    options
  );
  return Object.entries(data && typeof data === "object" ? data : {}).filter(([, instance]) => instance && typeof instance === "object");
}

function instanceUuid(ref: ProviderInstanceRef): string {
  const uuid = ref.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) throw new Error(`${PROVIDER}: the box record has no instance uuid`);
  return uuid;
}

export const thunderAdapter: BoxProviderAdapter = {
  id: "thunder",
  label: "Thunder Compute",
  kinds: [],
  website: "https://www.thundercompute.com",
  credentialsUrl: "https://console.thundercompute.com/settings/tokens",
  credentialFields: [{ id: "apiKey", label: "API token", secret: true, help: "Console → Settings → Tokens." }],
  accountNote: `Not available for boxes yet: ${THUNDER_UNSUPPORTED}. Single-GPU instances also use a virtualized GPU without CUDA managed memory (UVM), MPS, GPU profilers or FFmpeg GPU acceleration.`,
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () => listInstances(credentials, options));
  },

  async offers(_credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    // Public endpoints: no credentials needed.
    const [pricing, specs, stock] = await Promise.all([
      providerRequestWorded<{ pricing?: Record<string, number> }>(PROVIDER, { url: `${API}/v2/pricing` }, options),
      providerRequestWorded<{ specs?: Record<string, ThunderSpec> }>(PROVIDER, { url: `${API}/v2/specs` }, options),
      providerRequestWorded<{ specs?: Record<string, string> }>(PROVIDER, { url: `${API}/v2/status` }, options)
    ]);
    const sizes: BoxSizeOffer[] = [];
    for (const [key, spec] of Object.entries(specs.data?.specs ?? {})) {
      if (stock.data?.specs?.[key] !== "available") continue;
      const price = hourly(num(pricing.data?.pricing?.[key]));
      const vcpu = Math.min(...(spec.vcpuOptions ?? []).filter((value) => typeof value === "number"));
      if (price === null || !Number.isFinite(vcpu)) continue;
      const ramGb = Math.min(vcpu * (num(spec.ramPerVCPUGiB) ?? 0), num(spec.ramCapGiB) ?? Infinity);
      const gpu = { model: spec.displayName ?? key, count: num(spec.gpuCount) ?? 1, vramGb: num(spec.vramGB) };
      sizes.push({
        id: key,
        label: gpuSizeLabel({ ...gpu, vramGb: null }, { vcpu, ramGb }),
        vcpu,
        ramGb,
        diskGb: num(spec.storageGB?.min),
        gpu,
        hourlyUsd: price,
        regions: [THUNDER_REGION]
      });
    }
    sizes.sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    return { sizes, regions: [{ id: THUNDER_REGION, label: "United States", country: "US" }], images: [], priceSource: "live" };
  },

  async create() {
    throw new Error(`${PROVIDER}: ${THUNDER_UNSUPPORTED}`);
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const uuid = instanceUuid(ref);
    const found = (await listInstances(credentials, options)).find(([, instance]) => instance.uuid === uuid)?.[1];
    if (!found) return { state: "gone", detail: "No longer exists in Thunder Compute", publicIp: null, hourlyUsd: null };
    return { state: instanceState(found.status), detail: str(found.status), publicIp: str(found.ip), hourlyUsd: null };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const uuid = instanceUuid(ref);
    // The delete call takes the instance's current index; an instance no longer listed is gone.
    const entry = (await listInstances(credentials, options)).find(([, instance]) => instance.uuid === uuid);
    if (!entry || instanceState(entry[1].status) === "gone") return;
    await providerRequestWorded(
      PROVIDER,
      { method: "POST", url: `${API}/v1/instances/${encodeURIComponent(entry[0])}/delete`, headers: headers(credentials), body: {}, okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    return (await listInstances(credentials, options))
      .filter(([, instance]) => typeof instance.name === "string" && instance.name.startsWith("orq-") && typeof instance.uuid === "string")
      .map(([index, instance]) => ({
        ref: { uuid: instance.uuid, index },
        name: instance.name!,
        boxId: boxIdFromInstanceName(instance.name!),
        createdAt: isoTime(instance.createdAt),
        state: instanceState(instance.status)
      }));
  }
};
