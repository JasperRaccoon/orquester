import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KNOWLEDGE_DEFAULT_SETTINGS, type AgentAccountsResponse, type KnowledgeSettings, type SessionSummary } from "@orquester/api";
import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";
import type { DaemonApi } from "../../chat-client/index.ts";
import type { AccountsReader } from "../../workflows/contracts.ts";
import { emptyMemory } from "../../workflows/agent/failover.ts";
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
  it("automatic: least used over the Claude accounts (the system login only without any), Sonnet by default", () => {
    const [entry] = knowledgeWorkerChain(settings(), accounts(["c1", "c2", "cx1"]));
    assert.equal(entry!.agent, "claude");
    assert.equal(entry!.model, "sonnet");
    assert.equal(entry!.accounts.strategy, "least-used");
    assert.equal(entry!.accounts.includeSystem, false);
    assert.equal(knowledgeWorkerChain(settings(), accounts([]))[0]!.accounts.includeSystem, true);
  });

  it("a chosen account goes first, every other Claude account after it (failover)", () => {
    const [entry] = knowledgeWorkerChain(settings({ accountId: "c2", model: "opus" }), accounts(["c1", "c2", "c3", "cx1"]));
    assert.equal(entry!.model, "opus");
    assert.equal(entry!.accounts.strategy, "fixed");
    assert.deepEqual(entry!.accounts.accounts, ["c2", "c1", "c3"]);
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
        { turnId: "t1", state: "completed", tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 100, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 40, hasSubagents: false } },
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

  it("counts every input token of the chat's turns (cached and cache writes included) and closes the tab", async () => {
    const { api, requests } = fakeApi();
    const sessions = port(api);
    assert.deepEqual(await sessions.usage("s1"), { in: 1050, out: 40 });
    await sessions.stop("s1", { interrupt: true });
    assert.ok(requests.some((r) => r.path === agentChatCommandPath("s1", "interrupt")));
    assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/api/sessions/s1"));
  });
});
