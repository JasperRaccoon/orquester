/**
 * Agent chat — the provider-snapshot cache (spec §6.3, §4.6.4).
 *
 * `GET /api/agent/providers` answers one snapshot per adapter plus the host's
 * instance id. Changes broadcast the **coarse** `agent.providers.changed` bus
 * event and the client re-reads — there is no provider stream (§6.3, differs
 * from T3, which pushes provider changes on a config stream).
 *
 * The cache is process-wide rather than per thread: every chat tab in the
 * window reads the same catalog, and the composer must not re-fetch it on each
 * tab switch.
 *
 * No React import.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import { parseGoalSupport } from "@orquester/api/agent-chat";
import type {
  AdapterCapabilities,
  AdapterGoalSupport,
  AgentAdapterId,
  ProviderAuth,
  ProviderSnapshot,
  ProviderUsageLimitsUpdate
} from "@orquester/api/agent-chat";

import type { AgentChatTransport } from "./transport";

export interface ProvidersState {
  providers: ProviderSnapshot[];
  /** §8: changes on every host start. A change means re-read, never resume. */
  hostInstanceId: string | null;
  loading: boolean;
  error: string | null;
  loadedAt: string | null;
}

const INITIAL: ProvidersState = {
  providers: [],
  hostInstanceId: null,
  loading: false,
  error: null,
  loadedAt: null
};

export type ProvidersStore = StoreApi<ProvidersState>;

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

/**
 * What a provider row degrades to when the host omits `capabilities`.
 *
 * Every value here withholds an affordance rather than offering one that would
 * fail: no plan chip, no context meter, no in-session model switch, and
 * `supportsConversationRollback: false` so "rewind to here" is not offered at
 * all — which §6.3 prefers to offering it and failing at step 2 of §5.5.
 */
const FALLBACK_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "unsupported",
  supportsConversationRollback: false,
  showPlanModeToggle: false,
  reportsContextWindow: false,
  compaction: { type: "native" }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const isAuthStatus = (value: unknown): value is ProviderAuth["status"] =>
  value === "authenticated" || value === "unauthenticated" || value === "unknown";

/**
 * A provider's goal block, or `undefined` for none (goals §8.1).
 *
 * Field-wise, and **a malformed block is absent** rather than half-trusted:
 * the chip's actions and the composer's `/goal` row both branch on it, and a
 * guessed `command` would send `/goal …` to a provider that reads it as chat
 * text. The one leniency is per action: an action this client does not know
 * is dropped, not the block — a newer host may add one, and the ones this
 * client does know still work (goals §9's additive rule, from the reading
 * side). The rule is `parseGoalSupport`'s, which the MCP reads by too.
 */
function sanitizeGoalSupport(value: unknown): AdapterGoalSupport | undefined {
  return parseGoalSupport(value) ?? undefined;
}

/**
 * Repair one provider row from the wire, or drop it.
 *
 * **A snapshot is not trusted input just because it came from our own host.**
 * §8 is explicit that a surviving host runs *old code* after a deploy, so the
 * client can be handed a snapshot shape it predates. Consumers read
 * `provider?.capabilities.showPlanModeToggle` — the `?.` guards the provider,
 * not the block — so one older row crashes the composer for every thread. This
 * is the same "validate with a fallback, never let raw JSON reach typed code"
 * rule AGENTS.md states for persisted state; a forward-compatible wire earns it
 * for the same reason (R6 #11).
 *
 * Field-wise rather than zod, matching `panel-sizes.ts`: zod lives in
 * `@orquester/config` and a provider row is a wire shape, not on-disk state.
 */
export function sanitizeProviderSnapshot(value: unknown): ProviderSnapshot | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  const capabilities = isRecord(value.capabilities)
    ? (() => {
        // `goals` is taken out of the spread and put back only once it has
        // been read field-wise (goals §8.1).
        const { goals: rawGoals, ...rest } = value.capabilities;
        const goals = sanitizeGoalSupport(rawGoals);
        return {
          ...FALLBACK_CAPABILITIES,
          ...(rest as Partial<AdapterCapabilities>),
          // A present block still has to carry the two the UI branches on.
          showPlanModeToggle: value.capabilities.showPlanModeToggle === true,
          reportsContextWindow: value.capabilities.reportsContextWindow === true,
          ...(goals !== undefined ? { goals } : {})
        };
      })()
    : FALLBACK_CAPABILITIES;
  // An unreadable auth block is `unknown`, never a sign-in verdict: guessing
  // `unauthenticated` here would toast "sign in again" at a provider that is
  // signed in perfectly well.
  const auth: ProviderAuth = isRecord(value.auth) && isAuthStatus(value.auth.status)
    ? { ...(value.auth as unknown as ProviderAuth), status: value.auth.status }
    : { status: "unknown" };
  const refIds = asArray<unknown>(value.refIds).filter(
    (refId): refId is string => typeof refId === "string"
  );
  return {
    ...(value as unknown as ProviderSnapshot),
    // `refIds` keys the rate-limit fan-out and the composer's provider lookup;
    // an empty one would silently orphan the row, so fall back to the id.
    refIds: refIds.length > 0 ? refIds : [value.id],
    auth,
    models: asArray(value.models),
    slashCommands: asArray(value.slashCommands),
    skills: asArray(value.skills),
    capabilities
  } as ProviderSnapshot;
}

/** Repair a whole catalog, dropping only the rows that cannot be repaired. */
export function sanitizeProviderSnapshots(value: unknown): ProviderSnapshot[] {
  return asArray<unknown>(value)
    .map(sanitizeProviderSnapshot)
    .filter((provider): provider is ProviderSnapshot => provider !== null);
}

export const providersStore: ProvidersStore = createStore<ProvidersState>()(() => INITIAL);

let inFlight: Promise<void> | null = null;
let boundTransport: AgentChatTransport | null = null;

/**
 * Where a snapshot's ambient facts go (§7.7).
 *
 * `auth.status` and `account.rate-limits.updated` are **not thread facts**
 * (§5.1): they update the provider snapshot and surface outside the chat — the
 * Settings usage overview merges rate-limit windows by id, and an auth error
 * becomes a toast pointing at Settings → Accounts. The app store owns both
 * surfaces, and this module is imported by it, so the sinks are registered
 * rather than imported: a direct import would be a cycle between the store and
 * the cache the store feeds.
 */
export interface ProviderSideEffects {
  onRateLimits?(agentRefId: string, update: ProviderUsageLimitsUpdate): void;
  onAuthError?(error: {
    agentName: string;
    message: string;
    adapterId: AgentAdapterId;
    tone: ProviderNoticeTone;
    providerStatus: ProviderSnapshot["status"];
    authStatus: ProviderAuth["status"];
  }): void;
}

/**
 * Which copy the ambient notice gets.
 *
 * `"sign-in"` is T3's alarming title — "<provider> is unauthenticated" — and
 * it is reserved for a snapshot that can PROVE the credential is the problem.
 * `"status"` is T3's neutral title, "<provider> provider status", for a
 * snapshot that merely failed.
 *
 * *T3: `ProviderStatusBanner.tsx:78-81`.*
 */
export type ProviderNoticeTone = "sign-in" | "status";

export interface ProviderAuthNotice {
  message: string;
  tone: ProviderNoticeTone;
  /** Part of the dismissal key, so the same verdict never re-toasts. */
  providerStatus: ProviderSnapshot["status"];
  authStatus: ProviderAuth["status"];
}

let sideEffects: ProviderSideEffects = {};

export function setProviderSideEffects(next: ProviderSideEffects): void {
  sideEffects = next;
}

/**
 * The auth message for a snapshot, or null when the provider is fine.
 *
 * §7.7: "`auth.status` with an error surfaces a toast pointing at Settings →
 * Accounts."
 *
 * **This is one half of a value contract with the host, and the two halves
 * have disagreed once already** (V1 §9, R8-M4).
 *
 * **`unknown` is NOT `unauthenticated`** (§7.7, T3 `providerStatus.ts:44-79`
 * and `ProviderStatusBanner.tsx:9-32,78-81`). Only a snapshot that can *prove*
 * the credential is the problem — `auth.status: "unauthenticated"`, which
 * Codex reads off `account/read` and Grok off an explicit "not logged in", and
 * which the Claude probe deliberately no longer manufactures from a silent
 * init result — earns the "needs signing in again" copy. Everything else is an
 * ambiguity, and telling a user to re-authenticate an account that is signed
 * in perfectly well is worse than saying nothing.
 *
 * A snapshot that merely FAILED still gets an ambient notice, but with T3's
 * neutral copy and only while the CLI is actually installed: an uninstalled
 * provider is a Settings → Agents problem, not a credential one, and
 * `status: "degraded"` is not here at all (the Codex and OpenCode probes set it
 * for version advisories that have nothing to do with credentials).
 */
export function authErrorNotice(provider: ProviderSnapshot): ProviderAuthNotice | null {
  const label = provider.refIds[0] ?? provider.id;
  const key = { providerStatus: provider.status, authStatus: provider.auth.status } as const;
  if (provider.auth.status === "unauthenticated") {
    return {
      ...key,
      tone: "sign-in",
      message:
        provider.auth.label ?? `${label} is not signed in. Open Settings → Accounts.`
    };
  }
  if (
    provider.status === "error" &&
    provider.auth.status !== "authenticated" &&
    provider.installed
  ) {
    return {
      ...key,
      tone: "status",
      message: provider.message ?? `${label} is unavailable.`
    };
  }
  return null;
}

/** The notice's copy, or null when the provider is fine. */
export function authErrorMessage(provider: ProviderSnapshot): string | null {
  return authErrorNotice(provider)?.message ?? null;
}

/** Fan a fresh snapshot out to the ambient surfaces of §7.7. Never throws. */
function publishAmbientFacts(providers: readonly ProviderSnapshot[]): void {
  for (const provider of providers) {
    try {
      if (provider.usageLimits && provider.usageLimits.windows.length > 0) {
        // Merged by window id, so a sparse turn-driven update and a full probe
        // land on the same row (§4.1).
        for (const refId of provider.refIds) {
          sideEffects.onRateLimits?.(refId, { windows: provider.usageLimits.windows });
        }
      }
      const notice = authErrorNotice(provider);
      if (notice === null) {
        continue;
      }
      // Raised on every read; the app store remembers dismissals per
      // `(adapterId, status, auth.status, message)` — T3's own banner key
      // (`ProviderStatusBanner.tsx:20-23`) — and drops a repeat, so this stays
      // a plain publish with one memory rather than two that can disagree
      // (Q2-11).
      sideEffects.onAuthError?.({
        adapterId: provider.id,
        agentName: provider.refIds[0] ?? provider.id,
        ...notice
      });
    } catch {
      // An ambient surface must never be able to blank the provider catalog.
    }
  }
}

/**
 * Read the catalog, coalescing concurrent callers. Safe to call from every
 * mounted composer: the second caller joins the first request.
 */
export function loadProviders(
  transport: AgentChatTransport,
  options?: { force?: boolean }
): Promise<void> {
  const state = providersStore.getState();
  if (!options?.force && boundTransport === transport && state.loadedAt !== null) {
    return Promise.resolve();
  }
  if (inFlight && boundTransport === transport && !options?.force) {
    return inFlight;
  }
  boundTransport = transport;
  providersStore.setState({ loading: true, error: null });
  inFlight = transport
    .providers()
    .then((response) => {
      // Every row is repaired before it reaches typed state (R6 #11).
      const providers = sanitizeProviderSnapshots(response.providers);
      providersStore.setState({
        providers,
        hostInstanceId: response.hostInstanceId,
        loading: false,
        error: null,
        loadedAt: new Date().toISOString()
      });
      publishAmbientFacts(providers);
    })
    .catch((error: unknown) => {
      providersStore.setState({
        loading: false,
        // One unrenderable provider must not blank the composer's chips, so a
        // failed read keeps the last good catalog and only records the error.
        error: error instanceof Error ? error.message : "Could not read the provider catalog.",
        loadedAt: providersStore.getState().loadedAt
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The bus hook: call this from the app store's `agent.providers.changed`
 * handler. The event is coarse by design — it carries at most the adapter id,
 * and the client re-reads (§6.4).
 */
export function notifyProvidersChanged(_payload?: { adapterId?: AgentAdapterId }): void {
  if (!boundTransport) {
    return;
  }
  void loadProviders(boundTransport, { force: true });
}

/**
 * `POST /api/agent/providers/:id/refresh` — an explicit user action, and the
 * only refresh allowed to re-read model catalogs (§6.3).
 */
export async function refreshProvider(
  transport: AgentChatTransport,
  adapterId: AgentAdapterId,
  cwd?: string
): Promise<void> {
  const response = await transport.refreshProvider(adapterId, cwd ? { cwd } : {});
  const refreshed = sanitizeProviderSnapshot(response.provider);
  if (!refreshed) {
    return;
  }
  providersStore.setState((state) => ({
    // Append when the id is absent: an adapter that becomes available only
    // after the first load — the user installs an agent and hits Refresh —
    // was otherwise discarded silently (fix-wave Q2-12).
    providers: state.providers.some((provider) => provider.id === refreshed.id)
      ? state.providers.map((provider) => (provider.id === refreshed.id ? refreshed : provider))
      : [...state.providers, refreshed],
    loadedAt: new Date().toISOString()
  }));
  publishAmbientFacts([refreshed]);
}

/** Resolve the adapter serving a registry id (claude ← claude/claudex/claudemix). */
export function providerForRefId(
  providers: readonly ProviderSnapshot[],
  refId: string
): ProviderSnapshot | null {
  return providers.find((provider) => provider.refIds.includes(refId)) ?? null;
}

/** Test seam. */
export function resetProvidersStore(): void {
  providersStore.setState(INITIAL, true);
  inFlight = null;
  boundTransport = null;
  sideEffects = {};
}
