/**
 * Agent host — the Claude adapter (spec §4.5 Claude).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts` and
 * `apps/server/src/provider/Layers/ClaudeProvider.ts`, translated from Effect
 * into plain promises and corrected against the traffic captured from the CLI
 * installed on this host (`apps/daemon/test/fixtures/claude/README.md`).
 *
 * The SDK's `query()` drives one CLI per thread with a streaming input kept
 * open across turns; `pathToClaudeCodeExecutable` is always the
 * registry-resolved `claude`, never the SDK's bundled copy (§10); env is
 * `CLAUDE_CONFIG_DIR` only, because relocating `HOME` also relocates the
 * keychain lookup and the CLI then reports "Not logged in" (§4.5).
 */

import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type {
  ApprovalDecision,
  ProviderSession,
  ProviderSnapshot,
  RuntimeEvent,
  ThreadSnapshot,
  WorkspaceSnapshot
} from "@orquester/api/agent-chat";

import type {
  AdapterContext,
  AdapterFactory,
  AgentAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput
} from "../../adapter.ts";
import { AsyncEventQueue } from "./async-queue.ts";
import { readClaudeResumeCursor, type ClaudeResumeCursor } from "./cursor.ts";
import { defaultClaudeAdapterDeps, type ClaudeAdapterDeps } from "./deps.ts";
import {
  claudeVersionGateMessage,
  meetsMinimumClaudeVersion,
  FALLBACK_CLAUDE_MODELS
} from "./models.ts";
import {
  buildClaudeSnapshot,
  buildClaudeWorkspaceSnapshot,
  CLAUDE_CAPABILITIES,
  CLAUDE_PROBE_CACHE_MS,
  CLAUDE_REF_IDS,
  mergeWorkspaceSnapshot,
  probeClaudeCapabilities,
  probeClaudeVersion,
  type ClaudeProbeResult
} from "./probe.ts";
import { ClaudeSession } from "./session.ts";
import type { ClaudeScopedLimitNames } from "./usage.ts";

/** The registry id whose `bin` the SDK is pointed at. */
const DEFAULT_REF_ID = "claude";

interface StartRecord {
  input: StartSessionInput;
  cursor: ClaudeResumeCursor | undefined;
}

export const createClaudeAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => createClaudeAdapterWith(context, defaultClaudeAdapterDeps());

/**
 * The tested seam. Production calls {@link createClaudeAdapter}; the lifecycle
 * tests inject a scripted `query` and a fake `spawn` so the real adapter runs
 * against a peer that speaks the same surface (§9).
 */
export async function createClaudeAdapterWith(
  context: AdapterContext,
  deps: ClaudeAdapterDeps
): Promise<AgentAdapter> {
  const events = new AsyncEventQueue<RuntimeEvent>();
  const sessions = new Map<string, ClaudeSession>();
  const starts = new Map<string, StartRecord>();

  let snapshot: ProviderSnapshot | undefined;
  let snapshotKey: string | undefined;
  let snapshotAtMs = 0;
  let inFlight: Promise<ProviderSnapshot> | undefined;
  let scopedLimitNames: ClaudeScopedLimitNames = {};
  let workspaceSnapshots: WorkspaceSnapshot[] = [];
  let usageStale = false;

  context.signal.addEventListener(
    "abort",
    () => {
      void stopAll().finally(() => events.close());
    },
    { once: true }
  );

  const emit = (batch: readonly RuntimeEvent[]): void => {
    events.pushAll(batch);
  };

  const probeEnv = (): Record<string, string> =>
    // A probe runs under the host's own identity: it must not bind an account
    // home, because it never authenticates and never opens a session (§4.1).
    context.buildEnv({ threadId: "agent-chat-probe", home: { kind: "system", path: "" } });

  const configDirOf = (env: Record<string, string>): string =>
    env.CLAUDE_CONFIG_DIR ?? nodePath.join(nodeOs.homedir(), ".claude");

  async function refreshSnapshot(input?: { cwd?: string }): Promise<ProviderSnapshot> {
    const cwd = input?.cwd;
    const binaryPath = await context.resolveBin(DEFAULT_REF_ID);
    const env = probeEnv();
    const key = `${binaryPath ?? ""}\u0000${configDirOf(env)}\u0000${cwd ?? ""}`;
    const fresh =
      snapshot !== undefined &&
      snapshotKey === key &&
      !usageStale &&
      context.clock.now().getTime() - snapshotAtMs < CLAUDE_PROBE_CACHE_MS;
    if (fresh && snapshot !== undefined) {
      return withWorkspaces(snapshot);
    }
    // Refreshes are serialised: two clients opening Settings must not run two
    // probes (§3.2).
    if (inFlight !== undefined) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let version: string | null = null;
        let probe: ClaudeProbeResult | undefined;
        if (binaryPath !== null) {
          version = await probeClaudeVersion({
            deps,
            executablePath: binaryPath,
            env,
            cwd: cwd ?? nodeOs.homedir()
          });
          if (meetsMinimumClaudeVersion(version)) {
            probe = await probeClaudeCapabilities({
              deps,
              executablePath: binaryPath,
              env,
              ...(cwd !== undefined ? { cwd } : {})
            });
          }
        }
        const built = buildClaudeSnapshot({
          checkedAt: context.clock.nowIso(),
          binaryPath,
          version,
          probe,
          ...(cwd !== undefined ? { cwd } : {}),
          configDir: configDirOf(env)
        });
        scopedLimitNames = built.scopedLimitNames;
        for (const session of sessions.values()) {
          session.normalizer.scopedLimitNames = scopedLimitNames;
        }
        if (cwd !== undefined) {
          workspaceSnapshots = mergeWorkspaceSnapshot(
            workspaceSnapshots,
            await buildClaudeWorkspaceSnapshot({
              cwd,
              configDir: configDirOf(env),
              checkedAt: built.snapshot.checkedAt
            })
          );
        }
        snapshot = built.snapshot;
        snapshotKey = key;
        snapshotAtMs = context.clock.now().getTime();
        usageStale = false;
        return withWorkspaces(built.snapshot);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  function withWorkspaces(base: ProviderSnapshot): ProviderSnapshot {
    return workspaceSnapshots.length > 0 ? { ...base, workspaceSnapshots } : base;
  }

  function models(): ProviderSnapshot["models"] {
    return snapshot?.models ?? [...FALLBACK_CLAUDE_MODELS];
  }

  async function ensureVersionGate(): Promise<string> {
    const binaryPath = await context.resolveBin(DEFAULT_REF_ID);
    if (binaryPath === null) {
      throw new Error(
        "The claude CLI is not installed or could not be resolved. Install it from Settings → Agents."
      );
    }
    const current = snapshot?.version ?? null;
    if (current !== null && meetsMinimumClaudeVersion(current)) {
      return binaryPath;
    }
    const version = await probeClaudeVersion({
      deps,
      executablePath: binaryPath,
      env: probeEnv(),
      cwd: nodeOs.homedir()
    });
    // A version gate refuses rather than degrades (§10): an out-of-range CLI
    // is never started and told to fail on the first unrecognised frame.
    if (!meetsMinimumClaudeVersion(version)) {
      throw new Error(claudeVersionGateMessage(version));
    }
    return binaryPath;
  }

  async function startSession(input: StartSessionInput): Promise<ProviderSession> {
    const existing = sessions.get(input.threadId);
    if (existing) {
      // One live session per thread: a resume cursor must never be advanced by
      // two processes (§3.1).
      await existing.stop("Replaced by a new session for this thread.");
    }

    const executablePath = await ensureVersionGate();
    // `home.proxyRefId` names the claudex/claudemix launcher whose extra env
    // (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, …) the host
    // attaches; the adapter passes it through untouched (§4.5).
    const env = context.buildEnv({ threadId: input.threadId, home: input.home });
    const cursor = readClaudeResumeCursor(input.resumeCursor);

    if (snapshot === undefined) {
      // A first session should not wait on a full probe, but it must not run
      // with an empty model catalogue either; the probe is cheap and cached.
      await refreshSnapshot({ cwd: input.cwd }).catch(() => undefined);
    }

    const session = new ClaudeSession({
      context,
      deps,
      threadId: input.threadId,
      cwd: input.cwd,
      home: input.home,
      runtimeMode: input.runtimeMode,
      modelSelection: input.modelSelection,
      models: models(),
      executablePath,
      env,
      ...(cursor !== undefined ? { resumeCursor: cursor } : {}),
      scopedLimitNames,
      emit,
      onClosed: (closed) => {
        // §4.1 "cursor per turn", plus Claude's own refresh on every assistant
        // message: the cursor a lazy recovery resumes from is the one the
        // dying session last held, not the one `sendTurn` happened to return.
        const start = starts.get(closed.threadId);
        const latest = closed.currentCursor();
        if (start !== undefined && latest !== undefined) {
          starts.set(closed.threadId, { ...start, cursor: latest });
        }
        if (sessions.get(closed.threadId) === closed) {
          sessions.delete(closed.threadId);
        }
      },
      onUsageLimitsStale: () => {
        usageStale = true;
      }
    });
    sessions.set(input.threadId, session);
    starts.set(input.threadId, { input, cursor });

    try {
      const record = await session.start();
      starts.set(input.threadId, { input, cursor: session.currentCursor() ?? cursor });
      // The per-cwd skills overlay is refreshed off the session start, forked
      // so it never delays the turn (§4.6.4).
      void refreshWorkspace(input.cwd);
      return record;
    } catch (error) {
      sessions.delete(input.threadId);
      throw error;
    }
  }

  function refreshWorkspace(cwd: string): void {
    void (async () => {
      try {
        const env = probeEnv();
        workspaceSnapshots = mergeWorkspaceSnapshot(
          workspaceSnapshots,
          await buildClaudeWorkspaceSnapshot({
            cwd,
            configDir: configDirOf(env),
            checkedAt: context.clock.nowIso()
          })
        );
      } catch {
        // Best effort: a failed scan keeps the previous overlay.
      }
    })();
  }

  /** §4.1 lazy recovery: a crashed session is indistinguishable from a fresh one. */
  async function ensureSession(threadId: string): Promise<ClaudeSession> {
    const live = sessions.get(threadId);
    if (live?.isAlive === true) {
      return live;
    }
    const start = starts.get(threadId);
    if (start === undefined) {
      throw new Error(`No Claude session has been started for thread ${threadId}.`);
    }
    await startSession({
      ...start.input,
      ...(start.cursor !== undefined ? { resumeCursor: start.cursor } : {})
    });
    const recovered = sessions.get(threadId);
    if (recovered === undefined) {
      throw new Error(`Could not recover the Claude session for thread ${threadId}.`);
    }
    return recovered;
  }

  async function sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    if (
      input.continuation === true &&
      input.input.trim().length === 0 &&
      input.attachments.length === 0
    ) {
      // Promptless continuation is validated, not assumed (§4.1): Claude does
      // not declare `promptlessTurnContinuation`.
      throw new Error(
        "Claude cannot continue a turn without a prompt. Send the continuation text with the turn."
      );
    }
    const session = await ensureSession(input.threadId);
    const result = await session.sendTurn({
      text: input.input,
      attachments: input.attachments,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      interactionMode: input.interactionMode
    });
    const start = starts.get(input.threadId);
    if (start !== undefined && result.resumeCursor !== undefined) {
      starts.set(input.threadId, { ...start, cursor: result.resumeCursor });
    }
    return {
      turnId: result.turnId,
      ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {})
    };
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...sessions.values()].map((session) => session.stop("Host is stopping.")));
    sessions.clear();
  }

  const adapter: AgentAdapter = {
    id: "claude",
    capabilities: CLAUDE_CAPABILITIES,

    startSession,
    sendTurn,

    async interruptTurn(threadId, turnId) {
      await sessions.get(threadId)?.interruptTurn(turnId);
    },

    async respondToApproval(threadId, requestId, decision: ApprovalDecision) {
      const session = sessions.get(threadId);
      if (session === undefined) {
        throw new Error(`No live Claude session for thread ${threadId}.`);
      }
      session.respondToApproval(requestId, decision);
    },

    async respondToUserInput(threadId, requestId, answers) {
      const session = sessions.get(threadId);
      if (session === undefined) {
        throw new Error(`No live Claude session for thread ${threadId}.`);
      }
      session.respondToUserInput(requestId, answers);
    },

    async compact(threadId) {
      const session = await ensureSession(threadId);
      await session.compact();
    },

    async readThread(threadId) {
      const session = sessions.get(threadId);
      if (session === undefined) {
        // A thread whose session is gone has no provider-side items to
        // reconcile; an empty snapshot is the truthful answer (§4.1).
        return { threadId, turns: [] } satisfies ThreadSnapshot;
      }
      return session.readThread();
    },

    async rollbackThread(threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        throw new Error("numTurns must be an integer >= 1.");
      }
      const session = await ensureSession(threadId);
      const start = starts.get(threadId);
      if (start === undefined) {
        throw new Error(`No Claude session has been started for thread ${threadId}.`);
      }
      // Phase 1: everything that can refuse runs BEFORE anything is torn down
      // or written (§5.5 step 2). A misaligned fork is a hard error here.
      const plan = await session.planRollback(numTurns);

      await session.stop("Rewinding the conversation.");
      const restarted = await startSession({
        ...start.input,
        ...(plan.cursor !== undefined ? { resumeCursor: plan.cursor } : { resumeCursor: undefined })
      });
      void restarted;
      const next = sessions.get(threadId);
      if (next === undefined) {
        throw new Error("The Claude session could not be restarted after the rewind.");
      }
      next.seedTurns(plan.retainedTurns);
      starts.set(threadId, { input: start.input, cursor: plan.cursor });
      return next.readThread();
    },

    listSessions() {
      return [...sessions.values()].map((session) => session.session);
    },

    hasSession(threadId) {
      return sessions.get(threadId)?.isAlive === true;
    },

    async stopSession(threadId) {
      await sessions.get(threadId)?.stop();
    },

    stopAll,

    refreshSnapshot,

    get events(): AsyncIterable<RuntimeEvent> {
      return events;
    }
  };

  return adapter;
}

export { CLAUDE_REF_IDS, CLAUDE_CAPABILITIES };
