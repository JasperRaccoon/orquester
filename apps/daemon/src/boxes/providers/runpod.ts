/**
 * RunPod — GPU pods through the REST API v2 (`https://api.runpod.io/v2`, spec:
 * `/v2/openapi.json`; the GraphQL/v1 API retires 2026-11-15 and is not used).
 *
 * A pod is a Docker container (no systemd, no Docker inside), so the bootstrap
 * is the container's ENTRYPOINT (`BoxBootstrap.containerCommand`) with
 * `BoxBootstrap.env`; no ports are exposed — `orq-agent` dials out.
 *
 * Size ids are `<cloud>:<gpuTypeId>` (`community:NVIDIA GeForce RTX 4090`): one
 * GPU of that catalog type on RunPod's community or secure cloud. Region ids are
 * data center ids (`EU-RO-1`) or `any` (the scheduler picks; the only choice on
 * community cloud, whose stock is not reported per data center). Pods carry no
 * labels: the marker is the pod name `orq-<boxId>` plus an `ORQUESTER_BOX_ID`
 * env var.
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
import { gpuSizeLabel, hourly, isNotFound, isoTime, num, requireCredential, str, throwIfAborted, validateWith } from "./gpu-common.ts";
import { boxIdFromInstanceName, providerRequest } from "./http.ts";

const PROVIDER = "RunPod";
const API = "https://api.runpod.io/v2";
export const RUNPOD_ANY_REGION = "any";
/** Container disk (GB) of every pod: room for toolchains and a checkout; billed only while running. */
const CONTAINER_DISK_GB = 80;

/** Official RunPod base images (Ubuntu with curl, bash, tar, git); the CUDA floor keeps the host driver compatible. */
const RUNPOD_IMAGES: ReadonlyArray<BoxImageOffer & { minCudaVersion: string | null }> = [
  { id: "runpod/base:1.4.1-cuda1281-ubuntu2404", label: "Ubuntu 24.04 + CUDA 12.8", minCudaVersion: "12.8" },
  { id: "runpod/base:1.4.1-cuda1300-ubuntu2404", label: "Ubuntu 24.04 + CUDA 13.0", minCudaVersion: "13.0" },
  { id: "runpod/base:1.4.1-ubuntu2404", label: "Ubuntu 24.04 (driver only, no CUDA toolkit)", minCudaVersion: null }
];
export const RUNPOD_DEFAULT_IMAGE = RUNPOD_IMAGES[0]!.id;

type Cloud = "COMMUNITY" | "SECURE";
type Availability = "NONE" | "LOW" | "MEDIUM" | "HIGH";

interface RunpodGpuType {
  id: string;
  name: string;
  manufacturer?: string;
  memory?: number;
  secure?: boolean;
  community?: boolean;
  price?: { secure?: number; community?: number };
  availability?: Availability;
  dataCenters?: Array<{ id: string; name?: string; availability?: Availability }>;
}

interface RunpodDataCenter {
  id: string;
  name?: string;
  region?: string;
}

interface RunpodPod {
  id: string;
  name: string;
  status?: "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";
  env?: Record<string, string>;
  gpu?: { id?: string; count?: number; vcpuCount?: number; memory?: number };
  cloud?: Cloud;
  dataCenterId?: string | null;
  cost?: number;
  runtime?: { ports?: Array<{ ip?: string; public?: number; private?: number }> } | null;
  createdAt?: string;
}

interface RunpodPodList {
  pods?: RunpodPod[];
  pagination?: { nextCursor?: string | null; hasNextPage?: boolean };
}

const REGION_LABELS: Record<string, string> = {
  NORTH_AMERICA: "North America",
  SOUTH_AMERICA: "South America",
  EUROPE: "Europe",
  ASIA: "Asia",
  MIDDLE_EAST: "Middle East",
  AFRICA: "Africa",
  OCEANIA: "Oceania"
};

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

/** `community:<gpu id>` → its parts; throws on anything else. */
export function parseRunpodSize(size: string): { cloud: Cloud; gpuId: string } {
  const match = /^(community|secure):(.+)$/.exec(size);
  if (!match) throw new Error(`${PROVIDER}: unknown size "${size}"`);
  return { cloud: match[1] === "community" ? "COMMUNITY" : "SECURE", gpuId: match[2]! };
}

function podState(status: RunpodPod["status"]): ProviderInstanceState {
  switch (status) {
    case "RUNNING":
      return "running";
    case "EXITED":
      return "stopped";
    case "ERROR":
      return "error";
    case "TERMINATED":
      return "gone";
    default:
      return "pending";
  }
}

function podIp(pod: RunpodPod): string | null {
  return pod.runtime?.ports?.find((port) => typeof port.ip === "string" && port.ip.length > 0)?.ip ?? null;
}

function podId(ref: ProviderInstanceRef): string {
  const id = ref.podId;
  if (typeof id !== "string" || id.length === 0) throw new Error(`${PROVIDER}: the box record has no pod id`);
  return id;
}

/** A DC's two-letter country from its id (`EU-RO-1` → RO, `US-KS-2` → US, `EUR-IS-1` → IS). */
function dataCenterCountry(id: string): string | null {
  const parts = id.split("-");
  if (parts.length < 3) return null;
  return parts[0] === "US" || parts[0] === "CA" ? parts[0] : /^[A-Z]{2}$/.test(parts[1]!) ? parts[1]! : null;
}

async function listGpuTypes(credentials: ProviderCredentials, cloud: Cloud, options: ProviderCallOptions): Promise<RunpodGpuType[]> {
  const url = `${API}/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=${cloud}`;
  const { data } = await providerRequest<{ gpus?: RunpodGpuType[] }>(PROVIDER, { url, headers: headers(credentials) }, options);
  return data?.gpus ?? [];
}

function sizesFor(gpus: RunpodGpuType[], cloud: Cloud): BoxSizeOffer[] {
  const sizes: BoxSizeOffer[] = [];
  for (const gpu of gpus) {
    // The catalog lists every type in both answers; `community`/`secure` says whether the cloud offers it at all,
    // `availability` is the stock for one GPU right now.
    const offered = cloud === "COMMUNITY" ? gpu.community === true : gpu.secure === true;
    if (!offered || !gpu.availability || gpu.availability === "NONE") continue;
    const price = hourly(num(cloud === "COMMUNITY" ? gpu.price?.community : gpu.price?.secure));
    if (price === null) continue;
    const info = { model: gpu.name, count: 1, vramGb: num(gpu.memory) };
    const dataCenters = (gpu.dataCenters ?? []).filter((dc) => dc.availability && dc.availability !== "NONE").map((dc) => dc.id);
    sizes.push({
      id: `${cloud === "COMMUNITY" ? "community" : "secure"}:${gpu.id}`,
      label: gpuSizeLabel(info, { note: `${cloud === "COMMUNITY" ? "Community" : "Secure"} cloud` }),
      // RunPod sizes the pod's vCPU and RAM per GPU at placement; they are known once it exists.
      vcpu: 0,
      ramGb: 0,
      diskGb: CONTAINER_DISK_GB,
      gpu: info,
      hourlyUsd: price,
      regions: [RUNPOD_ANY_REGION, ...dataCenters]
    });
  }
  return sizes;
}

export const runpodAdapter: BoxProviderAdapter = {
  id: "runpod",
  label: "RunPod",
  kinds: ["linux-gpu"],
  website: "https://www.runpod.io",
  credentialsUrl: "https://console.runpod.io/user/settings",
  credentialFields: [
    {
      id: "apiKey",
      label: "API key",
      secret: true,
      placeholder: "rpa_…",
      help: "Settings → API Keys. Read/Write access (or restricted with Pods read/write)."
    }
  ],
  accountNote: "GPU boxes are RunPod pods (Docker containers): no systemd and no Docker inside the box.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () =>
      providerRequest(PROVIDER, { url: `${API}/pods?limit=1`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind: BoxKind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const [community, secure, dcResponse] = await Promise.all([
      listGpuTypes(credentials, "COMMUNITY", options),
      listGpuTypes(credentials, "SECURE", options),
      providerRequest<{ dataCenters?: RunpodDataCenter[] }>(
        PROVIDER,
        { url: `${API}/catalog/datacenters`, headers: headers(credentials) },
        options
      )
    ]);
    const sizes = [...sizesFor(community, "COMMUNITY"), ...sizesFor(secure, "SECURE")].sort(
      (a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity)
    );
    const used = new Set(sizes.flatMap((size) => size.regions));
    const regions: BoxRegionOffer[] = [{ id: RUNPOD_ANY_REGION, label: "Any data center", country: null }];
    for (const dc of dcResponse.data?.dataCenters ?? []) {
      if (!used.has(dc.id)) continue;
      const area = dc.region ? REGION_LABELS[dc.region] : undefined;
      regions.push({ id: dc.id, label: area ? `${dc.id} (${area})` : dc.id, country: dataCenterCountry(dc.id) });
    }
    return { sizes, regions, images: RUNPOD_IMAGES.map(({ id, label }) => ({ id, label })), priceSource: "live" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    const { cloud, gpuId } = parseRunpodSize(request.size);
    const image = request.image ?? RUNPOD_DEFAULT_IMAGE;
    const minCudaVersion = RUNPOD_IMAGES.find((candidate) => candidate.id === image)?.minCudaVersion ?? null;
    const boxId = request.tags["orquester-box"] ?? request.boxId;
    const body = {
      name: request.name,
      image,
      cloud,
      gpu: { id: gpuId, count: 1, ...(minCudaVersion ? { minCudaVersion } : {}) },
      ...(request.region && request.region !== RUNPOD_ANY_REGION ? { dataCenterIds: [request.region] } : {}),
      disk: CONTAINER_DISK_GB,
      // Exec form: the image's own start script (sshd, Jupyter) is replaced by the bootstrap.
      entrypoint: request.bootstrap.containerCommand,
      cmd: [],
      env: { ...request.bootstrap.env, ORQUESTER_BOX_ID: boxId },
      ports: [],
      startSsh: false,
      startJupyter: false
    };
    // One attempt: a retried create could rent a second pod.
    const { data } = await providerRequest<RunpodPod>(
      PROVIDER,
      { method: "POST", url: `${API}/pods`, headers: headers(credentials), body, attempts: 1, timeoutMs: 60_000 },
      options
    );
    if (!data || typeof data.id !== "string") throw new Error(`${PROVIDER}: the create response carried no pod id`);
    return {
      ref: { podId: data.id, cloud, gpuId, dataCenterId: data.dataCenterId ?? null },
      hourlyUsd: hourly(num(data.cost))
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    try {
      const { data } = await providerRequest<RunpodPod>(
        PROVIDER,
        { url: `${API}/pods/${encodeURIComponent(podId(ref))}`, headers: headers(credentials) },
        options
      );
      const state = podState(data.status);
      return {
        state,
        detail: state === "gone" ? "Terminated in RunPod" : state === "error" ? "RunPod reports the pod failed" : (data.status ?? null),
        publicIp: podIp(data),
        hourlyUsd: hourly(num(data.cost))
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "No longer exists in RunPod", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    // DELETE terminates the pod and its container disk; no volumes are attached. 404 = already gone.
    await providerRequest(
      PROVIDER,
      { method: "DELETE", url: `${API}/pods/${encodeURIComponent(podId(ref))}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const managed: ProviderManagedInstance[] = [];
    let cursor: string | null = null;
    do {
      throwIfAborted(options.signal);
      const url: string = `${API}/pods?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await providerRequest<RunpodPodList>(PROVIDER, { url, headers: headers(credentials) }, options);
      const data: RunpodPodList = response.data;
      for (const pod of data?.pods ?? []) {
        if (typeof pod.name !== "string" || !pod.name.startsWith("orq-")) continue;
        managed.push({
          ref: { podId: pod.id, cloud: pod.cloud ?? null, gpuId: pod.gpu?.id ?? null, dataCenterId: pod.dataCenterId ?? null },
          name: pod.name,
          boxId: str(pod.env?.ORQUESTER_BOX_ID) ?? boxIdFromInstanceName(pod.name),
          createdAt: isoTime(pod.createdAt),
          state: podState(pod.status)
        });
      }
      cursor = data?.pagination?.hasNextPage ? (data.pagination.nextCursor ?? null) : null;
    } while (cursor);
    return managed;
  }
};
