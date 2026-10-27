/**
 * Ephemeral AI VMs — wire validation for every `boxRoutes` answer and `boxes`
 * event payload, before any of it reaches shared UI state.
 *
 * The rule throughout: a record this client cannot reason about (no id, a
 * state, kind or provider it does not know) is left out on its own; a bad
 * optional field is repaired to its empty value; a broken envelope (not an
 * object, the list not an array) makes the whole answer `null` so the caller
 * keeps what it holds. No React, no store.
 */

import {
  BOX_SETUP_STEP_IDS,
  BOX_STATES,
  isBoxKind,
  isBoxProviderId,
  isBoxPurpose,
  type BlacksmithSetupResponse,
  type BlacksmithSetupStep,
  type BlacksmithSetupStepId,
  type BlacksmithSetupStepState,
  type BoxArch,
  type BoxConfigChangeFile,
  type BoxConfigChangeSet,
  type BoxConfigChangeState,
  type BoxConfigChangesResponse,
  type BoxConnectionSettings,
  type BoxDestroyedReason,
  type BoxesResponse,
  type BoxesTotals,
  type BoxGpuInfo,
  type BoxImageOffer,
  type BoxKindAvailability,
  type BoxLocalTailscale,
  type BoxKindsResponse,
  type BoxMcpRunInBoxEntry,
  type BoxMcpRunInBoxResponse,
  type BoxOffersResponse,
  type BoxOs,
  type BoxProjectRef,
  type BoxProviderCredentialField,
  type BoxProviderInfo,
  type BoxProviderStatus,
  type BoxProvidersResponse,
  type BoxRegionOffer,
  type BoxSetupStep,
  type BoxSetupStepId,
  type BoxSetupStepState,
  type BoxSizeOffer,
  type BoxState,
  type BoxSummary,
  type BoxWindowsImageState
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

const stringOrNull = (value: unknown): string | null => (nonEmpty(value) ? value : null);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A non-negative finite number, else null. */
const amountOrNull = (value: unknown): number | null => (finite(value) && value >= 0 ? value : null);

const countOr = (value: unknown, fallback: number): number =>
  finite(value) && Number.isInteger(value) && value >= 0 ? value : fallback;

/** Positive whole minutes, else null. */
const minutesOrNull = (value: unknown): number | null =>
  finite(value) && Number.isInteger(value) && value > 0 ? value : null;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Valid entries of a wire list, deduplicated by `key`; anything malformed is left out. */
function listOf<T>(value: unknown, sanitize: (raw: unknown) => T | null, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = sanitize(raw);
    if (item === null) continue;
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

const OSES: readonly BoxOs[] = ["linux", "win32", "darwin"];
const ARCHES: readonly BoxArch[] = ["x64", "arm64"];
const SETUP_STATES: readonly BoxSetupStepState[] = ["pending", "running", "done", "failed", "skipped"];
const DESTROYED_REASONS: readonly BoxDestroyedReason[] = [
  "deleted",
  "agent",
  "time-limit",
  "chat-closed",
  "provider-gone",
  "provider-error",
  "provisioning-failed",
  "orphan"
];

/** A destroyed reason this build knows, else null (a newer daemon's reason reads as plain "destroyed"). */
export function readDestroyedReason(value: unknown): BoxDestroyedReason | null {
  return oneOf(DESTROYED_REASONS, value) ? value : null;
}

function sanitizeSetupStep(value: unknown): BoxSetupStep | null {
  if (!isRecord(value) || !oneOf<BoxSetupStepId>(BOX_SETUP_STEP_IDS, value.id)) return null;
  return {
    id: value.id,
    label: nonEmpty(value.label) ? value.label : value.id,
    state: oneOf(SETUP_STATES, value.state) ? value.state : "pending",
    startedAt: stringOrNull(value.startedAt),
    finishedAt: stringOrNull(value.finishedAt),
    message: stringOrNull(value.message)
  };
}

function sanitizeProjectRef(value: unknown): BoxProjectRef | null {
  if (!isRecord(value) || !nonEmpty(value.path) || !nonEmpty(value.name)) return null;
  return { workspace: stringOr(value.workspace, ""), name: value.name, path: value.path };
}

/**
 * One box from the wire, repaired field-wise — or `null` without an id, or
 * with a purpose, kind, provider or state this client does not know.
 */
export function sanitizeBoxSummary(value: unknown): BoxSummary | null {
  if (!isRecord(value) || !nonEmpty(value.id)) return null;
  const { purpose, kind, provider, state } = value;
  if (!isBoxPurpose(purpose) || !isBoxKind(kind) || !isBoxProviderId(provider) || !oneOf<BoxState>(BOX_STATES, state)) {
    return null;
  }
  const region = stringOr(value.region, "");
  const size = stringOr(value.size, "");
  return {
    id: value.id,
    purpose,
    kind,
    provider,
    providerLabel: nonEmpty(value.providerLabel) ? value.providerLabel : provider,
    region,
    regionLabel: nonEmpty(value.regionLabel) ? value.regionLabel : region,
    size,
    sizeLabel: nonEmpty(value.sizeLabel) ? value.sizeLabel : size,
    image: stringOrNull(value.image),
    os: oneOf(OSES, value.os) ? value.os : null,
    arch: oneOf(ARCHES, value.arch) ? value.arch : null,
    state,
    stateReason: stringOrNull(value.stateReason),
    destroyedReason: readDestroyedReason(value.destroyedReason),
    hourlyUsd: amountOrNull(value.hourlyUsd),
    estimatedCostUsd: amountOrNull(value.estimatedCostUsd) ?? 0,
    createdAt: stringOr(value.createdAt, ""),
    readyAt: stringOrNull(value.readyAt),
    deadlineAt: stringOrNull(value.deadlineAt),
    destroyedAt: stringOrNull(value.destroyedAt),
    connected: value.connected === true,
    lastSeenAt: stringOrNull(value.lastSeenAt),
    project: sanitizeProjectRef(value.project),
    threadId: stringOrNull(value.threadId),
    purposeNote: stringOrNull(value.purposeNote),
    setup: listOf(value.setup, sanitizeSetupStep, (step) => step.id)
  };
}

/** The totals the daemon computed, each recomputed from `boxes` when missing or malformed. */
function sanitizeTotals(value: unknown, boxes: readonly BoxSummary[]): BoxesTotals {
  const raw = isRecord(value) ? value : {};
  const active = boxes.filter((box) => box.state !== "destroyed");
  return {
    activeCount: countOr(raw.activeCount, active.length),
    hourlyUsd: amountOrNull(raw.hourlyUsd) ?? active.reduce((sum, box) => sum + (box.hourlyUsd ?? 0), 0),
    monthEstimatedUsd:
      amountOrNull(raw.monthEstimatedUsd) ?? boxes.reduce((sum, box) => sum + box.estimatedCostUsd, 0)
  };
}

/** `GET boxRoutes.list` / `BOXES_CHANGED_EVENT`; null when the envelope is broken. */
export function sanitizeBoxesResponse(value: unknown): BoxesResponse | null {
  if (!isRecord(value) || !Array.isArray(value.boxes)) return null;
  const boxes = listOf(value.boxes, sanitizeBoxSummary, (box) => box.id);
  return { boxes, totals: sanitizeTotals(value.totals, boxes) };
}

/** `GET boxRoutes.box(id)` and a destroy's answer: the box, or null. */
export function sanitizeBoxResponse(value: unknown): BoxSummary | null {
  return isRecord(value) ? sanitizeBoxSummary(value.box) : null;
}

// ---------------------------------------------------------------------------
// Providers, kinds, offers
// ---------------------------------------------------------------------------

const PROVIDER_STATUSES: readonly BoxProviderStatus[] = ["not-configured", "checking", "connected", "error"];
const WINDOWS_IMAGE_STATES: readonly BoxWindowsImageState[] = ["none", "preparing", "ready", "failed"];

function sanitizeCredentialField(value: unknown): BoxProviderCredentialField | null {
  if (!isRecord(value) || !nonEmpty(value.id)) return null;
  return {
    id: value.id,
    label: nonEmpty(value.label) ? value.label : value.id,
    // Unknown means masked: a secret is never shown by mistake.
    secret: value.secret !== false,
    ...(nonEmpty(value.placeholder) ? { placeholder: value.placeholder } : {}),
    ...(nonEmpty(value.help) ? { help: value.help } : {}),
    ...(value.optional === true ? { optional: true } : {})
  };
}

/** Only `http(s)` links are ever rendered as hrefs. */
const httpUrlOrEmpty = (value: unknown): string => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

/** Same, null instead of empty. */
const httpUrlOrNull = (value: unknown): string | null => httpUrlOrEmpty(value) || null;

export function sanitizeBoxProviderInfo(value: unknown): BoxProviderInfo | null {
  if (!isRecord(value) || !isBoxProviderId(value.id)) return null;
  const kinds = Array.isArray(value.kinds) ? [...new Set(value.kinds.filter(isBoxKind))] : [];
  const image = isRecord(value.windowsImage) ? value.windowsImage : null;
  return {
    id: value.id,
    label: nonEmpty(value.label) ? value.label : value.id,
    kinds,
    website: httpUrlOrEmpty(value.website),
    credentialsUrl: httpUrlOrEmpty(value.credentialsUrl),
    credentialFields: listOf(value.credentialFields, sanitizeCredentialField, (field) => field.id),
    status: oneOf(PROVIDER_STATUSES, value.status) ? value.status : "not-configured",
    error: stringOrNull(value.error),
    keyHint: stringOrNull(value.keyHint),
    accountNote: stringOrNull(value.accountNote),
    maxLifetimeMinutes: minutesOrNull(value.maxLifetimeMinutes),
    ...(image
      ? {
          windowsImage: {
            state: oneOf(WINDOWS_IMAGE_STATES, image.state) ? image.state : "none",
            message: stringOrNull(image.message),
            updatedAt: stringOrNull(image.updatedAt)
          }
        }
      : {})
  };
}

/** `GET boxRoutes.providers` / `BOX_PROVIDERS_CHANGED_EVENT`; null when the envelope is broken. */
export function sanitizeBoxProvidersResponse(value: unknown): BoxProvidersResponse | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null;
  return { providers: listOf(value.providers, sanitizeBoxProviderInfo, (provider) => provider.id) };
}

function sanitizeKindAvailability(value: unknown): BoxKindAvailability | null {
  if (!isRecord(value) || !isBoxKind(value.kind)) return null;
  const providers = Array.isArray(value.providers) ? [...new Set(value.providers.filter(isBoxProviderId))] : [];
  return {
    kind: value.kind,
    providers,
    fromHourlyUsd: amountOrNull(value.fromHourlyUsd),
    maxLifetimeMinutes: minutesOrNull(value.maxLifetimeMinutes),
    unavailableReason: stringOrNull(value.unavailableReason)
  };
}

/** `GET boxRoutes.kinds`; null when the envelope is broken. */
export function sanitizeBoxKindsResponse(value: unknown): BoxKindsResponse | null {
  if (!isRecord(value) || !Array.isArray(value.kinds)) return null;
  return { kinds: listOf(value.kinds, sanitizeKindAvailability, (entry) => entry.kind) };
}

function sanitizeGpu(value: unknown): BoxGpuInfo | null {
  if (!isRecord(value) || !nonEmpty(value.model)) return null;
  return { model: value.model, count: countOr(value.count, 1) || 1, vramGb: amountOrNull(value.vramGb) };
}

function sanitizeSize(value: unknown): BoxSizeOffer | null {
  if (!isRecord(value) || !nonEmpty(value.id)) return null;
  return {
    id: value.id,
    label: nonEmpty(value.label) ? value.label : value.id,
    vcpu: amountOrNull(value.vcpu) ?? 0,
    ramGb: amountOrNull(value.ramGb) ?? 0,
    diskGb: amountOrNull(value.diskGb),
    gpu: sanitizeGpu(value.gpu),
    hourlyUsd: amountOrNull(value.hourlyUsd),
    regions: Array.isArray(value.regions) ? [...new Set(value.regions.filter(nonEmpty))] : []
  };
}

function sanitizeRegion(value: unknown): BoxRegionOffer | null {
  if (!isRecord(value) || !nonEmpty(value.id)) return null;
  return { id: value.id, label: nonEmpty(value.label) ? value.label : value.id, country: stringOrNull(value.country) };
}

function sanitizeImage(value: unknown): BoxImageOffer | null {
  if (!isRecord(value) || !nonEmpty(value.id)) return null;
  return { id: value.id, label: nonEmpty(value.label) ? value.label : value.id };
}

/**
 * `GET boxRoutes.offers(provider, kind)`; null when the envelope is broken or
 * answers for another provider or kind than asked.
 */
export function sanitizeBoxOffersResponse(
  value: unknown,
  provider: BoxProviderInfo["id"],
  kind: BoxKindAvailability["kind"]
): BoxOffersResponse | null {
  if (!isRecord(value) || !Array.isArray(value.sizes) || !Array.isArray(value.regions)) return null;
  if (value.provider !== provider || value.kind !== kind) return null;
  const regions = listOf(value.regions, sanitizeRegion, (region) => region.id);
  const known = new Set(regions.map((region) => region.id));
  const sizes: BoxSizeOffer[] = [];
  for (const size of listOf(value.sizes, sanitizeSize, (entry) => entry.id)) {
    // Empty = every region of the answer.
    if (size.regions.length === 0) {
      sizes.push(size);
      continue;
    }
    // A size names only regions this answer has; one left with none of its
    // listed regions cannot be rented anywhere and is left out.
    const here = size.regions.filter((id) => known.has(id));
    if (here.length > 0) sizes.push({ ...size, regions: here });
  }
  return {
    provider,
    kind,
    sizes,
    regions,
    images: listOf(value.images, sanitizeImage, (image) => image.id),
    priceSource: value.priceSource === "live" ? "live" : "table",
    fetchedAt: stringOr(value.fetchedAt, "")
  };
}

// ---------------------------------------------------------------------------
// Connection, Blacksmith
// ---------------------------------------------------------------------------

/** `GET/PUT boxRoutes.connection`, `POST connectionTest`; null when it is not a settings object. */
/** Tailscale on the daemon's machine; null when absent (older daemons) or malformed. */
function sanitizeLocalTailscale(value: unknown): BoxLocalTailscale | null {
  if (!isRecord(value) || typeof value.installed !== "boolean") return null;
  const port = value.servePort;
  return {
    installed: value.installed,
    running: value.running === true,
    dnsName: stringOrNull(value.dnsName),
    tailnetIp: stringOrNull(value.tailnetIp),
    servePort: finite(port) && Number.isInteger(port) && port > 0 && port < 65536 ? port : 10000,
    serving: value.serving === true,
    // As sent (an origin without a trailing slash): it fills the URL field.
    suggestedUrl: httpUrlOrNull(value.suggestedUrl) ? (value.suggestedUrl as string) : null,
    serveCommand: stringOrNull(value.serveCommand)
  };
}

export function sanitizeBoxConnectionSettings(value: unknown): BoxConnectionSettings | null {
  if (!isRecord(value)) return null;
  const tailscale = isRecord(value.tailscale) ? value.tailscale : {};
  const local = sanitizeLocalTailscale(tailscale.local);
  const identity = isRecord(tailscale.workloadIdentity) ? tailscale.workloadIdentity : null;
  const workloadIdentity = identity && nonEmpty(identity.clientId) && nonEmpty(identity.audience) ? { clientId: identity.clientId, audience: identity.audience } : null;
  return {
    mode: value.mode === "tailscale" ? "tailscale" : "public-url",
    publicUrl: stringOrNull(value.publicUrl),
    tailscale: {
      configured: tailscale.configured === true,
      keyHint: stringOrNull(tailscale.keyHint),
      tailnet: stringOrNull(tailscale.tailnet),
      daemonUrl: stringOrNull(tailscale.daemonUrl),
      policySnippet: stringOr(tailscale.policySnippet, ""),
      ...(local ? { local } : {}),
      workloadIdentity
    },
    reachable: value.reachable === "ok" || value.reachable === "failed" ? value.reachable : "unknown",
    reachableMessage: stringOrNull(value.reachableMessage),
    checkedAt: stringOrNull(value.checkedAt)
  };
}

const BLACKSMITH_STEP_IDS: readonly BlacksmithSetupStepId[] = ["account", "org", "app", "repo", "test"];
const BLACKSMITH_STEP_STATES: readonly BlacksmithSetupStepState[] = ["todo", "running", "ok", "action-needed", "failed"];
const BLACKSMITH_STEP_LABELS: Readonly<Record<BlacksmithSetupStepId, string>> = {
  account: "GitHub account",
  org: "Organization",
  app: "Blacksmith app",
  repo: "Control repo",
  test: "Test run"
};

function sanitizeBlacksmithStep(value: unknown): BlacksmithSetupStep | null {
  if (!isRecord(value) || !oneOf(BLACKSMITH_STEP_IDS, value.id)) return null;
  return {
    id: value.id,
    label: nonEmpty(value.label) ? value.label : BLACKSMITH_STEP_LABELS[value.id],
    state: oneOf(BLACKSMITH_STEP_STATES, value.state) ? value.state : "todo",
    message: stringOrNull(value.message),
    actionUrl: httpUrlOrNull(value.actionUrl)
  };
}

/**
 * `GET/PUT boxRoutes.blacksmith`; null when it is not an object. The five
 * steps always come back in order — one the answer lacks shows as to-do.
 */
export function sanitizeBlacksmithSetup(value: unknown): BlacksmithSetupResponse | null {
  if (!isRecord(value)) return null;
  const given = new Map(listOf(value.steps, sanitizeBlacksmithStep, (step) => step.id).map((step) => [step.id, step]));
  return {
    gitAccountId: stringOrNull(value.gitAccountId),
    org: stringOrNull(value.org),
    repo: stringOrNull(value.repo),
    steps: BLACKSMITH_STEP_IDS.map(
      (id) => given.get(id) ?? { id, label: BLACKSMITH_STEP_LABELS[id], state: "todo", message: null, actionUrl: null }
    )
  };
}

// ---------------------------------------------------------------------------
// Config changes (box → host, spec §8.3)
// ---------------------------------------------------------------------------

const CHANGE_STATES: readonly BoxConfigChangeState[] = ["pending", "approved", "denied", "stale"];
const FILE_CHANGES = ["added", "modified", "deleted"] as const;

function sanitizeChangeFile(value: unknown): BoxConfigChangeFile | null {
  if (!isRecord(value) || !nonEmpty(value.path) || !oneOf(FILE_CHANGES, value.change)) return null;
  return {
    path: value.path,
    change: value.change,
    // Unknown means executable: the card then asks for the closer look.
    executable: value.executable !== false,
    diff: stringOr(value.diff, ""),
    truncated: value.truncated === true,
    binary: value.binary === true
  };
}

export function sanitizeBoxConfigChangeSet(value: unknown): BoxConfigChangeSet | null {
  if (!isRecord(value) || !nonEmpty(value.id) || !nonEmpty(value.boxId) || !oneOf(CHANGE_STATES, value.state)) {
    return null;
  }
  return {
    id: value.id,
    boxId: value.boxId,
    threadId: stringOrNull(value.threadId),
    createdAt: stringOr(value.createdAt, ""),
    decidedAt: stringOrNull(value.decidedAt),
    state: value.state,
    files: listOf(value.files, sanitizeChangeFile, (file) => file.path)
  };
}

/** `GET boxRoutes.configChanges` / `BOX_CONFIG_CHANGES_EVENT`; null when the envelope is broken. */
export function sanitizeBoxConfigChangesResponse(value: unknown): BoxConfigChangesResponse | null {
  if (!isRecord(value) || !Array.isArray(value.changes)) return null;
  return { changes: listOf(value.changes, sanitizeBoxConfigChangeSet, (change) => change.id) };
}

// ---------------------------------------------------------------------------
// Global MCP servers' "Run in box"
// ---------------------------------------------------------------------------

function sanitizeRunInBoxEntry(value: unknown): BoxMcpRunInBoxEntry | null {
  if (!isRecord(value) || !nonEmpty(value.name) || !nonEmpty(value.agent)) return null;
  return { name: value.name, agent: value.agent, runInBox: value.runInBox === true };
}

/** `GET` / `PUT boxRoutes.mcpRunInBox`; null when the envelope is broken. */
export function sanitizeBoxMcpRunInBoxResponse(value: unknown): BoxMcpRunInBoxResponse | null {
  if (!isRecord(value) || !Array.isArray(value.servers)) return null;
  return { servers: listOf(value.servers, sanitizeRunInBoxEntry, (entry) => `${entry.agent}\u0000${entry.name}`) };
}

/** Whether an agent's Global server is switched to "Run in box" (absent: it is not). */
export function runsInBox(response: BoxMcpRunInBoxResponse, agent: string, name: string): boolean {
  return response.servers.some((entry) => entry.agent === agent && entry.name === name && entry.runInBox);
}
