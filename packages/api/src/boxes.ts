/**
 * Ephemeral AI VMs ("boxes") — the HTTP/UI contracts of the built-in plugin
 * (spec docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md).
 *
 * A **box** is a machine rented from a provider. A *project box* belongs to one
 * project (it is created with the project and destroyed when the project is
 * deleted); a *temporary box* belongs to the agent chat that created it through
 * the box MCP tools. The wire protocol between the daemon and the program in
 * the box (`orq-agent`) lives in `box-protocol.ts`.
 *
 * Nothing here ever carries a secret value: provider credentials, Tailscale
 * keys and Windows passwords stay on the daemon (`keyHint` shows the last four
 * characters at most).
 */

// ---------------------------------------------------------------------------
// Kinds, providers, states
// ---------------------------------------------------------------------------

export type BoxKind = "linux" | "linux-gpu" | "windows" | "windows-gpu" | "macos";
export const BOX_KINDS: readonly BoxKind[] = ["linux", "linux-gpu", "windows", "windows-gpu", "macos"];

export function isBoxKind(value: unknown): value is BoxKind {
  return typeof value === "string" && (BOX_KINDS as readonly string[]).includes(value);
}

export const BOX_KIND_LABELS: Readonly<Record<BoxKind, string>> = {
  linux: "Linux VM",
  "linux-gpu": "Linux + GPU",
  windows: "Windows",
  "windows-gpu": "Windows + GPU",
  macos: "macOS"
};

/** The box's operating system as `orq-agent` reports it (Node's `process.platform` names). */
export type BoxOs = "linux" | "win32" | "darwin";
export type BoxArch = "x64" | "arm64";
export type BoxLibc = "glibc" | "musl";

/** Every provider the plugin can rent from (spec §11.1). */
export type BoxProviderId =
  // Linux (and some Windows) VMs
  | "hetzner"
  | "vultr"
  | "ionos"
  | "ovh"
  | "scaleway"
  | "digitalocean"
  | "exoscale"
  | "linode"
  | "fly"
  | "morph"
  | "civo"
  | "oracle"
  | "upcloud"
  // GPU marketplaces and GPU clouds
  | "vastai"
  | "runpod"
  | "hyperstack"
  | "thunder"
  | "cloudrift"
  | "massed"
  | "jarvislabs"
  | "tensordock"
  // macOS through GitHub Actions
  | "blacksmith";

export const BOX_PROVIDER_IDS: readonly BoxProviderId[] = [
  "hetzner",
  "vultr",
  "ionos",
  "ovh",
  "scaleway",
  "digitalocean",
  "exoscale",
  "linode",
  "fly",
  "morph",
  "civo",
  "oracle",
  "upcloud",
  "vastai",
  "runpod",
  "hyperstack",
  "thunder",
  "cloudrift",
  "massed",
  "jarvislabs",
  "tensordock",
  "blacksmith"
];

export function isBoxProviderId(value: unknown): value is BoxProviderId {
  return typeof value === "string" && (BOX_PROVIDER_IDS as readonly string[]).includes(value);
}

export type BoxPurpose = "project" | "temporary";

/**
 * - `provisioning` — being created and set up (see `setup`).
 * - `ready` — `orq-agent` is connected and setup finished.
 * - `unreachable` — `orq-agent` dropped while the provider still reports the instance; reconnecting.
 * - `destroying` — a destroy call is in flight.
 * - `destroy-failed` — the provider refused or failed the destroy; it may still bill. Retry is offered.
 * - `destroyed` — gone (see `destroyedReason`). Terminal.
 */
export type BoxState = "provisioning" | "ready" | "unreachable" | "destroying" | "destroy-failed" | "destroyed";
export const BOX_STATES: readonly BoxState[] = [
  "provisioning",
  "ready",
  "unreachable",
  "destroying",
  "destroy-failed",
  "destroyed"
];

/**
 * Why a box is `destroyed`:
 * - `deleted` — its project was deleted in Orquester.
 * - `agent` — the agent called `destroy_box`.
 * - `time-limit` — its time limit ran out (macOS job deadline, a temporary box's limit).
 * - `chat-closed` — the temporary box's chat was closed.
 * - `provider-gone` — the provider no longer has the instance (destroyed in its dashboard, reclaimed).
 * - `provider-error` — the provider reports the instance failed.
 * - `provisioning-failed` — creation or setup failed and the instance was torn down.
 * - `orphan` — an instance Orquester had no live record for, cleaned up by the reconciler.
 */
export type BoxDestroyedReason =
  | "deleted"
  | "agent"
  | "time-limit"
  | "chat-closed"
  | "provider-gone"
  | "provider-error"
  | "provisioning-failed"
  | "orphan";

/** Whether a box was destroyed by something other than Orquester or its user acting in Orquester. */
export function boxDestroyedOutsideOrquester(reason: BoxDestroyedReason | undefined): boolean {
  return reason === "provider-gone" || reason === "provider-error" || reason === "time-limit";
}

// ---------------------------------------------------------------------------
// Setup progress
// ---------------------------------------------------------------------------

/**
 * Setup steps, in order (spec §8.2). A temporary box runs only `create`,
 * `connect` and `ready`; a project box runs them all.
 */
export type BoxSetupStepId = "create" | "connect" | "paths" | "config" | "tooling" | "clone" | "toolchain" | "ready";
export const BOX_SETUP_STEP_IDS: readonly BoxSetupStepId[] = [
  "create",
  "connect",
  "paths",
  "config",
  "tooling",
  "clone",
  "toolchain",
  "ready"
];
export type BoxSetupStepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface BoxSetupStep {
  id: BoxSetupStepId;
  label: string;
  state: BoxSetupStepState;
  startedAt: string | null;
  finishedAt: string | null;
  /** One line: what failed, or what was skipped and why. */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Box summaries
// ---------------------------------------------------------------------------

export interface BoxProjectRef {
  workspace: string;
  name: string;
  /** The project's host path — identical to its path in the box (except Windows, see `box-protocol.ts`). */
  path: string;
}

export interface BoxSummary {
  id: string;
  purpose: BoxPurpose;
  kind: BoxKind;
  provider: BoxProviderId;
  providerLabel: string;
  region: string;
  regionLabel: string;
  size: string;
  sizeLabel: string;
  /** The OS image chosen (Windows/macOS version), when the provider offers a choice. */
  image: string | null;
  /** Known once `orq-agent` connected. */
  os: BoxOs | null;
  arch: BoxArch | null;
  state: BoxState;
  /** One line explaining the state (e.g. "Reconnecting…", "Gone in the Vultr dashboard"). */
  stateReason: string | null;
  destroyedReason: BoxDestroyedReason | null;
  /** Price recorded at creation, USD per hour (licence fees included). Null when the provider gave none. */
  hourlyUsd: number | null;
  /** Uptime × `hourlyUsd`, an estimate. */
  estimatedCostUsd: number;
  createdAt: string;
  readyAt: string | null;
  /** When the box is destroyed automatically (macOS job deadline, a temporary box's time limit). */
  deadlineAt: string | null;
  destroyedAt: string | null;
  /** Whether `orq-agent` is connected right now. */
  connected: boolean;
  lastSeenAt: string | null;
  project: BoxProjectRef | null;
  /** Temporary boxes: the agent-chat thread (= session id) that created it. */
  threadId: string | null;
  /** Temporary boxes: the agent's short purpose ("build the engine on macOS"). */
  purposeNote: string | null;
  setup: BoxSetupStep[];
}

export interface BoxesTotals {
  /** Boxes not `destroyed`. */
  activeCount: number;
  /** Sum of `hourlyUsd` of active boxes. */
  hourlyUsd: number;
  /** Estimated spend this calendar month (UTC), destroyed boxes included. */
  monthEstimatedUsd: number;
}

export interface BoxesResponse {
  boxes: BoxSummary[];
  totals: BoxesTotals;
}

export interface BoxResponse {
  box: BoxSummary;
}

/** The box fields a project row and its chats show (`ProjectSummary.box`). */
export interface ProjectBoxInfo {
  boxId: string;
  kind: BoxKind;
  provider: BoxProviderId;
  providerLabel: string;
  state: BoxState;
  stateReason: string | null;
  destroyedReason: BoxDestroyedReason | null;
  hourlyUsd: number | null;
  deadlineAt: string | null;
}

export function projectBoxInfo(box: BoxSummary): ProjectBoxInfo {
  return {
    boxId: box.id,
    kind: box.kind,
    provider: box.provider,
    providerLabel: box.providerLabel,
    state: box.state,
    stateReason: box.stateReason,
    destroyedReason: box.destroyedReason,
    hourlyUsd: box.hourlyUsd,
    deadlineAt: box.deadlineAt
  };
}

// ---------------------------------------------------------------------------
// Creating a project in a box
// ---------------------------------------------------------------------------

/**
 * `CreateProjectRequest.location` for a project that runs in a new box. Absent
 * (or `{ kind: "host" }`) = this host, as before.
 */
export interface BoxLocationRequest {
  kind: "box";
  boxKind: BoxKind;
  provider: BoxProviderId;
  /** A `BoxSizeOffer.id` from the provider's offers. */
  size: string;
  /** A `BoxRegionOffer.id`. */
  region: string;
  /** A `BoxImageOffer.id`, when the provider offers a choice for the kind. */
  image?: string;
  /** macOS: the job's lifetime, ≤ the provider's `maxLifetimeMinutes`. Default: the maximum. */
  lifetimeMinutes?: number;
}

export type ProjectLocationRequest = { kind: "host" } | BoxLocationRequest;

// ---------------------------------------------------------------------------
// Providers and offers
// ---------------------------------------------------------------------------

export type BoxProviderStatus = "not-configured" | "checking" | "connected" | "error";

/** One credential input a provider needs (most need one API key; OVH and Oracle need several). */
export interface BoxProviderCredentialField {
  id: string;
  label: string;
  /** Masked input; never echoed back. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Optional fields may be left empty. */
  optional?: boolean;
}

export type BoxWindowsImageState = "none" | "preparing" | "ready" | "failed";

export interface BoxProviderInfo {
  id: BoxProviderId;
  label: string;
  /** The kinds this provider can rent. */
  kinds: BoxKind[];
  website: string;
  /** Where to create an API key. */
  credentialsUrl: string;
  credentialFields: BoxProviderCredentialField[];
  status: BoxProviderStatus;
  /** One line when `status` is `error`. */
  error: string | null;
  /** Last four characters of the main key, for recognition. */
  keyHint: string | null;
  /** A one-time account step the owner should know about (ID check, GPU account review). */
  accountNote: string | null;
  /** Hard maximum lifetime of one box (macOS: 7200 min). Null = none. */
  maxLifetimeMinutes: number | null;
  /** Providers whose Windows boxes need a one-time prepared image (spec §11.1). Absent otherwise. */
  windowsImage?: { state: BoxWindowsImageState; message: string | null; updatedAt: string | null };
}

export interface BoxProvidersResponse {
  providers: BoxProviderInfo[];
}

/** Body for `PUT boxRoutes.provider(id)`: field id → value. Validated with a cheap read call before it is saved. */
export interface SetBoxProviderCredentialsRequest {
  credentials: Record<string, string>;
}

export interface BoxGpuInfo {
  model: string;
  count: number;
  vramGb: number | null;
}

export interface BoxSizeOffer {
  id: string;
  label: string;
  vcpu: number;
  ramGb: number;
  diskGb: number | null;
  gpu: BoxGpuInfo | null;
  /** USD per hour including licence fees for the kind, null when unknown. */
  hourlyUsd: number | null;
  /** Region ids this size is available in; empty = all of the response's regions. */
  regions: string[];
}

export interface BoxRegionOffer {
  id: string;
  label: string;
  country: string | null;
}

export interface BoxImageOffer {
  id: string;
  label: string;
}

export interface BoxOffersResponse {
  provider: BoxProviderId;
  kind: BoxKind;
  sizes: BoxSizeOffer[];
  regions: BoxRegionOffer[];
  images: BoxImageOffer[];
  /** `live` = from the provider's API now; `table` = Orquester's bundled price table. */
  priceSource: "live" | "table";
  fetchedAt: string;
}

/** One card of the New project dialog's "Runs on" row. */
export interface BoxKindAvailability {
  kind: BoxKind;
  /** Connected providers that rent this kind, cheapest first. */
  providers: BoxProviderId[];
  fromHourlyUsd: number | null;
  /** The smallest provider maximum among `providers` (macOS: 7200). Null = none. */
  maxLifetimeMinutes: number | null;
  /** Why the kind is unavailable even with providers (e.g. "Tailscale is not set up on this desktop"). */
  unavailableReason: string | null;
}

export interface BoxKindsResponse {
  kinds: BoxKindAvailability[];
}

// ---------------------------------------------------------------------------
// Connection (how boxes reach this daemon, spec §6)
// ---------------------------------------------------------------------------

export type BoxConnectionMode = "public-url" | "tailscale";

export interface BoxConnectionSettings {
  mode: BoxConnectionMode;
  /** The daemon's public HTTPS origin boxes connect to (`public-url` mode). */
  publicUrl: string | null;
  tailscale: {
    /** A Tailscale API token or OAuth client is stored. */
    configured: boolean;
    keyHint: string | null;
    tailnet: string | null;
    /** The daemon's address on the tailnet boxes dial (`https://<host>.<tailnet>.ts.net:<port>`). */
    daemonUrl: string | null;
    /** Policy snippet for the owner to paste (Orquester never edits the policy itself in the product). */
    policySnippet: string;
  };
  reachable: "unknown" | "ok" | "failed";
  reachableMessage: string | null;
  checkedAt: string | null;
}

/** Body for `PUT boxRoutes.connection`; secret fields are write-only. */
export interface SetBoxConnectionRequest {
  mode?: BoxConnectionMode;
  publicUrl?: string | null;
  tailscaleDaemonUrl?: string | null;
  /** A Tailscale API access token (`tskey-api-…`), or */
  tailscaleApiToken?: string;
  /** an OAuth client id + secret with `auth_keys` write scope. */
  tailscaleOAuthClientId?: string;
  tailscaleOAuthClientSecret?: string;
  /** Remove the stored Tailscale credentials. */
  clearTailscale?: boolean;
}

// ---------------------------------------------------------------------------
// Blacksmith macOS setup (spec §11.2)
// ---------------------------------------------------------------------------

export type BlacksmithSetupStepId = "account" | "org" | "app" | "repo" | "test";
export type BlacksmithSetupStepState = "todo" | "running" | "ok" | "action-needed" | "failed";

export interface BlacksmithSetupStep {
  id: BlacksmithSetupStepId;
  label: string;
  state: BlacksmithSetupStepState;
  message: string | null;
  /** A link the owner must open (create an org, install the Blacksmith app). */
  actionUrl: string | null;
}

export interface BlacksmithSetupResponse {
  /** The Git hosting account (Settings → Git hosting) whose token is used. */
  gitAccountId: string | null;
  org: string | null;
  /** The private control repo, `owner/name`. */
  repo: string | null;
  steps: BlacksmithSetupStep[];
}

export interface SetBlacksmithSetupRequest {
  gitAccountId?: string;
  org?: string;
}

// ---------------------------------------------------------------------------
// Box → host config changes waiting for approval (spec §8.3)
// ---------------------------------------------------------------------------

export interface BoxConfigChangeFile {
  /** Host path of the file. */
  path: string;
  change: "added" | "modified" | "deleted";
  /** A hook, an MCP server command, a plugin or skill script, or a file with the executable bit. */
  executable: boolean;
  /** Unified diff, truncated to `BOX_CONFIG_DIFF_MAX_CHARS`. Empty for binary files. */
  diff: string;
  truncated: boolean;
  binary: boolean;
}

export type BoxConfigChangeState = "pending" | "approved" | "denied" | "stale";

export interface BoxConfigChangeSet {
  id: string;
  boxId: string;
  /** The chat whose turn made the changes, when one was running. */
  threadId: string | null;
  createdAt: string;
  decidedAt: string | null;
  state: BoxConfigChangeState;
  files: BoxConfigChangeFile[];
}

export const BOX_CONFIG_DIFF_MAX_CHARS = 64 * 1024;

export interface BoxConfigChangesResponse {
  changes: BoxConfigChangeSet[];
}

export interface DecideBoxConfigChangeRequest {
  decision: "approve" | "deny";
}

// ---------------------------------------------------------------------------
// Routes and events
// ---------------------------------------------------------------------------

const boxPath = (id: string): string => `/api/boxes/${encodeURIComponent(id)}`;
const providerPath = (id: string): string => `/api/boxes/providers/${encodeURIComponent(id)}`;

export const boxRoutes = {
  /** `GET` → `BoxesResponse`. */
  list: "/api/boxes",
  /** `GET` → `BoxResponse`; `DELETE` destroys a box (project boxes: only through project delete → 409 `BOX_IS_PROJECT`). */
  box: (id: string): string => boxPath(id),
  /** `GET` → text/plain setup log of a box (no secrets). */
  setupLog: (id: string): string => `${boxPath(id)}/setup-log`,
  /** `GET` → `BoxKindsResponse`. */
  kinds: "/api/boxes/kinds",
  /** `GET` → `BoxProvidersResponse`. */
  providers: "/api/boxes/providers",
  /** `PUT` `SetBoxProviderCredentialsRequest` → `BoxProviderInfo`; `DELETE` forgets the credentials. */
  provider: (id: string): string => providerPath(id),
  /** `GET ?kind=` → `BoxOffersResponse`. */
  offers: (id: string, kind: BoxKind): string => `${providerPath(id)}/offers?kind=${encodeURIComponent(kind)}`,
  /** `POST` → 202; builds the provider's prepared Windows image. */
  windowsImage: (id: string): string => `${providerPath(id)}/windows-image`,
  /** `GET` → `BoxConnectionSettings`; `PUT` `SetBoxConnectionRequest` → `BoxConnectionSettings`. */
  connection: "/api/boxes/connection",
  /** `POST` → `BoxConnectionSettings` after a reachability check. */
  connectionTest: "/api/boxes/connection/test",
  /** `GET` → `BlacksmithSetupResponse`; `PUT` `SetBlacksmithSetupRequest` → `BlacksmithSetupResponse` (runs the automatic steps). */
  blacksmith: "/api/boxes/blacksmith",
  /** `POST` → 202; starts a test macOS box, waits for it to connect, destroys it. */
  blacksmithTest: "/api/boxes/blacksmith/test",
  /** `GET` → `BoxConfigChangesResponse` (pending first). */
  configChanges: "/api/boxes/config-changes",
  /** `POST` `DecideBoxConfigChangeRequest` → `{ change: BoxConfigChangeSet }`. */
  configChange: (id: string): string => `/api/boxes/config-changes/${encodeURIComponent(id)}`,
  /**
   * REMOTE, box-authenticated (bootstrap token or box credential in `Authorization: Bearer`):
   * `GET` → the `orq-agent` executable for `<os>-<arch>[-musl]`, e.g. `linux-x64`, `linux-arm64-musl`,
   * `darwin-arm64`, `win32-x64`. Not behind the daemon's user auth.
   */
  agentBinary: (platform: string): string => `/api/boxes/agent/${encodeURIComponent(platform)}`,
  /** REMOTE WebSocket, box-authenticated by its `hello` message (`box-protocol.ts`). */
  connect: "/api/boxes/connect",
  /**
   * SOCKET-ONLY (registered on the unix-socket app alone, never on the remote transport):
   * `POST` `BoxInternalTokenRequest` → the daemon's `AgentTokenGrant` (an access token, never a
   * refresh token), for the agent host at spawn time and on Codex refresh requests. Refusals:
   * `{ code, message }` with 400/403/404/409/503/504.
   */
  internalToken: "/api/boxes/internal/token"
} as const;

/** Body of `boxRoutes.internalToken`. `minValidSeconds` defaults to 45 minutes. */
export interface BoxInternalTokenRequest {
  boxId: string;
  agent: "claude" | "codex" | "grok";
  accountId: string;
  minValidSeconds?: number;
}

/** The `/events` channel box changes go out on. */
export const BOXES_CHANNEL = "boxes";
/** Payload: `BoxesResponse`. */
export const BOXES_CHANGED_EVENT = "boxes.changed";
/** Payload: `BoxConfigChangesResponse`. */
export const BOX_CONFIG_CHANGES_EVENT = "boxes.configChanges";
/** Payload: `BoxProvidersResponse`. */
export const BOX_PROVIDERS_CHANGED_EVENT = "boxes.providersChanged";

export type BoxErrorCode =
  | "BOXES_DISABLED"
  | "BOX_NOT_FOUND"
  | "BOX_IS_PROJECT"
  | "BOX_NOT_READY"
  | "BOX_PROVIDER_NOT_CONFIGURED"
  | "BOX_PROVIDER_ERROR"
  | "BOX_INVALID_REQUEST"
  | "BOX_CONNECTION_NOT_CONFIGURED"
  | "BOX_UNSUPPORTED"
  // boxes (sync): `POST boxRoutes.configChange(id)` refusals.
  | "BOX_CONFIG_CHANGE_NOT_FOUND"
  | "BOX_CONFIG_CHANGE_DECIDED";
