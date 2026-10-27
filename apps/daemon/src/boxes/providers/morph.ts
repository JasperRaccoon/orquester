/**
 * Morph Cloud (https://cloud.morph.so/docs/api-reference, OpenAPI
 * https://cloud.morph.so/api/openapi.json). Linux boxes only.
 *
 * - Auth: an API key as a bearer token.
 * - Prices: none in the API; Morph bills MCUs (price-tables.ts). Morph has no
 *   region choice, so there is one region offer.
 * - Instances start from snapshots. Each size gets one snapshot of the base
 *   image, created once and found again by its `digest`
 *   (`orquester-<image>-<vcpus>c-<memory>m-<disk>d`); boxes share it, so
 *   destroy leaves it (a pristine base image costs ~nothing to keep).
 * - Marker: instance metadata `orquester-box=<boxId>` and `name=orq-<boxId>`.
 *   The list filter matches exact metadata values only, so `listManaged` lists
 *   all instances and keeps the marked ones.
 * - Bootstrap: Morph has no user data. Once the instance is ready, one `exec`
 *   (run over SSH, no stdin) writes `posixScript` to a file from base64 and
 *   starts it detached (`setsid nohup`), installing curl first on images that
 *   have neither curl nor wget. The exec API takes only argv, so the script
 *   text — bootstrap token included — is visible in the box's own process
 *   list for the few milliseconds the writer runs; the token is single-use.
 *   The script deletes its file as soon as it starts (`selfDeletingScript`).
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
import { selfDeletingScript } from "./gpu-common.ts";
import { providerRequest } from "./http.ts";
import { MORPH_MCU_DISK_GB, MORPH_MCU_RAM_GB, MORPH_USD_PER_MCU, roundUsd } from "./price-tables.ts";
import {
  abortableDelay,
  assertKind,
  base64,
  baseSizeId,
  BOX_TAG_KEY,
  isManagedName,
  isNotFound,
  isoOrNull,
  managedBoxId,
  ProviderInputError,
  refString,
  requireCredential,
  sortSizes,
  validateWith
} from "./vm-common.ts";

const PROVIDER = "Morph";
const API = "https://cloud.morph.so/api";
const KINDS: readonly BoxKind[] = ["linux"];
const DEFAULT_IMAGE = "morphvm-minimal";
const REGION: BoxRegionOffer = { id: "default", label: "Morph Cloud", country: null };
/** How long a snapshot or instance may take to become ready. */
const READY_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const EXEC_TIMEOUT_MS = 120_000;

interface MorphSize {
  id: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
}

/** Balanced sizes: each resource uses exactly the MCUs its vCPUs do. */
const SIZES: readonly MorphSize[] = [1, 2, 4, 8, 16].map((vcpus) => ({
  id: `${vcpus}vcpu-${vcpus * MORPH_MCU_RAM_GB}gb`,
  vcpus,
  memoryGb: vcpus * MORPH_MCU_RAM_GB,
  diskGb: vcpus * MORPH_MCU_DISK_GB
}));

interface MorphImage {
  id: string;
  name: string;
  description?: string | null;
}

interface MorphSnapshot {
  id: string;
  status: "pending" | "ready" | "failed" | "deleting" | "deleted";
  digest?: string | null;
}

interface MorphInstance {
  id: string;
  status: string;
  created: number;
  metadata?: Record<string, string>;
  refs?: { snapshot_id?: string; image_id?: string };
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return { Authorization: `Bearer ${requireCredential(PROVIDER, credentials, "apiKey", "API key")}` };
}

function sizeFor(sizeId: string): MorphSize {
  const size = SIZES.find((entry) => entry.id === baseSizeId(sizeId));
  if (!size) throw new ProviderInputError(PROVIDER, `unknown size ${sizeId}`);
  return size;
}

function hourlyUsd(size: MorphSize): number {
  const mcus = Math.max(size.vcpus, Math.ceil(size.memoryGb / MORPH_MCU_RAM_GB), Math.ceil(size.diskGb / MORPH_MCU_DISK_GB));
  return roundUsd(mcus * MORPH_USD_PER_MCU);
}

function mapState(status: string): ProviderInstanceState {
  switch (status) {
    case "ready":
      return "running";
    case "pending":
    case "saving":
      return "pending";
    case "paused":
      return "stopped";
    case "error":
    case "failed":
      return "error";
    default:
      // A state this adapter does not know is taken as transient: only a failure state destroys a box.
      return "pending";
  }
}

/**
 * GET `url` until `done` says the resource is ready (true) or failed (a
 * message), waiting between polls only — the first check is immediate.
 */
async function pollUntil<T>(
  url: string,
  credentials: ProviderCredentials,
  options: ProviderCallOptions,
  what: string,
  done: (value: T) => true | string | false
): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const { data } = await providerRequest<T>(PROVIDER, { url, headers: headers(credentials) }, options);
    const result = done(data);
    if (result === true) return data;
    if (typeof result === "string") throw new Error(`${PROVIDER}: ${result}`);
    if (Date.now() >= deadline) throw new Error(`${PROVIDER}: ${what} was not ready after ${READY_TIMEOUT_MS / 60_000} minutes`);
    await abortableDelay(POLL_INTERVAL_MS, options.signal);
  }
}

/** The snapshot of `image` at `size`: an existing one with the same digest, or a new one. */
async function sizeSnapshot(
  credentials: ProviderCredentials,
  image: string,
  size: MorphSize,
  options: ProviderCallOptions
): Promise<string> {
  const memory = size.memoryGb * 1024;
  const disk = size.diskGb * 1024;
  const digest = `orquester-${image}-${size.vcpus}c-${memory}m-${disk}d`;
  const auth = headers(credentials);
  const { data: existing } = await providerRequest<{ data: MorphSnapshot[] }>(
    PROVIDER,
    { url: `${API}/snapshot?digest=${encodeURIComponent(digest)}`, headers: auth },
    options
  );
  let snapshot = existing.data.find((entry) => entry.digest === digest && (entry.status === "ready" || entry.status === "pending"));
  if (!snapshot) {
    // Morph returns the existing snapshot for a digest it already has, so this POST is safe to retry.
    const { data } = await providerRequest<MorphSnapshot>(
      PROVIDER,
      {
        method: "POST",
        url: `${API}/snapshot`,
        headers: auth,
        body: { image_id: image, vcpus: size.vcpus, memory, disk_size: disk, digest, metadata: { orquester: "base" } }
      },
      options
    );
    snapshot = data;
  }
  if (snapshot.status === "ready") return snapshot.id;
  const ready = await pollUntil<MorphSnapshot>(
    `${API}/snapshot/${encodeURIComponent(snapshot.id)}`,
    credentials,
    options,
    "the base snapshot",
    (value) => (value.status === "ready" ? true : value.status === "pending" ? false : `the base snapshot is ${value.status}`)
  );
  return ready.id;
}

/** The `sh -c` program the bootstrap exec runs (see the header). */
export function bootstrapCommand(posixScript: string): string[] {
  const program = [
    "set -e",
    "umask 077",
    'f="${HOME:-/root}/.orq-bootstrap.sh"',
    `printf '%s' '${base64(selfDeletingScript(posixScript))}' | base64 -d > "$f"`,
    'chmod 700 "$f"',
    "setsid nohup /bin/sh -c '" +
      "command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || " +
      "{ apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates; }; " +
      'exec /bin/sh "$0"\' "$f" > "${f%.sh}.log" 2>&1 < /dev/null &'
  ].join("\n");
  return ["/bin/sh", "-c", program];
}

async function deleteInstance(credentials: ProviderCredentials, instanceId: string, options: ProviderCallOptions): Promise<void> {
  await providerRequest(
    PROVIDER,
    { method: "DELETE", url: `${API}/instance/${encodeURIComponent(instanceId)}`, headers: headers(credentials), okStatuses: [404] },
    options
  );
}

export const morphAdapter: BoxProviderAdapter = {
  id: "morph",
  label: "Morph Cloud",
  kinds: KINDS,
  website: "https://cloud.morph.so",
  credentialsUrl: "https://cloud.morph.so/web/keys",
  credentialFields: [
    {
      id: "apiKey",
      label: "API key",
      secret: true,
      help: "In the Morph Cloud console open API Keys and create a key (the value the SDK reads as MORPH_API_KEY)."
    }
  ],
  accountNote: "Morph bills compute in MCUs ($0.05 each) from the account's credits; a plan's included MCUs make boxes cheaper than shown.",
  maxLifetimeMinutes: null,

  validate(credentials, options) {
    return validateWith(options, () => providerRequest(PROVIDER, { url: `${API}/image`, headers: headers(credentials) }, options));
  },

  async offers(credentials, kind, options): Promise<ProviderOffers> {
    assertKind(PROVIDER, KINDS, kind);
    const { data } = await providerRequest<{ data: MorphImage[] }>(PROVIDER, { url: `${API}/image`, headers: headers(credentials) }, options);
    const images: BoxImageOffer[] = data.data.map((image) => ({ id: image.id, label: image.description || image.name || image.id }));
    images.sort((a, b) => (a.id === DEFAULT_IMAGE ? -1 : b.id === DEFAULT_IMAGE ? 1 : a.id.localeCompare(b.id)));

    const sizes: BoxSizeOffer[] = SIZES.map((size) => ({
      id: size.id,
      label: `${size.vcpus} vCPU, ${size.memoryGb} GB RAM, ${size.diskGb} GB disk`,
      vcpu: size.vcpus,
      ramGb: size.memoryGb,
      diskGb: size.diskGb,
      gpu: null,
      hourlyUsd: hourlyUsd(size),
      regions: []
    }));
    return { sizes: sortSizes(sizes), regions: [REGION], images, priceSource: "table" };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    assertKind(PROVIDER, KINDS, request.kind);
    const size = sizeFor(request.size);
    const auth = headers(credentials);
    const snapshotId = await sizeSnapshot(credentials, request.image ?? DEFAULT_IMAGE, size, options);

    const { data: started } = await providerRequest<MorphInstance>(
      PROVIDER,
      {
        method: "POST",
        url: `${API}/instance`,
        headers: auth,
        attempts: 1,
        body: { snapshot_id: snapshotId, metadata: { ...request.tags, name: request.name } }
      },
      options
    );

    try {
      if (started.status !== "ready") {
        await pollUntil<MorphInstance>(
          `${API}/instance/${encodeURIComponent(started.id)}`,
          credentials,
          options,
          "the instance",
          (value) =>
            value.status === "ready" ? true : value.status === "pending" || value.status === "saving" ? false : `the instance is ${value.status}`
        );
      }
      const { data: exec } = await providerRequest<{ exit_code: number }>(
        PROVIDER,
        {
          method: "POST",
          url: `${API}/instance/${encodeURIComponent(started.id)}/exec`,
          headers: auth,
          attempts: 1,
          timeoutMs: EXEC_TIMEOUT_MS,
          body: { command: bootstrapCommand(request.bootstrap.posixScript) }
        },
        options
      );
      // stderr is not surfaced: a shell error could echo the script, token included.
      if (exec.exit_code !== 0) throw new Error(`${PROVIDER}: starting the bootstrap failed (exit code ${exec.exit_code})`);
    } catch (error) {
      // A box whose bootstrap never started can never connect: do not leave it billing.
      await deleteInstance(credentials, started.id, { ...options, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }

    return { ref: { instanceId: started.id, snapshotId }, hourlyUsd: hourlyUsd(size) };
  },

  async status(credentials, ref: ProviderInstanceRef, options): Promise<ProviderInstanceStatus> {
    const instanceId = refString(PROVIDER, ref, "instanceId");
    try {
      const { data } = await providerRequest<MorphInstance>(
        PROVIDER,
        { url: `${API}/instance/${encodeURIComponent(instanceId)}`, headers: headers(credentials) },
        options
      );
      const state = mapState(data.status);
      return { state, detail: state === "running" ? null : `Morph reports the instance ${data.status}`, publicIp: null, hourlyUsd: null };
    } catch (error) {
      if (isNotFound(error)) return { state: "gone", detail: "The instance no longer exists in Morph Cloud", publicIp: null, hourlyUsd: null };
      throw error;
    }
  },

  async destroy(credentials, ref, options): Promise<void> {
    await deleteInstance(credentials, refString(PROVIDER, ref, "instanceId"), options);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const { data } = await providerRequest<{ data: MorphInstance[] }>(PROVIDER, { url: `${API}/instance`, headers: headers(credentials) }, options);
    const managed: ProviderManagedInstance[] = [];
    for (const instance of data.data) {
      const tag = instance.metadata?.[BOX_TAG_KEY];
      const name = instance.metadata?.name ?? instance.id;
      if (!tag && !isManagedName(name)) continue;
      managed.push({
        ref: { instanceId: instance.id, snapshotId: instance.refs?.snapshot_id ?? null },
        name,
        boxId: managedBoxId(tag, name),
        createdAt: isoOrNull(instance.created),
        state: mapState(instance.status)
      });
    }
    return managed;
  }
};
