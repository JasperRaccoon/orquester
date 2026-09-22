/**
 * Agent host — the Grok adapter (spec §4.5 Grok).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/GrokAdapter.ts` +
 * `apps/server/src/provider/Layers/GrokProvider.ts`.
 *
 * One `grok agent stdio` child **per thread**, speaking ACP plus the `x.ai/*`
 * extensions in both spellings. The generic transport lives in `acp/`; the
 * per-thread machinery in `session.ts`; the frame→event translation in
 * `normalize.ts`; the probe in `probe.ts`.
 *
 * Where this adapter deviates from spec §4.5, it is because the CLI installed
 * on this host behaves differently and the fixtures prove it. Each deviation
 * is documented at its call site; the headline ones are:
 *
 * - **Grok DOES emit token usage and a context window**, so
 *   `reportsContextWindow` is `true` and `turn.completed` carries a real
 *   `TurnTokenUsage` (§4.5 says it emits none).
 * - **Permission requests are off unless `[features] support_permission =
 *   true`** — the adapter writes that key into a managed account home, or
 *   warns when the home is not ours to edit.
 * - **`allow_always` is advertised**, as `options[0]`; selection keys on
 *   `kind`, never on index.
 * - **`session/load` replay arrives as `_x.ai/session/update`**, a method name
 *   T3 does not register.
 * - **Plan mode is declared** via `_meta["x.ai/tool"].kind`, not inferred.
 * - **Concurrent prompts are queued, not steered**, so steering is implemented
 *   as cancel-then-send under the same turn id.
 */

import type {
  AccountHome,
  AdapterCapabilities,
  AgentAdapterId,
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
import { join } from "node:path";

import { MAX_TURN_INPUT_CHARS } from "@orquester/api/agent-chat";
import { projectGrokHistory } from "./history.ts";
import { GROK_EXTRA_ENV } from "./launch.ts";
import { pendingStatusMessage } from "../pending.ts";
import {
  COMPACT_SLASH_COMMAND,
  FALLBACK_GROK_MODELS,
  probeGrok,
  probeSkills
} from "./probe.ts";
import { GrokSession, parseGrokResumeCursor } from "./session.ts";

/** The registry ids this adapter serves. */
const GROK_REF_IDS = ["grok"] as const;
const ADAPTER_ID: AgentAdapterId = "grok";

/**
 * §4.1 capabilities.
 *
 * `reportsContextWindow: true` is the reality correction of §4.5: the context
 * size rides `_meta.totalTokens` on every streamed chunk and the window is
 * `initialize._meta.modelState…totalContextTokens` (500 000).
 *
 * `showPlanModeToggle: false` stays — plan mode is entered by the *model*
 * through `enter_plan_mode`, not by a per-turn client flag, so a toggle would
 * promise a control that does not exist.
 *
 * `supportsConversationRollback: false` stays too: there is no provider-side
 * rollback, and §5.5 step 2 refuses before anything is touched.
 */
export const GROK_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  supportsConversationRollback: false,
  showPlanModeToggle: false,
  reportsContextWindow: true,
  compaction: { type: "slash-command", command: "/compact" }
};

/**
 * The §3.2 PENDING snapshot: what `GET /providers` answers for Grok before any
 * probe has run in this host process. Synchronous, no I/O.
 *
 * *T3: `apps/server/src/provider/makeManagedServerProvider.ts:69-73` —
 * `initialSnapshot(settings)`; `Layers/ClaudeProvider.ts:595-640` — the pending
 * shape (`installed:false`, `auth:{status:"unknown"}`, the "has not been
 * checked in this session yet" message) **plus a bundled catalog**.
 *
 * `status` is `"unknown"`, never `"error"`: an unlooked-at provider must not
 * raise the client's "sign in again" toast (`adapters/pending.ts`).
 */
export function pendingGrokSnapshot(checkedAt: string): ProviderSnapshot {
  return {
    id: ADAPTER_ID,
    refIds: [...GROK_REF_IDS],
    installed: false,
    version: null,
    status: "unknown",
    message: pendingStatusMessage("Grok"),
    auth: { status: "unknown" },
    checkedAt,
    models: [...FALLBACK_GROK_MODELS],
    slashCommands: [COMPACT_SLASH_COMMAND],
    skills: [],
    capabilities: GROK_CAPABILITIES
  };
}

/** At most this many per-cwd overlays are retained (§4.6.4). */
const MAX_WORKSPACE_SNAPSHOTS = 16;

/**
 * The home a probe uses before any session has named one. An EMPTY path is
 * deliberate: `support/env.ts` only sets `GROK_HOME` for a non-empty path, so
 * this means "the CLI's own identity" rather than "an empty directory that
 * looks logged out".
 */
const PROBE_SYSTEM_HOME: AccountHome = { kind: "system", path: "" };

class GrokAdapter implements AgentAdapter {
  readonly id = ADAPTER_ID;
  readonly capabilities = GROK_CAPABILITIES;

  /** §3.2 layer one. Synchronous, no I/O — see `adapters/pending.ts`. */
  pendingSnapshot(checkedAt: string): ProviderSnapshot {
    return pendingGrokSnapshot(checkedAt);
  }

  private readonly context: AdapterContext;
  private readonly sessions = new Map<string, GrokSession>();
  private readonly queue: RuntimeEvent[] = [];
  private waiter: ((value: void) => void) | null = null;
  private closed = false;
  private readonly workspaceSnapshots = new Map<string, WorkspaceSnapshot>();
  private lastSnapshot: ProviderSnapshot | null = null;
  private refreshInFlight: Promise<ProviderSnapshot> | null = null;
  /**
   * The last account home a session was started under, so the probe reads the
   * identity the user actually selected. Without it `grok models` runs against
   * whatever `~/.grok` the daemon user has — which on a managed deployment is
   * nothing, and the snapshot then reports `unauthenticated` for an account
   * that works perfectly (observed on the first smoke run).
   */
  private probeHome: AccountHome = PROBE_SYSTEM_HOME;

  constructor(context: AdapterContext) {
    this.context = context;
    context.signal.addEventListener(
      "abort",
      () => {
        // `stopAll` awaits every `session.stop()`, any of which can reject;
        // `main.ts` wraps its own call for exactly this reason and the signal
        // handler must too (Q1 #26). `.finally` would re-throw.
        void this.stopAll()
          .catch((error: unknown) => {
            this.context.logger.warn("grok: stopAll failed during shutdown", error);
          })
          .then(() => {
            this.closeStream();
          });
      },
      { once: true }
    );
  }

  // ------------------------------------------------------------ the stream

  get events(): AsyncIterable<RuntimeEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RuntimeEvent> => ({
        next: async (): Promise<IteratorResult<RuntimeEvent>> => {
          for (;;) {
            const next = this.queue.shift();
            if (next !== undefined) {
              return { value: next, done: false };
            }
            if (this.closed) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              this.waiter = resolve;
            });
          }
        }
      })
    };
  }

  private emit = (event: RuntimeEvent): void => {
    this.queue.push(event);
    this.wake();
  };

  private wake(): void {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter();
    }
  }

  /**
   * End the event stream. Only the host shutting down does this: `stopAll()`
   * alone must NOT, or a host that stops every session and then starts a new
   * one would find its consumer already finished.
   */
  private closeStream(): void {
    this.closed = true;
    this.wake();
  }

  // ----------------------------------------------------------- lifecycle

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const existing = this.sessions.get(input.threadId);
    if (existing !== undefined) {
      // One live session per thread: a cursor must never be advanced by two
      // processes (§3.1).
      await existing.stop();
      this.sessions.delete(input.threadId);
    }

    const command = await this.context.resolveBin("grok");
    if (command === null) {
      throw new Error("Grok CLI (`grok`) is not installed or not on PATH.");
    }

    const env = this.context.buildEnv({
      threadId: input.threadId,
      home: input.home,
      extraEnv: GROK_EXTRA_ENV
    });

    const session: GrokSession = new GrokSession({
      threadId: input.threadId,
      cwd: input.cwd,
      home: input.home,
      runtimeMode: input.runtimeMode,
      modelSelection: input.modelSelection,
      ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
      command,
      env,
      clientInfo: { name: "orquester", version: "1" },
      emit: this.emit,
      stamp: () => ({ eventId: this.context.ids.eventId(), createdAt: this.context.clock.nowIso() }),
      uuid: () => this.context.ids.uuid(),
      logRaw: (direction, frame) =>
        this.context.logRawFrame(input.threadId, { direction, frame }),
      logger: this.context.logger,
      // Under the host's own tmp dir: the overlay is ours, and `/tmp` is
      // unavailable under `ProtectSystem=strict`.
      overlayDir: join(this.context.tmpDir(), "grok-config", input.threadId),
      // A crashed child would otherwise leave a dead session in the map, so
      // `hasSession` stays true and `listSessions()` keeps reporting it to the
      // §3.3 reconcile and the drain-restart (Q1 #30).
      onClosed: (threadId) => {
        if (this.sessions.get(threadId) === session) {
          this.sessions.delete(threadId);
        }
      },
      homeDirs: [input.home.path, env["HOME"]].filter(
        (value): value is string => typeof value === "string" && value.length > 1
      )
    });

    this.probeHome = input.home;
    this.sessions.set(input.threadId, session);
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(input.threadId);
      throw error;
    }

    // §4.6.4: refresh the per-cwd skill overlay off session start, forked so
    // it never delays the first turn.
    void this.refreshWorkspace(input.cwd).catch(() => undefined);

    return session.summary;
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const text = input.input.trim();
    if (text.length > MAX_TURN_INPUT_CHARS) {
      throw new Error(`grok: turn input exceeds ${MAX_TURN_INPUT_CHARS} characters`);
    }
    // §4.6.5: a provider-side permission change would desynchronise the host's
    // runtime mode — and `/always-approve off` is additionally a no-op on this
    // CLI, so the user would believe they had changed something.
    if (isBlockedGrokCommand(text)) {
      throw grokBlockedCommandError();
    }
    if (text.length === 0 && input.attachments.length === 0) {
      // Grok does not declare `promptlessTurnContinuation`, so an empty
      // continuation is a validation error rather than a silently empty turn.
      throw new Error("grok: a turn needs text");
    }

    const session = this.requireSession(input.threadId);
    // References only (§4.1): the host owns the bytes, the adapter only ever
    // hands the agent a path it can read for itself.
    const attachments = await Promise.all(
      input.attachments.map(async (attachment) => ({
        id: attachment.id,
        name: attachment.name,
        path: await this.context.resolveAttachmentPath(input.threadId, attachment.id),
        ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType })
      }))
    );
    const result = await session.sendTurn({
      text,
      attachments,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      interactionMode: input.interactionMode
    });
    return { turnId: result.turnId, resumeCursor: result.resumeCursor };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      return;
    }
    await session.interrupt(turnId);
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    this.requireSession(threadId).respondToApproval(requestId, decision);
    await Promise.resolve();
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void> {
    this.requireSession(threadId).respondToUserInput(requestId, answers);
    await Promise.resolve();
  }

  /**
   * Compaction is the `/compact` slash command sent as an ordinary turn —
   * there is no compaction RPC. The boundary comes back on the private
   * channel as `auto_compact_completed`, which the normaliser turns into
   * `thread.state.changed {compacted, beforeTokens, afterTokens}`; without
   * that channel compaction is invisible.
   */
  async compact(threadId: string): Promise<void> {
    const session = this.requireSession(threadId);
    if (session.hasActiveTurn) {
      throw new Error("grok: cannot compact while a turn is running");
    }
    await session.sendTurn({ text: "/compact", interactionMode: "default" });
  }

  /**
   * The provider-side snapshot used to reconcile after a restart.
   *
   * Grok exposes no transcript RPC, and `session/load` replays only a fraction
   * of the history (39 events produced, 5 replayed), so the only honest source
   * is what this adapter itself observed: one opaque item per settled turn,
   * carrying the provider's own prompt id and stop reason. §4.1 calls the
   * items opaque, and that is exactly what they are here.
   */
  /**
   * E6: rebuild a timeline for a thread whose history the host has never seen
   * — a §6.1 resume of somebody else's conversation, or one whose
   * `events.ndjson` predates this host.
   *
   * Grok has no transcript RPC; the only source is what `session/load`
   * replays, which is **partial by construction** (README 10: capture `02`
   * produced 39 events, replay returned 5). So this restores the shape of the
   * conversation and never claims to be the transcript, and every projected
   * turn reports `tokenUsage: unavailable`. A thread with nothing replayed
   * projects `[]` and the host renders its own info activity.
   */
  projectHistory(snapshot: ThreadSnapshot): RuntimeEvent[] {
    return projectGrokHistory(snapshot, {
      threadId: snapshot.threadId,
      stamp: () => ({ eventId: this.context.ids.eventId(), createdAt: this.context.clock.nowIso() })
    });
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    const session = this.requireSession(threadId);
    return await Promise.resolve({ threadId: session.threadId, turns: session.turns });
  }

  /**
   * §4.5: **no rollback.** Validated first so a malformed request is still a
   * validation error, then always refused — a provider that cannot roll back
   * its conversation must reject the operation rather than half-perform it
   * (§10), and the refusal happens at step 2 of §5.5, before anything on disk
   * or in the provider is touched.
   */
  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot> {
    this.requireSession(threadId);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("grok: numTurns must be an integer >= 1");
    }
    return await Promise.reject(
      new Error("Grok sessions do not support provider-side conversation rollback.")
    );
  }

  listSessions(): ProviderSession[] {
    return [...this.sessions.values()].map((session) => session.summary);
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      return;
    }
    this.sessions.delete(threadId);
    await session.stop();
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => await session.stop()));
  }

  // ------------------------------------------------------------- snapshot

  /**
   * One call, not two (§4.1). Refreshes are serialised so two clients opening
   * Settings cannot run two probes.
   */
  async refreshSnapshot(input?: { cwd?: string }): Promise<ProviderSnapshot> {
    if (input?.cwd !== undefined) {
      await this.refreshWorkspace(input.cwd);
      if (this.lastSnapshot !== null) {
        return this.withWorkspaces(this.lastSnapshot);
      }
    }
    if (this.refreshInFlight !== null) {
      return await this.refreshInFlight;
    }
    const work = this.runProbe(input?.cwd);
    this.refreshInFlight = work;
    try {
      return await work;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async runProbe(cwd?: string): Promise<ProviderSnapshot> {
    const command = await this.context.resolveBin("grok");
    const env = this.context.buildEnv({ threadId: "probe", home: this.probeHome });
    const probe = await probeGrok({
      command,
      env,
      cwd: cwd ?? this.context.tmpDir(),
      clientInfo: { name: "orquester-probe", version: "1" },
      logger: this.context.logger
    });

    // §4.5: "typed probe errors so a failure never caches an empty catalogue".
    // One timed-out `grok inspect --json` must not blank the Settings card and
    // the composer's skill menu (R4 #5); the per-cwd overlay already had this
    // rule, the machine-level snapshot did not.
    const previous = this.lastSnapshot;
    const keep = <T>(next: T[], stale: boolean, before: T[] | undefined): T[] =>
      stale && before !== undefined && before.length > 0 ? before : next;

    const snapshot: ProviderSnapshot = {
      id: ADAPTER_ID,
      refIds: [...GROK_REF_IDS],
      installed: probe.installed,
      version: probe.version,
      status: probe.status,
      ...(probe.message === undefined ? {} : { message: probe.message }),
      auth: probe.auth,
      checkedAt: this.context.clock.nowIso(),
      models: keep(probe.models, probe.unavailable.models, previous?.models),
      slashCommands: keep(
        probe.slashCommands.length > 0 ? probe.slashCommands : [COMPACT_SLASH_COMMAND],
        probe.unavailable.slashCommands,
        previous?.slashCommands
      ),
      skills: keep(probe.skills, probe.unavailable.skills, previous?.skills),
      capabilities: GROK_CAPABILITIES
    };
    this.lastSnapshot = snapshot;
    return this.withWorkspaces(snapshot);
  }

  private withWorkspaces(snapshot: ProviderSnapshot): ProviderSnapshot {
    const overlays = [...this.workspaceSnapshots.values()];
    // A live session's `available_commands_update` carries the REAL catalog —
    // 69 commands against the 7 `initialize` advertises — so any live session
    // beats the probe, and the last update wins because the list grows as
    // plugins load (observation 20).
    const live = [...this.sessions.values()].map((session) => session.slashCommands).find((list) => list.length > 0);
    return {
      ...snapshot,
      ...(live === undefined ? {} : { slashCommands: mergeCommands(snapshot.slashCommands, live) }),
      ...(overlays.length === 0 ? {} : { workspaceSnapshots: overlays })
    };
  }

  /**
   * Only **skills** are re-scoped per cwd for Grok — the command list is
   * machine-level. A probe that comes back empty never blanks a non-empty
   * cached list, and at most 16 cwds are retained, oldest evicted.
   */
  private async refreshWorkspace(cwd: string): Promise<void> {
    const command = await this.context.resolveBin("grok");
    if (command === null) {
      return;
    }
    const env = this.context.buildEnv({
      threadId: "probe",
      home: this.probeHome,
      extraEnv: GROK_EXTRA_ENV
    });
    const skills = await probeSkills(command, env, cwd);
    const previous = this.workspaceSnapshots.get(cwd);
    // `null` is "could not read"; an empty array is a real, empty directory.
    if (skills === null) {
      return;
    }
    if (skills.length === 0 && previous !== undefined && previous.skills.length > 0) {
      return;
    }
    this.workspaceSnapshots.delete(cwd);
    this.workspaceSnapshots.set(cwd, {
      cwd,
      checkedAt: this.context.clock.nowIso(),
      // The machine-level catalog is the command source; the overlay carries
      // only skills, per §4.6.4.
      slashCommands: this.lastSnapshot?.slashCommands ?? [COMPACT_SLASH_COMMAND],
      skills
    });
    while (this.workspaceSnapshots.size > MAX_WORKSPACE_SNAPSHOTS) {
      const oldest = this.workspaceSnapshots.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.workspaceSnapshots.delete(oldest);
    }
  }

  private requireSession(threadId: string): GrokSession {
    const session = this.sessions.get(threadId);
    if (session === undefined || session.isStopped) {
      throw new Error(`grok: no live session for thread ${threadId}`);
    }
    return session;
  }
}

function mergeCommands(
  base: ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }>,
  live: ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }>
): Array<{ name: string; description?: string; input?: { hint: string } }> {
  const byName = new Map(base.map((command) => [command.name, command]));
  for (const command of live) {
    // The same two names the probe filters are filtered here too: a live
    // catalog must not smuggle back a command the host refuses to forward.
    if (command.name.toLowerCase() === "always-approve" || command.name.toLowerCase() === "context") {
      continue;
    }
    byName.set(command.name, command);
  }
  return [...byName.values()];
}

/**
 * §4.6.5(c) / §4.6.6: Grok's `/always-approve` is **refused**, because a
 * provider-side permission change would desynchronise the host's runtime mode
 * — and on this CLI it is additionally a no-op, so the user would believe they
 * had changed something (README 6).
 *
 * Exported so the refusal can happen where it can still be a 400: the composer
 * pre-check and the host's `decide("turn")` both need the same predicate, and
 * by the time `sendTurn` throws, the user message has already been committed
 * (R2 #7). The adapter keeps the check as the backstop.
 */
export function isBlockedGrokCommand(text: string): boolean {
  return /^\/always-approve(?:\s|$)/i.test(text.trim());
}

/** The message the refusal carries, pointing at the control that does work. */
export const GROK_BLOCKED_COMMAND_MESSAGE =
  "Change permissions with the permission selector on the composer instead of /always-approve.";

/**
 * A refusal shaped so the host answers `400 INVALID_COMMAND` rather than
 * letting it surface as a failed-turn activity.
 */
export function grokBlockedCommandError(): Error & { code: string; status: number } {
  return Object.assign(new Error(GROK_BLOCKED_COMMAND_MESSAGE), {
    code: "INVALID_COMMAND",
    status: 400
  });
}

export const createGrokAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  // Acquiring an adapter happens BEFORE the command gate opens (§3.1), so a
  // factory may do real work — but must not start a provider session.
  return await Promise.resolve(new GrokAdapter(context));
};

export { GrokSession, parseGrokResumeCursor };
