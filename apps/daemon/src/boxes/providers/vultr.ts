/**
 * Vultr (https://www.vultr.com/api/). Linux and Windows boxes.
 *
 * - Auth: an account API key as a bearer token. Vultr checks the caller's IP
 *   against the key's access-control list.
 * - Prices: `/plans` carries live hourly prices; the Windows licence fee is
 *   not in the API and comes from price-tables.ts.
 * - Marker: tags `orquester-box` (the list filter) and `orquester-box=<boxId>`;
 *   the label is the instance name.
 * - Bootstrap: Linux gets cloud-init `user_data`. Windows images run a Vultr
 *   "boot" startup script once at first boot (`C:\image\firstboot.cmd`, as
 *   Administrator); the script created for the box is a cmd/PowerShell
 *   polyglot that runs `powershellScript`, and is deleted with the box.
 */

import type { BoxImageOffer, BoxKind, BoxRegionOffer, BoxSizeOffer } from "@orquester/api";

import type {
  BoxBootstrap,
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
import { providerRequest } from "./http.ts";
import { monthlyToHourly, roundUsd, VULTR_WINDOWS_LICENCE_USD_PER_VCPU_MONTH } from "./price-tables.ts";
import {
  assertKind,
  base64,
  BOX_TAG_KEY,
  isManagedName,
  isNotFound,
  isoOrNull,
  isWindowsKind,
  managedBoxId,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Vultr";
const API = "https://api.vultr.com/v2";
const KINDS: readonly BoxKind[] = ["linux", "windows"];
const PAGE_SIZE = 500;
/** Vultr refuses Windows on plans below 2 GB of RAM. */
const WINDOWS_MIN_RAM_MB = 2048;
const LINUX_MIN_RAM_MB = 1024;
const DEFAULT_LINUX_IMAGE = "Ubuntu 24.04 LTS x64";
const DEFAULT_WINDOWS_IMAGE = "Windows 2022 Standard x64";

interface VultrPlan {
  id: string;
  vcpu_count: number;
  ram: number;
  disk: number;
  disk_count?: number;
  type: string;
  monthly_cost: number;
  hourly_cost?: number;
  gpu_type?: string | null;
  locations: string[];
}

interface VultrRegion {
  id: string;
  city: string;
  country: string;
}

interface VultrOs {
  id: number;
  name: string;
  arch: string;
  family: string;
}

interface VultrInstance {
  id: string;
  label: string;
  status: string;
  power_status: string;
  server_status: string;
  main_ip: string;
  v6_main_ip?: string;
  date_created: string;
  tags?: string[];
  default_password?: string;
}

interface VultrListMeta {
  meta?: { links?: { next?: string } };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "apiKey", "API key")}` };
}

async function listAll<T>(credentials: ProviderCredentials, path: string, key: string, options: ProviderCallOptions): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  do {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${API}${path}${separator}per_page=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { data } = await providerRequest<VultrListMeta & Record<string, unknown>>(PROVIDER, { url, headers: headers(credentials) }, options);
    items.push(...((data[key] as T[] | undefined) ?? []));
    cursor = data.meta?.links?.next ?? "";
  } while (cursor);
  return items;
}

function mapState(instance: Pick<VultrInstance, "status" | "power_status">): ProviderInstanceState {
  if (instance.status === "pending") return "pending";
  if (instance.status === "suspended") return "stopped";
  if (instance.status === "active" || instance.status === "resizing") {
    return instance.power_status === "running" ? "running" : "stopped";
  }
  return "error";
}

function planHourly(plan: VultrPlan, windows: boolean): number {
  const base = plan.hourly_cost ?? monthlyToHourly(plan.monthly_cost);
  const licence = windows ? monthlyToHourly(VULTR_WINDOWS_LICENCE_USD_PER_VCPU_MONTH * plan.vcpu_count) : 0;
  return roundUsd(base + licence);
}

/** Plans this kind can use: no GPU plans, no IPv6-only plans, enough RAM. */
function planFits(plan: VultrPlan, windows: boolean): boolean {
  if (plan.gpu_type) return false;
  if (plan.id.endsWith("-v6")) return false;
  if (plan.locations.length === 0) return false;
  return plan.ram >= (windows ? WINDOWS_MIN_RAM_MB : LINUX_MIN_RAM_MB);
}

function imageOffers(os: VultrOs[], windows: boolean): BoxImageOffer[] {
  const wanted = windows
    ? os.filter((entry) => entry.family === "windows" && entry.arch === "x64")
    : os.filter((entry) => (entry.family === "ubuntu" || entry.family === "debian") && entry.arch === "x64" && !/\d\d\.10/.test(entry.name));
  const preferred = windows ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE;
  return wanted
    .map((entry) => ({ id: String(entry.id), label: entry.name }))
    .sort((a, b) => (a.label === preferred ? -1 : b.label === preferred ? 1 : b.label.localeCompare(a.label)));
}

/**
 * The Windows boot script: cmd runs PowerShell, which reads this same file
 * and runs everything after the marker line, so the PowerShell script needs no
 * cmd escaping and has no command-line length limit. The marker is split in
 * the command so only the real marker line matches.
 */
export function vultrWindowsBootScript(bootstrap: BoxBootstrap): string {
  const marker = "#ORQ-POWERSHELL-BEGIN";
  const command =
    "$t=[IO.File]::ReadAllText('%~f0');" +
    "$m=[char]35+'ORQ-POWERSHELL-'+'BEGIN';" +
    "$s=$t.Substring($t.IndexOf($m)+$m.Length);" +
    "$f=Join-Path $env:TEMP 'orq-bootstrap.ps1';" +
    "[IO.File]::WriteAllText($f,$s);" +
    "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f;" +
    "exit $LASTEXITCODE";
  return [
    "@echo off",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${command}"`,
    "exit /b %ERRORLEVEL%",
    marker,
    bootstrap.powershellScript
  ].join("\r\n");
}

async function deleteStartupScript(credentials: ProviderCredentials, scriptId: string, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${API}/startup-scripts/${encodeURIComponent(scriptId)}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

async function resolveOsId(credentials: ProviderCredentials, request: ProviderCreateRequest, options: ProviderCallOptions): Promise<number> {
  if (request.image !== null && /^\d+$/.test(request.image)) return Number(request.image);
  const os = await listAll<VultrOs>(credentials, "/os", "os", options);
  const wanted = request.image ?? (isWindowsKind(request.kind) ? DEFAULT_WINDOWS_IMAGE : DEFAULT_LINUX_IMAGE);
  const match = os.find((entry) => entry.name === wanted);
  if (!match) throw new Error(`${PROVIDER}: no OS image named ${wanted}`);
  return match.id;
}

function tagsFor(request: ProviderCreateRequest): string[] {
  return [BOX_TAG_KEY, ...Object.entries(request.tags).map(([key, value]) => `${key}=${value}`)];
}

function boxIdFromTags(tags: string[] | undefined): string | null {
  const prefix = `${BOX_TAG_KEY}=`;
  const tag = tags?.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

export const vultrAdapter: BoxProviderAdapter = {
  id: "vultr",
  label: "Vultr",
  kinds: KINDS,
  website: "https://www.vultr.com",
  credentialsUrl: "https://my.vultr.com/settings/#settingsapi",
  credentialFields: [
    {
      id: "apiKey",
      label: "API key",
      secret: true,
      help: "Account → API: enable the API and copy the key. Under Access Control, allow this Orquester host's IP address (or any IPv4/IPv6)."
    }
  ],
  accountNote: "The API key's access control list must allow this Orquester host's public IP.",
  maxLifetimeMinutes: null,
  needsWindowsImage: false,

  validate(credentials, options) {
    return validateWith(options, () =>
      providerRequest(PROVIDER, { url: `${API}/instances?per_page=1`, headers: headers(credentials) }, options)
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const windows = isWindowsKind(kind);
    const [plans, regions, os] = await Promise.all([
      listAll<VultrPlan>(credentials, "/plans", "plans", options),
      listAll<VultrRegion>(credentials, "/regions", "regions", options),
      listAll<VultrOs>(credentials, "/os", "os", options)
    ]);
    const used = new Set<string>();
    const sizes: BoxSizeOffer[] = plans
      .filter((plan) => planFits(plan, windows))
      .map((plan) => {
        for (const location of plan.locations) used.add(location);
        return {
          id: plan.id,
          label: `${plan.id} — ${plan.vcpu_count} vCPU, ${Math.round((plan.ram / 1024) * 10) / 10} GB`,
          vcpu: plan.vcpu_count,
          ramGb: Math.round((plan.ram / 1024) * 10) / 10,
          diskGb: plan.disk * (plan.disk_count ?? 1),
          gpu: null,
          hourlyUsd: planHourly(plan, windows),
          regions: [...plan.locations]
        };
      });
    const regionOffers: BoxRegionOffer[] = regions
      .filter((region) => used.has(region.id))
      .map((region) => ({ id: region.id, label: `${region.city} (${region.id})`, country: region.country }));
    return { sizes: sortSizes(sizes), regions: regionOffers, images: imageOffers(os, windows), priceSource: windows ? "table" : "live" };
  },

  async create(credentials, request, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const windows = isWindowsKind(request.kind);
    const auth = headers(credentials);
    const osId = await resolveOsId(credentials, request, options);
    // The price is read before anything billable exists; a failure here just leaves it unknown.
    const plan = await listAll<VultrPlan>(credentials, "/plans", "plans", options)
      .then((plans) => plans.find((entry) => entry.id === request.size) ?? null)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        return null;
      });

    let scriptId: string | null = null;
    if (windows) {
      const { data } = await providerRequest<{ startup_script: { id: string } }>(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/startup-scripts`,
          headers: auth,
          attempts: 1,
          body: { name: request.name, type: "boot", script: base64(vultrWindowsBootScript(request.bootstrap)) }
        },
        options
      );
      scriptId = data.startup_script.id;
    }

    const body: Record<string, unknown> = {
      region: request.region,
      plan: request.size,
      os_id: osId,
      label: request.name,
      hostname: windows ? request.name.slice(0, 15) : request.name,
      tags: tagsFor(request),
      enable_ipv6: true,
      backups: "disabled",
      activation_email: false
    };
    if (windows) body.script_id = scriptId;
    else body.user_data = base64(request.bootstrap.cloudInit);

    let instance: VultrInstance;
    try {
      const { data } = await providerRequest<{ instance: VultrInstance }>(
        PROVIDER,
        { method: "POST", url: `${API}/instances`, headers: auth, attempts: 1, body },
        options
      );
      instance = data.instance;
    } catch (error) {
      // No instance means nothing references the script; leave nothing behind.
      if (scriptId !== null) await deleteStartupScript(credentials, scriptId, { ...options, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }

    const result: ProviderCreateResult = {
      ref: scriptId === null ? { instanceId: instance.id } : { instanceId: instance.id, startupScriptId: scriptId },
      hourlyUsd: plan ? planHourly(plan, windows) : null
    };
    // Linux root passwords are dropped (no one logs in); the Windows Administrator password is kept on the host.
    if (windows && instance.default_password) result.windowsPassword = instance.default_password;
    return result;
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    try {
      const { data } = await providerRequest<{ instance: VultrInstance }>(
        PROVIDER,
        { url: `${API}/instances/${encodeURIComponent(instanceId)}`, headers: headers(credentials) },
        options
      );
      const { instance } = data;
      const state = mapState(instance);
      const ip = instance.main_ip && instance.main_ip !== "0.0.0.0" ? instance.main_ip : (instance.v6_main_ip || null);
      return {
        state,
        detail: state === "running" ? null : `Vultr reports the instance ${instance.status}, power ${instance.power_status}`,
        publicIp: ip,
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Vultr", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    await providerRequest(
      PROVIDER,
      { method: "DELETE", url: `${API}/instances/${encodeURIComponent(instanceId)}`, headers: headers(credentials), okStatuses: [404] },
      options
    );
    const scriptId = ref.startupScriptId;
    if (typeof scriptId === "string" && scriptId.length > 0) await deleteStartupScript(credentials, scriptId, options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    // Every instance, filtered here: tags are the marker, the `orq-` label the fallback.
    const instances = await listAll<VultrInstance>(credentials, "/instances", "instances", options);
    return instances
      .filter((instance) => instance.tags?.includes(BOX_TAG_KEY) || isManagedName(instance.label))
      .map((instance) => ({
        ref: { instanceId: instance.id },
        name: instance.label,
        boxId: managedBoxId(boxIdFromTags(instance.tags), instance.label),
        createdAt: isoOrNull(instance.date_created),
        state: mapState(instance)
      }));
  }
};
