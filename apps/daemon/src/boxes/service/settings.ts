/**
 * The plugin's settings (spec §6, §11.2, §11.3): provider credentials and their offers, the
 * "Runs on" kinds, the connection route boxes dial, and the Blacksmith
 * macOS setup. Secret values go into box-secrets.json and never come back out: responses carry a
 * `keyHint` (last four characters) at most.
 */

import {
  BOX_KINDS,
  BOX_KIND_LABELS,
  type AccountSummary,
  type BlacksmithSetupResponse,
  type BlacksmithSetupStep,
  type BlacksmithSetupStepId,
  type BlacksmithSetupStepState,
  type BoxConnectionMode,
  type BoxConnectionSettings,
  type BoxKind,
  type BoxKindAvailability,
  type BoxLocalTailscale,
  type BoxOffersResponse,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxProvidersResponse,
  type SetBlacksmithSetupRequest,
  type SetBoxConnectionRequest,
  type SetBoxProviderCredentialsRequest
} from "@orquester/api";

import type { BoxProviderAdapter, BoxProviderRegistry, ProviderCredentials, TailscaleKeys } from "../contracts.ts";
import type { DeviceCacheWarmRequest, DeviceCacheWarmRun, DeviceCacheWarmStatus } from "../providers/blacksmith.ts";
import { byoOffers } from "../providers/byo.ts";
import { DEFAULT_TAILSCALE_SERVE_PORT, tailnetUrl, type DaemonHttpAddress, type LocalTailscale } from "../tailscale/local.ts";
import { fetchFailureMessage, statusFailureMessage } from "./connection-check.ts";
import { BoxError, errorLine } from "./errors.ts";
import type { BoxClock, BoxConnectivity, ConnectRoute } from "./lifecycle.ts";
import type { BoxStore, TailscaleSecrets } from "./store.ts";
import { isActiveRecord } from "./summary.ts";

/** How long a provider's offers are reused. */
export const OFFERS_TTL_MS = 10 * 60_000;
const PROVIDER_CALL_TIMEOUT_MS = 30_000;
/** A device-cache dispatch may first re-commit the workflows and wait for GitHub to index them. */
const DEVICE_CACHE_CALL_TIMEOUT_MS = 120_000;
const MAX_CREDENTIAL_CHARS = 16 * 1024;

export interface TailscaleCredentials extends TailscaleSecrets {
  /** `<name>.ts.net`, derived from the daemon's tailnet URL. */
  tailnet: string | null;
}

/** The connected Git hosting accounts (Settings → Git hosting), through `AccountsService`. Tokens stay on the host. */
export interface BoxHostingAccounts {
  list(): Promise<AccountSummary[]>;
  /** The account's REST token, or null when it has none. Host-only: never returned or logged. */
  token(accountId: string): Promise<string | null>;
  /** Parse a user-typed repo with the account's provider grammar: the clone URL (SSH unless HTTPS is needed) and the default dir name. */
  resolveClone(accountId: string, input: string): Promise<{ url: string; name: string }>;
  /** Create a repo through the provider's API; resolves the URL to clone it over. */
  createRepo(accountId: string, options: { owner: string; name: string; visibility: "private" | "public"; description?: string }): Promise<{ url: string }>;
}

/**
 * The GitHub side of the Blacksmith setup (boxes/github implements it). Every call takes the Git
 * hosting account's token; none returns it. Refusals carry the exact fix (`message`) and, where a
 * browser click is needed, the page (`actionUrl`).
 */
export interface BlacksmithSetupDriver {
  /** Token scopes (`repo`, `workflow`) and that it can create repos in orgs. */
  checkAccount(token: string, signal: AbortSignal): Promise<BlacksmithCheck>;
  /** The org exists and the account may create repos in it. */
  checkOrg(token: string, org: string, signal: AbortSignal): Promise<BlacksmithCheck>;
  /** The Blacksmith GitHub App is installed on the org. */
  checkApp(token: string, org: string, signal: AbortSignal): Promise<BlacksmithCheck>;
  /**
   * Create the private control repo (or reuse it), commit the workflow, wait until a dispatch is
   * accepted. `tailscale`: the runs join the tailnet with this federated identity first.
   */
  ensureControlRepo(
    token: string,
    org: string,
    options: { daemonUrl: string; tailscale?: BlacksmithTailnetJoin | null; signal: AbortSignal }
  ): Promise<{ repo: string; workflowFile: string }>;
  /**
   * The credentials the Blacksmith adapter takes for this setup. `tailscale`: the identity runs
   * join the tailnet with now (the adapter re-commits the workflow when its template changed).
   */
  adapterCredentials(setup: { token: string; org: string; repo: string; workflowFile: string; tailscale?: BlacksmithTailnetJoin | null }): ProviderCredentials;
  /** Start the device-cache workflow for one OS (Devices phase 2); resolves its run. */
  dispatchDeviceCacheWarm(credentials: ProviderCredentials, request: DeviceCacheWarmRequest, signal: AbortSignal): Promise<DeviceCacheWarmRun>;
  /** A device-cache run's state. */
  deviceCacheWarmStatus(credentials: ProviderCredentials, runId: string, signal: AbortSignal): Promise<DeviceCacheWarmStatus>;
}

export type BlacksmithCheck = { ok: true; message?: string } | { ok: false; message: string; actionUrl: string | null };

/** The Tailscale federated identity a macOS runner joins the tailnet with (`tailscale/github-action`). */
export interface BlacksmithTailnetJoin {
  oauthClientId: string;
  audience: string;
}

/** How macOS runners (GitHub Actions, outside the tailnet) reach this daemon. */
export interface BlacksmithRoute {
  mode: BoxConnectionMode;
  daemonUrl: string;
  /** Set when the runner dials the tailnet URL: the identity it joins with. */
  join: BlacksmithTailnetJoin | null;
}

export const MACOS_ROUTE_MESSAGE =
  "macOS boxes run on GitHub Actions runners outside your tailnet: set a Public URL (the runner dials it), or add a Tailscale federated identity.";
/** The values the workflow's Tailscale step takes (workflow-template.ts checks the same). */
const WORKLOAD_VALUE = /^[A-Za-z0-9._:/-]{1,200}$/;

export interface BoxSettingsDeps {
  store: BoxStore;
  providers: BoxProviderRegistry;
  tailscale: (credentials: TailscaleCredentials) => TailscaleKeys;
  accounts: BoxHostingAccounts;
  blacksmith?: BlacksmithSetupDriver;
  /** The daemon's configured public origin, when it has one (the default public URL). */
  publicOrigin: () => string | null;
  /** Tailscale on this machine (status, `tailscale serve`). Absent: not reported. */
  localTailscale?: LocalTailscale;
  /** Where the daemon's HTTP transport listens (the Check's reverse proxy hint names its port). */
  daemonHttp?: () => DaemonHttpAddress;
  clock: BoxClock;
  logger: Pick<Console, "warn" | "error">;
  /** Provider settings changed (credentials, Blacksmith steps). */
  providersChanged(): void;
  /** Whether a box's `orq-agent` is connected now (bring-your-own machines are offered only then). Absent: never. */
  connected?: (boxId: string) => boolean;
}

const BLACKSMITH_STEPS: readonly { id: BlacksmithSetupStepId; label: string }[] = [
  { id: "account", label: "GitHub account" },
  { id: "org", label: "GitHub organization" },
  { id: "app", label: "Blacksmith GitHub App" },
  { id: "repo", label: "Control repository" },
  { id: "test", label: "Test run" }
];

const BLACKSMITH_STEP_STATES: readonly BlacksmithSetupStepState[] = ["todo", "running", "ok", "action-needed", "failed"];
const NEW_ORG_URL = "https://github.com/account/organizations/new";
const TOKENS_URL = "https://github.com/settings/tokens";

type StoredStep = { state: BlacksmithSetupStepState; message: string | null; actionUrl: string | null };

function keyHint(value: string | undefined): string | null {
  return value && value.length >= 8 ? value.slice(-4) : null;
}

/** `https://host[:port]` without a trailing slash, or null when `value` is not an http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** `<name>.ts.net` from a MagicDNS URL (`https://host.<name>.ts.net:port`), or null. */
export function tailnetOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const match = /^[^.]+\.(.+\.ts\.net)$/i.exec(host);
    return match ? match[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The tailnet policy lines that let boxes reach only Orquester: this machine's Tailscale IP when
 * known, and the port of the configured tailnet URL (else the port Tailscale serves Orquester on).
 */
export function tailscalePolicySnippet(daemonUrl: string | null, local?: Pick<BoxLocalTailscale, "tailnetIp" | "servePort"> | null): string {
  let port = String(local?.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT);
  if (daemonUrl) {
    try {
      const url = new URL(daemonUrl);
      port = url.port || (url.protocol === "http:" ? "80" : "443");
    } catch {
      // Keep the serve port.
    }
  }
  const ip = local?.tailnetIp && /^[0-9a-f:.]+$/i.test(local.tailnetIp) ? local.tailnetIp : null;
  return [
    "// Lets Orquester boxes reach only Orquester's port on the daemon machine.",
    ...(ip ? [] : ["// Replace <daemon-tailscale-ip> with that machine's Tailscale IP (or a host alias)."]),
    '"tagOwners": { "tag:orq-box": ["autogroup:admin"] },',
    `"grants": [{ "src": ["tag:orq-box"], "dst": ["${ip ?? "<daemon-tailscale-ip>"}"], "ip": ["tcp:${port}"] }]`
  ].join("\n");
}

export class BoxSettings implements BoxConnectivity {
  private readonly offersCache = new Map<string, { at: number; value: Promise<BoxOffersResponse> }>();
  private readonly checking = new Set<string>();
  private serving: Promise<BoxConnectionSettings> | null = null;
  /** Blacksmith checks run one at a time; a re-run queues behind the current one. */
  private blacksmithRuns: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BoxSettingsDeps) {}

  // ---- providers ---------------------------------------------------------------------------------

  adapter(id: string): BoxProviderAdapter {
    const adapter = this.deps.providers.get(id as BoxProviderId);
    if (!adapter) throw new BoxError(404, "BOX_INVALID_REQUEST", `No box provider "${id.slice(0, 64)}".`);
    return adapter;
  }

  providersResponse(): BoxProvidersResponse {
    // An adapter that rents no kind (Thunder: it cannot bootstrap without SSH) is not offered.
    return { providers: [...this.deps.providers.values()].filter((adapter) => adapter.kinds.length > 0).map((adapter) => this.providerInfo(adapter)) };
  }

  providerInfo(adapter: BoxProviderAdapter): BoxProviderInfo {
    const settings = this.deps.store.providerSettings(adapter.id);
    const credentials = this.deps.store.providerCredentials(adapter.id);
    let status: BoxProviderInfo["status"];
    let error = settings.error ?? null;
    let hint: string | null = null;
    if (adapter.id === "byo") {
      // Nothing to connect: the owner's machines are there whenever the plugin is on.
      status = "connected";
    } else if (adapter.id === "blacksmith") {
      const steps = this.blacksmithSteps();
      const failed = steps.find((step) => step.state === "failed");
      status = this.blacksmithReady() ? "connected" : failed ? "error" : "not-configured";
      error = failed?.message ?? null;
    } else if (this.checking.has(adapter.id)) {
      status = "checking";
    } else if (!credentials) {
      status = "not-configured";
    } else {
      status = settings.status === "error" ? "error" : "connected";
      const secret = adapter.credentialFields.find((field) => field.secret) ?? adapter.credentialFields[0];
      hint = secret ? keyHint(credentials[secret.id]) : null;
    }
    return {
      id: adapter.id,
      label: adapter.label,
      kinds: [...adapter.kinds],
      website: adapter.website,
      credentialsUrl: adapter.credentialsUrl,
      credentialFields: adapter.credentialFields.map((field) => ({ ...field })),
      status,
      error: status === "error" ? error : null,
      keyHint: hint,
      accountNote: adapter.accountNote,
      maxLifetimeMinutes: adapter.maxLifetimeMinutes
    };
  }

  /** Validate with a cheap read, then save. Bad credentials are refused (400) and nothing is saved. */
  async setCredentials(id: string, body: SetBoxProviderCredentialsRequest | undefined): Promise<BoxProviderInfo> {
    const adapter = this.adapter(id);
    if (adapter.id === "blacksmith") {
      throw new BoxError(409, "BOX_UNSUPPORTED", "Blacksmith is set up through its own steps (a Git hosting account and an org).");
    }
    if (adapter.id === "byo") throw new BoxError(409, "BOX_UNSUPPORTED", "Your own machines need no credentials: add one with Add your machine.");
    const raw = body && typeof body === "object" && typeof body.credentials === "object" && body.credentials !== null ? body.credentials : null;
    if (!raw) throw new BoxError(400, "BOX_INVALID_REQUEST", "Send `credentials`: field id → value.");
    const credentials: Record<string, string> = {};
    for (const field of adapter.credentialFields) {
      const value = (raw as Record<string, unknown>)[field.id];
      if (value !== undefined && typeof value !== "string") throw new BoxError(400, "BOX_INVALID_REQUEST", `"${field.label}" must be text.`);
      const trimmed = (value ?? "").trim();
      if (trimmed.length > MAX_CREDENTIAL_CHARS) throw new BoxError(400, "BOX_INVALID_REQUEST", `"${field.label}" is too long.`);
      if (trimmed.length === 0) {
        if (!field.optional) throw new BoxError(400, "BOX_INVALID_REQUEST", `"${field.label}" is required.`);
        continue;
      }
      credentials[field.id] = trimmed;
    }
    this.checking.add(adapter.id);
    this.deps.providersChanged();
    let result: { ok: true } | { ok: false; message: string };
    try {
      result = await adapter.validate(credentials, this.callOptions());
    } catch (error) {
      throw new BoxError(502, "BOX_PROVIDER_ERROR", `Could not reach ${adapter.label} to check the key: ${errorLine(error)}`);
    } finally {
      this.checking.delete(adapter.id);
      this.deps.providersChanged();
    }
    if (!result.ok) throw new BoxError(400, "BOX_PROVIDER_ERROR", `${adapter.label} refused the credentials: ${result.message}`);
    await this.assertSeesLiveBoxes(adapter, credentials);
    await this.deps.store.setProviderCredentials(adapter.id, credentials);
    const at = new Date(this.deps.clock.now()).toISOString();
    await this.deps.store.updateProviderSettings(adapter.id, (settings) => {
      settings.status = "connected";
      settings.error = null;
      settings.checkedAt = at;
    });
    this.invalidateOffers(adapter.id);
    this.deps.providersChanged();
    return this.providerInfo(adapter);
  }

  /**
   * Replacing the credentials of a provider with live boxes is allowed only when the new ones see
   * every one of them: a key for another account would make them read as gone (the record
   * destroyed, the box billing on). A box still being created with the stored key (no instance ref
   * yet) blocks it; without a stored key (box-secrets.json was lost) such a box cannot be checked
   * and does not.
   */
  private async assertSeesLiveBoxes(adapter: BoxProviderAdapter, credentials: ProviderCredentials): Promise<void> {
    const live = this.deps.store.list().filter((record) => record.provider === adapter.id && isActiveRecord(record));
    if (live.length === 0) return;
    const stored = this.deps.store.providerCredentials(adapter.id) !== null;
    const refuse = (detail: string) =>
      new BoxError(
        409,
        "BOX_INVALID_REQUEST",
        `${live.length} box${live.length === 1 ? "" : "es"} at ${adapter.label} still exist${live.length === 1 ? "s" : ""}, and ${detail} New credentials must belong to the account the boxes run in; destroy the boxes first to switch accounts.`
      );
    for (const record of live) {
      if (!record.providerRef) {
        if (stored) throw refuse(`box ${record.name} is still being created.`);
        continue;
      }
      let state: string;
      try {
        state = (await adapter.status(credentials, record.providerRef, this.callOptions())).state;
      } catch (error) {
        throw refuse(`the new credentials could not be checked against box ${record.name} (${errorLine(error)}).`);
      }
      if (state === "gone") throw refuse(`the new credentials cannot see box ${record.name}.`);
    }
  }

  /** Forget a provider's credentials. Refused while a box of it may still exist (it could not be destroyed without them). */
  async deleteCredentials(id: string): Promise<BoxProviderInfo> {
    const adapter = this.adapter(id);
    if (adapter.id === "byo") throw new BoxError(409, "BOX_UNSUPPORTED", "Your own machines have no credentials: remove a machine from its row.");
    const live = this.deps.store.list().filter((record) => record.provider === adapter.id && isActiveRecord(record));
    if (live.length > 0) {
      throw new BoxError(
        409,
        "BOX_INVALID_REQUEST",
        `${live.length} box${live.length === 1 ? "" : "es"} at ${adapter.label} still exist${live.length === 1 ? "s" : ""}; destroy ${live.length === 1 ? "it" : "them"} first.`
      );
    }
    if (adapter.id === "blacksmith") {
      await this.deps.store.updateBlacksmith(() => null);
    } else {
      await this.deps.store.setProviderCredentials(adapter.id, null);
    }
    await this.deps.store.updateProviderSettings(adapter.id, () => null);
    this.invalidateOffers(adapter.id);
    this.deps.providersChanged();
    return this.providerInfo(adapter);
  }

  /** Whether the provider can rent boxes now. */
  configured(id: BoxProviderId): boolean {
    if (id === "byo") return true;
    if (id === "blacksmith") return this.blacksmithReady();
    return this.deps.store.providerCredentials(id) !== null && this.deps.store.providerSettings(id).status !== "error";
  }

  async credentials(provider: BoxProviderId): Promise<ProviderCredentials | null> {
    if (provider !== "blacksmith") return this.deps.store.providerCredentials(provider);
    const setup = this.deps.store.blacksmith();
    const driver = this.deps.blacksmith;
    if (!driver || !setup.gitAccountId || !setup.org || !setup.repo || !setup.workflowFile) return null;
    const token = await this.deps.accounts.token(setup.gitAccountId);
    if (!token) return null;
    let tailscale: BlacksmithTailnetJoin | null = null;
    try {
      tailscale = this.blacksmithRoute().join;
    } catch {
      // No route: creates fail on it before they need the workflow.
    }
    return driver.adapterCredentials({ token, org: setup.org, repo: setup.repo, workflowFile: setup.workflowFile, tailscale });
  }

  // ---- offers and kinds --------------------------------------------------------------------------

  /** A provider's offers for a kind, cached {@link OFFERS_TTL_MS} (a failed fetch is not cached). */
  async offers(id: string, kind: unknown): Promise<BoxOffersResponse> {
    const adapter = this.adapter(id);
    if (typeof kind !== "string" || !(BOX_KINDS as readonly string[]).includes(kind)) {
      throw new BoxError(400, "BOX_INVALID_REQUEST", "`kind` must be a box kind.");
    }
    const boxKind = kind as BoxKind;
    if (!adapter.kinds.includes(boxKind)) {
      throw new BoxError(400, "BOX_UNSUPPORTED", `${adapter.label} does not rent ${BOX_KIND_LABELS[boxKind]} boxes.`);
    }
    if (adapter.id === "byo") {
      // The machines free right now (never cached: they come and go with their connections).
      const offers = byoOffers(this.deps.store.list(), boxKind, (boxId) => this.deps.connected?.(boxId) ?? false);
      return { provider: adapter.id, kind: boxKind, ...offers, fetchedAt: new Date(this.deps.clock.now()).toISOString() };
    }
    const key = `${adapter.id}\u0000${boxKind}`;
    const cached = this.offersCache.get(key);
    if (cached && this.deps.clock.now() - cached.at < OFFERS_TTL_MS) return cached.value;
    const credentials = await this.credentials(adapter.id);
    if (!credentials) throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", `${adapter.label} is not connected.`);
    const value = adapter.offers(credentials, boxKind, this.callOptions()).then(
      (offers): BoxOffersResponse => ({
        provider: adapter.id,
        kind: boxKind,
        sizes: offers.sizes,
        regions: offers.regions,
        images: offers.images,
        priceSource: offers.priceSource,
        fetchedAt: new Date(this.deps.clock.now()).toISOString()
      }),
      (error: unknown) => {
        this.offersCache.delete(key);
        throw new BoxError(502, "BOX_PROVIDER_ERROR", `Could not load ${adapter.label}'s offers: ${errorLine(error)}`);
      }
    );
    this.offersCache.set(key, { at: this.deps.clock.now(), value });
    return value;
  }

  invalidateOffers(providerId: string): void {
    for (const key of this.offersCache.keys()) {
      if (key.startsWith(`${providerId}\u0000`)) this.offersCache.delete(key);
    }
  }

  /** Why no box (of `provider`) can be created right now (no route to this daemon), or null. */
  routeProblem(provider?: BoxProviderId): string | null {
    try {
      this.route(provider);
      return null;
    } catch (error) {
      return errorLine(error);
    }
  }

  /** The cheapest priced size of a provider's offers for a kind (null when none has a price or the fetch failed). */
  async cheapest(adapter: BoxProviderAdapter, kind: BoxKind): Promise<number | null> {
    try {
      const offers = await this.offers(adapter.id, kind);
      const prices = offers.sizes.map((size) => size.hourlyUsd).filter((price): price is number => typeof price === "number");
      return prices.length > 0 ? Math.min(...prices) : null;
    } catch {
      return null;
    }
  }

  async kinds(): Promise<BoxKindAvailability[]> {
    return Promise.all(
      BOX_KINDS.map(async (kind): Promise<BoxKindAvailability> => {
        // The owner's machines count only while one of the kind is free, and come after every
        // rented provider: they are never the default pick unless nothing else is connected.
        const freeMachine = (adapter: BoxProviderAdapter) =>
          adapter.id !== "byo" || byoOffers(this.deps.store.list(), kind, (boxId) => this.deps.connected?.(boxId) ?? false).sizes.length > 0;
        const renting = [...this.deps.providers.values()].filter(
          (adapter) => adapter.kinds.includes(kind) && this.configured(adapter.id) && freeMachine(adapter)
        );
        const priced = await Promise.all(renting.map(async (adapter) => ({ adapter, price: await this.cheapest(adapter, kind) })));
        priced.sort(
          (a, b) =>
            Number(a.adapter.id === "byo") - Number(b.adapter.id === "byo") ||
            (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY)
        );
        const prices = priced.map((entry) => entry.price).filter((price): price is number => price !== null);
        // A kind caps lifetimes only when every provider does: Blacksmith's Linux runners (5 days)
        // next to clouds without a cap must not put a deadline on every Linux box. A box still
        // gets its own provider's maximum (placement).
        const caps = renting.map((adapter) => adapter.maxLifetimeMinutes);
        const lifetimes = caps.every((value) => value !== null) ? (caps as number[]) : [];
        // macOS runners route differently: a kind is blocked only when none of its providers has a route.
        const routeProblems = renting.map((adapter) => this.routeProblem(adapter.id));
        const routeProblem = routeProblems.every((problem) => problem !== null) ? (routeProblems[0] ?? null) : null;
        let unavailableReason: string | null = null;
        if (renting.length === 0) unavailableReason = `No connected provider rents ${BOX_KIND_LABELS[kind]} boxes.`;
        else if (routeProblem) unavailableReason = routeProblem;
        return {
          kind,
          providers: priced.map((entry) => entry.adapter.id),
          fromHourlyUsd: prices.length > 0 ? Math.min(...prices) : null,
          maxLifetimeMinutes: lifetimes.length > 0 ? Math.min(...lifetimes) : null,
          unavailableReason
        };
      })
    );
  }

  /** Keep the existing endpoint's refusal: every provider bootstraps Windows boxes directly. */
  async prepareWindowsImage(id: string): Promise<void> {
    const adapter = this.adapter(id);
    throw new BoxError(409, "BOX_UNSUPPORTED", `${adapter.label} needs no prepared Windows image.`);
  }

  // ---- connection --------------------------------------------------------------------------------

  private mode(): BoxConnectionMode {
    return this.deps.store.connection().mode === "tailscale" ? "tailscale" : "public-url";
  }

  private publicUrl(): string | null {
    const stored = this.deps.store.connection().publicUrl;
    if (stored !== undefined) return stored;
    const origin = this.deps.publicOrigin();
    return origin ? normalizeOrigin(origin) : null;
  }

  /** The settings with Tailscale on this machine as last read (see {@link loadConnectionSettings}). */
  connectionSettings(): BoxConnectionSettings {
    const stored = this.deps.store.connection();
    const secrets = this.deps.store.tailscale();
    const daemonUrl = stored.tailscaleDaemonUrl ?? null;
    const local = this.deps.localTailscale?.cached() ?? null;
    return {
      mode: this.mode(),
      publicUrl: this.publicUrl(),
      tailscale: {
        configured: secrets !== null,
        keyHint: keyHint(secrets?.apiToken ?? secrets?.oauthClientSecret),
        tailnet: stored.tailnet ?? tailnetOf(daemonUrl),
        daemonUrl,
        policySnippet: tailscalePolicySnippet(daemonUrl, local),
        ...(local ? { local } : {}),
        workloadIdentity: this.workloadIdentity()
          ? { clientId: stored.tailscaleWorkloadClientId as string, audience: stored.tailscaleWorkloadAudience as string }
          : null
      },
      reachable: stored.lastCheck ? (stored.lastCheck.ok ? "ok" : "failed") : "unknown",
      reachableMessage: stored.lastCheck?.message ?? null,
      checkedAt: stored.lastCheck?.at ?? null
    };
  }

  /** {@link connectionSettings} after reading Tailscale on this machine (cached briefly). */
  async loadConnectionSettings(options: { fresh?: boolean } = {}): Promise<BoxConnectionSettings> {
    await this.deps.localTailscale?.state(options);
    return this.connectionSettings();
  }

  async setConnection(body: SetBoxConnectionRequest | undefined): Promise<BoxConnectionSettings> {
    const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const invalid = (message: string) => new BoxError(400, "BOX_INVALID_REQUEST", message);
    const { mode, publicUrl, tailscaleDaemonUrl, tailscaleApiToken, tailscaleOAuthClientId, tailscaleOAuthClientSecret, clearTailscale } = request;
    if (mode !== undefined && mode !== "public-url" && mode !== "tailscale") throw invalid('`mode` must be "public-url" or "tailscale".');
    const urlField = (value: unknown, name: string): string | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || value === "") return null;
      if (typeof value !== "string") throw invalid(`\`${name}\` must be a URL.`);
      const origin = normalizeOrigin(value);
      if (!origin) throw invalid(`\`${name}\` must be an http(s) URL without credentials, query or fragment.`);
      return origin;
    };
    const nextPublicUrl = urlField(publicUrl, "publicUrl");
    const nextTailscaleUrl = urlField(tailscaleDaemonUrl, "tailscaleDaemonUrl");
    if (nextPublicUrl && !nextPublicUrl.startsWith("https://")) throw invalid("Boxes reach the public URL over the internet: it must be https.");
    for (const [value, name] of [
      [tailscaleApiToken, "tailscaleApiToken"],
      [tailscaleOAuthClientId, "tailscaleOAuthClientId"],
      [tailscaleOAuthClientSecret, "tailscaleOAuthClientSecret"]
    ] as const) {
      if (value !== undefined && (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_CREDENTIAL_CHARS)) {
        throw invalid(`\`${name}\` must be non-empty text.`);
      }
    }
    if ((tailscaleOAuthClientId === undefined) !== (tailscaleOAuthClientSecret === undefined)) {
      throw invalid("Send the Tailscale OAuth client id and secret together.");
    }
    if (clearTailscale !== undefined && typeof clearTailscale !== "boolean") throw invalid("`clearTailscale` must be a boolean.");
    const { tailscaleWorkloadClientId, tailscaleWorkloadAudience } = request;
    const workloadField = (value: unknown, name: string): string | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || (typeof value === "string" && value.trim() === "")) return null;
      if (typeof value !== "string" || !WORKLOAD_VALUE.test(value.trim())) {
        throw invalid(`\`${name}\` must be up to 200 letters, digits and . _ : / -.`);
      }
      return value.trim();
    };
    const workloadClientId = workloadField(tailscaleWorkloadClientId, "tailscaleWorkloadClientId");
    const workloadAudience = workloadField(tailscaleWorkloadAudience, "tailscaleWorkloadAudience");
    if ((workloadClientId === undefined) !== (workloadAudience === undefined) || (workloadClientId === null) !== (workloadAudience === null)) {
      throw invalid("Send the Tailscale federated identity's client id and audience together.");
    }

    if (clearTailscale === true) {
      await this.deps.store.setTailscale(null);
    } else if (typeof tailscaleApiToken === "string" || typeof tailscaleOAuthClientId === "string") {
      await this.deps.store.setTailscale(
        typeof tailscaleApiToken === "string"
          ? { apiToken: tailscaleApiToken.trim() }
          : { oauthClientId: (tailscaleOAuthClientId as string).trim(), oauthClientSecret: (tailscaleOAuthClientSecret as string).trim() }
      );
    }
    await this.deps.store.updateConnection((settings) => {
      if (mode !== undefined) settings.mode = mode;
      if (nextPublicUrl !== undefined) settings.publicUrl = nextPublicUrl;
      if (nextTailscaleUrl !== undefined) {
        settings.tailscaleDaemonUrl = nextTailscaleUrl;
        settings.tailnet = tailnetOf(nextTailscaleUrl);
      }
      if (workloadClientId !== undefined) {
        settings.tailscaleWorkloadClientId = workloadClientId;
        settings.tailscaleWorkloadAudience = workloadAudience ?? null;
      }
      // The route changed: the last reachability check says nothing about the new one.
      if (mode !== undefined || nextPublicUrl !== undefined || nextTailscaleUrl !== undefined) delete settings.lastCheck;
    });
    // The Blacksmith control repo step depends on the route: check it again.
    this.rerunBlacksmithChecks();
    return this.loadConnectionSettings();
  }

  /** Fetch `<url>/api/boxes/agent/linux-x64` without credentials: Orquester's own route answers 401. */
  async testConnection(): Promise<BoxConnectionSettings> {
    const mode = this.mode();
    const url = mode === "tailscale" ? (this.deps.store.connection().tailscaleDaemonUrl ?? null) : this.publicUrl();
    let ok = false;
    let message: string;
    // The remedy depends on what Tailscale serves right now.
    const local = mode === "tailscale" ? ((await this.deps.localTailscale?.state({ fresh: true })) ?? null) : null;
    const context = { mode, local, daemonPort: this.deps.daemonHttp?.().port ?? null };
    if (!url) {
      message = mode === "tailscale" ? "Enter the daemon's tailnet URL first." : "Enter the daemon's public URL first.";
    } else {
      try {
        const response = await fetch(`${url}/api/boxes/agent/linux-x64`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000)
        });
        await response.body?.cancel().catch(() => undefined);
        ok = response.status === 401;
        message = ok ? `Reachable: ${url} answers as Orquester.` : statusFailureMessage(url, response.status, context);
      } catch (error) {
        message = fetchFailureMessage(url, error, context);
      }
    }
    const at = new Date(this.deps.clock.now()).toISOString();
    await this.deps.store.updateConnection((settings) => {
      settings.lastCheck = { at, ok, message };
    });
    if (ok) this.rerunBlacksmithChecks();
    return this.loadConnectionSettings();
  }

  /**
   * "Set up for me": serve the daemon on an HTTPS port of this machine's tailnet name (unless it is
   * served already), switch to Tailscale mode with that URL, and check it.
   */
  setupTailscaleServe(): Promise<BoxConnectionSettings> {
    this.serving ??= this.runTailscaleServe().finally(() => {
      this.serving = null;
    });
    return this.serving;
  }

  private async runTailscaleServe(): Promise<BoxConnectionSettings> {
    const localTailscale = this.deps.localTailscale;
    if (!localTailscale) throw new BoxError(409, "BOX_UNSUPPORTED", "This daemon can't run Tailscale commands.");
    const local = await localTailscale.state({ fresh: true });
    if (!local.installed) {
      throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Tailscale isn't installed on this machine: install it and log in, then try again.");
    }
    if (!local.running) {
      throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Tailscale isn't running on this machine: start it and log in (`tailscale up`), then try again.");
    }
    if (!local.dnsName) {
      throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "This machine has no MagicDNS name: turn on MagicDNS and HTTPS certificates in the Tailscale admin console (DNS), then try again.");
    }
    let port = local.servePort;
    if (!local.serving) {
      const result = await localTailscale.serve(port);
      if (!result.ok) {
        if (result.reason === "permission") throw new BoxError(409, "BOX_TAILSCALE_NEEDS_PERMISSION", result.message, result.commands);
        throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", `Tailscale could not serve Orquester: ${result.message}`);
      }
      port = result.port;
      const after = await localTailscale.state({ fresh: true });
      if (after.serving) port = after.servePort;
    }
    const daemonUrl = normalizeOrigin(tailnetUrl(local.dnsName, port));
    await this.deps.store.updateConnection((settings) => {
      settings.mode = "tailscale";
      settings.tailscaleDaemonUrl = daemonUrl;
      settings.tailnet = tailnetOf(daemonUrl);
      delete settings.lastCheck;
    });
    return this.testConnection();
  }

  route(provider?: BoxProviderId): ConnectRoute {
    if (provider === "byo") {
      // The owner's machine dials the configured URL as it is: in Tailscale mode it must already be
      // on the tailnet (Orquester never joins someone's own machine to it with an ephemeral key).
      if (this.mode() === "tailscale") {
        const daemonUrl = this.deps.store.connection().tailscaleDaemonUrl ?? null;
        if (!daemonUrl) throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Set the daemon's tailnet URL in Connection first.");
        return { mode: "tailscale", daemonUrl, tailscale: null };
      }
      const publicUrl = this.publicUrl();
      if (!publicUrl) throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Your machine has no way to reach this daemon: set its public URL (or Tailscale) in Connection.");
      return { mode: "public-url", daemonUrl: publicUrl, tailscale: null };
    }
    if (provider === "blacksmith") {
      const route = this.blacksmithRoute();
      // The runner joins the tailnet itself (federated identity): no auth key is minted for it.
      return { mode: route.mode, daemonUrl: route.daemonUrl, tailscale: null };
    }
    if (this.mode() === "tailscale") {
      const daemonUrl = this.deps.store.connection().tailscaleDaemonUrl ?? null;
      const secrets = this.deps.store.tailscale();
      if (!daemonUrl || !secrets) {
        throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Tailscale is not set up on this daemon: add its credentials and tailnet URL in Connection.");
      }
      return { mode: "tailscale", daemonUrl, tailscale: this.deps.tailscale({ ...secrets, tailnet: tailnetOf(daemonUrl) }) };
    }
    const publicUrl = this.publicUrl();
    if (!publicUrl) {
      throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", "Boxes have no way to reach this daemon: set its public URL (or Tailscale) in Connection.");
    }
    return { mode: "public-url", daemonUrl: publicUrl, tailscale: null };
  }

  private workloadIdentity(): BlacksmithTailnetJoin | null {
    const stored = this.deps.store.connection();
    const clientId = stored.tailscaleWorkloadClientId;
    const audience = stored.tailscaleWorkloadAudience;
    return clientId && audience && WORKLOAD_VALUE.test(clientId) && WORKLOAD_VALUE.test(audience) ? { oauthClientId: clientId, audience } : null;
  }

  /**
   * macOS runners are GitHub Actions jobs outside the tailnet: they dial the public URL whenever one
   * is known (whatever the mode), else the tailnet URL only when they can join it (federated identity).
   */
  blacksmithRoute(): BlacksmithRoute {
    const publicUrl = this.publicUrl();
    if (publicUrl) return { mode: "public-url", daemonUrl: publicUrl, join: null };
    const tailnetUrl = this.deps.store.connection().tailscaleDaemonUrl ?? null;
    const join = this.workloadIdentity();
    if (tailnetUrl && join) return { mode: "tailscale", daemonUrl: tailnetUrl, join };
    throw new BoxError(409, "BOX_CONNECTION_NOT_CONFIGURED", MACOS_ROUTE_MESSAGE);
  }

  tailscaleKeys(): TailscaleKeys | null {
    const secrets = this.deps.store.tailscale();
    if (!secrets) return null;
    return this.deps.tailscale({ ...secrets, tailnet: tailnetOf(this.deps.store.connection().tailscaleDaemonUrl ?? null) });
  }

  // ---- Blacksmith ---------------------------------------------------------------------------------

  /**
   * Start the Blacksmith device-cache workflow (Devices phase 2 §2 goal 6): builds and saves the
   * device caches of `request.os` that are missing. Resolves the run id for {@link deviceCacheWarmStatus}.
   */
  async dispatchDeviceCacheWarm(request: DeviceCacheWarmRequest): Promise<DeviceCacheWarmRun> {
    if (request?.os !== "macos" && request?.os !== "linux") throw new BoxError(400, "BOX_INVALID_REQUEST", '`os` must be "macos" or "linux".');
    const { driver, credentials } = await this.blacksmithCalls();
    try {
      return await driver.dispatchDeviceCacheWarm(credentials, request, AbortSignal.timeout(DEVICE_CACHE_CALL_TIMEOUT_MS));
    } catch (error) {
      throw new BoxError(502, "BOX_PROVIDER_ERROR", `Could not start the device cache run: ${errorLine(error)}`);
    }
  }

  /** A device-cache run's state (`queued` → `running` → `completed`, `conclusion: "success"` when the caches exist). */
  async deviceCacheWarmStatus(runId: string): Promise<DeviceCacheWarmStatus> {
    if (typeof runId !== "string" || !/^\d{1,20}$/.test(runId)) throw new BoxError(400, "BOX_INVALID_REQUEST", "`runId` must be a workflow run id.");
    const { driver, credentials } = await this.blacksmithCalls();
    try {
      return await driver.deviceCacheWarmStatus(credentials, runId, AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS));
    } catch (error) {
      throw new BoxError(502, "BOX_PROVIDER_ERROR", `Could not read the device cache run: ${errorLine(error)}`);
    }
  }

  private async blacksmithCalls(): Promise<{ driver: BlacksmithSetupDriver; credentials: ProviderCredentials }> {
    const driver = this.deps.blacksmith;
    const credentials = await this.credentials("blacksmith");
    if (!driver || !credentials) throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", "Finish the Blacksmith setup steps first.");
    return { driver, credentials };
  }

  blacksmithReady(): boolean {
    const setup = this.deps.store.blacksmith();
    return Boolean(this.deps.blacksmith && setup.gitAccountId && setup.org && setup.repo && setup.workflowFile);
  }

  private storedSteps(): Partial<Record<BlacksmithSetupStepId, StoredStep>> {
    const raw = this.deps.store.blacksmith().steps;
    const out: Partial<Record<BlacksmithSetupStepId, StoredStep>> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const { id } of BLACKSMITH_STEPS) {
      const step = (raw as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
      if (!step || !BLACKSMITH_STEP_STATES.includes(step.state as BlacksmithSetupStepState)) continue;
      out[id] = {
        state: step.state as BlacksmithSetupStepState,
        message: typeof step.message === "string" ? step.message : null,
        actionUrl: typeof step.actionUrl === "string" ? step.actionUrl : null
      };
    }
    return out;
  }

  blacksmithSteps(): BlacksmithSetupStep[] {
    const stored = this.storedSteps();
    const setup = this.deps.store.blacksmith();
    return BLACKSMITH_STEPS.map(({ id, label }) => {
      const step = stored[id];
      if (step) return { id, label, ...step };
      if (id === "test" && setup.testedAt) return { id, label, state: "ok", message: `Last test run ${setup.testedAt}.`, actionUrl: null };
      return { id, label, state: "todo", message: null, actionUrl: null };
    });
  }

  blacksmithResponse(): BlacksmithSetupResponse {
    const setup = this.deps.store.blacksmith();
    return { gitAccountId: setup.gitAccountId ?? null, org: setup.org ?? null, repo: setup.repo ?? null, steps: this.blacksmithSteps() };
  }

  async setBlacksmithStep(id: BlacksmithSetupStepId, step: StoredStep): Promise<void> {
    await this.deps.store.updateBlacksmith((settings) => {
      const steps = typeof settings.steps === "object" && settings.steps !== null ? { ...(settings.steps as Record<string, unknown>) } : {};
      steps[id] = step;
      settings.steps = steps;
    });
    this.deps.providersChanged();
  }

  /** Save the account and org, then run the automatic steps in order, stopping at the first that needs the owner. */
  async setBlacksmith(body: SetBlacksmithSetupRequest | undefined): Promise<BlacksmithSetupResponse> {
    const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const { gitAccountId, org } = request;
    if (gitAccountId !== undefined && (typeof gitAccountId !== "string" || gitAccountId.length === 0 || gitAccountId.length > 200)) {
      throw new BoxError(400, "BOX_INVALID_REQUEST", "`gitAccountId` must be a Git hosting account id.");
    }
    if (org !== undefined && (typeof org !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org))) {
      throw new BoxError(400, "BOX_INVALID_REQUEST", "`org` must be a GitHub organization name.");
    }
    const current = this.deps.store.blacksmith();
    const accountChanged = gitAccountId !== undefined && gitAccountId !== current.gitAccountId;
    const orgChanged = org !== undefined && org !== current.org;
    if (accountChanged || orgChanged) {
      const live = this.deps.store.list().filter((record) => record.provider === "blacksmith" && isActiveRecord(record));
      if (live.length > 0) throw new BoxError(409, "BOX_INVALID_REQUEST", "A macOS box is still running on the current setup; destroy it first.");
    }
    await this.deps.store.updateBlacksmith((settings) => {
      if (accountChanged) settings.gitAccountId = gitAccountId as string;
      if (orgChanged) settings.org = org as string;
      if (accountChanged || orgChanged) {
        delete settings.repo;
        delete settings.workflowFile;
        delete settings.testedAt;
        delete settings.steps;
      }
    });
    await this.runBlacksmithChecks();
    this.deps.providersChanged();
    return this.blacksmithResponse();
  }

  /**
   * The connection changed (or a Check passed): run the automatic steps again in the background,
   * so a step that failed for want of a route does not keep its old error. Nothing to do before an
   * account is picked.
   */
  rerunBlacksmithChecks(): void {
    if (!this.deps.blacksmith || !this.deps.store.blacksmith().gitAccountId) return;
    // Shown at once (the client re-reads the setup while a step runs); the checks queue behind any run.
    const marked = this.setBlacksmithStep("repo", { state: "running", message: "Checking again with the new connection…", actionUrl: null }).catch(() => undefined);
    this.blacksmithRuns = this.blacksmithRuns
      .then(() => marked)
      .then(() => this.checkBlacksmithSteps())
      .catch((error) => this.deps.logger.warn("Blacksmith setup re-check failed", errorLine(error)))
      .finally(() => this.deps.providersChanged());
  }

  /** Every background Blacksmith re-check has finished. */
  async blacksmithChecksSettled(): Promise<void> {
    for (let current = this.blacksmithRuns; ; current = this.blacksmithRuns) {
      await current;
      if (current === this.blacksmithRuns) return;
    }
  }

  /** One run of the automatic steps at a time. */
  private runBlacksmithChecks(): Promise<void> {
    const run = this.blacksmithRuns.then(() => this.checkBlacksmithSteps());
    this.blacksmithRuns = run.catch(() => undefined);
    return run;
  }

  private async checkBlacksmithSteps(): Promise<void> {
    const setup = this.deps.store.blacksmith();
    const driver = this.deps.blacksmith;
    const signal = AbortSignal.timeout(5 * 60_000);
    const steps: Partial<Record<BlacksmithSetupStepId, StoredStep>> = {};
    const stop = (id: BlacksmithSetupStepId, state: BlacksmithSetupStepState, message: string, actionUrl: string | null = null) => {
      steps[id] = { state, message, actionUrl };
    };
    const check = async (id: BlacksmithSetupStepId, run: () => Promise<BlacksmithCheck>): Promise<boolean> => {
      try {
        const result = await run();
        if (result.ok) {
          steps[id] = { state: "ok", message: result.message ?? null, actionUrl: null };
          return true;
        }
        stop(id, "action-needed", result.message, result.actionUrl);
      } catch (error) {
        stop(id, "failed", errorLine(error));
      }
      return false;
    };
    await (async () => {
      if (!setup.gitAccountId) return stop("account", "action-needed", "Pick one of the GitHub accounts connected in Settings → Git hosting.");
      if (!driver) return stop("account", "failed", "The Blacksmith setup is not available in this build.");
      const account = (await this.deps.accounts.list()).find((candidate) => candidate.id === setup.gitAccountId);
      if (!account) return stop("account", "failed", "That Git hosting account is no longer connected.");
      if (account.provider !== "github") return stop("account", "action-needed", "Blacksmith runs through GitHub: pick a GitHub account.");
      const token = await this.deps.accounts.token(account.id);
      if (!token) return stop("account", "action-needed", "This account has no API token; add one with the repo and workflow scopes.", TOKENS_URL);
      if (!(await check("account", () => driver.checkAccount(token, signal)))) return;
      if (!setup.org) return stop("org", "action-needed", "Pick an organization (Blacksmith works only with organizations).", NEW_ORG_URL);
      const org = setup.org;
      if (!(await check("org", () => driver.checkOrg(token, org, signal)))) return;
      if (!(await check("app", () => driver.checkApp(token, org, signal)))) return;
      let route: BlacksmithRoute;
      try {
        route = this.blacksmithRoute();
      } catch (error) {
        return stop("repo", "action-needed", errorLine(error));
      }
      try {
        const { repo, workflowFile } = await driver.ensureControlRepo(token, org, { daemonUrl: route.daemonUrl, tailscale: route.join, signal });
        await this.deps.store.updateBlacksmith((settings) => {
          settings.repo = repo;
          settings.workflowFile = workflowFile;
        });
        steps.repo = { state: "ok", message: repo, actionUrl: null };
      } catch (error) {
        stop("repo", "failed", errorLine(error));
      }
    })();
    await this.deps.store.updateBlacksmith((settings) => {
      const previous = typeof settings.steps === "object" && settings.steps !== null ? (settings.steps as Record<string, unknown>) : {};
      // The test step keeps its last result; every other step is what this run found (or todo).
      settings.steps = { ...(previous.test ? { test: previous.test } : {}), ...steps };
    });
  }

  private callOptions() {
    return { signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS) };
  }
}
