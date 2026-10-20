/**
 * vast.ai — a GPU marketplace (`https://console.vast.ai/api/v0`, docs
 * `https://docs.vast.ai/api-reference/`). Instances are Docker containers on
 * hosts' machines: no systemd, no Docker inside.
 *
 * Offers and size ids: `offers()` searches rentable, verified, on-demand,
 * single-GPU offers from hosts with ≥ 98 % reliability, room for the box disk and
 * a CUDA driver new enough for the images below, and returns one size per GPU
 * model at its best price. A size id is the vast.ai `gpu_name` (`RTX 4090`); a
 * region id is a two-letter country code or `any`. `create()` re-runs that same
 * search narrowed to the size (and country) and rents the cheapest offer; when
 * the offer was taken in between (404/410 `no_such_ask`, nothing rented) it tries
 * the next one, up to three. Rents are never retried on any other failure.
 *
 * Bootstrap: `runtype: "ssh"` keeps vast.ai's own init in the container (it keeps
 * the container alive) and runs `onstart`, which vast.ai caps at 4048 characters:
 * `BoxBootstrap.stagedPosixScript`, the compact first stage that writes the
 * secrets, joins the tailnet and fetches the rest of the bootstrap from the
 * daemon (a full `posixScript` with Tailscale does not fit). A bootstrap without
 * a staged script sends `posixScript`; either is refused before renting when it
 * is too long. `env` is `BoxBootstrap.env` minus its secrets, which `onstart`
 * already carries. No ports are mapped; `orq-agent` dials out. The marker is the instance `label`
 * (`orq-<boxId>`). Prices (`dph_total`) include the disk's storage.
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
import { ORQ_AGENT_ENV } from "../bootstrap/bootstrap.ts";
import { gpuSizeLabel, hourly, isoTime, num, providerRequestWorded, requireCredential, str, throwIfAborted, validateWith } from "./gpu-common.ts";
import { ProviderHttpError, boxIdFromInstanceName } from "./http.ts";
import type { ProviderRequest, ProviderResponse } from "./http.ts";

const PROVIDER = "vast.ai";
const API = "https://console.vast.ai/api";
export const VAST_ANY_REGION = "any";
/** Disk of every box (GB): toolchains, a checkout and build output. */
export const VAST_DISK_GB = 64;
/** vast.ai rejects longer `onstart` scripts. */
export const VAST_ONSTART_MAX = 4048;
const MIN_RELIABILITY = 0.98;
const RENT_CANDIDATES = 3;

/** vast.ai's own images (Ubuntu, curl, bash, tar; `-auto` picks the host's architecture). Value: the CUDA driver floor. */
const VAST_IMAGES: ReadonlyArray<BoxImageOffer & { minCuda: number }> = [
  { id: "vastai/base-image:cuda-12.8.1-auto", label: "Ubuntu + CUDA 12.8", minCuda: 12.8 },
  { id: "vastai/base-image:cuda-12.4.1-auto", label: "Ubuntu + CUDA 12.4 (older drivers)", minCuda: 12.4 },
  { id: "vastai/pytorch:cuda-12.8.1-auto", label: "PyTorch + CUDA 12.8", minCuda: 12.8 }
];
export const VAST_DEFAULT_IMAGE = VAST_IMAGES[0]!.id;
const LOWEST_CUDA = Math.min(...VAST_IMAGES.map((image) => image.minCuda));

interface VastOffer {
  id: number;
  gpu_name?: string;
  num_gpus?: number;
  gpu_ram?: number;
  cpu_cores_effective?: number;
  cpu_ram?: number;
  disk_space?: number;
  dph_total?: number;
  geolocation?: string | null;
  reliability?: number;
  cuda_max_good?: number;
}

interface VastInstance {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  intended_status?: string | null;
  cur_state?: string | null;
  status_msg?: string | null;
  public_ipaddr?: string | null;
  dph_total?: number | null;
  start_date?: number | null;
  gpu_name?: string | null;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

/** vast.ai error bodies are `{success, error, msg}`: `error` is a code (`auth_error`, `no_such_ask`), `msg` the sentence. */
function vastRequest<T>(request: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  return providerRequestWorded<T>(PROVIDER, request, options);
}

/** The bootstrap env without its secrets: `onstart` writes them to 0600 files, so they need not sit in every process's environment. */
export function vastEnv(env: Record<string, string>): Record<string, string> {
  const secrets: readonly string[] = [ORQ_AGENT_ENV.bootstrapToken, ORQ_AGENT_ENV.tailscaleAuthKey];
  return Object.fromEntries(Object.entries(env).filter(([name]) => !secrets.includes(name)));
}

/** `"Oregon, US"` → `US`. */
export function vastCountry(geolocation: string | null | undefined): string | null {
  const match = /(?:^|,\s*)([A-Z]{2})\s*$/.exec(geolocation ?? "");
  return match ? match[1]! : null;
}

/** The search body every offer read and every rent uses (vast.ai's filter language; the object is the body). */
export function vastSearchBody(filters: { gpuName?: string; country?: string; minCuda: number; limit: number }): Record<string, unknown> {
  return {
    verified: { eq: true },
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
    reliability: { gte: MIN_RELIABILITY },
    num_gpus: { eq: 1 },
    disk_space: { gte: VAST_DISK_GB },
    cuda_max_good: { gte: filters.minCuda },
    ...(filters.gpuName ? { gpu_name: { eq: filters.gpuName } } : {}),
    ...(filters.country ? { geolocation: { in: [filters.country] } } : {}),
    type: "on-demand",
    allocated_storage: VAST_DISK_GB,
    order: [["dph_total", "asc"]],
    limit: filters.limit
  };
}

async function searchOffers(
  credentials: ProviderCredentials,
  filters: Parameters<typeof vastSearchBody>[0],
  options: ProviderCallOptions
): Promise<VastOffer[]> {
  const { data } = await vastRequest<{ offers?: VastOffer[] }>(
    { method: "POST", url: `${API}/v0/bundles/`, headers: headers(credentials), body: vastSearchBody(filters) },
    options
  );
  return (data?.offers ?? []).filter((offer) => typeof offer.id === "number" && typeof offer.gpu_name === "string");
}

function instanceState(instance: VastInstance): ProviderInstanceState {
  switch (instance.actual_status) {
    case "running":
      return "running";
    case "stopped":
    case "frozen":
      return "stopped";
    case "exited":
      // A container that exited on its own never comes back to running (vast.ai docs); one the owner stopped did stop.
      return instance.intended_status === "stopped" ? "stopped" : "error";
    default:
      // null (still being placed), created, loading, rebooting; `offline`/`unknown` (the host lost
      // touch with vast.ai for a while) are transient too.
      return "pending";
  }
}

function instanceId(ref: ProviderInstanceRef): number {
  const id = num(ref.instanceId);
  if (id === null) throw new Error(`${PROVIDER}: the box record has no instance id`);
  return id;
}

/** vast.ai's no-longer-available offer answers (nothing was rented). */
function offerGone(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.status === 404 || error.status === 410) return true;
  return /no_such_ask/.test(JSON.stringify(error.body ?? ""));
}

async function showInstance(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<VastInstance | null> {
  const { data } = await vastRequest<{ instances?: VastInstance | null }>(
    { url: `${API}/v0/instances/${id}/?owner=me`, headers: headers(credentials), okStatuses: [404] },
    options
  );
  const instance = data?.instances;
  return instance && typeof instance === "object" && !Array.isArray(instance) ? instance : null;
}

export const vastaiAdapter: BoxProviderAdapter = {
  id: "vastai",
  label: "vast.ai",
  kinds: ["linux-gpu"],
  website: "https://vast.ai",
  credentialsUrl: "https://cloud.vast.ai/manage-keys/",
  credentialFields: [
    { id: "apiKey", label: "API key", secret: true, help: "Account → Keys → API Keys. Needs instance read/write." }
  ],
  accountNote: "GPU boxes are Docker containers on third-party hosts (verified hosts with ≥ 98 % reliability only): no systemd and no Docker inside the box.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () =>
      vastRequest({ url: `${API}/v0/users/current/`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const offers = await searchOffers(credentials, { minCuda: LOWEST_CUDA, limit: 1000 }, options);
    // Offers arrive cheapest first, so the first offer per GPU model is its best price.
    const byModel = new Map<string, { best: VastOffer; countries: Set<string> }>();
    const countries = new Set<string>();
    for (const offer of offers) {
      const model = offer.gpu_name!;
      const country = vastCountry(offer.geolocation);
      if (country) countries.add(country);
      const entry = byModel.get(model) ?? { best: offer, countries: new Set<string>() };
      if (country) entry.countries.add(country);
      byModel.set(model, entry);
    }
    const sizes: BoxSizeOffer[] = [];
    for (const [model, { best, countries: where }] of byModel) {
      const price = hourly(num(best.dph_total));
      if (price === null) continue;
      const vramMb = num(best.gpu_ram);
      const gpu = { model, count: 1, vramGb: vramMb ? Math.round(vramMb / 1024) : null };
      const vcpu = Math.floor(num(best.cpu_cores_effective) ?? 0);
      const ramGb = Math.round((num(best.cpu_ram) ?? 0) / 1024);
      sizes.push({
        id: model,
        label: gpuSizeLabel(gpu, { vcpu, ramGb, note: "best offer now" }),
        vcpu,
        ramGb,
        diskGb: VAST_DISK_GB,
        gpu,
        hourlyUsd: price,
        regions: [VAST_ANY_REGION, ...[...where].sort()]
      });
    }
    sizes.sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    const regions: BoxRegionOffer[] = [
      { id: VAST_ANY_REGION, label: "Any country (cheapest)", country: null },
      ...[...countries].sort().map((country) => ({ id: country, label: country, country }))
    ];
    return { sizes, regions, images: VAST_IMAGES.map(({ id, label }) => ({ id, label })), priceSource: "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    const onstart = request.bootstrap.stagedPosixScript ?? request.bootstrap.posixScript;
    if (onstart.length > VAST_ONSTART_MAX) {
      throw new Error(`${PROVIDER}: the bootstrap script is ${onstart.length} characters; vast.ai accepts at most ${VAST_ONSTART_MAX}`);
    }
    const image = request.image ?? VAST_DEFAULT_IMAGE;
    const minCuda = VAST_IMAGES.find((candidate) => candidate.id === image)?.minCuda ?? LOWEST_CUDA;
    const country = request.region && request.region !== VAST_ANY_REGION ? request.region : undefined;
    const found = await searchOffers(credentials, { gpuName: request.size, country, minCuda, limit: RENT_CANDIDATES }, options);
    const candidates = found.filter((offer) => offer.gpu_name === request.size).slice(0, RENT_CANDIDATES);
    if (candidates.length === 0) {
      throw new Error(`${PROVIDER}: no rentable ${request.size} offer${country ? ` in ${country}` : ""} right now`);
    }
    const boxId = request.tags["orquester-box"] ?? request.boxId;
    let lastError: unknown;
    for (const offer of candidates) {
      throwIfAborted(options.signal);
      try {
        // One attempt per offer: a retried rent could rent twice.
        const { data } = await vastRequest<{ success?: boolean; new_contract?: number; msg?: string; error?: string }>(
          {
            method: "PUT",
            url: `${API}/v0/asks/${offer.id}/`,
            headers: headers(credentials),
            body: {
              client_id: "me",
              image,
              disk: VAST_DISK_GB,
              label: request.name,
              runtype: "ssh",
              onstart,
              env: { ...vastEnv(request.bootstrap.env), ORQUESTER_BOX_ID: boxId },
              cancel_unavail: true
            },
            attempts: 1,
            timeoutMs: 60_000
          },
          options
        );
        const contract = num(data?.new_contract);
        if (data?.success === false || contract === null) {
          throw new ProviderHttpError(PROVIDER, 200, `${PROVIDER}: ${data?.msg ?? data?.error ?? "the rent was not accepted"}`, {
            success: data?.success,
            error: data?.error,
            msg: data?.msg
          });
        }
        return {
          ref: { instanceId: contract, offerId: offer.id, gpuName: offer.gpu_name ?? request.size },
          hourlyUsd: hourly(num(offer.dph_total))
        };
      } catch (error) {
        if (!offerGone(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instance = await showInstance(credentials, instanceId(ref), options);
    if (!instance) return { state: "gone", detail: "No longer exists in vast.ai", publicIp: null, hourlyUsd: null };
    const state = instanceState(instance);
    return {
      state,
      detail: str(instance.status_msg)?.split("\n")[0]?.slice(0, 200) ?? str(instance.actual_status),
      publicIp: str(instance.public_ipaddr)?.trim() ?? null,
      hourlyUsd: hourly(num(instance.dph_total))
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const id = instanceId(ref);
    // Destroying deletes the container disk; Orquester attaches no separate volumes.
    const { status, data } = await vastRequest<{ success?: boolean; msg?: string; error?: string } | null>(
      { method: "DELETE", url: `${API}/v0/instances/${id}/`, headers: headers(credentials), body: {}, okStatuses: [404] },
      options
    );
    if (status === 404 || data?.success !== false) return;
    // `success: false` with 200: gone already is fine, anything else is a failed destroy.
    if ((await showInstance(credentials, id, options)) === null) return;
    throw new ProviderHttpError(PROVIDER, status, `${PROVIDER}: ${data.msg ?? data.error ?? "destroy was refused"}`, data);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const managed: ProviderManagedInstance[] = [];
    let token: string | null = null;
    do {
      throwIfAborted(options.signal);
      const url: string = `${API}/v1/instances/?limit=25${token ? `&after_token=${encodeURIComponent(token)}` : ""}`;
      const response = await vastRequest<{ instances?: VastInstance[]; next_token?: string | null }>(
        { url, headers: headers(credentials) },
        options
      );
      for (const instance of response.data?.instances ?? []) {
        const label = str(instance.label);
        if (!label || !label.startsWith("orq-")) continue;
        managed.push({
          ref: { instanceId: instance.id, gpuName: instance.gpu_name ?? null },
          name: label,
          boxId: boxIdFromInstanceName(label),
          createdAt: isoTime(instance.start_date),
          state: instanceState(instance)
        });
      }
      token = str(response.data?.next_token);
    } while (token);
    return managed;
  }
};
