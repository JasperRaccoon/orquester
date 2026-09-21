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

import type {
  AgentAdapterId,
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
  onAuthError?(error: { agentName: string; message: string; adapterId: AgentAdapterId }): void;
}

let sideEffects: ProviderSideEffects = {};

export function setProviderSideEffects(next: ProviderSideEffects): void {
  sideEffects = next;
}

/**
 * Auth messages already raised, keyed `<adapterId>\0<message>`.
 *
 * Every coarse `agent.providers.changed` forces a reload and every reload
 * re-publishes, so without this the toast came back the moment the user
 * dismissed it and the provider was still signed out (fix-wave Q2-11). The
 * same shape the thread error banner uses: a **different** message re-raises,
 * the same one does not.
 */
const raisedAuthMessages = new Set<string>();

/**
 * Forget a raised auth message so a later occurrence re-raises. The app
 * store calls this from `dismissAgentAuthError`; a provider that signs back
 * in clears its own entry below.
 */
export function forgetRaisedAuthError(adapterId: string, message: string): void {
  raisedAuthMessages.delete(`${adapterId}\u0000${message}`);
}

/**
 * The auth message for a snapshot, or null when the provider is fine.
 *
 * §7.7: "`auth.status` with an error surfaces a toast pointing at Settings →
 * Accounts." Both an explicit error status and a plain unauthenticated
 * provider are that toast — the difference is only how the daemon learned it.
 */
export function authErrorMessage(provider: ProviderSnapshot): string | null {
  const label = provider.refIds[0] ?? provider.id;
  if (provider.auth.status === "unauthenticated") {
    return provider.auth.label ?? `${label} is not signed in. Open Settings → Accounts.`;
  }
  // A provider whose snapshot carries an error while auth is unknown is the
  // `auth.status {error}` case W1 routes onto the snapshot.
  if (provider.status === "error" && provider.auth.status !== "authenticated") {
    return provider.message ?? `${label} could not authenticate. Open Settings → Accounts.`;
  }
  return null;
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
      const message = authErrorMessage(provider);
      if (message === null) {
        // Signed back in: the next failure is news again.
        for (const key of [...raisedAuthMessages]) {
          if (key.startsWith(`${provider.id}\u0000`)) {
            raisedAuthMessages.delete(key);
          }
        }
        continue;
      }
      const key = `${provider.id}\u0000${message}`;
      if (raisedAuthMessages.has(key)) {
        continue;
      }
      raisedAuthMessages.add(key);
      sideEffects.onAuthError?.({
        adapterId: provider.id,
        agentName: provider.refIds[0] ?? provider.id,
        message
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
      providersStore.setState({
        providers: response.providers,
        hostInstanceId: response.hostInstanceId,
        loading: false,
        error: null,
        loadedAt: new Date().toISOString()
      });
      publishAmbientFacts(response.providers);
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
  providersStore.setState((state) => ({
    // Append when the id is absent: an adapter that becomes available only
    // after the first load — the user installs an agent and hits Refresh —
    // was otherwise discarded silently (fix-wave Q2-12).
    providers: state.providers.some((provider) => provider.id === response.provider.id)
      ? state.providers.map((provider) =>
          provider.id === response.provider.id ? response.provider : provider
        )
      : [...state.providers, response.provider],
    loadedAt: new Date().toISOString()
  }));
  publishAmbientFacts([response.provider]);
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
  raisedAuthMessages.clear();
}
