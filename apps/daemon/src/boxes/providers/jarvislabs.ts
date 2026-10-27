/**
 * Jarvislabs.ai — GPU instances through the backend the official `jarvislabs`
 * SDK/CLI uses (OpenAPI at `https://backendn.jarvislabs.net/openapi.json`).
 * Each region has its own host: create and destroy go to the instance's region
 * host, account-wide reads (instances, scripts, balance, prices) to the default
 * (Noida) host. Many failures come back as HTTP 200 with `success: false` or
 * without the expected id, so bodies are checked, not only statuses.
 *
 * Instances are containers from Jarvislabs templates (no systemd, no Docker
 * inside); boxes use the `pytorch` template (Ubuntu, curl, bash). The bootstrap
 * is a Jarvislabs startup script: uploaded per box (`orq-<boxId>`), passed by id
 * at create, run as root on launch, deleted with the box; it starts
 * `posixScript` detached. Sizes are Jarvislabs `gpu_type`s (1 GPU), regions
 * their region names; prices come live from `misc/server_meta`, with the bundled
 * table as fallback. The marker is the instance name `orq-<boxId>` (Jarvislabs
 * allows 40 characters; longer names are cut, and their box id is left to the
 * box record).
 */

import { randomBytes } from "node:crypto";

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
import { detachedStartCommand, gpuSizeLabel, hourly, num, requireCredential, str, validateWith } from "./gpu-common.ts";
import { tableHourlyUsd } from "./gpu-price-tables.ts";
import { ProviderHttpError, boxIdFromInstanceName, providerRequest } from "./http.ts";
import type { ProviderRequest, ProviderResponse } from "./http.ts";

const PROVIDER = "Jarvislabs";
export const JARVIS_HOSTS: Readonly<Record<string, string>> = {
  "india-noida-01": "https://backendn.jarvislabs.net/",
  "india-chennai-01": "https://backendc.jarvislabs.net/",
  "europe-01": "https://backendeu.jarvislabs.net/"
};
const DEFAULT_HOST = JARVIS_HOSTS["india-noida-01"]!;
const REGION_LABELS: Record<string, { label: string; country: string | null }> = {
  "india-noida-01": { label: "Noida, India (IN2)", country: "IN" },
  "india-chennai-01": { label: "Chennai, India (IN1)", country: "IN" },
  "europe-01": { label: "Europe (EU1)", country: null }
};
const TEMPLATE = "pytorch";
export const JARVIS_STORAGE_GB = 100;
const NAME_MAX = 40;

interface JlServerMeta {
  gpu_type?: string;
  region?: string;
  workload_type?: "container" | "vm" | null;
  price_per_hour?: number;
  num_free_devices?: number;
  effective_num_free_devices?: number;
  cpus_per_gpu?: number;
  ram_per_gpu?: number;
  vram?: string | number;
}

interface JlInstance {
  machine_id: number;
  name?: string;
  status?: string;
  region?: string;
  gpu_type?: string;
  num_gpus?: number;
  public_ip?: string | null;
  template?: string;
}

interface JlEnvelope {
  success?: boolean | string;
  sucess?: boolean | string;
  message?: string;
  error?: string;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(credentials, "apiKey", PROVIDER)}` };
}

function hostFor(region: string): string {
  const host = JARVIS_HOSTS[region];
  if (!host) throw new Error(`${PROVIDER}: unknown region ${region}`);
  return host;
}

/** Jarvislabs spells success as `success`, `"True"`, or `sucess`. */
function succeeded(body: JlEnvelope | null | undefined): boolean {
  const value = body?.success ?? body?.sucess;
  return value === true || value === "True" || value === "true";
}

function bodyMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return null;
}

function jlName(name: string): string {
  return name.slice(0, NAME_MAX);
}

function instanceState(status: string | undefined): ProviderInstanceState {
  switch ((status ?? "").toLowerCase()) {
    case "running":
      return "running";
    case "paused":
    case "pausing":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "gone";
    case "failed":
      return "error";
    default:
      // Creating, Resuming.
      return "pending";
  }
}

function machineId(ref: ProviderInstanceRef): number {
  const id = num(ref.machineId);
  if (id === null) throw new Error(`${PROVIDER}: the box record has no machine id`);
  return id;
}

async function call<T>(request: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  return providerRequest<T>(PROVIDER, request, options);
}

async function serverMeta(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<JlServerMeta[]> {
  const { data } = await call<{ server_meta?: JlServerMeta[] }>(
    { url: `${DEFAULT_HOST}misc/server_meta?workload_type=container`, headers: headers(credentials) },
    options
  );
  return (data?.server_meta ?? []).filter((row) => typeof row.gpu_type === "string" && typeof row.region === "string" && row.workload_type !== "vm");
}

function freeDevices(row: JlServerMeta): number {
  return num(row.effective_num_free_devices) ?? num(row.num_free_devices) ?? 0;
}

function rowPrice(row: JlServerMeta): { usd: number | null; source: "live" | "table" } {
  const live = hourly(num(row.price_per_hour));
  return live !== null ? { usd: live, source: "live" } : { usd: tableHourlyUsd("jarvislabs", row.gpu_type!, 1), source: "table" };
}

/** A `success: false` reply that says the instance does not exist (`"Instance not found"`). */
function saysNotFound(body: unknown): boolean {
  return /\b(not found|does not exist|no such)\b/i.test(bodyMessage(body) ?? "");
}

/**
 * The instance, or null when Jarvislabs says it does not exist (404, or a 200 `success: false`
 * reply saying so). Any other unsuccessful reply throws: it proves nothing about the instance.
 */
async function fetchInstance(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<JlInstance | null> {
  const { status, data } = await call<JlEnvelope & { instance?: JlInstance }>(
    { url: `${DEFAULT_HOST}users/fetch/${id}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
  if (status === 404) return null;
  if (succeeded(data) && data?.instance) return data.instance;
  if (!succeeded(data) && saysNotFound(data)) return null;
  throw new ProviderHttpError(PROVIDER, status, `${PROVIDER}: ${bodyMessage(data) ?? "the instance could not be read"}`, data);
}

/** `multipart/form-data` with one file field, as `scripts/add` wants (the HTTP helper sends strings as is). */
export function multipartScript(content: string, filename: string): { body: string; contentType: string } {
  const boundary = `----orq${randomBytes(12).toString("hex")}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="script"; filename="${filename}"\r\n` +
    "Content-Type: application/x-sh\r\n\r\n" +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The startup script Jarvislabs runs: start `posixScript` detached so the container start is not held up. */
export function jarvisStartupScript(posixScript: string): string {
  return `#!/bin/bash\n${detachedStartCommand(posixScript)}\n`;
}

async function scriptIdByName(credentials: ProviderCredentials, name: string, options: ProviderCallOptions): Promise<number | null> {
  const { data } = await call<{ script_meta?: Array<{ script_id?: number; script_name?: string }> }>(
    { url: `${DEFAULT_HOST}scripts/`, headers: headers(credentials) },
    options
  );
  const ids = (data?.script_meta ?? []).filter((script) => script.script_name === name).map((script) => num(script.script_id) ?? -1);
  const newest = Math.max(-1, ...ids);
  return newest >= 0 ? newest : null;
}

async function deleteScript(credentials: ProviderCredentials, id: number, options: ProviderCallOptions): Promise<void> {
  await call({ method: "DELETE", url: `${DEFAULT_HOST}scripts/?script_id=${id}`, headers: headers(credentials), okStatuses: [404] }, options);
}

export const jarvislabsAdapter: BoxProviderAdapter = {
  id: "jarvislabs",
  label: "Jarvislabs",
  kinds: ["linux-gpu"],
  website: "https://jarvislabs.ai",
  credentialsUrl: "https://jarvislabs.ai/settings/api-keys",
  credentialFields: [{ id: "apiKey", label: "API key", secret: true, help: "Settings → API keys." }],
  accountNote: "GPU boxes are Jarvislabs template containers (no systemd, no Docker inside). Regions are in India and Europe.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(PROVIDER, options.signal, () => call({ url: `${DEFAULT_HOST}users/balance`, headers: headers(credentials) }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    if (kind !== "linux-gpu") return { sizes: [], regions: [], images: [], priceSource: "live" };
    const rows = await serverMeta(credentials, options);
    const byGpu = new Map<string, BoxSizeOffer>();
    const regions = new Map<string, BoxRegionOffer>();
    let fromTable = false;
    for (const row of rows) {
      if (freeDevices(row) < 1) continue;
      const price = rowPrice(row);
      if (price.usd === null) continue;
      if (price.source === "table") fromTable = true;
      const region = row.region!;
      const known = REGION_LABELS[region];
      regions.set(region, { id: region, label: known?.label ?? region, country: known?.country ?? null });
      const existing = byGpu.get(row.gpu_type!);
      if (existing) {
        if (!existing.regions.includes(region)) existing.regions.push(region);
        if ((existing.hourlyUsd ?? Infinity) > price.usd) existing.hourlyUsd = price.usd;
        continue;
      }
      const vram = num(row.vram);
      const gpu = { model: row.gpu_type!, count: 1, vramGb: vram };
      const vcpu = num(row.cpus_per_gpu) ?? 0;
      const ramGb = num(row.ram_per_gpu) ?? 0;
      byGpu.set(row.gpu_type!, {
        id: row.gpu_type!,
        label: gpuSizeLabel(gpu, { vcpu, ramGb }),
        vcpu,
        ramGb,
        diskGb: JARVIS_STORAGE_GB,
        gpu,
        hourlyUsd: price.usd,
        regions: [region]
      });
    }
    const sizes = [...byGpu.values()].sort((a, b) => (a.hourlyUsd ?? Infinity) - (b.hourlyUsd ?? Infinity));
    return { sizes, regions: [...regions.values()].sort((a, b) => a.id.localeCompare(b.id)), images: [], priceSource: fromTable ? "table" : "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    const host = hostFor(request.region);
    const rows = await serverMeta(credentials, options);
    const row = rows.find((candidate) => candidate.gpu_type === request.size && candidate.region === request.region);
    if (!row) throw new Error(`${PROVIDER}: ${request.size} is not offered in ${request.region}`);
    const name = jlName(request.name);

    // 1. The startup script, uploaded under the box's name (the upload answers without an id).
    const upload = multipartScript(jarvisStartupScript(request.bootstrap.posixScript), "orq-bootstrap.sh");
    const { data: uploaded } = await call<JlEnvelope>(
      {
        method: "POST",
        url: `${DEFAULT_HOST}scripts/add?name=${encodeURIComponent(name)}`,
        headers: { ...headers(credentials), "Content-Type": upload.contentType },
        body: upload.body,
        attempts: 1
      },
      options
    );
    const scriptId = await scriptIdByName(credentials, name, options);
    if (scriptId === null) throw new Error(`${PROVIDER}: the startup script was not stored${bodyMessage(uploaded) ? ` (${bodyMessage(uploaded)})` : ""}`);

    // 2. The instance. One attempt: the API has no idempotency key.
    let created: ProviderResponse<JlEnvelope & { machine_id?: number }>;
    try {
      created = await call<JlEnvelope & { machine_id?: number }>(
        {
          method: "POST",
          url: `${host}templates/${TEMPLATE}/create`,
          headers: headers(credentials),
          body: {
            gpu_type: request.size,
            num_gpus: 1,
            hdd: JARVIS_STORAGE_GB,
            region: request.region,
            name,
            is_spot: false,
            duration: "hour",
            disk_type: "ssd",
            http_ports: "",
            script_id: String(scriptId),
            script_args: "",
            fs_id: null,
            arguments: ""
          },
          attempts: 1,
          timeoutMs: 120_000
        },
        options
      );
    } catch (error) {
      // A 4xx created nothing; anything else may have, and destroy/the reconciler removes the script with it.
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500) {
        await deleteScript(credentials, scriptId, options).catch(() => undefined);
      }
      throw error;
    }
    const id = num(created.data?.machine_id);
    if (id === null) {
      await deleteScript(credentials, scriptId, options).catch(() => undefined);
      throw new ProviderHttpError(PROVIDER, created.status, `${PROVIDER}: ${bodyMessage(created.data) ?? "the instance was not created"}`, created.data);
    }
    return { ref: { machineId: id, region: request.region, scriptId, name }, hourlyUsd: rowPrice(row).usd };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instance = await fetchInstance(credentials, machineId(ref), options);
    if (!instance) return { state: "gone", detail: "No longer exists in Jarvislabs", publicIp: null, hourlyUsd: null };
    return { state: instanceState(instance.status), detail: str(instance.status), publicIp: str(instance.public_ip), hourlyUsd: null };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const id = machineId(ref);
    const region = str(ref.region);
    const host = region ? hostFor(region) : DEFAULT_HOST;
    let failure: unknown = null;
    try {
      const { data } = await call<JlEnvelope>(
        { method: "POST", url: `${host}misc/destroy?machine_id=${id}`, headers: headers(credentials), okStatuses: [404] },
        options
      );
      if (!succeeded(data)) failure = new ProviderHttpError(PROVIDER, 200, `${PROVIDER}: ${bodyMessage(data) ?? "destroy was refused"}`, data);
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      failure = error;
    }
    if (failure) {
      // Destroy is not reliably idempotent: gone or already destroying counts as done.
      const instance = await fetchInstance(credentials, id, options);
      if (instance && instanceState(instance.status) !== "gone") throw failure;
    }
    let scriptId = num(ref.scriptId);
    const name = str(ref.name);
    if (scriptId === null && name?.startsWith("orq-")) scriptId = await scriptIdByName(credentials, name, options);
    if (scriptId !== null) await deleteScript(credentials, scriptId, options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { status, data } = await call<JlEnvelope & { instances?: JlInstance[] }>({ url: `${DEFAULT_HOST}users/fetch`, headers: headers(credentials) }, options);
    // An error reply is not an empty account: the reconciler would take every box for gone.
    if (!succeeded(data) || (data?.instances !== undefined && !Array.isArray(data.instances))) {
      throw new ProviderHttpError(PROVIDER, status, `${PROVIDER}: ${bodyMessage(data) ?? "the instance list could not be read"}`, data);
    }
    return (data?.instances ?? [])
      .filter((instance) => typeof instance.name === "string" && instance.name.startsWith("orq-"))
      .map((instance) => ({
        ref: { machineId: instance.machine_id, region: instance.region ?? null, name: instance.name },
        name: instance.name!,
        // A name at the 40-character limit may be cut; its box id is then unknown here.
        boxId: instance.name!.length < NAME_MAX ? boxIdFromInstanceName(instance.name!) : null,
        createdAt: null,
        state: instanceState(instance.status)
      }));
  }
};
