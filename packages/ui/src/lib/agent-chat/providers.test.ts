/**
 * Fix-wave regressions for the provider-snapshot cache (Q2-11, Q2-12, and the
 * `auth.status {error}` toast the arbitration routes here).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AdapterCapabilities, ProviderSnapshot } from "@orquester/api/agent-chat";

import {
  authErrorMessage,
  authErrorNotice,
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

describe("authErrorNotice — `unknown` is not `unauthenticated` (§7.7, T3 §7)", () => {
  it("names an unauthenticated provider, and earns the SIGN-IN copy", () => {
    const notice = authErrorNotice(provider({ auth: { status: "unauthenticated" } }));
    assert.match(notice?.message ?? "", /not signed in/);
    assert.equal(notice?.tone, "sign-in");
  });

  it("gives `status: error` + `unauthenticated` the alarming tone as well", () => {
    // T3 `ProviderStatusBanner.tsx:78-81`: the "<provider> is unauthenticated"
    // title is `status === "error" && auth.status === "unauthenticated"`.
    const notice = authErrorNotice(
      provider({ status: "error", auth: { status: "unauthenticated" }, message: "401" })
    );
    assert.equal(notice?.tone, "sign-in");
  });

  it("never tells an `unknown` provider to sign in — it gets the NEUTRAL tone", () => {
    const notice = authErrorNotice(
      provider({ status: "error", auth: { status: "unknown" }, message: "token expired" })
    );
    assert.equal(notice?.message, "token expired");
    assert.equal(notice?.tone, "status", "an ambiguity is never a credential verdict");
  });

  it("says nothing at all for an `unknown` provider that merely is not installed", () => {
    // Settings → Agents, not Settings → Accounts: an absent CLI has no
    // credential to fix, and a toast pointing at accounts is pure noise.
    assert.equal(
      authErrorNotice(
        provider({ installed: false, status: "error", auth: { status: "unknown" }, message: "not installed" })
      ),
      null
    );
  });

  it("is silent for a healthy provider, and for an errored one that IS signed in", () => {
    assert.equal(authErrorMessage(provider()), null);
    assert.equal(
      authErrorMessage(provider({ status: "error", auth: { status: "authenticated" } })),
      null
    );
  });

  it("carries the two snapshot columns the dismissal key spans", () => {
    const notice = authErrorNotice(
      provider({ status: "error", auth: { status: "unauthenticated" } })
    );
    assert.equal(notice?.providerStatus, "error");
    assert.equal(notice?.authStatus, "unauthenticated");
  });

  it("is silent for a PENDING snapshot — nobody has looked at that provider yet", () => {
    // Host §3.2 layer one seeds every provider with this shape at construction
    // so `GET /providers` is never `[]`. It claims no verdict, so it must not
    // read as "sign in again": `status` is `unknown`, deliberately never
    // `error`, and `auth.status` is `unknown`, never `unauthenticated`.
    const pending = provider({
      installed: false,
      version: null,
      status: "unknown",
      auth: { status: "unknown" },
      message: "Claude provider status has not been checked in this session yet.",
      models: [{ slug: "default", name: "Default", isDefault: true, capabilities: null }]
    });
    assert.equal(authErrorNotice(pending), null);
    assert.equal(authErrorMessage(pending), null);
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

describe("R8-M4 hop 3 — the values the host actually writes reach the toast", () => {
  /**
   * V1 §9 found the two halves of this contract disagreeing: the host marked an
   * `auth.status {error}` one way and the client tested for another, so the
   * toast could never fire in production while both suites stayed green. These
   * cases pin the client half to the two markings the host writes, and — just
   * as importantly — to the one it writes for non-credential trouble.
   */
  const raise = (): Array<{ adapterId: string; agentName: string; message: string; tone: string }> => {
    const raised: Array<{ adapterId: string; agentName: string; message: string; tone: string }> = [];
    setProviderSideEffects({ onAuthError: (error) => raised.push(error) });
    return raised;
  };

  it("toasts end-to-end when the host writes `auth: unauthenticated`", async () => {
    const raised = raise();
    await loadProviders(
      transportServing([
        provider({
          id: "codex",
          refIds: ["codex"],
          status: "error",
          auth: { status: "unauthenticated", label: "Codex sign-in expired." }
        })
      ]),
      { force: true }
    );
    assert.deepEqual(raised, [
      {
        adapterId: "codex",
        agentName: "codex",
        message: "Codex sign-in expired.",
        tone: "sign-in",
        providerStatus: "error",
        authStatus: "unauthenticated"
      }
    ]);
  });

  it("still surfaces `status: error` with auth unresolved — but never as a sign-in demand", async () => {
    const raised = raise();
    await loadProviders(
      transportServing([
        provider({ status: "error", auth: { status: "unknown" }, message: "401 from the API" })
      ]),
      { force: true }
    );
    assert.deepEqual(raised, [
      {
        adapterId: "claude",
        agentName: "claude",
        message: "401 from the API",
        tone: "status",
        providerStatus: "error",
        authStatus: "unknown"
      }
    ]);
  });

  it("stays silent for `status: degraded`, which is not a credential verdict", async () => {
    // The Codex and OpenCode probes set `degraded` for a missing binary or a
    // version advisory. Widening the predicate to cover it would turn every
    // such snapshot into a "sign in again" toast — the failure mode this row
    // must never trade for the one it fixed.
    const raised = raise();
    await loadProviders(
      transportServing([
        provider({
          status: "degraded",
          auth: { status: "unknown" },
          message: "codex is 2 minor versions behind"
        })
      ]),
      { force: true }
    );
    assert.deepEqual(raised, []);
  });

  it("reports a refresh's auth error too, not just the catalog read", async () => {
    await loadProviders(transportServing([provider()]), { force: true });
    const raised = raise();
    await refreshProvider(
      transportServing([provider()], provider({ auth: { status: "unauthenticated" } })),
      "claude"
    );
    assert.equal(raised.length, 1);
    assert.match(raised[0]!.message, /not signed in/);
  });
});

describe("R6 #11 — a provider row from an older host is repaired, never trusted", () => {
  /**
   * §8: a host that survived a deploy runs OLD code, so the wire can hand this
   * client a snapshot shape it predates. Consumers read
   * `provider?.capabilities.showPlanModeToggle` — the `?.` guards the provider,
   * not the block — so one such row used to crash the composer for every thread.
   */
  const load = async (rows: unknown[]): Promise<ProviderSnapshot[]> => {
    await loadProviders(
      {
        async providers() {
          return { providers: rows, hostInstanceId: "h1" };
        }
      } as unknown as AgentChatTransport,
      { force: true }
    );
    return providersStore.getState().providers;
  };

  it("defaults a missing `capabilities` block to the withholding shape", async () => {
    const [row] = await load([
      { id: "claude", refIds: ["claude"], status: "ready", auth: { status: "authenticated" } }
    ]);
    assert.ok(row, "the row survives rather than being dropped");
    assert.equal(row.capabilities.showPlanModeToggle, false);
    assert.equal(row.capabilities.reportsContextWindow, false);
    assert.equal(row.capabilities.supportsConversationRollback, false);
    assert.equal(row.capabilities.sessionModelSwitch, "unsupported");
  });

  it("keeps what a partial `capabilities` block does carry", async () => {
    const [row] = await load([
      {
        id: "claude",
        refIds: ["claude"],
        capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: true }
      }
    ]);
    assert.equal(row?.capabilities.sessionModelSwitch, "in-session");
    assert.equal(row?.capabilities.showPlanModeToggle, true);
    // Absent from the older block, so it withholds rather than guesses.
    assert.equal(row?.capabilities.reportsContextWindow, false);
  });

  it("defaults the list fields so `.map` on them cannot throw", async () => {
    const [row] = await load([{ id: "grok", capabilities }]);
    assert.deepEqual(row?.models, []);
    assert.deepEqual(row?.slashCommands, []);
    assert.deepEqual(row?.skills, []);
    // An empty `refIds` would orphan the row from every lookup and from the
    // rate-limit fan-out, so it falls back to the adapter id.
    assert.deepEqual(row?.refIds, ["grok"]);
  });

  it("repairs a missing `auth` block into `unknown` rather than toasting or crashing", async () => {
    const raised: string[] = [];
    setProviderSideEffects({ onAuthError: ({ message }) => raised.push(message) });
    const [row] = await load([{ id: "claude", refIds: ["claude"], status: "ready", capabilities }]);
    assert.equal(row?.auth.status, "unknown");
    assert.deepEqual(raised, [], "an unreadable auth block is not a sign-in verdict");
  });

  it("drops only the rows that cannot be repaired, keeping the rest of the catalog", async () => {
    const rows = await load([
      null,
      { refIds: ["claude"] },
      { id: "codex", refIds: ["codex"], capabilities }
    ]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["codex"]
    );
  });
});
