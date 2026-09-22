/**
 * Agent host — a scripted in-process adapter (spec §9).
 *
 * Ported in spirit from T3 Code (MIT):
 * `apps/server/integration/TestProviderAdapter.integration.ts` — a fake
 * `ProviderAdapterShape` with scripted per-turn events and an optional resume
 * failure.
 *
 * It emits canned {@link RuntimeEvent}s and records every call, so the §3.3
 * reconcile, the §3.4 restart policy and every §6.2 command can be asserted
 * without a provider, an account or a network. **Nothing here waits on a
 * timer** — a test drives it by pushing events and awaiting the orchestrator's
 * drain (§9).
 */

import type {
  AdapterCapabilities,
  AgentAdapterId,
  ApprovalDecision,
  ProviderSession,
  ProviderSnapshot,
  RuntimeEvent,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type { AgentAdapter, SendTurnInput, SendTurnResult, StartSessionInput } from "../../adapter.ts";

export interface ScriptedCall {
  kind:
    | "startSession"
    | "sendTurn"
    | "interruptTurn"
    | "respondToApproval"
    | "respondToUserInput"
    | "compact"
    | "backgroundTasks"
    | "readThread"
    | "projectHistory"
    | "rollbackThread"
    | "stopSession"
    | "stopAll"
    | "refreshSnapshot";
  threadId?: string;
  detail?: unknown;
}

export interface ScriptedAdapterOptions {
  id?: AgentAdapterId;
  /** The `readThread` result a resume replays (E6). */
  history?: ThreadSnapshot;
  /** Omit to model an adapter with no `projectHistory` at all. */
  projectHistory?: (snapshot: ThreadSnapshot) => RuntimeEvent[];
  capabilities?: Partial<AdapterCapabilities>;
  /** Fail the next `startSession` with this error, then clear it. */
  failStartSession?: Error | null;
  failSendTurn?: Error | null;
  failCompact?: Error | null;
  failInterrupt?: Error | null;
  failApproval?: Error | null;
  version?: string | null;
}

export interface ScriptedAdapter extends AgentAdapter {
  readonly calls: ScriptedCall[];
  /** Push one runtime event onto the adapter's stream. */
  emit(event: RuntimeEvent): void;
  /** Close the stream so `consume()` returns. */
  close(): void;
  /** Make the next call of that kind reject. */
  failNext(kind: keyof ScriptedAdapterOptions, error: Error): void;
  /** Turn ids handed out by `sendTurn`, in order. */
  readonly turnIds: string[];
  /** The last `startSession` input, for restart assertions. */
  readonly lastStart: StartSessionInput | null;
  readonly lastTurn: SendTurnInput | null;
}

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" }
};

export function createScriptedAdapter(options: ScriptedAdapterOptions = {}): ScriptedAdapter {
  const id = options.id ?? "claude";
  const capabilities: AdapterCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const calls: ScriptedCall[] = [];
  const sessions = new Map<string, ProviderSession>();
  const turnIds: string[] = [];
  let turnCounter = 0;
  let lastStart: StartSessionInput | null = null;
  let lastTurn: SendTurnInput | null = null;

  const failures: Record<string, Error | null> = {
    failStartSession: options.failStartSession ?? null,
    failSendTurn: options.failSendTurn ?? null,
    failCompact: options.failCompact ?? null,
    failInterrupt: options.failInterrupt ?? null,
    failApproval: options.failApproval ?? null
  };

  const take = (key: string): Error | null => {
    const error = failures[key] ?? null;
    failures[key] = null;
    return error;
  };

  // A tiny unbounded async queue: `emit` never blocks, `close` ends the stream.
  const buffer: RuntimeEvent[] = [];
  let waiting: ((value: IteratorResult<RuntimeEvent>) => void) | null = null;
  let closed = false;

  const events: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
      return {
        next(): Promise<IteratorResult<RuntimeEvent>> {
          const queued = buffer.shift();
          if (queued) {
            return Promise.resolve({ value: queued, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
            waiting = resolve;
          });
        }
      };
    }
  };

  const adapter: ScriptedAdapter = {
    id,
    capabilities,
    calls,
    turnIds,
    events,

    get lastStart() {
      return lastStart;
    },
    get lastTurn() {
      return lastTurn;
    },

    emit(event: RuntimeEvent): void {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: event, done: false });
        return;
      }
      buffer.push(event);
    },

    close(): void {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },

    failNext(kind, error): void {
      failures[kind as string] = error;
    },

    async startSession(input: StartSessionInput): Promise<ProviderSession> {
      calls.push({ kind: "startSession", threadId: input.threadId, detail: input });
      lastStart = input;
      const failure = take("failStartSession");
      if (failure) throw failure;
      const now = new Date(0).toISOString();
      const session: ProviderSession = {
        threadId: input.threadId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        model: input.modelSelection.model,
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        createdAt: now,
        updatedAt: now
      };
      sessions.set(input.threadId, session);
      return session;
    },

    async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
      calls.push({ kind: "sendTurn", threadId: input.threadId, detail: input });
      lastTurn = input;
      const failure = take("failSendTurn");
      if (failure) throw failure;
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      turnIds.push(turnId);
      const session = sessions.get(input.threadId);
      if (session) {
        sessions.set(input.threadId, { ...session, status: "running", activeTurnId: turnId });
      }
      return { turnId, resumeCursor: { cursor: turnId } };
    },

    async interruptTurn(threadId: string, turnId?: string): Promise<void> {
      calls.push({ kind: "interruptTurn", threadId, detail: turnId ?? null });
      const failure = take("failInterrupt");
      if (failure) throw failure;
    },

    async respondToApproval(
      threadId: string,
      requestId: string,
      decision: ApprovalDecision
    ): Promise<void> {
      calls.push({ kind: "respondToApproval", threadId, detail: { requestId, decision } });
      const failure = take("failApproval");
      if (failure) throw failure;
    },

    async respondToUserInput(
      threadId: string,
      requestId: string,
      answers: Record<string, unknown>
    ): Promise<void> {
      calls.push({ kind: "respondToUserInput", threadId, detail: { requestId, answers } });
    },

    async compact(threadId: string): Promise<void> {
      calls.push({ kind: "compact", threadId });
      const failure = take("failCompact");
      if (failure) throw failure;
    },
    async backgroundTasks(threadId: string, toolUseId?: string): Promise<boolean> {
      calls.push({ kind: "backgroundTasks", threadId, detail: { toolUseId } });
      return true;
    },

    async readThread(threadId: string): Promise<ThreadSnapshot> {
      calls.push({ kind: "readThread", threadId });
      return options.history ?? { threadId, turns: [] };
    },

    ...(options.projectHistory
      ? {
          projectHistory(snapshot: ThreadSnapshot): RuntimeEvent[] {
            calls.push({ kind: "projectHistory", detail: snapshot });
            return options.projectHistory!(snapshot);
          }
        }
      : {}),

    async rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot> {
      calls.push({ kind: "rollbackThread", threadId, detail: numTurns });
      return { threadId, turns: [] };
    },

    listSessions(): ProviderSession[] {
      return [...sessions.values()];
    },

    hasSession(threadId: string): boolean {
      return sessions.has(threadId);
    },

    async stopSession(threadId: string): Promise<void> {
      calls.push({ kind: "stopSession", threadId });
      sessions.delete(threadId);
    },

    async stopAll(): Promise<void> {
      calls.push({ kind: "stopAll" });
      sessions.clear();
    },

    async refreshSnapshot(input?: { cwd?: string }): Promise<ProviderSnapshot> {
      calls.push({ kind: "refreshSnapshot", detail: input });
      return {
        id,
        refIds: [id],
        installed: true,
        version: options.version ?? "9.9.9",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: new Date(0).toISOString(),
        models: [],
        slashCommands: [],
        skills: [],
        capabilities
      };
    }
  };

  return adapter;
}
