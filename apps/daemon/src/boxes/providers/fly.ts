/**
 * Fly.io Machines (https://fly.io/docs/machines/api/, OpenAPI
 * https://docs.machines.dev/openapi.json). Linux boxes only.
 *
 * - Auth: an org or personal token. Tokens printed by `fly tokens create`
 *   start with `FlyV1 ` and are sent as they are; anything else is sent as a
 *   bearer token.
 * - Prices: no pricing API; price-tables.ts carries the pricing page's
 *   calculator constants and per-region multipliers. Regions are live
 *   (`/v1/platform/regions`, which answers `Regions` with a capital R although
 *   the OpenAPI document says `regions`).
 * - One Fly app per box, named `request.name` (`orq-<boxId>`): app names are
 *   global across Fly, so a name taken by another account fails the create
 *   with that message. The Machine carries the `orquester-box` metadata key;
 *   apps have no tags, so `listManaged` lists the org's apps by name.
 *   Destroying the app (`force`) destroys its Machine with it.
 * - Bootstrap: Fly Machines run the image under Fly's own init (no systemd).
 *   `posixScript` is written into the Machine as a file (`config.files`, so the
 *   bootstrap token stays out of the Machine's argv) and `init.exec` runs it
 *   in the foreground as the Machine's main process. The default image is
 *   `buildpack-deps:noble-scm` (Docker official: Ubuntu 24.04 with curl, wget,
 *   git and CA certificates), because plain `ubuntu` has no way to download
 *   `orq-agent`. No IP is allocated: `orq-agent` dials out, and Machines reach
 *   the internet without one.
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
import { ProviderHttpError, providerRequest } from "./http.ts";
import {
  FLY_INCLUDED_RAM_GB_PER_VCPU,
  FLY_REGION_PRICE_MULTIPLIERS,
  FLY_USD_PER_RAM_GB_SECOND,
  FLY_USD_PER_VCPU_SECOND,
  roundUsd
} from "./price-tables.ts";
import {
  assertKind,
  base64,
  BOX_TAG_KEY,
  baseSizeId,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  offersByRegionalPrice,
  optionalCredential,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Fly.io";
const API = "https://api.machines.dev/v1";
const KINDS: readonly BoxKind[] = ["linux"];
const DEFAULT_ORG = "personal";
const DEFAULT_IMAGE = "buildpack-deps:noble-scm";
/** Where the bootstrap script lands in the Machine. */
const BOOTSTRAP_PATH = "/orq/bootstrap.sh";
/**
 * Root filesystem size. Fly grows the rootfs past its ~8 GB default with an
 * overlay when `size_gb` is set; a started Machine pays nothing extra for it.
 */
const ROOTFS_GB = 20;
/** Fly app names: lowercase letters, digits and dashes. */
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

type CpuKind = "shared" | "performance";

interface FlySize {
  id: string;
  cpuKind: CpuKind;
  cpus: number;
  memoryMb: number;
}

/**
 * The Fly presets offered, with the memory steps that suit an agent box
 * (shared presets below 1 GB cannot run the agent CLIs). Ids are the preset
 * name plus the RAM.
 */
const SIZES: readonly FlySize[] = (
  [
    ["shared", 1, 1],
    ["shared", 1, 2],
    ["shared", 2, 2],
    ["shared", 2, 4],
    ["shared", 4, 4],
    ["shared", 4, 8],
    ["shared", 8, 8],
    ["shared", 8, 16],
    ["performance", 1, 2],
    ["performance", 1, 4],
    ["performance", 2, 4],
    ["performance", 2, 8],
    ["performance", 4, 8],
    ["performance", 4, 16],
    ["performance", 8, 16],
    ["performance", 8, 32],
    ["performance", 16, 32],
    ["performance", 16, 64]
  ] as const
).map(([cpuKind, cpus, gb]) => ({
  id: `${presetName(cpuKind, cpus)}-${gb}gb`,
  cpuKind,
  cpus,
  memoryMb: gb * 1024
}));

const IMAGES: readonly BoxImageOffer[] = [
  { id: DEFAULT_IMAGE, label: "Ubuntu 24.04 LTS (with git and curl)" },
  { id: "buildpack-deps:noble", label: "Ubuntu 24.04 LTS (with build tools)" },
  { id: "buildpack-deps:jammy-scm", label: "Ubuntu 22.04 LTS (with git and curl)" },
  { id: "buildpack-deps:bookworm-scm", label: "Debian 12 (with git and curl)" }
];

/** ISO country of each region, for the region picker (the API gives a city name only). */
const REGION_COUNTRIES: Readonly<Record<string, string>> = {
  ams: "NL",
  arn: "SE",
  cdg: "FR",
  dfw: "US",
  ewr: "US",
  fra: "DE",
  gru: "BR",
  iad: "US",
  jnb: "ZA",
  lax: "US",
  lhr: "GB",
  nrt: "JP",
  ord: "US",
  sin: "SG",
  sjc: "US",
  syd: "AU",
  yyz: "CA"
};

interface FlyRegion {
  code: string;
  name: string;
  deprecated?: boolean;
}

interface FlyApp {
  id: string;
  name: string;
  status?: string;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at?: string;
  config?: { metadata?: Record<string, string> };
}

function presetName(cpuKind: CpuKind, cpus: number): string {
  return `${cpuKind === "shared" ? "shared-cpu" : "performance"}-${cpus}x`;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  const token = requireCredential(PROVIDER, credentials, "token", "Access token");
  return { Authorization: token.startsWith("FlyV1 ") ? token : `Bearer ${token}` };
}

function orgSlug(credentials: ProviderCredentials): string {
  return optionalCredential(credentials, "orgSlug") ?? DEFAULT_ORG;
}

function appPath(app: string): string {
  return `${API}/apps/${encodeURIComponent(app)}`;
}

function sizeFor(sizeId: string): FlySize {
  const size = SIZES.find((entry) => entry.id === baseSizeId(sizeId));
  if (!size) throw new ProviderInputError(PROVIDER, `unknown size ${sizeId}`);
  return size;
}

/** Hourly USD of a size in a region; null for a region the price table does not know. */
function hourlyUsd(size: FlySize, region: string): number | null {
  const multiplier = FLY_REGION_PRICE_MULTIPLIERS[region];
  if (multiplier === undefined) return null;
  const extraRamGb = Math.max(0, size.memoryMb / 1024 - size.cpus * FLY_INCLUDED_RAM_GB_PER_VCPU[size.cpuKind]);
  const perSecond = size.cpus * FLY_USD_PER_VCPU_SECOND[size.cpuKind] + extraRamGb * FLY_USD_PER_RAM_GB_SECOND;
  return roundUsd(perSecond * 3600 * multiplier);
}

function mapState(state: string): ProviderInstanceState {
  switch (state) {
    case "started":
      return "running";
    case "created":
    case "creating":
    case "starting":
    case "restarting":
    case "updating":
    case "replacing":
      return "pending";
    case "stopping":
    case "stopped":
    case "suspending":
    case "suspended":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "gone";
    case "failed":
      return "error";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

async function appMachines(credentials: ProviderCredentials, app: string, options: ProviderCallOptions): Promise<FlyMachine[]> {
  const { data } = await providerRequest<FlyMachine[]>(
    PROVIDER,
    { url: `${appPath(app)}/machines?summary=true`, headers: headers(credentials) },
    options
  );
  return Array.isArray(data) ? data : [];
}

async function deleteApp(credentials: ProviderCredentials, app: string, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${appPath(app)}?force=true`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

function gone(detail: string): ProviderInstanceStatus {
  return { state: "gone", detail, publicIp: null, hourlyUsd: null };
}

export const flyAdapter: BoxProviderAdapter = {
  id: "fly",
  label: "Fly.io Machines",
  kinds: KINDS,
  website: "https://fly.io",
  credentialsUrl: "https://fly.io/dashboard/personal/tokens",
  credentialFields: [
    {
      id: "token",
      label: "Access token",
      secret: true,
      placeholder: "FlyV1 fm2_…",
      help: "An org token from `fly tokens create org` (or the dashboard's Tokens page). Paste it whole, including the `FlyV1 ` prefix."
    },
    {
      id: "orgSlug",
      label: "Organization slug",
      secret: false,
      optional: true,
      placeholder: DEFAULT_ORG,
      help: "The organization boxes are created in (`fly orgs list`). Leave empty for your personal organization."
    }
  ],
  accountNote: "Fly.io asks for a credit card before an organization can run Machines. Each box is its own Fly app, named orq-<box id>.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () =>
      providerRequest(
        PROVIDER,
        { url: `${API}/apps?org_slug=${encodeURIComponent(orgSlug(credentials))}&limit=1`, headers: headers(credentials) },
        options
      )
    );
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const { data } = await providerRequest<{ Regions?: FlyRegion[]; regions?: FlyRegion[] }>(
      PROVIDER,
      { url: `${API}/platform/regions`, headers: headers(credentials) },
      options
    );
    const live = (data.Regions ?? data.regions ?? []).filter((region) => !region.deprecated);
    const regions: BoxRegionOffer[] = live.map((region) => ({
      id: region.code,
      label: `${region.name} (${region.code})`,
      country: REGION_COUNTRIES[region.code] ?? null
    }));

    const sizes: BoxSizeOffer[] = [];
    for (const size of SIZES) {
      const prices = new Map<string, number | null>();
      for (const region of live) prices.set(region.code, hourlyUsd(size, region.code));
      const kindLabel = size.cpuKind === "shared" ? "shared" : "dedicated";
      sizes.push(
        ...offersByRegionalPrice(
          {
            label: `${presetName(size.cpuKind, size.cpus)} — ${size.cpus} ${kindLabel} vCPU, ${size.memoryMb / 1024} GB`,
            vcpu: size.cpus,
            ramGb: size.memoryMb / 1024,
            diskGb: ROOTFS_GB,
            gpu: null
          },
          size.id,
          prices
        )
      );
    }
    return { sizes: sortSizes(sizes), regions, images: [...IMAGES], priceSource: "table" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const auth = headers(credentials);
    const org = orgSlug(credentials);
    const size = sizeFor(request.size);
    const app = request.name;
    if (!APP_NAME.test(app)) throw new ProviderInputError(PROVIDER, `${app} is not a valid Fly app name`);

    try {
      await providerRequest(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/apps`,
          headers: auth,
          attempts: 1,
          // The OpenAPI document names the field `name`, the prose docs `app_name`: send both.
          body: { name: app, app_name: app, org_slug: org, idempotency_key: request.boxId }
        },
        options
      );
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 422 && (error.body as { status?: unknown } | null)?.status === "name_taken") {
        throw new ProviderHttpError(
          PROVIDER,
          422,
          `${PROVIDER}: the app name ${app} is already taken on Fly.io (app names are global); it belongs to another account or organization`,
          error.body
        );
      }
      throw error;
    }

    let machine: FlyMachine;
    try {
      const response = await providerRequest<FlyMachine>(
        PROVIDER,
        {
          method: "POST",
          url: `${appPath(app)}/machines`,
          headers: auth,
          attempts: 1,
          body: {
            name: request.name,
            region: request.region,
            config: {
              image: request.image ?? DEFAULT_IMAGE,
              guest: { cpu_kind: size.cpuKind, cpus: size.cpus, memory_mb: size.memoryMb },
              init: { exec: ["/bin/sh", BOOTSTRAP_PATH] },
              env: request.bootstrap.env,
              files: [{ guest_path: BOOTSTRAP_PATH, raw_value: base64(request.bootstrap.posixScript), mode: 0o700 }],
              // A crash restarts orq-agent; a clean exit (Orquester told it to stop) does not.
              restart: { policy: "on-failure" },
              // Keep the box's files across such a restart.
              rootfs: { persist: "restart", size_gb: ROOTFS_GB },
              auto_destroy: false,
              metadata: request.tags
            }
          }
        },
        options
      );
      machine = response.data;
    } catch (error) {
      // The app alone bills nothing, but it would hold the name: remove it.
      await deleteApp(credentials, app, { ...options, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }

    return {
      ref: { app, machineId: machine.id, region: machine.region ?? request.region },
      hourlyUsd: hourlyUsd(size, request.region)
    };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const app = refString(PROVIDER, ref, "app");
    try {
      let machine: FlyMachine | undefined;
      if (typeof ref.machineId === "string" && ref.machineId.length > 0) {
        const { data } = await providerRequest<FlyMachine>(
          PROVIDER,
          { url: `${appPath(app)}/machines/${encodeURIComponent(ref.machineId)}`, headers: headers(credentials) },
          options
        );
        machine = data;
      } else {
        machine = (await appMachines(credentials, app, options))[0];
      }
      if (!machine) return gone(`The Fly app ${app} has no Machine`);
      const state = mapState(machine.state);
      return {
        state,
        detail: state === "running" ? null : `Fly.io reports the Machine ${machine.state}`,
        publicIp: null,
        hourlyUsd: null
      };
    } catch (error) {
      if (isNotFound(error)) return gone("The Machine no longer exists on Fly.io");
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    await deleteApp(credentials, refString(PROVIDER, ref, "app"), options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { data } = await providerRequest<{ apps?: FlyApp[] }>(
      PROVIDER,
      { url: `${API}/apps?org_slug=${encodeURIComponent(orgSlug(credentials))}`, headers: headers(credentials) },
      options
    );
    const managed: ProviderManagedInstance[] = [];
    for (const app of data.apps ?? []) {
      if (!isManagedName(app.name)) continue;
      let machines: FlyMachine[];
      try {
        machines = await appMachines(credentials, app.name, options);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      const machine = machines[0];
      managed.push({
        ref: machine ? { app: app.name, machineId: machine.id, region: machine.region } : { app: app.name },
        name: app.name,
        boxId: managedBoxId(machine?.config?.metadata?.[BOX_TAG_KEY], app.name),
        createdAt: isoOrNull(machine?.created_at),
        // An app without a Machine is a create in progress (or one that failed half-way).
        state: machine ? mapState(machine.state) : "pending"
      });
    }
    return managed;
  }
};
