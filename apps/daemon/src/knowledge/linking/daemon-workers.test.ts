import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWLEDGE_DEFAULT_ACCOUNT_POLICY,
  KNOWLEDGE_DEFAULT_SETTINGS,
  type AgentAccountsResponse,
  type KnowledgeSettings,
  type SessionSummary
} from "@orquester/api";
import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";
import type { DaemonApi } from "../../chat-client/index.ts";
import type { DaemonMethod } from "../../mcp/daemon-api.ts";
import type { AccountsReader } from "../../workflows/contracts.ts";
import { emptyMemory } from "../../workflows/agent/failover.ts";
import { FakeClock, flushAsync } from "../../workflows/agent/testing/fake-clock.ts";
import { createDaemonWorkerSessions, type DaemonWorkerCandidate } from "./daemon-workers.ts";
import { KNOWLEDGE_INDEXER_PROFILE_ID, KNOWLEDGE_WORKER_PROMPT } from "./indexer-profile.ts";
import { WorkerStartError } from "./workers.ts";

const accounts = (ids: string[]): AccountsReader => ({
  list: (): AgentAccountsResponse => ({
    accounts: ids.map((id) => ({ id, agent: "claude", label: id, email: null, plan: null, needsReauth: false, createdAt: "t", importedAt: "t" })),
    defaults: { claude: null, codex: null, grok: null }
  })
});

const settings = (patch: Partial<KnowledgeSettings> = {}): KnowledgeSettings => ({ ...KNOWLEDGE_DEFAULT_SETTINGS, ...patch });

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
        if (method === "GET" && path === "/api/registry") return { status: 200, body: { agents: [{ id: "claude", name: "Claude Code", enabled: true, chat: { adapter: "claude" } }] } };
        if (method === "GET" && path === agentChatRoutes.providers) return { status: 200, body: { providers: [{ id: "claude", installed: true, models: [{ slug: "sonnet", name: "Sonnet" }, { slug: "opus", name: "Opus" }] }] } };
        if (method === "GET" && path === "/api/agent-accounts") return { status: 200, body: accounts(["c1", "c2"]).list() };
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

  function port(api: DaemonApi, ensureProfile = async () => KNOWLEDGE_INDEXER_PROFILE_ID, currentSettings = () => settings()) {
    return createDaemonWorkerSessions({
      api,
      accounts: accounts(["c1", "c2"]),
      usage: { snapshot: () => ({ agents: [] }) as never },
      cooldowns: { get: () => null, set: async () => undefined, list: () => ({}) },
      clock: new FakeClock(),
      settings: currentSettings,
      workDir: "/plugin/workers",
      ensureProfile
    });
  }

  it("picks from the current account policy with Sonnet by default and the configured model after an edit", async () => {
    const { api } = fakeApi();
    let value = settings({ accountPolicy: { ...KNOWLEDGE_DEFAULT_ACCOUNT_POLICY, strategy: "fixed", accounts: ["c2"] } });
    const sessions = port(api, undefined, () => value);
    const first = await sessions.pick(emptyMemory());
    assert.ok(first.kind === "chosen");
    assert.equal(first.candidate.accountId, "c2");
    assert.equal(first.candidate.model, "sonnet");

    value = settings({ model: "opus", accountPolicy: { ...KNOWLEDGE_DEFAULT_ACCOUNT_POLICY, strategy: "fixed", accounts: ["c1"] } });
    const next = await sessions.pick(emptyMemory());
    assert.ok(next.kind === "chosen");
    assert.equal(next.candidate.accountId, "c1");
    assert.equal(next.candidate.model, "opus");
  });

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

  it("interrupt() resolves only once the interrupted turn has ended (on the session's events), so its usage counts", async () => {
    const { api, requests } = fakeApi();
    // The chat is mid-turn: t3 runs and has not reported its usage yet.
    let running = true;
    const thread = () => ({
      head: { session: { status: running ? "running" : "ready", activeTurnId: running ? "t3" : null } },
      turns: [
        { turnId: "t1", state: "completed", tokenUsage: { inputTokens: 1000, outputTokens: 40 } },
        running ? { turnId: "t3", state: "running" } : { turnId: "t3", state: "interrupted", tokenUsage: { inputTokens: 200, outputTokens: 7 } }
      ],
      items: [],
      pending: { approvals: [], userInputs: [] }
    });
    const listeners = new Set<(event: { channel: string; payload: unknown }) => void>();
    const base = api.request.bind(api);
    // Resolves when the wait first reads the thread after the interrupt was sent.
    let readAfterInterrupt!: () => void;
    const waiting = new Promise<void>((resolve) => (readAfterInterrupt = resolve));
    const live = {
      async request(method: DaemonMethod, path: string, opts?: { body?: unknown }) {
        if (method === "GET" && path === agentChatRoutes.thread("s1")) {
          requests.push({ method, path });
          if (requests.some((r) => r.path === agentChatCommandPath("s1", "interrupt"))) readAfterInterrupt();
          return { status: 200, body: { kind: "snapshot", thread: thread() } };
        }
        if (method === "GET" && path === "/api/sessions") {
          requests.push({ method, path });
          const [summary] = (await base(method, path)).body as SessionSummary[];
          return { status: 200, body: [{ ...summary, chatSessionStatus: running ? "running" : "ready" }] };
        }
        return base(method, path, opts);
      },
      subscribe: (listener: (event: { channel: string; payload: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as unknown as DaemonApi;
    const sessions = port(live);
    let ended = false;
    const interrupting = sessions.interrupt("s1").then(() => (ended = true));
    // The interrupt was sent and the session read: the turn has not ended yet.
    await waiting;
    await flushAsync();
    assert.equal(ended, false, "still running: interrupt() waits");
    // The turn ends; the session's event wakes the wait.
    running = false;
    for (const listener of listeners) listener({ channel: "sessions", payload: { id: "s1" } });
    await interrupting;
    assert.deepEqual(await sessions.usage("s1"), { in: 1200, out: 47 }, "the interrupted turn's usage counts");
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
