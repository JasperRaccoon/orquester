/**
 * Fix-wave regressions for the provider-snapshot cache (Q2-11, Q2-12, and the
 * `auth.status {error}` toast the arbitration routes here).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AdapterCapabilities, ProviderSnapshot } from "@orquester/api/agent-chat";

import {
  authErrorMessage,
  loadProviders,
  providerForRefId,
  providersStore,
  refreshProvider,
  resetProvidersStore,
  setProviderSideEffects
} from "./providers";
import type { AgentChatTransport } from "./transport";

const capabilities: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" }
};

const provider = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot =>
  ({
    id: "claude",
    refIds: ["claude"],
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    capabilities,
    ...overrides
  }) as ProviderSnapshot;

function transportServing(providers: ProviderSnapshot[], refreshed?: ProviderSnapshot) {
  return {
    async providers() {
      return { providers, hostInstanceId: "h1" };
    },
    async refreshProvider() {
      return { provider: refreshed ?? providers[0]!, changed: true };
    }
  } as unknown as AgentChatTransport;
}

beforeEach(() => {
  resetProvidersStore();
});

describe("authErrorMessage", () => {
  it("names an unauthenticated provider", () => {
    assert.match(authErrorMessage(provider({ auth: { status: "unauthenticated" } })) ?? "", /not signed in/);
  });

  it("names an `auth.status {error}` snapshot too", () => {
    const message = authErrorMessage(
      provider({ status: "error", auth: { status: "unknown" }, message: "token expired" })
    );
    assert.equal(message, "token expired");
  });

  it("is silent for a healthy provider, and for an errored one that IS signed in", () => {
    assert.equal(authErrorMessage(provider()), null);
    assert.equal(
      authErrorMessage(provider({ status: "error", auth: { status: "authenticated" } })),
      null
    );
  });
});

describe("Q2-11 — auth errors are published for the sink to de-duplicate", () => {
  it("publishes on every read, leaving dismissal memory to the app store", async () => {
    const raised: string[] = [];
    setProviderSideEffects({ onAuthError: ({ message }) => raised.push(message) });

    const signedOut = provider({ auth: { status: "unauthenticated" } });
    const transport = transportServing([signedOut]);
    await loadProviders(transport, { force: true });
    await loadProviders(transport, { force: true });
    assert.equal(raised.length, 2, "one memory, and it is the app store's");
    assert.match(raised[0]!, /not signed in/);
  });

  it("says nothing at all for a healthy catalog", async () => {
    const raised: string[] = [];
    setProviderSideEffects({ onAuthError: ({ message }) => raised.push(message) });
    await loadProviders(transportServing([provider()]), { force: true });
    assert.deepEqual(raised, []);
  });

  it("publishes an `auth.status {error}` snapshot as the same toast", async () => {
    const raised: string[] = [];
    setProviderSideEffects({ onAuthError: ({ message }) => raised.push(message) });
    await loadProviders(
      transportServing([
        provider({ status: "error", auth: { status: "unknown" }, message: "token expired" })
      ]),
      { force: true }
    );
    assert.deepEqual(raised, ["token expired"]);
  });
});

describe("Q2-12 — refresh appends a provider the catalog has not seen", () => {
  it("appends rather than silently dropping it", async () => {
    await loadProviders(transportServing([provider()]), { force: true });
    assert.equal(providersStore.getState().providers.length, 1);

    const codex = provider({ id: "codex", refIds: ["codex"] });
    await refreshProvider(transportServing([provider()], codex), "codex");
    assert.equal(providersStore.getState().providers.length, 2);
    assert.equal(providerForRefId(providersStore.getState().providers, "codex")?.id, "codex");
  });

  it("still replaces one it already has", async () => {
    await loadProviders(transportServing([provider()]), { force: true });
    const updated = provider({ version: "2" });
    await refreshProvider(transportServing([provider()], updated), "claude");
    assert.equal(providersStore.getState().providers.length, 1);
    assert.equal(providersStore.getState().providers[0]?.version, "2");
  });
});

describe("rate limits", () => {
  it("fans a snapshot's windows out per registry id, merged by window id", async () => {
    const seen: Array<{ refId: string; ids: string[] }> = [];
    setProviderSideEffects({
      onRateLimits: (refId, update) =>
        seen.push({ refId, ids: update.windows.map((window) => window.id) })
    });
    await loadProviders(
      transportServing([
        provider({
          refIds: ["claude", "claudex"],
          usageLimits: {
            checkedAt: "2026-01-01T00:00:00.000Z",
            windows: [{ id: "w1", kind: "weekly", label: "Weekly", usedPercent: 10 }]
          }
        })
      ]),
      { force: true }
    );
    assert.deepEqual(seen, [
      { refId: "claude", ids: ["w1"] },
      { refId: "claudex", ids: ["w1"] }
    ]);
  });
});
