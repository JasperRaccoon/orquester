/**
 * The plugin's settings (spec §6, §11.2, §11.3): provider credentials and their offers, the
 * "Runs on" kinds, Windows prepared images, the connection route boxes dial, and the Blacksmith
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
  type BoxOffersResponse,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxProvidersResponse,
  type BoxWindowsImageState,
  type SetBlacksmithSetupRequest,
  type SetBoxConnectionRequest,
  type SetBoxProviderCredentialsRequest
} from "@orquester/api";

import type { BoxProviderAdapter, BoxProviderRegistry, BuildBootstrap, ProviderCredentials, TailscaleKeys } from "../contracts.ts";
import type { BoxSetupLog } from "./box-exec.ts";
import { BoxError, errorLine } from "./errors.ts";
import type { BoxClock, BoxConnectivity, ConnectRoute } from "./lifecycle.ts";
import type { BoxStore, TailscaleSecrets } from "./store.ts";
import { isActiveRecord } from "./summary.ts";

/** How long a provider's offers are reused. */
export const OFFERS_TTL_MS = 10 * 60_000;
const PROVIDER_CALL_TIMEOUT_MS = 30_000;
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
  /** Create the private control repo (or reuse it), commit the workflow, wait until a dispatch is accepted. */
  ensureControlRepo(token: string, org: string, options: { daemonUrl: string; signal: AbortSignal }): Promise<{ repo: string; workflowFile: string }>;
  /** The credentials the Blacksmith adapter takes for this setup. */
  adapterCredentials(setup: { token: string; org: string; repo: string; workflowFile: string }): ProviderCredentials;
}

export type BlacksmithCheck = { ok: true; message?: string } | { ok: false; message: string; actionUrl: string | null };

export interface BoxSettingsDeps {
  store: BoxStore;
  providers: BoxProviderRegistry;
  buildBootstrap: BuildBootstrap;
  tailscale: (credentials: TailscaleCredentials) => TailscaleKeys;
  accounts: BoxHostingAccounts;
  blacksmith?: BlacksmithSetupDriver;
  /** The daemon's configured public origin, when it has one (the default public URL). */
  publicOrigin: () => string | null;
  setupLog: BoxSetupLog;
  clock: BoxClock;
  fetch?: typeof fetch;
  logger: Pick<Console, "warn" | "error">;
  /** Provider settings changed (credentials, Windows image, Blacksmith steps). */
  providersChanged(): void;
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

export function tailscalePolicySnippet(daemonUrl: string | null): string {
  let port = "443";
  if (daemonUrl) {
    try {
      const url = new URL(daemonUrl);
      port = url.port || (url.protocol === "http:" ? "80" : "443");
    } catch {
      // Keep the default port.
    }
  }
  return [
    "// Lets Orquester boxes reach only Orquester's port on the daemon machine.",
    "// Replace <daemon-tailscale-ip> with that machine's Tailscale IP (or a host alias).",
    '"tagOwners": { "tag:orq-box": ["autogroup:admin"] },',
    `"grants": [{ "src": ["tag:orq-box"], "dst": ["<daemon-tailscale-ip>"], "ip": ["tcp:${port}"] }]`
  ].join("\n");
}

export class BoxSettings implements BoxConnectivity {
  private readonly offersCache = new Map<string, { at: number; value: Promise<BoxOffersResponse> }>();
  private readonly checking = new Set<string>();
  private readonly windowsImageRuns = new Map<string, Promise<void>>();

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
    if (adapter.id === "blacksmith") {
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
    const info: BoxProviderInfo = {
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
    if (adapter.needsWindowsImage) {
      const image = settings.windowsImage;
      const state: BoxWindowsImageState = image && ["none", "preparing", "ready", "failed"].includes(image.state) ? (image.state as BoxWindowsImageState) : "none";
      info.windowsImage = { state, message: image?.message ?? null, updatedAt: image?.updatedAt ?? null };
    }
    return info;
  }

  /** Validate with a cheap read, then save. Bad credentials are refused (400) and nothing is saved. */
  async setCredentials(id: string, body: SetBoxProviderCredentialsRequest | undefined): Promise<BoxProviderInfo> {
    const adapter = this.adapter(id);
    if (adapter.id === "blacksmith") {
      throw new BoxError(409, "BOX_UNSUPPORTED", "Blacksmith is set up through its own steps (a Git hosting account and an org).");
    }
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
    return driver.adapterCredentials({ token, org: setup.org, repo: setup.repo, workflowFile: setup.workflowFile });
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

  /** Why no box can be created at all right now (no route to this daemon), or null. */
  routeProblem(): string | null {
    try {
      this.route();
      return null;
    } catch (error) {
      return errorLine(error);
    }
  }

  /** A provider that rents `kind` but cannot right now (its Windows image is not prepared), or null. */
  kindBlocker(adapter: BoxProviderAdapter, kind: BoxKind): string | null {
    if ((kind === "windows" || kind === "windows-gpu") && adapter.needsWindowsImage) {
      const image = this.deps.store.providerSettings(adapter.id).windowsImage;
      if (image?.state !== "ready" || !image.imageId) return `Prepare ${adapter.label}'s Windows image first.`;
    }
    return null;
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
    const routeProblem = this.routeProblem();
    return Promise.all(
      BOX_KINDS.map(async (kind): Promise<BoxKindAvailability> => {
        const renting = [...this.deps.providers.values()].filter((adapter) => adapter.kinds.includes(kind) && this.configured(adapter.id));
        const blocked = renting.map((adapter) => this.kindBlocker(adapter, kind));
        const usable = renting.filter((_adapter, index) => blocked[index] === null);
        const priced = await Promise.all(usable.map(async (adapter) => ({ adapter, price: await this.cheapest(adapter, kind) })));
        priced.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
        const prices = priced.map((entry) => entry.price).filter((price): price is number => price !== null);
        const lifetimes = usable.map((adapter) => adapter.maxLifetimeMinutes).filter((value): value is number => value !== null);
        let unavailableReason: string | null = null;
        if (renting.length === 0) unavailableReason = `No connected provider rents ${BOX_KIND_LABELS[kind]} boxes.`;
        else if (usable.length === 0) unavailableReason = blocked.find((reason) => reason !== null) ?? null;
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

  // ---- Windows prepared images -------------------------------------------------------------------

  /** Start building the provider's prepared Windows image in the background (202). */
  async prepareWindowsImage(id: string): Promise<void> {
    const adapter = this.adapter(id);
    if (!adapter.needsWindowsImage || !adapter.prepareWindowsImage) {
      throw new BoxError(409, "BOX_UNSUPPORTED", `${adapter.label} needs no prepared Windows image.`);
    }
    if (this.windowsImageRuns.has(adapter.id)) throw new BoxError(409, "BOX_INVALID_REQUEST", "The Windows image is already being prepared.");
    const credentials = await this.credentials(adapter.id);
    if (!credentials) throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", `${adapter.label} is not connected.`);
    const route = this.route();
    const windowsKind: BoxKind = adapter.kinds.includes("windows") ? "windows" : "windows-gpu";
    const offers = await this.offers(adapter.id, windowsKind);
    const region = offers.regions[0]?.id;
    if (!region) throw new BoxError(502, "BOX_PROVIDER_ERROR", `${adapter.label} lists no region for Windows.`);
    await this.setWindowsImage(adapter.id, { state: "preparing", message: `Preparing in ${offers.regions[0]!.label}…`, region });
    const logId = `windows-image-${adapter.id}`;
    // The image installs orq-agent as a service but carries no token: each box created from it
    // gets its own bootstrap token through its startup script.
    const bootstrap = this.deps.buildBootstrap({ boxId: logId, daemonUrl: route.daemonUrl, bootstrapToken: "", tailscaleAuthKey: null, container: false });
    const run = (async () => {
      try {
        const { imageId } = await adapter.prepareWindowsImage!(
          credentials,
          { region, bootstrap, log: (line) => void this.deps.setupLog.append(logId, line) },
          { signal: AbortSignal.timeout(2 * 60 * 60_000), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }
        );
        await this.setWindowsImage(adapter.id, { state: "ready", message: null, imageId, region });
      } catch (error) {
        this.deps.logger.error(`Preparing the ${adapter.label} Windows image failed`, errorLine(error));
        await this.setWindowsImage(adapter.id, { state: "failed", message: errorLine(error), region }).catch(() => undefined);
      } finally {
        this.windowsImageRuns.delete(adapter.id);
      }
    })();
    this.windowsImageRuns.set(adapter.id, run);
  }

  /** The prepared image to create a Windows box from, when the provider needs one. */
  windowsImageId(adapter: BoxProviderAdapter, kind: BoxKind): string | null {
    if (!adapter.needsWindowsImage || (kind !== "windows" && kind !== "windows-gpu")) return null;
    const image = this.deps.store.providerSettings(adapter.id).windowsImage;
    return image?.state === "ready" && image.imageId ? image.imageId : null;
  }

  private async setWindowsImage(
    providerId: string,
    image: { state: BoxWindowsImageState; message: string | null; imageId?: string; region?: string }
  ): Promise<void> {
    const at = new Date(this.deps.clock.now()).toISOString();
    await this.deps.store.updateProviderSettings(providerId, (settings) => {
      settings.windowsImage = {
        ...(settings.windowsImage ?? {}),
        state: image.state,
        message: image.message,
        updatedAt: at,
        ...(image.region ? { region: image.region } : {}),
        ...(image.imageId ? { imageId: image.imageId } : {})
      };
    });
    this.deps.providersChanged();
  }

  async windowsImagesSettled(): Promise<void> {
    await Promise.all([...this.windowsImageRuns.values()]);
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

  connectionSettings(): BoxConnectionSettings {
    const stored = this.deps.store.connection();
    const secrets = this.deps.store.tailscale();
    const daemonUrl = stored.tailscaleDaemonUrl ?? null;
    return {
      mode: this.mode(),
      publicUrl: this.publicUrl(),
      tailscale: {
        configured: secrets !== null,
        keyHint: keyHint(secrets?.apiToken ?? secrets?.oauthClientSecret),
        tailnet: stored.tailnet ?? tailnetOf(daemonUrl),
        daemonUrl,
        policySnippet: tailscalePolicySnippet(daemonUrl)
      },
      reachable: stored.lastCheck ? (stored.lastCheck.ok ? "ok" : "failed") : "unknown",
      reachableMessage: stored.lastCheck?.message ?? null,
      checkedAt: stored.lastCheck?.at ?? null
    };
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
      // The route changed: the last reachability check says nothing about the new one.
      if (mode !== undefined || nextPublicUrl !== undefined || nextTailscaleUrl !== undefined) delete settings.lastCheck;
    });
    return this.connectionSettings();
  }

  /** Fetch `<url>/api/boxes/agent/linux-x64` without credentials: Orquester's own route answers 401. */
  async testConnection(): Promise<BoxConnectionSettings> {
    const mode = this.mode();
    const url = mode === "tailscale" ? (this.deps.store.connection().tailscaleDaemonUrl ?? null) : this.publicUrl();
    let ok = false;
    let message: string;
    if (!url) {
      message = mode === "tailscale" ? "Enter the daemon's tailnet URL first." : "Enter the daemon's public URL first.";
    } else {
      try {
        const response = await (this.deps.fetch ?? fetch)(`${url}/api/boxes/agent/linux-x64`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000)
        });
        await response.body?.cancel().catch(() => undefined);
        ok = response.status === 401;
        message = ok ? `Reachable: ${url} answers as Orquester.` : `${url} answered ${response.status}; expected Orquester's 401.`;
      } catch (error) {
        message = `${url} is not reachable: ${errorLine(error)}`;
      }
    }
    const at = new Date(this.deps.clock.now()).toISOString();
    await this.deps.store.updateConnection((settings) => {
      settings.lastCheck = { at, ok, message };
    });
    return this.connectionSettings();
  }

  route(): ConnectRoute {
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

  tailscaleKeys(): TailscaleKeys | null {
    const secrets = this.deps.store.tailscale();
    if (!secrets) return null;
    return this.deps.tailscale({ ...secrets, tailnet: tailnetOf(this.deps.store.connection().tailscaleDaemonUrl ?? null) });
  }

  // ---- Blacksmith ---------------------------------------------------------------------------------

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

  private async runBlacksmithChecks(): Promise<void> {
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
      let daemonUrl: string;
      try {
        daemonUrl = this.route().daemonUrl;
      } catch (error) {
        return stop("repo", "action-needed", errorLine(error));
      }
      try {
        const { repo, workflowFile } = await driver.ensureControlRepo(token, org, { daemonUrl, signal });
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
    return { signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) };
  }
}
