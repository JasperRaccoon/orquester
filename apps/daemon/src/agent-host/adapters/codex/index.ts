/**
 * Agent host — the Codex adapter (spec §4, §4.5 Codex).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexAdapter.ts`,
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts`,
 * `apps/server/src/provider/Layers/CodexProvider.ts`,
 * `packages/effect-codex-app-server/src/{protocol,client}.ts`.
 *
 * One `codex app-server` child per thread, speaking hand-written NDJSON
 * JSON-RPC over stdio (`protocol.ts`) typed by the bindings generated from the
 * installed CLI (`_generated/`). Everything protocol-shaped lives in the
 * sibling modules; this file is the `AgentAdapter` surface and the per-thread
 * bookkeeping around it.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  AgentAdapterId,
  ApprovalDecision,
  ProviderSession,
  ProviderSnapshot,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type {
  AdapterContext,
  AdapterFactory,
  AgentAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput
} from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import { CODEX_ADAPTER_CAPABILITIES } from "./capabilities.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import { CodexPeer } from "./protocol.ts";
import {
  MINIMUM_CODEX_VERSION,
  codexVersionFromUserAgent,
  meetsMinimumVersion,
  probeCodex,
  uninstalledCodexSnapshot
} from "./probe.ts";
import { CodexSession, type CodexResumeCursor } from "./session.ts";
import type { RuntimeEventDraft } from "./normalise.ts";
import type { RuntimeEvent } from "@orquester/api/agent-chat";

const CODEX_ADAPTER_ID: AgentAdapterId = "codex";
/** The registry id whose resolved bin this adapter launches. */
const CODEX_REF_ID = "codex";

/** Providers snapshots are re-probed in the background on this cadence (§3.2). */
const SNAPSHOT_TTL_MS = 5 * 60_000;

export const createCodexAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  // Acquiring happens BEFORE the command gate opens (§3.1), so resolving the
  // binary here is allowed — starting a provider session is not.
  const bin = await context.resolveBin(CODEX_REF_ID);

  const events = new AsyncEventQueue<RuntimeEvent>({
    onDrop: (dropped) => {
      context.logger.warn("codex: dropped runtime events under backpressure", { dropped });
    }
  });
  const sessions = new Map<string, CodexSession>();

  let cachedSnapshot: ProviderSnapshot | null = null;
  let cachedSnapshotAt = 0;
  /** Keyed by probe key, so probes for different cwds do not share a result. */
  const inFlightSnapshots = new Map<string, Promise<ProviderSnapshot>>();
  /** §4.6.4: at most 16 cwds per provider, oldest evicted. */
  const probedCwds: string[] = [];

  const stamp = (threadId: string, draft: RuntimeEventDraft): RuntimeEvent => {
    return {
      ...draft,
      eventId: context.ids.eventId(),
      threadId,
      createdAt: context.clock.nowIso()
    } as RuntimeEvent;
  };

  const emitFor =
    (threadId: string) =>
    (draft: RuntimeEventDraft): void => {
      events.push(stamp(threadId, draft));
    };

  const requireBin = (): string => {
    if (bin === null) {
      throw new Error(
        "codex is not installed on this host. Install it from Settings → Agents, then try again."
      );
    }
    return bin;
  };

  /**
   * §3.2's minimum-version gate. **Refuses rather than degrades** (§10): an
   * out-of-range CLI is refused with the required version in the message
   * rather than started and allowed to fail on the first unrecognised frame.
   * A version that cannot be read counts as unsupported.
   */
  const assertVersionSupported = async (): Promise<void> => {
    const snapshot = await getSnapshot();
    if (!snapshot.installed) {
      throw new Error(snapshot.message ?? "codex is not installed on this host.");
    }
    if (!meetsMinimumVersion(snapshot.version, MINIMUM_CODEX_VERSION)) {
      throw new Error(
        `codex ${snapshot.version ?? "(version unreadable)"} is below the required ${MINIMUM_CODEX_VERSION}. Update it from Settings → Agents.`
      );
    }
  };

  /**
   * Run one short-lived `codex app-server` for a probe.
   *
   * Probes NEVER authenticate and NEVER open a real session (§4.1): the child
   * is handshaken, read from, and killed.
   */
  const runProbe = async (cwd?: string): Promise<ProviderSnapshot> => {
    const nowIso = context.clock.nowIso();
    if (bin === null) {
      return uninstalledCodexSnapshot(nowIso, "codex was not found on the session PATH.");
    }

    const env = context.buildEnv({ threadId: "codex-probe", home: probeHome() });
    const child = spawnProviderChild({
      command: bin,
      args: ["app-server"],
      env,
      cwd: cwd ?? context.tmpDir()
    });
    let peer: CodexPeer | null = null;
    try {
      peer = new CodexPeer({
        stdin: child.stdin,
        stdout: child.stdout,
        handlers: {
          onRequest: () => Promise.reject(new Error("probe answers no server requests")),
          onNotification: () => {},
          onUnknownFrame: () => {},
          onMalformedLine: () => {}
        }
      });
      // stderr is drained but never surfaced from a probe: a probe's noise is
      // not a session's problem.
      child.stderr.resume();

      const activePeer = peer;
      const initialize = await withDeadline(
        () =>
          activePeer.request("initialize", {
            clientInfo: { name: "orquester", title: "Orquester", version: "1" },
            capabilities: { experimentalApi: true, requestAttestation: false }
          }),
        { label: "codex probe initialize", timeoutMs: AGENT_HOST_DEADLINES.handshakeMs }
      );
      activePeer.notify("initialized");

      return await probeCodex({
        peer: activePeer,
        initialize,
        ...(cwd !== undefined ? { cwd } : {}),
        nowIso,
        onWarning: (message, detail) => {
          context.logger.warn(message, detail);
        }
      });
    } catch (error) {
      const version = null;
      void version;
      return {
        ...uninstalledCodexSnapshot(nowIso),
        installed: true,
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      peer?.close("probe finished");
      await child.kill();
    }
  };

  /**
   * Refreshes are serialised by a single in-flight promise so two clients
   * opening Settings cannot run two probes, and an identical configuration
   * short-circuits to the cache (§3.2).
   */
  const getSnapshot = async (options: { cwd?: string; force?: boolean } = {}): Promise<ProviderSnapshot> => {
    const fresh =
      cachedSnapshot !== null &&
      Date.now() - cachedSnapshotAt < SNAPSHOT_TTL_MS &&
      options.force !== true;
    const cwdAlreadyProbed =
      options.cwd === undefined ||
      cachedSnapshot?.workspaceSnapshots?.some((entry) => entry.cwd === options.cwd) === true;
    if (fresh && cwdAlreadyProbed && cachedSnapshot !== null) {
      return cachedSnapshot;
    }
    // Coalesce by the PROBE KEY, not globally: a Settings-wide probe and a
    // per-project one issued together must not hand one caller the other's
    // snapshot, or the §4.6.4 per-cwd overlay is silently absent for that call
    // (Q1 finding 35). `force` is part of the key so an explicit refresh is
    // never served by a passive probe already in flight.
    const key = `${options.cwd ?? ""}\u0000${options.force === true ? "force" : ""}`;
    const running = inFlightSnapshots.get(key);
    if (running !== undefined) {
      return running;
    }
    const probe = (async () => {
      try {
        const next = await runProbe(options.cwd);
        cachedSnapshot = mergeSnapshot(cachedSnapshot, next, probedCwds);
        cachedSnapshotAt = Date.now();
        return cachedSnapshot;
      } finally {
        inFlightSnapshots.delete(key);
      }
    })();
    inFlightSnapshots.set(key, probe);
    return probe;
  };

  const probeHome = (): StartSessionInput["home"] => ({
    kind: "system",
    path: defaultCodexHome()
  });

  const requireSession = (threadId: string): CodexSession => {
    const session = sessions.get(threadId);
    if (session === undefined) {
      throw new Error(`codex: no live session for thread ${threadId}`);
    }
    return session;
  };

  const startSession = async (input: StartSessionInput): Promise<ProviderSession> => {
    // One live session per thread: stop whatever the thread still holds before
    // starting, so a resume cursor is never advanced by two processes (§3.1).
    const existing = sessions.get(input.threadId);
    if (existing !== undefined) {
      await existing.stop();
      sessions.delete(input.threadId);
    }
    await assertVersionSupported();

    const codexHome = resolveCodexHome(input.home.path);
    const session = new CodexSession({
      context,
      threadId: input.threadId,
      cwd: input.cwd,
      ...(codexHome !== null ? { codexHome } : {}),
      bin: requireBin(),
      env: context.buildEnv({
        threadId: input.threadId,
        home: codexHome !== null ? { ...input.home, path: codexHome } : input.home
      }),
      runtimeMode: input.runtimeMode,
      modelSelection: input.modelSelection,
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      emit: emitFor(input.threadId),
      onClosed: () => {
        if (sessions.get(input.threadId) === session) {
          sessions.delete(input.threadId);
        }
      }
    });
    sessions.set(input.threadId, session);
    try {
      const summary = await session.start();
      // §4.6.4: refresh the per-cwd overlay off the session start, forked so it
      // never delays the turn.
      void getSnapshot({ cwd: input.cwd }).catch(() => {});
      return summary;
    } catch (error) {
      await session.stop().catch(() => {});
      sessions.delete(input.threadId);
      throw error;
    }
  };

  const adapter: AgentAdapter = {
    id: CODEX_ADAPTER_ID,
    capabilities: CODEX_ADAPTER_CAPABILITIES,
    events,

    startSession,

    async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
      // Lazy recovery (§4.1): a crashed, OOM-killed or restarted session is
      // indistinguishable from a fresh one, so `sendTurn` on a thread with no
      // live session is not an error — the caller supplies the cursor through
      // `startSession` before reaching here, and a session that died mid-flight
      // is reported rather than silently restarted without one.
      const session = sessions.get(input.threadId);
      if (session === undefined || !session.isLive) {
        throw new Error(
          `codex: thread ${input.threadId} has no live session; start one from the persisted cursor first`
        );
      }
      const result = await session.sendTurn({
        input: input.input,
        attachments: input.attachments,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        interactionMode: input.interactionMode,
        ...(input.continuation !== undefined ? { continuation: input.continuation } : {})
      });
      return { turnId: result.turnId, resumeCursor: result.resumeCursor };
    },

    async interruptTurn(threadId: string, turnId?: string): Promise<void> {
      await sessions.get(threadId)?.interruptTurn(turnId);
    },

    respondToApproval(
      threadId: string,
      requestId: string,
      decision: ApprovalDecision
    ): Promise<void> {
      sessions.get(threadId)?.respondToApproval(requestId, decision);
      return Promise.resolve();
    },

    respondToUserInput(
      threadId: string,
      requestId: string,
      answers: Record<string, unknown>
    ): Promise<void> {
      sessions.get(threadId)?.respondToUserInput(requestId, answers);
      return Promise.resolve();
    },

    async compact(threadId: string): Promise<void> {
      await requireSession(threadId).compact();
    },

    readThread(threadId: string): Promise<ThreadSnapshot> {
      return requireSession(threadId).readThread();
    },

    rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot> {
      return requireSession(threadId).rollbackThread(numTurns);
    },

    listSessions(): ProviderSession[] {
      return [...sessions.values()].map((session) => session.summary());
    },

    hasSession(threadId: string): boolean {
      return sessions.get(threadId)?.isLive === true;
    },

    async stopSession(threadId: string): Promise<void> {
      const session = sessions.get(threadId);
      if (session === undefined) {
        return;
      }
      sessions.delete(threadId);
      await session.stop();
    },

    async stopAll(): Promise<void> {
      const live = [...sessions.values()];
      sessions.clear();
      await Promise.all(live.map((session) => session.stop().catch(() => {})));
      events.close();
    },

    refreshSnapshot(input?: { cwd?: string }): Promise<ProviderSnapshot> {
      return getSnapshot({ ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}), force: true });
    }
  };

  // Honour host shutdown: every child is owned by its session's scope, and
  // stopping the host closes every scope (§3.1).
  context.signal.addEventListener(
    "abort",
    () => {
      void adapter.stopAll();
    },
    { once: true }
  );

  return adapter;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `CODEX_HOME` is **tilde-expanded here** (§4.5): `child_process.spawn` does
 * not shell-expand env values, so `CODEX_HOME=~/.codex_work` reaches codex
 * verbatim and it errors that the path does not exist.
 */
export function resolveCodexHome(path: string | undefined): string | null {
  if (path === undefined || path.length === 0) {
    return null;
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : null;
}

function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}

/**
 * §4.6.4: a probe that comes back empty NEVER blanks a non-empty cached list,
 * and at most 16 cwds are retained per provider, oldest evicted.
 */
export function mergeSnapshot(
  previous: ProviderSnapshot | null,
  next: ProviderSnapshot,
  probedCwds: string[]
): ProviderSnapshot {
  const merged: ProviderSnapshot = {
    ...next,
    models: next.models.length > 0 ? next.models : (previous?.models ?? []),
    slashCommands:
      next.slashCommands.length > 0 ? next.slashCommands : (previous?.slashCommands ?? []),
    skills: next.skills.length > 0 ? next.skills : (previous?.skills ?? [])
  };

  const overlays = new Map<string, NonNullable<ProviderSnapshot["workspaceSnapshots"]>[number]>();
  for (const entry of previous?.workspaceSnapshots ?? []) {
    overlays.set(entry.cwd, entry);
  }
  for (const entry of next.workspaceSnapshots ?? []) {
    const existing = overlays.get(entry.cwd);
    overlays.set(entry.cwd, {
      ...entry,
      skills: entry.skills.length > 0 ? entry.skills : (existing?.skills ?? []),
      slashCommands:
        entry.slashCommands.length > 0 ? entry.slashCommands : (existing?.slashCommands ?? [])
    });
    const index = probedCwds.indexOf(entry.cwd);
    if (index !== -1) {
      probedCwds.splice(index, 1);
    }
    probedCwds.push(entry.cwd);
  }
  while (probedCwds.length > MAX_WORKSPACE_SNAPSHOTS) {
    const evicted = probedCwds.shift();
    if (evicted !== undefined) {
      overlays.delete(evicted);
    }
  }
  if (overlays.size > 0) {
    merged.workspaceSnapshots = [...overlays.values()];
  }
  return merged;
}

/** *T3: `apps/server/src/provider/Layers/ProviderRegistry.ts:80-100`.* */
export const MAX_WORKSPACE_SNAPSHOTS = 16;

export { CODEX_ADAPTER_CAPABILITIES } from "./capabilities.ts";
export { MINIMUM_CODEX_VERSION, codexVersionFromUserAgent, meetsMinimumVersion } from "./probe.ts";
export type { CodexResumeCursor };
