import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWLEDGE_DEFAULT_ACCOUNT_POLICY,
  KNOWLEDGE_DEFAULT_SETTINGS,
  type AgentAccountsResponse,
  type KnowledgeSettings,
  type SessionSummary,
  type UsageResponse
} from "@orquester/api";
import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";
import type { AccountPolicy } from "@orquester/config";
import type { DaemonApi } from "../../chat-client/index.ts";
import type { AccountsReader } from "../../workflows/contracts.ts";
import { emptyMemory } from "../../workflows/agent/failover.ts";
import { selectAccount } from "../../workflows/agent/select.ts";
import { knowledgeSettingsFrom } from "../settings.ts";
import { FakeClock } from "../../workflows/agent/testing/fake-clock.ts";
import { createDaemonWorkerSessions, knowledgeWorkerChain, type DaemonWorkerCandidate } from "./daemon-workers.ts";
import { KNOWLEDGE_INDEXER_PROFILE_ID, KNOWLEDGE_WORKER_PROMPT } from "./indexer-profile.ts";
import { WorkerStartError } from "./workers.ts";

const accounts = (ids: string[]): AccountsReader => ({
  list: (): AgentAccountsResponse => ({
    accounts: ids.map((id) => ({ id, agent: id.startsWith("cx") ? "codex" : "claude", label: id, email: null, plan: null, needsReauth: false, createdAt: "t", importedAt: "t" })),
    defaults: { claude: null, codex: null, grok: null }
  })
});

const settings = (patch: Partial<KnowledgeSettings> = {}): KnowledgeSettings => ({ ...KNOWLEDGE_DEFAULT_SETTINGS, ...patch });

describe("knowledgeWorkerChain", () => {
  const NOW = new Date("2026-10-26T12:00:00.000Z");
  const at = (hours: number): string => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
  const row = (id: string, session: number, weekly: number, weeklyResetHours: number) => ({
    id,
    label: id,
    available: true,
    stale: false,
    session: { percent: session, resetsAt: at(2) },
    weekly: { percent: weekly, resetsAt: at(weeklyResetHours) },
    asOf: at(-0.05)
  });
  // c1 is the most used (60% weekly), c3 the least (40%) and resets soonest; c2 has the least weekly use.
  const usage = {
    agents: [
      {
        id: "claude",
        available: true,
        stale: false,
        session: null,
        weekly: null,
        asOf: at(-0.05),
        accounts: [row("c1", 10, 60, 72), row("c2", 50, 20, 120), row("c3", 5, 40, 24)],
        aggregate: { strategy: "worst-account", accountCount: 3 }
      }
    ]
  } as unknown as UsageResponse;
  const ids = ["c1", "c2", "c3", "cx1"];
  /** Who the workflow selection runs the chain on: the chosen account, else null. */
  const chosen = (value: KnowledgeSettings, accountIds = ids): string | null =>
    selectAccount({ chain: knowledgeWorkerChain(value), usage, accounts: accounts(accountIds).list(), cooldowns: {}, now: NOW }).chosen?.accountId ?? null;
  const read = (stored: unknown, accountIds = ids) => knowledgeSettingsFrom(stored, accountIds.filter((id) => !id.startsWith("cx")));
  const policy = (patch: Partial<AccountPolicy>): KnowledgeSettings => settings({ accountPolicy: { ...KNOWLEDGE_DEFAULT_ACCOUNT_POLICY, ...patch } });

  it("one Claude entry carrying the settings' policy as it is, Sonnet by default", () => {
    const value = policy({ strategy: "soonest-reset", maxWeeklyPct: 80 });
    const [entry, ...rest] = knowledgeWorkerChain(value);
    assert.deepEqual(rest, []);
    assert.equal(entry!.agent, "claude");
    assert.equal(entry!.model, "sonnet");
    assert.deepEqual(entry!.accounts, value.accountPolicy);
    assert.equal(knowledgeWorkerChain(settings({ model: "opus" }))[0]!.model, "opus");
  });

  it("legacy automatic (no record, accountId null): the least used Claude account; the System login only without any", () => {
    for (const stored of [undefined, {}, { accountId: null, concurrency: 2 }]) {
      const value = read(stored);
      assert.deepEqual(value.accountPolicy, KNOWLEDGE_DEFAULT_ACCOUNT_POLICY);
      assert.equal(chosen(value), "c3");
    }
    const none = read({ accountId: null }, []);
    assert.equal(none.accountPolicy.includeSystem, true);
    assert.equal(chosen(none, []), "system");
  });

  it("a legacy chosen account goes first, every other Claude account after it (failover)", () => {
    const value = read({ accountId: "c2", model: "opus" });
    assert.equal(value.accountPolicy.strategy, "fixed");
    assert.deepEqual(value.accountPolicy.accounts, ["c2", "c1", "c3"]);
    assert.equal(value.accountPolicy.includeSystem, false);
    assert.equal(chosen(value), "c2");
    const [entry] = knowledgeWorkerChain(value);
    assert.equal(entry!.model, "opus");
    // The legacy System login choice keeps the System login first.
    const system = read({ accountId: "system" });
    assert.deepEqual(system.accountPolicy.accounts, ["system", "c1", "c2", "c3"]);
    assert.equal(system.accountPolicy.includeSystem, true);
  });

  it("each strategy, the allow-list, the caps and unknown usage choose as a workflow Agent block does", () => {
    assert.equal(chosen(policy({ strategy: "least-used" })), "c3");
    assert.equal(chosen(policy({ strategy: "least-used", leastUsedMetric: "weekly" })), "c2");
    assert.equal(chosen(policy({ strategy: "least-used", accounts: ["c1", "c2"] })), "c2");
    assert.equal(chosen(policy({ strategy: "soonest-reset" })), "c3");
    assert.equal(chosen(policy({ strategy: "soonest-reset", accounts: ["c1", "c2"] })), "c1");
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["c1", "c3"] })), "c1");
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["c1", "c3"], maxWeeklyPct: 50 })), "c3");
    assert.equal(chosen(policy({ strategy: "least-used", maxWeeklyPct: 30 })), "c2");
    assert.equal(chosen(policy({ strategy: "least-used", maxSessionPct: 5, maxWeeklyPct: 30 })), null);
    // An account with no usage reading: tried after the others, or never.
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["c4"] }), [...ids, "c4"]), "c4");
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["c4"], unknownUsage: "exclude" }), [...ids, "c4"]), null);
    // The System login as a candidate (here with no usage reading, so after every account with one).
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["system"] })), "system");
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["system", "c1"] })), "c1");
    assert.equal(chosen(policy({ strategy: "fixed", accounts: ["c1"], includeSystem: true, maxWeeklyPct: 50 })), "system");
  });
});

describe("createDaemonWorkerSessions", () => {
  function fakeApi(options: { createStatus?: number; createCode?: string } = {}) {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const summary: SessionSummary = {
      id: "s1",
      kind: "agent-chat",
      refId: "claude",
      title: "Knowledge indexer",
      projectPath: "/plugin/workers",
      cwd: "/plugin/workers",
      cols: 0,
      rows: 0,
      status: "running",
      order: 0,
      createdAt: "2026-10-23T10:00:00.000Z"
    };
    const snapshot = {
      head: { session: { status: "ready", activeTurnId: null } },
      turns: [
        // The adapters' convention: `inputTokens` already holds the cache reads and writes (100 fresh + 900 + 50).
        { turnId: "t1", state: "completed", tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1050, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 40, hasSubagents: false } },
        { turnId: "t2", state: "completed" }
      ],
      items: [],
      pending: { approvals: [], userInputs: [] }
    };
    const api = {
      async request(method: string, path: string, opts?: { body?: unknown }) {
        requests.push({ method, path, ...(opts?.body !== undefined ? { body: opts.body } : {}) });
        if (method === "POST" && path === "/api/sessions") {
          if (options.createStatus) return { status: options.createStatus, body: { code: options.createCode, message: "refused" } };
          return { status: 200, body: summary };
        }
        if (method === "GET" && path === "/api/sessions") return { status: 200, body: [summary] };
        if (method === "GET" && path === agentChatRoutes.thread("s1")) return { status: 200, body: { kind: "snapshot", thread: snapshot } };
        if (method === "POST") return { status: 200, body: { seq: 1 } };
        if (method === "DELETE") return { status: 204, body: null };
        return { status: 404, body: { code: "NOT_FOUND", message: path } };
      },
      subscribe: () => () => undefined
    } as unknown as DaemonApi;
    return { api, requests };
  }

  const candidate: DaemonWorkerCandidate = {
    accountId: "c1",
    model: "sonnet",
    agent: { chainIndex: 0, agent: "claude", model: "sonnet", options: [], accountId: "c1", family: "claude", cooldownAccount: "c1" }
  };

  function port(api: DaemonApi, ensureProfile = async () => KNOWLEDGE_INDEXER_PROFILE_ID) {
    return createDaemonWorkerSessions({
      api,
      accounts: accounts(["c1"]),
      usage: { snapshot: () => ({ agents: [] }) as never },
      cooldowns: { get: () => null, set: async () => undefined, list: () => ({}) },
      clock: new FakeClock(),
      settings: () => settings(),
      workDir: "/plugin/workers",
      ensureProfile
    });
  }

  it("creates an unattended, full-access chat the indexer owns, in the empty workers dir, with the managed profile", async () => {
    const { api, requests } = fakeApi();
    const { sessionId } = await port(api).start({ candidate, runId: "kr_1", memory: emptyMemory() });
    assert.equal(sessionId, "s1");
    const create = requests.find((r) => r.method === "POST" && r.path === "/api/sessions")!;
    assert.deepEqual(create.body, {
      kind: "agent-chat",
      refId: "claude",
      projectPath: "/plugin/workers",
      cwd: "/plugin/workers",
      title: "Knowledge indexer · kr_1",
      accountId: "c1",
      profileId: KNOWLEDGE_INDEXER_PROFILE_ID,
      chat: { accountId: "c1", modelSelection: { model: "sonnet", options: [] }, runtimeMode: "full-access", unattended: true },
      owner: { kind: "knowledge-indexer", runId: "kr_1" }
    });
    const turn = requests.find((r) => r.path === agentChatCommandPath("s1", "turn"))!;
    assert.equal((turn.body as { input: string }).input, KNOWLEDGE_WORKER_PROMPT);
  });

  it("a refused create passes the account over; a profile that cannot be prepared is fatal", async () => {
    const refused = fakeApi({ createStatus: 400, createCode: "SESSION_UNAVAILABLE" });
    const memory = emptyMemory();
    await assert.rejects(port(refused.api).start({ candidate, runId: "kr_1", memory }), (error: unknown) => error instanceof WorkerStartError && !error.fatal);
    assert.deepEqual(memory.unusable, ["claude:c1"]);
    const profile = fakeApi({ createStatus: 400, createCode: "PROFILE_NOT_READY" });
    await assert.rejects(port(profile.api).start({ candidate, runId: "kr_1", memory: emptyMemory() }), (error: unknown) => error instanceof WorkerStartError && error.fatal);
    const noProfile = fakeApi();
    await assert.rejects(
      port(noProfile.api, async () => {
        throw new Error("disk full");
      }).start({ candidate, runId: "kr_1", memory: emptyMemory() }),
      (error: unknown) => error instanceof WorkerStartError && error.fatal && /disk full/.test(error.message)
    );
  });

  it("counts every input token of the chat's turns once (cached and cache writes are inside inputTokens) and closes the tab", async () => {
    const { api, requests } = fakeApi();
    const sessions = port(api);
    assert.deepEqual(await sessions.usage("s1"), { in: 1050, out: 40 });
    await sessions.stop("s1", { interrupt: true });
    assert.ok(requests.some((r) => r.path === agentChatCommandPath("s1", "interrupt")));
    assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/api/sessions/s1"));
  });
});
