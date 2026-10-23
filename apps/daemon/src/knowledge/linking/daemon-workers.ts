/**
 * Knowledge Graph linking — worker chats through the daemon's own API (`DaemonApi`), exactly the
 * way the workflow Agent block starts its unattended chats (`workflows/agent/create.ts`,
 * `executor.ts`): `POST /api/sessions` with
 *
 * - `kind: "agent-chat"`, `refId: "claude"`, an EXPLICIT `accountId` (the selection's), the
 *   indexing model, `runtimeMode: "full-access"`, `unattended: true`;
 * - `owner: {kind: "knowledge-indexer", runId}` — the session is the plugin's (never pushed, never
 *   a recent project, its usage-limit recovery left to this pool, hidden from the sidebar because
 *   its project is no project);
 * - `projectPath` = `cwd` = the plugin's empty workers dir (no project files, no CLAUDE.md);
 * - `profileId` = the managed "Knowledge indexer" profile (no items, no built-in tools).
 *
 * Then one turn (`KNOWLEDGE_WORKER_PROMPT`); the chat works through the worker tools inside it.
 * Accounts come from the Agent block's selection and failover (`select.ts`, `failover.ts`): the
 * chosen account first (`settings.accountId`, "fixed" order with every other Claude account
 * after it), else automatic (least used; the system login only when no Claude account is
 * managed), with the workflows' shared cooldowns. The watch is the Agent block's unattended
 * watcher (`watch.ts`); an open question or approval (none is expected) is answered the way a
 * workflow answers it.
 */

import {
  SYSTEM_ACCOUNT_ID,
  type CreateSessionRequest,
  type KnowledgeSessionOwner,
  type KnowledgeSettings,
  type SessionSummary
} from "@orquester/api";
import type { AgentChainEntry } from "@orquester/config";
import { readThread, sendCommand, ToolError, type DaemonApi } from "../../chat-client/index.ts";
import type { AccountsReader, Clock, CooldownStore, UsageReader } from "../../workflows/contracts.ts";
import { takeBaseline, type AgentBaseline } from "../../workflows/agent/classify.ts";
import { AgentCatalog, createSession, profileRefusalMessage } from "../../workflows/agent/create.ts";
import { candidateKey, coolDown, pickCandidate, type AgentCandidate, type FailoverDeps, type FailoverMemory } from "../../workflows/agent/failover.ts";
import { autonomousAnswers, autonomousDecision, observe, watchAgent } from "../../workflows/agent/watch.ts";
import { KNOWLEDGE_WORKER_PROMPT } from "./indexer-profile.ts";
import { WorkerStartError, type WorkerCandidate, type WorkerOutcome, type WorkerPick, type WorkerSessionPort } from "./workers.ts";

/** The indexing model when the settings name none (a Sonnet-class model). */
export const DEFAULT_KNOWLEDGE_MODEL = "sonnet";
/** A worker's turn never runs this long; past it the chat is treated as failed. */
const WATCH_DEADLINE_MS = 24 * 60 * 60_000;

export interface DaemonWorkerCandidate extends WorkerCandidate {
  agent: AgentCandidate;
}

export interface DaemonWorkerSessionsDeps {
  /** The always-on unix-socket app's client (`createInternalDaemonApi`). */
  api: DaemonApi;
  accounts: AccountsReader;
  usage: UsageReader;
  /** The workflows' shared cooldown store: a limit hit here cools the account for them too. */
  cooldowns: CooldownStore;
  clock: Clock;
  settings: () => KnowledgeSettings;
  /** `knowledgeWorkersDir(appdir)`, created by the caller. */
  workDir: string;
  /** Ensures the managed "Knowledge indexer" profile; answers its id. */
  ensureProfile: () => Promise<string>;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** The selection chain for the current settings (one Claude entry). */
export function knowledgeWorkerChain(settings: KnowledgeSettings, accounts: AccountsReader): AgentChainEntry[] {
  const model = settings.model?.trim() || DEFAULT_KNOWLEDGE_MODEL;
  const claude = accounts.list().accounts.filter((account) => account.agent === "claude").map((account) => account.id);
  const base = { soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
  const accountsPolicy = settings.accountId
    ? {
        ...base,
        strategy: "fixed" as const,
        accounts: [settings.accountId, ...claude.filter((id) => id !== settings.accountId)],
        includeSystem: settings.accountId === SYSTEM_ACCOUNT_ID
      }
    : { ...base, strategy: "least-used" as const, includeSystem: claude.length === 0 };
  return [{ agent: "claude", model, options: [], accounts: accountsPolicy }];
}

export function createDaemonWorkerSessions(deps: DaemonWorkerSessionsDeps): WorkerSessionPort<DaemonWorkerCandidate> {
  const failover: FailoverDeps = { usage: deps.usage, accounts: deps.accounts, cooldowns: deps.cooldowns, clock: deps.clock };
  const baselines = new Map<string, AgentBaseline>();

  const readBaseline = async (sessionId: string, summary?: SessionSummary): Promise<AgentBaseline> => {
    const obs = await observe(deps.api, sessionId);
    return takeBaseline(summary ?? obs?.summary ?? null, obs?.snapshot ?? null, deps.clock.now());
  };

  return {
    async pick(memory: FailoverMemory): Promise<WorkerPick<DaemonWorkerCandidate>> {
      const chain = knowledgeWorkerChain(deps.settings(), deps.accounts);
      const catalog = new AgentCatalog(deps.api);
      const pick = await pickCandidate(failover, chain, memory, 0, (candidate) => catalog.check(candidate));
      if (pick.kind === "none") {
        const resumesAt = pick.decision.earliestResetAt ?? null;
        return { kind: "none", reason: resumesAt ? "usage-limit" : "no-account", resumesAt, message: pick.decision.reason };
      }
      const agent = pick.candidate;
      return {
        kind: "chosen",
        candidate: { accountId: agent.accountId, ...(agent.accountLabel ? { accountLabel: agent.accountLabel } : {}), model: agent.model, agent }
      };
    },

    async start({ candidate, runId, memory }): Promise<{ sessionId: string }> {
      let profileId: string;
      try {
        profileId = await deps.ensureProfile();
      } catch (error) {
        throw new WorkerStartError(`The Knowledge indexer profile could not be prepared: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const owner: KnowledgeSessionOwner = { kind: "knowledge-indexer", runId };
      const agent = candidate.agent;
      const body: CreateSessionRequest = {
        kind: "agent-chat",
        refId: agent.agent,
        projectPath: deps.workDir,
        cwd: deps.workDir,
        title: `Knowledge indexer · ${runId}`,
        accountId: agent.accountId,
        profileId,
        chat: {
          accountId: agent.accountId,
          modelSelection: { model: agent.model, options: agent.options },
          runtimeMode: "full-access",
          unattended: true
        },
        owner
      };
      let summary: SessionSummary;
      try {
        summary = await createSession(deps.api, body);
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const refused = profileRefusalMessage(error.code, error.message, profileId);
        if (refused !== null) throw new WorkerStartError(refused, true);
        if (error.code !== "HOST_UNAVAILABLE") {
          // The daemon refused this launch (a gate, a missing account): pass the account over.
          const key = candidateKey(agent);
          if (!memory.unusable.includes(key)) memory.unusable.push(key);
        }
        throw new WorkerStartError(`The worker chat could not be created: ${error.message}`, false);
      }
      const baseline = await readBaseline(summary.id, summary);
      try {
        await sendCommand(deps.api, summary.id, "turn", { input: KNOWLEDGE_WORKER_PROMPT, interactionMode: "default" });
      } catch (error) {
        await closeSession(deps.api, summary.id);
        throw new WorkerStartError(`The worker chat could not be started: ${error instanceof Error ? error.message : String(error)}`, false);
      }
      baselines.set(summary.id, baseline);
      return { sessionId: summary.id };
    },

    async watch(sessionId: string, signal: AbortSignal): Promise<WorkerOutcome> {
      const baseline = baselines.get(sessionId) ?? (await readBaseline(sessionId));
      baselines.set(sessionId, baseline);
      const handled = new Set<string>();
      const deadlineAt = new Date(deps.clock.now().getTime() + WATCH_DEADLINE_MS);
      for (;;) {
        const outcome = await watchAgent({ api: deps.api, sessionId, baseline, clock: deps.clock, signal, deadlineAt, whenOnlyWatchLoopsRemain: "finish", handled });
        switch (outcome.kind) {
          case "done":
          case "plan":
            return { kind: "done" };
          case "failure":
            return {
              kind: "limit",
              reason: outcome.failure.reason,
              ...(outcome.failure.resetsAt ? { resetsAt: outcome.failure.resetsAt } : {}),
              message: outcome.failure.message
            };
          case "question":
            handled.add(outcome.request.requestId);
            await sendCommand(deps.api, sessionId, "answer", { requestId: outcome.request.requestId, answers: autonomousAnswers(outcome.request) }).catch(() => undefined);
            continue;
          case "approval":
            handled.add(outcome.request.requestId);
            await sendCommand(deps.api, sessionId, "approval", { requestId: outcome.request.requestId, decision: autonomousDecision(outcome.request) }).catch(() => undefined);
            continue;
          case "failed":
            return { kind: "failed", message: outcome.message };
          case "closed":
            return { kind: "closed" };
          case "timeout":
            return { kind: "failed", message: "The worker chat ran longer than a day." };
          case "cancelled":
            return { kind: "cancelled" };
        }
      }
    },

    async coolDown(candidate, memory, outcome): Promise<void> {
      await coolDown(failover, memory, candidate.agent, {
        reason: outcome.reason,
        ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}),
        message: outcome.message
      });
    },

    async usage(sessionId: string): Promise<{ in: number; out: number }> {
      const snapshot = await readThread(deps.api, sessionId);
      let tokensIn = 0;
      let tokensOut = 0;
      for (const turn of snapshot.turns) {
        const usage = turn.tokenUsage;
        if (!usage) continue;
        tokensIn += (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
        tokensOut += usage.outputTokens ?? 0;
      }
      return { in: tokensIn, out: tokensOut };
    },

    async stop(sessionId: string, options: { interrupt: boolean }): Promise<void> {
      baselines.delete(sessionId);
      if (options.interrupt) {
        await sendCommand(deps.api, sessionId, "interrupt", {}, { retryDelayMs: () => 0 }).catch(() => undefined);
      }
      await closeSession(deps.api, sessionId);
    },

    async isRunning(sessionId: string): Promise<boolean> {
      const obs = await observe(deps.api, sessionId);
      if (!obs?.summary) return false;
      const s = obs.summary;
      return s.latestTurn?.state === "running" || s.latestTurn?.state === "pending" || s.chatSessionStatus === "running" || s.chatSessionStatus === "starting";
    }
  };
}

async function closeSession(api: DaemonApi, sessionId: string): Promise<void> {
  try {
    await api.request("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    // A tab that is already gone, or a host that is down: nothing left to close.
  }
}
