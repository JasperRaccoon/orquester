/**
 * The daemon-side agent-chat service: one object `startDaemon` creates, wires
 * and stops.
 *
 * It owns the supervisor (§3.1), the host client, the chat tab records (§5.2),
 * the coarse summary subscription (§6.4) and the route dependencies of
 * §6.2/§6.3. `index.ts` keeps only the boot order and the `/api/sessions`
 * lifecycle glue.
 */

import { spawn } from "node:child_process";
import { availableParallelism, homedir, loadavg } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { readCodeStamp } from "../agent-host/support/code-stamp.ts";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AgentAdapterId,
  CreateAgentChatSessionFields,
  CreateSessionRequest,
  ForkSessionRequest,
  ForkSessionResponse,
  RegistryEntry,
  SessionSummary, AgentAccount,
  ThreadLineage } from "@orquester/api";
import { SYSTEM_ACCOUNT_ID, isSessionProfileAgentId, type SessionProfileAgentId } from "@orquester/api";
import { CONVERSATION_ALREADY_OPEN, forkTitle } from "@orquester/api/agent-chat";
import type { AgentChatHome, RuntimePlatform } from "@orquester/config";
import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";
// boxes:
import { boxSocketPath } from "@orquester/config";
import type { BoxRegistry, BoxToolingProvisioner } from "../boxes/contracts.ts";
import {
  AGENT_HOST_HEALTH_INTERVAL_MS,
  agentHostAuthValue,
  agentHostRoutes,
  type AgentHostHealthResponse,
  type CreateHostThreadRequest,
  type ForkHostThreadRequest,
  type ForkHostThreadResponse,
  type AgentHostRecycleOpenCodeRequest,
  type AgentHostProfileLeasesResponse,
  type HostThreadBox,
  type HostThreadProfile,
  type HostThreadServerPool,
  type SetThreadIdentityRequest,
  type SetThreadIdentityResponse,
  type ThreadLaunchProfileResponse
} from "../agent-host/host-protocol.ts";
import { SessionProfileError } from "../session-profiles/errors.ts";
import { deletedProfileNotice, type ChatLaunchFields, type ResolveProfileLaunch } from "../session-profiles/launch.ts";
import { Readable, Transform } from "node:stream";
import { MAX_UPLOAD_BYTES } from "@orquester/api";
import { isUploadTooLarge, UploadTooLargeError } from "../upload-stream.ts";
import { isAgentAdapterId } from "../agent-host/adapters/index.ts";
import { agentHostExtraRoutes } from "../agent-host/server/extra-routes.ts";
import { ACCOUNT_HOME_ENV_VAR } from "../agent-host/support/env.ts";
import type { SessionIndexContributor } from "../sessions.ts";
import { ChatSessionManager, ChatSessionError } from "./chat-sessions.ts";
import { AgentHostClient, HostUnavailableError } from "./host-client.ts";
import { markClaudeProjectTrusted } from "./home-prep.ts";
import { parseSessionOwner } from "./owner.ts";
import type { FastifyReply } from "fastify";
import type { AgentChatRouteDeps } from "./proxy-routes.ts";
import type { HtmlRenderReference, Skill, SlashCommand } from "@orquester/api/agent-chat";
import { publishHtmlRender, type LocalImageReader, type PublishHtmlRenderInput } from "./html-render-publish.ts";
import { HtmlPreviewError, measureHtmlPage, previewHtmlPage, type HtmlPageRenderer, type HtmlPreview, type HtmlPreviewInput } from "../html-preview/index.ts";
import { createVisualUrlSigner, type VisualUrlSigner } from "./visual-urls.ts";
import {
  AgentChatSummaryService,
  type SummaryBroadcaster,
  type SummaryPush,
  type SummarySecretRequests,
  type ThreadUsageReading
} from "./summary.ts";
import {
  AgentHostSupervisor,
  buildAgentHostEnv,
  legacyGoalTurnOf,
  type LegacyGoalTurn,
  type ProbeOutcome,
  type SupervisorTmux
} from "./supervisor.ts";

/**
 * A conversation id may only ever be a real history-file name. The same shape
 * `resumeLaunchArgs` enforces for a terminal launch — the leading char excludes
 * `-` so an id can never arrive at a provider as a flag.
 */
const CONVERSATION_ID = /^[\w.][\w.\-/]*$/;

/**
 * How long one adapter is left alone after a registry-driven provider refresh.
 *
 * An install, an update and the version re-detection that follows are three
 * separate registry events for the same binary; the window collapses them into
 * one probe and makes a flapping detector unable to loop. It is only ever a
 * *nudge* — the host re-probes a moved binary on its next read anyway
 * (`orchestration/provider-snapshots.ts`), so a dropped nudge costs latency,
 * never correctness.
 */
const PROVIDER_REFRESH_DEBOUNCE_MS = 10_000;

/**
 * Deadline on the refresh hop. Wider than the host's own 10 s auth probe so a
 * provider that must start a server first (OpenCode) still fits, and finite
 * because nothing else bounds a fire-and-forget call.
 */
const PROVIDER_REFRESH_DEADLINE_MS = 30_000;

/**
 * Deadline on the agent goals §5.7 `POST /goals/hold`. Short: the host only
 * pauses goals (each bounded by its own `goalPauseMs`) and writes a few head
 * files. The supervisor never awaits it — one request in flight at a time —
 * so it bounds only how long a request can occupy that slot. A missed
 * renewal costs nothing: the next evaluation asks again, well inside the
 * host's lease.
 */
const GOAL_HOLD_DEADLINE_MS = 5_000;

/**
 * Deadline on the agent profile §4.8 `POST /opencode/recycle-idle`. The host
 * answers once every idle server it stopped is gone (each within its 1 s kill
 * grace), so this only bounds a host that hangs.
 */
const OPENCODE_RECYCLE_DEADLINE_MS = 15_000;

/** Deadline on `GET /profiles/leases` (Agent Profiles): an in-memory read on the host. */
const PROFILE_LEASES_DEADLINE_MS = 5_000;

/**
 * Deadlines on the agent goals §5.7 legacy handover's host calls (a host from
 * before the goal hold): a thread snapshot, a session stop, and — on the
 * replacement — the resume of the sessions stopped. The supervisor awaits the
 * first two inside its transition queue, never on boot adoption (the fallback
 * runs only once that host has answered its hold with a 404), so each stays
 * short; a missed one is simply tried on the next evaluation.
 */
const LEGACY_GOAL_CALL_DEADLINE_MS = 5_000;

/** One launch-env contribution, mirroring `index.ts`'s `LaunchEnv`. */
export interface ChatLaunchEnv {
  env: Record<string, string>;
  unset?: string[];
  accountId?: string;
  /**
   * The keyed provider server a chat thread runs on (OpenCode), sent to the
   * host as `CreateHostThreadRequest.serverPool` on create and fork. Chat
   * only: a terminal launch has no shared server. Omitted: the global server.
   */
  serverPool?: HostThreadServerPool;
}

export interface AgentChatServiceOptions {
  /** `<appdir>`. */
  baseDir: string;
  /** The clock a fork reconcile's backoff reads (tests); `Date.now` by default. */
  now?: () => number;
  /** The daemon's own unix socket, handed to the host for session-tool calls (design 2026-10-14 §1.1). */
  daemonSocketPath?: string;
  daemonDir: string;
  platform: RuntimePlatform;
  /** cwd for the host process (the repo root the daemon runs from). */
  cwd: string;
  /** The wider session PATH, so the host resolves user-installed CLIs. */
  sessionPath: string;
  /** The daemon's own env, read ONLY for the four vars §8 names. */
  env: NodeJS.ProcessEnv;
  tmux: SupervisorTmux | null;
  broadcaster: SummaryBroadcaster;
  push: SummaryPush;
  /** Resolve the registry entry a chat tab launches from. */
  registryEntry(refId: string): RegistryEntry | undefined;
  /**
   * The SAME launch env a terminal launch of this entry would get today —
   * account home, timeouts (§3.1 "Launch environment"). `index.ts` passes its
   * own `resolveExtraEnv` body so the two can never drift.
   */
  resolveLaunchEnv(
    entry: RegistryEntry,
    ctx: { accountId?: string }
  ): Promise<ChatLaunchEnv | null>;
  /** The system Claude config file, when no `CLAUDE_CONFIG_DIR` is in play. */
  systemClaudeConfigFile(): string;
  /**
   * Confine a client-supplied project path to the workspaces sandbox and
   * realpath it, or answer null. The ONLY path a chat launch is allowed to
   * grant Claude project trust for — see `prepareHome`.
   */
  resolveTrustedProjectDir(projectPath: string): Promise<string | null>;
  /**
   * boxes: the image reader of a project that lives in a box (its page's local images are read
   * there, spec §8.9); undefined for a host project. Absent: every project is a host project.
   */
  localImages?(projectDir: string): LocalImageReader | undefined;
  /**
   * Stream a host-resolved attachment to the client. `index.ts` owns it
   * because the `Content-Disposition` / streaming conventions live there with
   * the other download routes.
   */
  sendAttachment(reply: FastifyReply, path: string): Promise<unknown>;
  /**
   * Headless Chromium for agent pages (design 2026-10-14 §2.1, §2.2):
   * `html_preview` screenshots and the heights `html_render` publishes with.
   * Absent: previews are unavailable and pages publish without heights.
   */
  htmlPreview?: HtmlPageRenderer;
  /** Managed accounts + family defaults, for the §7.7 auth overlay (see `provider-auth-overlay.ts`). */
  listManagedAccounts?(): { accounts: AgentAccount[]; defaults?: Partial<Record<AgentAccount["agent"], string | null>> };
  /**
   * Agent Profiles (spec 2026-10-18): how a chat launch gets its profile — `index.ts` wires the
   * preparation lifecycle through {@link AgentChatService.setSessionProfiles} once it exists.
   * Absent: every launch, fork or switch that names a profile is refused.
   */
  sessionProfiles?: ChatSessionProfiles;
  /** boxes: box projects and their tooling (also settable later, {@link AgentChatService.setBoxes}). */
  boxes?: ChatBoxes;
  logger?: {
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
    error?: (...a: unknown[]) => void;
  };
}

/** boxes (spec 2026-10-19 §8.5): what a chat launch needs to know about box projects. */
export interface ChatBoxes {
  registry: Pick<BoxRegistry, "locate">;
  /** The per-session env the box's tooling plugins contribute (spec §10); absent: none. */
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
}

/** The Agent Profiles a chat launch draws on (`session-profiles/launch.ts`). */
export interface ChatSessionProfiles {
  /** `ensureReady` → manifest → the agent's contribution. Throws `SessionProfileError`. */
  resolve: ResolveProfileLaunch;
  /** A deleted profile's name (durable, read at the fallback) — for the fallback notice. Should not reject. */
  profileName?(profileId: string): Promise<string | undefined> | string | undefined;
  /**
   * The composer's catalog for a profile chat whose live session has not reported its own: the
   * profile's own items for `agent` (`SessionProfileService.composerCatalog`). May reject.
   */
  catalog?(profileId: string, agent: SessionProfileAgentId): Promise<{ slashCommands: SlashCommand[]; skills: Skill[] }>;
}

/** A profile id off a request: absent, `null` (Global, where allowed), or a non-blank id ≤ 128. */
function requestedProfileId(value: unknown, allowNull: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new ChatSessionError(
      allowNull ? "profileId must be an Agent Profile id or null for Global." : "profileId must be an Agent Profile id.",
      "INVALID_COMMAND"
    );
  }
  return value.trim();
}

/** A profile refusal as the chat routes answer it (the profile's own code and message). */
function profileRefusal(error: unknown): unknown {
  return error instanceof SessionProfileError ? new ChatSessionError(error.message, error.code) : error;
}

/** How many profile switches {@link AgentChatService.switchProfile} remembers by commandId. */
const PROFILE_SWITCH_RECORDS = 256;

/**
 * `POST /api/sessions` with `kind: "agent-chat"`.
 *
 * The §6.1 extras ride the nested `chat` block the client sends; the flattened
 * spelling is still accepted so a socket/curl caller (and an older bundle) is
 * not a 400.
 */
export type CreateAgentChatRequest = CreateSessionRequest & Partial<CreateAgentChatSessionFields>;

/** Read §6.1's fields from either spelling, nested first. */
function chatFields(req: CreateAgentChatRequest): Partial<CreateAgentChatSessionFields> {
  return {
    ...(req.modelSelection !== undefined ? { modelSelection: req.modelSelection } : {}),
    ...(req.runtimeMode !== undefined ? { runtimeMode: req.runtimeMode } : {}),
    ...(req.resume !== undefined ? { resume: req.resume } : {}),
    ...(req.lineage !== undefined ? { lineage: req.lineage } : {}),
    ...(req.unattended !== undefined ? { unattended: req.unattended } : {}),
    ...(req.chat ?? {})
  };
}

/**
 * The fork tab's id a `commandId` names on a parent: a UUID-shaped digest, so a repeat of the
 * same fork — even after a daemon restart forgot the first — lands on the same tab and thread.
 */
export function forkIdFor(parentId: string, commandId: string): string {
  const hex = createHash("sha256").update(`fork\u0000${parentId}\u0000${commandId}`).digest("hex");
  // RFC 4122 layout, version nibble 5 and the variant bits, as a name-based UUID has.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The host never answered a fork: whether it created the child is unknown. */
class ForkOutcomeUnknown extends Error {
  constructor() {
    super("The agent host did not answer the fork.");
  }
}

/** How many fork keys {@link AgentChatService.forkSession} remembers. */
const FORK_RECORDS = 512;

/** A fork request's cut, for telling a repeat from a reuse of its key. */
function forkFingerprint(req: ForkSessionRequest): string {
  const body = (req ?? {}) as Record<string, unknown>;
  return JSON.stringify([body.messageId ?? null, body.turnId ?? null, body.role ?? null]);
}

/** The fork point a recorded {@link forkFingerprint} names, for re-sending the fork. */
function forkTargetOf(fingerprint: string | undefined): ForkHostThreadRequest["fork"] {
  try {
    const [messageId, turnId, role] = JSON.parse(fingerprint ?? "[]") as unknown[];
    return {
      ...(typeof messageId === "string" ? { messageId } : {}),
      ...(typeof turnId === "string" ? { turnId } : {}),
      ...(role === "user" || role === "assistant" ? { role } : {})
    };
  } catch {
    return {};
  }
}

/**
 * After a restart, with only the tab left to go by: does its recorded fork point match the
 * request's? A message names it; else a turn; else "the latest finished turn", which records none.
 */
function sameForkPoint(tab: SessionSummary, recorded: string | undefined, req: ForkSessionRequest): boolean {
  // The tab records what its key asked for: compared exactly — message, turn, role, or "latest".
  if (recorded !== undefined) return recorded === forkFingerprint(req);
  // A tab from before that record: its resolved fork point is all there is.
  const point = tab.lineage?.forkedFrom;
  if (typeof req.messageId === "string") return point?.messageId === req.messageId;
  if (typeof req.turnId === "string") return point === undefined || point.turnId === req.turnId;
  return point === undefined;
}

function forkConflict(what: string): ChatSessionError {
  return new ChatSessionError(
    `That commandId ${what}: send a new commandId to fork again.`,
    "COMMAND_ID_CONFLICT"
  );
}

/** A fork request's optional strings: absent, or a non-blank string of at most `max` characters. */
function optionalField(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max || !/\S/.test(value)) {
    throw new ChatSessionError(`${name} must be a non-empty string of at most ${max} characters.`, "INVALID_COMMAND");
  }
  return value;
}

export class AgentChatService {
  readonly chat: ChatSessionManager;
  private readonly client: AgentHostClient;
  private readonly supervisor: AgentHostSupervisor;
  private readonly summary: AgentChatSummaryService;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Signs the URLs agent pages are framed from (spec 2026-10-14 §2.2). Its
   * key is this process's own, never persisted: a restart retires them all.
   */
  private readonly visualUrls: VisualUrlSigner = createVisualUrlSigner();

  constructor(private readonly opts: AgentChatServiceOptions) {
    const socketPath = agentHostSocketPath(opts.baseDir, opts.platform);
    this.chat = new ChatSessionManager({ requestPersist: () => this.requestPersist() });
    // A closed fork's key never answers with it again (`forkSession`).
    this.chat.lifecycle.on("closed", ({ id, rolledBack }: { id: string; rolledBack?: boolean }) => {
      // A fork's own rollback is no close of the user's: its key may fork again.
      if (rolledBack) return;
      for (const record of this.forkRecords.values()) {
        if (record.childId === id) record.closed = true;
      }
    });
    this.client = new AgentHostClient({
      socketPath,
      token: () => this.supervisor.currentToken()
    });
    this.supervisor = new AgentHostSupervisor({
      appdir: opts.baseDir,
      tokenPath: agentHostTokenPath(opts.baseDir),
      cwd: opts.cwd,
      env: buildAgentHostEnv({
        sessionPath: opts.sessionPath,
        tmpdir: opts.env.TMPDIR,
        home: opts.env.HOME ?? homedir(),
        npmConfigPrefix: opts.env.NPM_CONFIG_PREFIX,
        appdir: opts.baseDir,
        socketPath,
        ...(opts.daemonSocketPath !== undefined ? { daemonSocketPath: opts.daemonSocketPath } : {})
      }),
      nodeBin: process.execPath,
      // The daemon's own commit, read at boot; a surviving host reporting a
      // different one is drained and replaced (see `support/code-stamp.ts`).
      codeStamp: readCodeStamp(opts.cwd),
      adapters: {
        probe: () => this.probe(),
        requestStop: () => this.requestHostStop(),
        // Agent goals §5.7: asked on every blocked drain evaluation while a
        // deploy waits, which is what keeps the host's hold lease alive.
        requestHoldGoals: () => this.requestHostHoldGoals(),
        // …and, on a host from before that route, the legacy handover's calls.
        inspectLegacyGoalTurn: (threadId) => this.inspectLegacyGoalTurn(threadId),
        threadAdapter: (threadId) => {
          const summary = this.chat.get(threadId);
          return summary ? (this.opts.registryEntry(summary.refId)?.chat?.adapter ?? null) : null;
        },
        stopThreadSession: (threadId) => this.requestHostSessionStop(threadId),
        resumeGoalSessions: (threadIds) => this.requestHostResumeGoalSessions(threadIds),
        tmux: opts.tmux,
        spawnDirect: (bin, args, env) => {
          const child = spawn(bin, args, { cwd: opts.cwd, detached: false, stdio: "ignore", env });
          child.on("error", (error) => opts.logger?.error?.("agent host spawnDirect failed", error));
          let alive = true;
          child.on("exit", () => {
            alive = false;
          });
          return {
            kill: () => child.kill(),
            pid: child.pid,
            // The supervisor waits for the process to exit before replacing a stopped host.
            isAlive: () => alive
          };
        },
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // The host's OWN refresh (§4.6.4) reaches the bus through here; the
        // explicit refresh route publishes separately.
        onProvidersRevision: () => this.summary.publishProvidersChanged(),
        // The daemon's own liveness view for the §3.1 drain: the host a deploy
        // replaces may predate `backgroundWorkThreadIds` on `/health`. Unknown
        // (null) until the first poll round — boot adoption runs before the
        // poll starts, and an empty view would read as "nothing running".
        backgroundWorkThreadIds: () =>
          this.summary.hasPolled() ? this.summary.threadsWithBackgroundLiveness() : null,
        // Tells a starved host from a dead one before it is restarted.
        loadPerCpu: () => loadavg()[0] / availableParallelism(),
        logger: opts.logger
      }
    });
    this.summary = new AgentChatSummaryService({
      client: this.client,
      chat: this.chat,
      broadcaster: opts.broadcaster,
      push: opts.push,
      logger: opts.logger,
      // The poll idles while the host is restarting or foreign: every chat
      // route answers 503 then anyway, and a read would only log noise.
      isHostHealthy: () => this.supervisor.isHealthy(),
      // A settled turn reopens the §3.1 drain window, so a deploy's version
      // handover happens the moment the host goes quiet — and so does a
      // subagent fleet or watch loop finishing, which the drain also waits on.
      onTurnSettled: () => this.supervisor.handleTurnSettled(),
      onBackgroundWorkEnded: () => this.supervisor.handleTurnSettled(),
      onUsageLimits: (reading) => this.usageLimitsListener(reading)
    });
  }

  private usageLimitsListener: (reading: ThreadUsageReading) => void = () => undefined;

  /** Where each thread's live account-usage reading goes (`index.ts`: the usage service). */
  setUsageLimitsListener(listener: (reading: ThreadUsageReading) => void): void {
    this.usageLimitsListener = listener;
  }

  /**
   * The daemon's `request_secret` cards (`index.ts`): a pending card raises the
   * thread's attention as a pending question does (design 2026-10-14 §5).
   */
  setSecretRequests(source: SummarySecretRequests): void {
    this.summary.setSecretRequests(source);
  }

  /** A thread's secret cards opened or closed: its attention follows at once, not at the next poll. */
  secretRequestsChanged(threadId: string): void {
    this.summary.secretRequestsChanged(threadId);
  }

  /** Persisting is the PTY manager's job; `index.ts` injects the callback. */
  private persist: () => void = () => undefined;

  setPersist(persist: () => void): void {
    this.persist = persist;
  }

  private requestPersist(): void {
    try {
      this.persist();
    } catch (error) {
      this.opts.logger?.error?.("failed to persist agent-chat tabs", error);
    }
  }

  /**
   * The §5.2 contributor the session manager writes and reads our records
   * through. `owns` is what keeps a chat record out of the tmux reattach and
   * out of the orphan reap.
   */
  indexContributor(): SessionIndexContributor {
    return {
      records: () => this.chat.records(),
      adopt: (records) => this.chat.adopt(records),
      owns: (record) => record.kind === "agent-chat",
      pendingThreadDeletes: () => this.chat.pendingThreadDeletes(),
      adoptPendingThreadDeletes: (ids) => this.chat.adoptPendingDeletes(ids)
    };
  }

  /** Boot: adopt or spawn the host, then start the coarse subscription. */
  async init(): Promise<void> {
    await this.supervisor.init();
    // Clear the durable delete queue as soon as a host is adopted, and again on
    // every later adoption (a respawn or the drain-restart).
    await this.replayPendingThreadDeletes();
    // …and settle every fork tab whose host answer was lost (`reconcileForks`) the same way.
    await this.reconcileForks();
    this.supervisor.onChange((status) => {
      if (status.state === "healthy") {
        void this.replayPendingThreadDeletes();
        void this.reconcileForks();
      }
    });
    this.summary.start();
    // `.catch`, never a bare `void`: a rejection here would be unhandled, and
    // Node ≥15 exits the process on one — taking every live terminal, `/events`
    // stream and WebSocket with it. Supervision failures are logged and retried
    // on the next tick, which is the whole point of the interval.
    this.healthTimer = setInterval(() => {
      this.supervisor
        .checkHealth()
        .catch((error) => this.opts.logger?.error?.("agent host health check failed", error))
        // A host that stayed healthy but answered a fork too late gets no "healthy" change:
        // its unconfirmed fork tabs are settled on the next tick. No I/O when there are none.
        .then(() => this.reconcileForks());
    }, AGENT_HOST_HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  /** Set by {@link stop}: a health tick or status change after it reconciles nothing. */
  private stopped = false;

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    await this.summary.stopAndWait();
    this.supervisor.stop();
  }

  /** Pids `/api/system/processes/kill` must refuse (§3.1 "Kill guard"). */
  protectedPids(): number[] {
    return this.supervisor.protectedPids();
  }

  /**
   * Agent Profiles (spec 2026-10-18): true when the adopted host launches a profile thread with
   * its profile (`AgentHostCapabilities.sessionProfiles`). A host without it would quietly run
   * one as Global, so a launch or switch that names a profile must be refused (or wait for the
   * deploy's host restart) while this is false.
   */
  hostSupportsSessionProfiles(): boolean {
    return this.supervisor.hostSupports("sessionProfiles");
  }

  private sessionProfiles: ChatSessionProfiles | null = null;

  /** `index.ts`: the Agent Profiles a launch draws on, once the preparation lifecycle exists. */
  setSessionProfiles(profiles: ChatSessionProfiles): void {
    this.sessionProfiles = profiles;
  }

  // boxes (spec 2026-10-19 §8.5) ---------------------------------------------------------------

  private boxes: ChatBoxes | null = null;

  /** `index.ts`: where box projects are (`BoxRegistry`) and what their tooling contributes, once the box service exists. */
  setBoxes(boxes: ChatBoxes): void {
    this.boxes = boxes;
  }

  /** A chat whose project's box was destroyed: why no agent can run in it (its transcript stays readable). */
  private destroyedBoxRefusal(id: string): string | null {
    const boxes = this.boxes ?? this.opts.boxes ?? null;
    const projectPath = this.chat.get(id)?.projectPath ?? "";
    if (boxes === null || projectPath.length === 0) return null;
    const location = boxes.registry.locate(projectPath);
    if (location.kind !== "box" || location.record.state !== "destroyed") return null;
    return "This project's box was destroyed, so no agent can run in it. Its transcript stays readable here.";
  }

  /**
   * The `box` launch field of a chat in `projectPath` (`HostThreadBox`), or none for a host
   * project. Refused — a `ChatSessionError` the chat shows — when the project's box cannot take a
   * chat: the agent host predates boxes (it would run the CLI here, in the empty stub), the chat
   * runs as the System account (its logins are refreshed outside Orquester, spec §7), or the box is
   * destroyed or has never connected.
   */
  private boxLaunchFor(projectPath: string, adapter: AgentAdapterId, accountId: string): { box?: HostThreadBox } {
    const boxes = this.boxes ?? this.opts.boxes ?? null;
    if (boxes === null || projectPath.length === 0) return {};
    const location = boxes.registry.locate(projectPath);
    if (location.kind !== "box") return {};
    if (location.record.state === "destroyed") {
      throw new ChatSessionError("This project's box was destroyed, so no agent can run in it.", "BOX_DESTROYED");
    }
    if (!this.supervisor.hostSupports("boxes")) {
      throw new ChatSessionError(
        "Chats in a box project need the updated agent host, which starts once no turn is running. Try again then.",
        "COMMAND_REJECTED"
      );
    }
    // OpenCode has no managed accounts: it runs as the System identity with API-key providers.
    if (adapter !== "opencode" && accountId.length === 0) {
      throw new ChatSessionError(
        "Chats in a box project run with an Orquester-managed account, not the System login. Pick an account for this chat.",
        "BOX_SYSTEM_ACCOUNT"
      );
    }
    const connection = location.connection;
    if (connection === undefined) {
      throw new ChatSessionError("This project's box has not connected yet. Try again once it shows ready.", "BOX_NOT_READY");
    }
    return {
      box: {
        boxId: location.boxId,
        socketPath: boxSocketPath(this.opts.baseDir, location.boxId),
        sys: connection.sys,
        paths: connection.paths,
        tooling: boxes.tooling?.contribution(location.boxId) ?? { pathPrepend: [], env: {}, nodeRequire: [] }
      }
    };
  }

  /**
   * The account's launch fields, EXACTLY as a terminal launch composes them: the registry entry's
   * own env (which already carries `<appdir>/daemon/env/<id>.env`, loaded by RegistryService)
   * under the `resolveExtraEnv` contributors, which win a collision — the same order the
   * terminal wrapper script's `export` has over `tmux -e`. The adapter's home variable is the
   * one authority on the home dir.
   */
  private accountLaunchFields(entry: RegistryEntry, adapter: AgentAdapterId, launch: ChatLaunchEnv | null): ChatLaunchFields {
    const launchEnv: Record<string, string> = { ...entry.env, ...(launch?.env ?? {}) };
    const homePath = launchEnv[ACCOUNT_HOME_ENV_VAR[adapter]];
    return {
      launchEnv,
      ...(launch?.unset?.length ? { unsetEnv: [...launch.unset] } : {}),
      ...(homePath ? { homePath } : {}),
      ...(launch?.serverPool ? { serverPool: launch.serverPool } : {})
    };
  }

  /**
   * The launch with a profile on top (spec 2026-10-18 §7 "One seam"): refused unless the host
   * runs profile threads with their profile (an older host would launch them Global), then the
   * profile's current prepared version for this agent and account and its agent's contribution
   * over `base`. Throws `ChatSessionError` — a profile refusal keeps its own code
   * (`PROFILE_NOT_FOUND`, `PROFILE_NOT_READY`, `PROFILE_UNSUPPORTED_AGENT`) and message.
   */
  private async profileLaunch(input: {
    profileId: string;
    adapter: AgentAdapterId;
    accountId: string;
    projectPath: string;
    base: ChatLaunchFields;
  }): Promise<{ profile: HostThreadProfile; fields: ChatLaunchFields }> {
    const profiles = this.sessionProfiles ?? this.opts.sessionProfiles ?? null;
    if (profiles === null) {
      throw new ChatSessionError("Agent Profiles are not available yet. Try again in a moment.", "COMMAND_REJECTED");
    }
    if (!this.hostSupportsSessionProfiles()) {
      throw new ChatSessionError(
        "Agent Profiles need the updated agent host, which starts once no turn is running. Try again then.",
        "COMMAND_REJECTED"
      );
    }
    try {
      return await profiles.resolve({
        profileId: input.profileId,
        agent: input.adapter,
        accountId: input.accountId,
        projectPath: input.projectPath,
        base: input.base
      });
    } catch (error) {
      throw profileRefusal(error);
    }
  }

  // --- §3.2 the registry moved a CLI under the host ------------------------

  /** The version each chat-capable registry entry was last seen at. */
  private readonly registryVersions = new Map<string, string>();
  /** The install state each chat-capable entry was last seen in. */
  private readonly registryInstallStates = new Map<string, RegistryEntry["installState"]>();
  /** When each adapter was last nudged, on the injected clock. */
  private readonly providerRefreshAt = new Map<AgentAdapterId, number>();
  /** In-flight nudges, used as the idempotence guard. */
  private readonly providerRefreshInFlight = new Map<AgentAdapterId, Promise<void>>();

  /**
   * A registry entry changed — ask the host to re-probe the provider it maps to.
   *
   * The incident: `claude` was updated from Settings → Agents (2.1.278 →
   * 2.1.280, which resolves the `opus` alias to a different model) and a chat
   * opened afterwards still offered the old alias, because the host's snapshot
   * was the one probed under the old binary and **nothing told it the CLI had
   * changed**. The daemon is the one process that knows an install just
   * happened, so it says so.
   *
   * Two arms, one debounce:
   * - the install/update itself, as `installState` settles from `installing`
   *   back to `idle` — the moment `RegistryService.runManaged` has re-resolved
   *   the bin and kicked its own version detection;
   * - a version that MOVED for an entry with a chat adapter, which also covers
   *   a CLI updated outside the registry entirely.
   *
   * A first sighting is never a change: the host's own boot probe already owns
   * boot.
   */
  onRegistryEntryChanged(entry: RegistryEntry): void {
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      // §5.3: a row with no chat adapter has no provider to refresh.
      return;
    }
    const previousState = this.registryInstallStates.get(entry.id);
    this.registryInstallStates.set(entry.id, entry.installState);
    const previousVersion = this.registryVersions.get(entry.id);
    // `undefined` is "not detected yet" — `runManaged` clears the version
    // before re-detecting it — and must never be read as a change, nor forget
    // the version we knew.
    if (entry.version !== undefined) {
      this.registryVersions.set(entry.id, entry.version);
    }

    const installed = previousState === "installing" && entry.installState === "idle";
    const moved =
      entry.version !== undefined &&
      previousVersion !== undefined &&
      previousVersion !== entry.version;
    if (!installed && !moved) {
      return;
    }
    this.refreshProvider(
      adapter,
      installed ? `${entry.id} install/update finished` : `${entry.id} version moved`
    );
  }

  /**
   * Nudge the host to re-probe one provider. **Fire-and-forget**: it is never
   * awaited by the route that triggered it, and a failure is logged and dropped
   * — an install response must never fail because the host was busy.
   *
   * A refresh that actually changed something publishes the same coarse
   * `agent.providers.changed` the manual `POST /api/agent/providers/:id/refresh`
   * does, so an open client re-reads §6.3 exactly as it does today. (The host
   * also bumps `providersRevision`, which the supervisor's health poll turns
   * into the same event — this only makes it immediate.)
   */
  private refreshProvider(adapterId: AgentAdapterId, reason: string): void {
    if (this.providerRefreshInFlight.has(adapterId)) {
      return;
    }
    if (!this.supervisor.isHealthy()) {
      // Every host route answers 503 now, and a host that comes up later probes
      // every provider at boot anyway.
      return;
    }
    const now = Date.now();
    const last = this.providerRefreshAt.get(adapterId);
    if (last !== undefined && now - last < PROVIDER_REFRESH_DEBOUNCE_MS) {
      return;
    }
    this.providerRefreshAt.set(adapterId, now);
    const task = this.client
      .json<{ changed?: boolean }>(
        "POST",
        agentHostRoutes.providerRefresh(adapterId),
        {},
        { timeoutMs: PROVIDER_REFRESH_DEADLINE_MS }
      )
      .then((response) => {
        if (response.value?.changed === true) {
          this.summary.publishProvidersChanged({ adapterId });
        }
      })
      .catch((error: unknown) => {
        this.opts.logger?.warn?.(
          `agent host provider refresh failed for ${adapterId} (${reason})`,
          error
        );
      })
      .finally(() => {
        this.providerRefreshInFlight.delete(adapterId);
      });
    this.providerRefreshInFlight.set(adapterId, task);
  }

  /**
   * Agent profile §4.8: ask the agent host to restart OpenCode's idle servers
   * (`POST /opencode/recycle-idle`) — `opencode serve` caches its global config
   * for its whole life, so a config write reaches the next turn only through a
   * fresh server. Busy servers are recycled by the host once they go idle.
   *
   * Never throws, and never needs awaiting (fire-and-forget after an OpenCode
   * mutation). A host that predates the route (404), a host that is down or
   * restarting, and a timeout are logged at info and otherwise ignored: the
   * change then applies once OpenCode's server restarts on its own.
   *
   * `poolKey` recycles only the servers started for that keyed pool
   * (`ChatLaunchEnv.serverPool`); omitted, every OpenCode server.
   */
  async recycleIdleOpenCodeServers(poolKey?: string): Promise<void> {
    if (!this.supervisor.isHealthy()) {
      this.opts.logger?.log?.("agent host unavailable; OpenCode servers not recycled");
      return;
    }
    const body: AgentHostRecycleOpenCodeRequest = poolKey !== undefined ? { poolKey } : {};
    try {
      const response = await this.client.json<{
        recycled?: unknown;
        deferred?: unknown;
        error?: { message?: unknown };
      }>("POST", agentHostRoutes.recycleIdleOpenCode, body, { timeoutMs: OPENCODE_RECYCLE_DEADLINE_MS });
      if (response.status === 404) {
        this.opts.logger?.log?.("agent host predates OpenCode server recycling; servers not recycled");
        return;
      }
      if (response.status !== 200) {
        const message = response.value?.error?.message;
        this.opts.logger?.warn?.(
          `agent host answered ${response.status} to the OpenCode server recycle` +
            (typeof message === "string" && message ? `: ${message}` : "")
        );
        return;
      }
      const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      this.opts.logger?.log?.(
        `OpenCode servers recycled: ${count(response.value?.recycled)} now, ${count(response.value?.deferred)} when idle`
      );
    } catch (error) {
      if (error instanceof HostUnavailableError) {
        this.opts.logger?.log?.(`agent host unavailable; OpenCode servers not recycled (${error.message})`);
        return;
      }
      this.opts.logger?.warn?.("OpenCode server recycle failed", error);
    }
  }

  /**
   * True only for the agent host's own bearer — the gate on the socket-only
   * session-tool route (design 2026-10-14 §1.1). Constant-time.
   */
  authorizeHostRequest(authorization: string | undefined): boolean {
    const token = this.supervisor.currentToken();
    if (!token || authorization === undefined) return false;
    const expected = Buffer.from(agentHostAuthValue(token), "utf8");
    const actual = Buffer.from(authorization, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * What a session-tool call's context says about its thread, from the
   * thread's own chat tab (never from the call): its project, its cwd and the
   * adapter it runs on. Null for a thread with no chat tab.
   */
  sessionToolThread(threadId: string): { projectPath: string; cwd: string; agentId: AgentAdapterId } | null {
    const summary = this.chat.get(threadId);
    if (!summary) return null;
    const agentId = this.opts.registryEntry(summary.refId)?.chat?.adapter;
    if (agentId === undefined || !isAgentAdapterId(agentId)) return null;
    return { projectPath: summary.projectPath, cwd: summary.cwd, agentId };
  }

  routeDeps(): AgentChatRouteDeps {
    return {
      client: this.client,
      isHostHealthy: () => this.supervisor.isHealthy(),
      hostInstanceId: () => this.supervisor.status().hostInstanceId,
      chatSession: (id) => this.chat.get(id),
      noteSeq: (id, seq) => this.chat.noteSeq(id, seq),
      agentRunRefusal: (id) => this.destroyedBoxRefusal(id),
      switchAccount: (id, body) => this.switchAccount(id, body),
      switchProfile: (id, body) => this.switchProfile(id, body),
      profileCatalog: (summary) => this.profileCatalog(summary),
      restartHost: async () => {
        this.lastMarkedThreadIds = [];
        const hostInstanceId = await this.supervisor.restartNow();
        return { hostInstanceId, markedThreadIds: this.lastMarkedThreadIds };
      },
      onProvidersChanged: (adapterId) =>
        this.summary.publishProvidersChanged(
          isAgentAdapterId(adapterId) ? { adapterId } : {}
        ),
      attachmentPath: (sessionId, attachmentId) => this.attachmentPath(sessionId, attachmentId),
      sendAttachment: (reply, path) => this.opts.sendAttachment(reply, path),
      visualUrls: this.visualUrls,
      ...(this.opts.listManagedAccounts
        ? { managedAccounts: () => this.opts.listManagedAccounts!() }
        : {}),
      logger: this.opts.logger
    };
  }

  /** Threads the OLD host marked for continuation on its way out (§3.3). */
  private lastMarkedThreadIds: string[] = [];

  /**
   * A profile chat's composer fallback (`GET …/catalog`, source `profile`): the profile's own items
   * for the chat's agent. `null` for a Global chat, an agent no profile serves, or a profile that
   * cannot be read (gone: its next start falls back to Global).
   */
  private async profileCatalog(summary: SessionSummary): Promise<{ slashCommands: SlashCommand[]; skills: Skill[] } | null> {
    const profiles = this.sessionProfiles ?? this.opts.sessionProfiles ?? null;
    const adapter = this.opts.registryEntry(summary.refId)?.chat?.adapter;
    if (!summary.profileId || profiles?.catalog === undefined || !isSessionProfileAgentId(adapter)) return null;
    return profiles.catalog(summary.profileId, adapter).catch(() => null);
  }

  /** HOST_UNAVAILABLE, worded for what the supervisor is doing about it. */
  private hostUnavailable(): ChatSessionError {
    const state = this.supervisor.status().state;
    const message =
      state === "starting"
        ? "The agent host is restarting. Try again in a moment."
        : state === "healthy"
          ? "The agent host is not responding. Try again in a moment."
          : "The agent host is not running.";
    return new ChatSessionError(message, "HOST_UNAVAILABLE");
  }

  // --- §6.1 lifecycle ------------------------------------------------------

  /**
   * Create a chat tab and its thread (§6.1). **Order is fixed**: the tab record
   * is written first, so a failed first turn leaves an empty thread the user
   * retries into rather than a half-created tab. A host that refuses the thread
   * rolls the tab back, because a tab pointing at no thread is worse than none.
   */
  async createSession(req: CreateAgentChatRequest, order: number): Promise<SessionSummary> {
    const entry = this.opts.registryEntry(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new ChatSessionError(`Registry entry "${req.refId}" is not available.`);
    }
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      // §5.3: an agent row without `chat` cannot open a chat tab.
      throw new ChatSessionError(`"${entry.name}" has no chat adapter.`);
    }
    const fields = chatFields(req);
    // workflows §5.10 — the route already refused a bad owner; this keeps a direct caller honest.
    const owner = parseSessionOwner(req.owner);
    if (!owner.ok) {
      throw new ChatSessionError(owner.message, owner.code);
    }
    // Spec 2026-10-14 §6, unified MCP design 2026-10-15 §4.1: a `delegate` (a task) or an `opened`
    // chat names its parent — a chat tab of any project. A fork carries the parent's conversation
    // and is created by `forkSession`, never here.
    let lineage: ThreadLineage | undefined;
    if (fields.lineage !== undefined) {
      const parentId = fields.lineage?.parentThreadId;
      const parent = typeof parentId === "string" ? this.chat.get(parentId) : undefined;
      const relation = fields.lineage?.relation;
      if ((relation !== "delegate" && relation !== "opened") || !parent) {
        throw new ChatSessionError(
          "lineage must name a chat session as parent, with relation \"delegate\" or \"opened\".",
          "INVALID_LINEAGE"
        );
      }
      // Compared as the daemon resolves a project everywhere else — realpath inside the
      // workspaces sandbox, else a plain resolve — so `/w/p/` and `/w/./p` are one project. A child
      // of the parent's project groups with its tabs under the parent's own spelling of the path.
      if (await this.sameProject(parent.projectPath, req.projectPath ?? "")) {
        req = { ...req, projectPath: parent.projectPath };
      }
      // PRINCIPAL-GATED (`principal.ts`): the route removed `agentCreated` unless the request's
      // principal is the parent's own agent (`gateSessionCreateBody`), so a `true` here is one.
      lineage = createdChildLineage(parent, { relation, agentCreated: fields.lineage.agentCreated === true }, (id) => this.chat.get(id), new Date().toISOString());
    }
    if (fields.resume && !isUsableConversationId(fields.resume.conversationId)) {
      throw new ChatSessionError(
        "That conversation cannot be resumed with this agent.",
        "RESUME_UNAVAILABLE"
      );
    }
    if (!this.supervisor.isHealthy()) {
      throw this.hostUnavailable();
    }

    // Agent Profiles (spec 2026-10-18 §5.5): carried at the top level like `accountId`;
    // `chat.profileId` is the host-side spelling. Omitted = Global.
    const profileId = requestedProfileId(req.profileId ?? fields.profileId, false) ?? undefined;
    const unattended = fields.unattended === true;

    let launch: ChatLaunchEnv | null = null;
    try {
      // The account rides the top level, shared with the terminal path;
      // `chat.accountId` is the host-side spelling and is only a fallback.
      launch = await this.opts.resolveLaunchEnv(entry, {
        accountId: req.accountId ?? fields.accountId
      });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }

    const accountId = launch?.accountId ?? "";
    const home = resolveHomeKind(accountId);
    const cwd = req.cwd || req.projectPath || homedir();
    // EXACTLY the env a terminal launch composes today, with the profile's contribution on top.
    // A create naming a profile that is gone or not ready FAILS (interactive or not): nothing has
    // run Global yet to fall back from, and the user (or the caller) is told why.
    let launchFields = this.accountLaunchFields(entry, adapter, launch);
    let profile: HostThreadProfile | undefined;
    if (profileId !== undefined) {
      ({ profile, fields: launchFields } = await this.profileLaunch({
        profileId,
        adapter,
        accountId,
        projectPath: req.projectPath ?? "",
        base: launchFields
      }));
    }
    // boxes: a box project's chat runs its CLI in the box (refused here when it cannot).
    const boxField = this.boxLaunchFor(req.projectPath ?? "", adapter, accountId);
    const id = randomUUID();

    // Prepare Claude trust before the thread exists so its first turn sees the project settings.
    await this.prepareHome(adapter, launchFields.launchEnv, req.projectPath ?? "");

    this.createsInFlight.add(id);
    const summary = this.chat.create({
      id,
      refId: entry.id,
      title: req.title || entry.name,
      projectPath: req.projectPath ?? "",
      cwd,
      order,
      accountId,
      home,
      ...(owner.owner ? { owner: owner.owner } : {}),
      ...(lineage ? { lineage } : {}),
      ...(profile ? { profileId: profile.profileId } : {}),
      ...(unattended ? { unattended: true } : {}),
      // Announced before the host has the thread: a view that opens its stream now must show
      // it as starting, not as gone (`SessionSummary.chatPending`).
      pending: true
    });

    const body: CreateHostThreadRequest = {
      threadId: id,
      projectPath: summary.projectPath,
      cwd,
      title: summary.title,
      refId: entry.id,
      accountId,
      home,
      // Passed through as the client sent it. An empty `modelSelection.model`
      // means "the provider's own default" — the launcher had no catalog to
      // pick from — and is never a refusal here.
      modelSelection: fields.modelSelection,
      runtimeMode: fields.runtimeMode,
      ...launchFields,
      ...(fields.resume ? { resume: fields.resume } : {}),
      ...(lineage ? { lineage } : {}),
      ...(profile ? { profile, profileId: profile.profileId } : {}),
      // boxes:
      ...boxField
    };
    try {
      const response = await this.client.json<{
        error?: { code: string; message: string; detail?: unknown };
      }>("POST", agentHostRoutes.createThread, body);
      if (response.status >= 400) {
        const code = response.value?.error?.code;
        // The conversation is already open in another tab (the host names it).
        // Its own code, so the client can switch to that tab instead of
        // reporting a failure — a second click on a slow resume is exactly this.
        const detail = response.value?.error?.detail as { ownerThreadId?: unknown } | undefined;
        if (typeof detail?.ownerThreadId === "string" && detail.ownerThreadId) {
          throw new ChatSessionError(
            response.value?.error?.message ?? "That conversation is already open in another tab.",
            CONVERSATION_ALREADY_OPEN,
            detail.ownerThreadId
          );
        }
        throw new ChatSessionError(
          response.value?.error?.message ?? "The agent host refused the thread.",
          code === "RESUME_UNAVAILABLE" ? "RESUME_UNAVAILABLE" : "SESSION_UNAVAILABLE"
        );
      }
    } catch (error) {
      this.chat.close(id);
      if (error instanceof ChatSessionError) throw error;
      if (error instanceof HostUnavailableError) {
        throw this.hostUnavailable();
      }
      throw new ChatSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      this.createsInFlight.delete(id);
    }
    // The host has the thread: said, so a view waiting on it connects again.
    return this.chat.confirmCreated(id) ?? summary;
  }

  /**
   * How many agent-made links lie above and including `tab` (spec 2026-10-14 §5 "Delegation";
   * unified MCP design 2026-10-15 §5.6, §13 c — {@link countsTowardDelegationDepth}): its
   * lineage's recorded `delegationDepth`, else — a record from before the field — counted up
   * through the open tabs its lineage names.
   */
  delegationDepthOf(tab: { lineage?: ThreadLineage }): number {
    return lineageDelegationDepth(tab, (id) => this.chat.get(id));
  }

  /**
   * Whether a chat created from `creator` (its delegate, opened chat or fork) inherits workflow
   * ownership — {@link lineageInheritsWorkflowOwnership} over the open tabs.
   */
  inheritsWorkflowOwnership(creator: { owner?: SessionSummary["owner"]; lineage?: ThreadLineage }): boolean {
    return lineageInheritsWorkflowOwnership(creator, (id) => this.chat.get(id));
  }

  /** Two project paths name one project once resolved (realpath in the sandbox, else `resolve`). */
  private async sameProject(a: string, b: string): Promise<boolean> {
    if (a.length === 0 || b.length === 0) return a === b;
    const canonical = async (path: string): Promise<string> =>
      (await this.opts.resolveTrustedProjectDir(path).catch(() => null)) ?? resolvePath(path);
    const [left, right] = await Promise.all([canonical(a), canonical(b)]);
    return left === right;
  }

  /**
   * Thread lineage (spec 2026-10-14 §6): a new chat tab in the parent's project, with the
   * parent's agent, account, model and options, whose conversation is the parent's up to a
   * message. The order mirrors {@link createSession}: everything that can refuse first, then the
   * tab record, then the host's `POST /threads/:parentId/fork` — and a refusal rolls the tab back.
   *
   * The account is the PARENT's, pinned (the system identity included): a provider's resume
   * identity stays in the home that created it, so a parent whose account is gone is refused
   * rather than forked into another home.
   */
  async forkSession(parentId: string, req: ForkSessionRequest, order: number): Promise<ForkSessionResponse> {
    const commandId = optionalField((req as Record<string, unknown> | undefined)?.commandId, "commandId", 200);
    if (commandId === undefined) return this.forkSessionNow(parentId, req, order, randomUUID());
    const fingerprint = forkFingerprint(req);
    const key = `${parentId}\u0000${commandId}`;
    const id = forkIdFor(parentId, commandId);
    // COMMAND_ID_CONFLICT, as a §6.2 command answers a reused id: the same key with another fork
    // point, or a key whose fork was closed meanwhile — never the first fork in its place, and
    // never a closed one back.
    const record = this.forkRecords.get(key);
    if (record) {
      if (record.fingerprint !== fingerprint) throw forkConflict("names another fork point");
      if (record.closed) throw forkConflict("opened a fork that was closed since");
    } else {
      if (this.chat.pendingThreadDeletes().includes(id)) throw forkConflict("opened a fork that was closed since");
      const existing = this.chat.get(id);
      if (existing && !sameForkPoint(existing, this.chat.forkFingerprint(id), req)) {
        throw forkConflict("names another fork point");
      }
    }
    // Idempotent by `commandId` (the receipts pattern): a repeat while the first is in flight
    // shares its answer, and a repeat after it landed — a daemon restart included — finds the
    // tab under the id the key names and has the host answer for it again (the host's fork of
    // an existing child is idempotent), so a double submit never opens a second fork.
    const running = this.forksInFlight.get(key);
    if (running) return running;
    // A reconcile of this very tab is asking the host: its outcome (confirmed, or taken back)
    // decides what this repeat finds, so it is waited for and the request read afresh.
    const confirming = this.forksConfirming.get(id);
    if (confirming) {
      await confirming;
      return this.forkSession(parentId, req, order);
    }
    this.rememberFork(key, { fingerprint, childId: id, closed: false });
    const run = this.forkSessionNow(parentId, req, order, id, fingerprint)
      .catch((error: unknown) => {
        // A fork that never landed leaves the key free for a retry.
        if (!this.chat.has(id)) this.forkRecords.delete(key);
        throw error;
      })
      .finally(() => {
        this.forksInFlight.delete(key);
      });
    this.forksInFlight.set(key, run);
    return run;
  }

  /**
   * Fork keys this daemon has seen (`parent\0commandId` → its fork point and tab), so a reused
   * key is answered truthfully: the same fork, or COMMAND_ID_CONFLICT. Bounded; after a restart
   * the tab's own lineage and the pending deletes stand in for it.
   */
  private readonly forkRecords = new Map<string, { fingerprint: string; childId: string; closed: boolean }>();

  private rememberFork(key: string, record: { fingerprint: string; childId: string; closed: boolean }): void {
    this.forkRecords.delete(key);
    this.forkRecords.set(key, record);
    if (this.forkRecords.size > FORK_RECORDS) {
      this.forkRecords.delete(this.forkRecords.keys().next().value as string);
    }
  }

  /** Forks in flight by `parentId\0commandId`, for {@link forkSession}'s idempotency. */
  private readonly forksInFlight = new Map<string, Promise<ForkSessionResponse>>();

  private async forkSessionNow(
    parentId: string,
    req: ForkSessionRequest,
    order: number,
    id: string,
    /** A keyed fork's fork point, recorded on its tab; absent for an unkeyed fork. */
    fingerprint?: string
  ): Promise<ForkSessionResponse> {
    // Marked from the first moment, so a reconcile never asks about (or takes back) this tab
    // while its own fork decides it.
    this.forkChildrenInFlight.add(id);
    try {
      return await this.forkSessionAttempt(parentId, req, order, id, fingerprint);
    } finally {
      this.forkChildrenInFlight.delete(id);
    }
  }

  private async forkSessionAttempt(
    parentId: string,
    req: ForkSessionRequest,
    order: number,
    id: string,
    fingerprint: string | undefined
  ): Promise<ForkSessionResponse> {
    const keyed = fingerprint !== undefined;
    const parent = this.chat.get(parentId);
    if (!parent) {
      throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND");
    }
    const body = (req ?? {}) as Record<string, unknown>;
    const messageId = optionalField(body.messageId, "messageId", 200);
    const turnId = optionalField(body.turnId, "turnId", 200);
    const role = body.role === undefined || body.role === null ? undefined : body.role;
    if (role !== undefined && role !== "user" && role !== "assistant") {
      throw new ChatSessionError('role must be "user" or "assistant".', "INVALID_COMMAND");
    }
    const title = optionalField(body.title, "title", 200)?.trim();
    // PRINCIPAL-GATED (`ForkSessionRequest.agentCreated`): the fork route removed it unless the
    // request's principal is the forked chat's own agent, so a `true` here is one (§13 c). A
    // repeat of a keyed fork keeps what the first recorded.
    const agentCreated = existingAgentCreated(this.chat.get(id)) ?? body.agentCreated === true;
    const entry = this.opts.registryEntry(parent.refId);
    if (!entry?.resolvedBin || !entry.enabled || !entry.chat?.adapter) {
      throw new ChatSessionError(`Registry entry "${parent.refId}" is not available.`);
    }
    const adapter = entry.chat.adapter;
    if (!this.supervisor.isHealthy()) {
      throw this.hostUnavailable();
    }
    const parentAccount = parent.accountId ?? "";
    let launch: ChatLaunchEnv | null = null;
    try {
      launch = await this.opts.resolveLaunchEnv(entry, { accountId: parentAccount || SYSTEM_ACCOUNT_ID });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }
    if ((launch?.accountId ?? "") !== parentAccount) {
      throw new ChatSessionError(
        "The account this conversation runs under is no longer available, so it cannot be forked.",
        "SESSION_UNAVAILABLE"
      );
    }
    const home = resolveHomeKind(parentAccount);
    // The child's Agent Profile (spec 2026-10-18 §5.5): the parent's unless the request names one
    // (`null` = Global). A fork of an unattended chat is unattended too.
    const requestedProfile = requestedProfileId(body.profileId, true);
    const unattended = body.unattended === true || this.chat.isUnattended(parentId);
    let childProfileId = requestedProfile === undefined ? (this.chat.profileOf(parentId) ?? null) : requestedProfile;
    let launchFields = this.accountLaunchFields(entry, adapter, launch);
    // Absent: the host gives the child the parent's own (its `launch.json`).
    let profileFields: Pick<ForkHostThreadRequest, "profile" | "profileId" | "profileFallback"> =
      requestedProfile === null ? { profile: null, profileId: null } : {};
    if (childProfileId !== null) {
      try {
        const resolved = await this.profileLaunch({
          profileId: childProfileId,
          adapter,
          accountId: parentAccount,
          projectPath: parent.projectPath,
          base: launchFields
        });
        launchFields = resolved.fields;
        profileFields = { profile: resolved.profile, profileId: resolved.profile.profileId };
      } catch (error) {
        // The parent's profile was deleted: an interactive fork goes ahead as Global under the
        // account's launch, SAID explicitly (inheriting would hand the child the parent's
        // `launch.json` version, which the delete may have collected — a native fork reads it),
        // with the §5.6 notice on the child. A profile the request named, an unattended fork, or
        // any other refusal fails.
        const inheritedAndGone =
          error instanceof ChatSessionError &&
          error.code === "PROFILE_NOT_FOUND" &&
          requestedProfile === undefined &&
          !unattended;
        if (!inheritedAndGone) throw error;
        const profiles = this.sessionProfiles ?? this.opts.sessionProfiles ?? null;
        const name = await Promise.resolve(profiles?.profileName?.(childProfileId)).catch(() => undefined);
        profileFields = {
          profile: null,
          profileId: null,
          profileFallback: { previousProfileId: childProfileId, notice: deletedProfileNotice(name) }
        };
        childProfileId = null;
      }
    }
    const { launchEnv } = launchFields;
    // boxes: the child runs where its parent's conversation lives.
    const boxField = this.boxLaunchFor(parent.projectPath, adapter, parentAccount);
    await this.prepareHome(adapter, launchEnv, parent.projectPath);

    const existing = this.chat.get(id);
    if (existing && existing.lineage?.parentThreadId !== parentId) {
      throw forkConflict("already names another session");
    }
    const summary = existing ?? this.chat.create({
      id,
      refId: parent.refId,
      title: title || forkTitle(parent.title),
      projectPath: parent.projectPath,
      cwd: parent.cwd,
      order,
      accountId: parentAccount,
      home,
      // A mirror of the head's: the child's own (or the parent's, inherited), else Global.
      ...(childProfileId !== null ? { profileId: childProfileId } : {}),
      ...(unattended ? { unattended: true } : {}),
      // Provisional until the host answers with the fork point it resolved.
      lineage: withLineageStamps(
        { parentThreadId: parentId, relation: "fork", createdAt: new Date().toISOString() },
        this.delegationDepthOf(parent),
        agentCreated,
        this.inheritsWorkflowOwnership(parent)
      ),
      // Recorded for every fork (an unkeyed one too): it tells a keyed repeat from a reuse, and
      // it is the cut a reconcile re-sends (`confirmFork`).
      forkFingerprint: fingerprint ?? forkFingerprint(req),
      // Until the host's answer is in: a daemon gone before it, or an answer lost, leaves the
      // tab for `reconcileForks` to settle with the host.
      forkUnconfirmed: true
    });
    const request: ForkHostThreadRequest = {
      threadId: id,
      projectPath: summary.projectPath,
      cwd: summary.cwd,
      title: summary.title,
      refId: parent.refId,
      accountId: parentAccount,
      home,
      // The parent's, chosen by the host from its head.
      modelSelection: undefined,
      runtimeMode: undefined,
      ...launchFields,
      ...profileFields,
      // boxes:
      ...boxField,
      fork: {
        ...(messageId !== undefined ? { messageId } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
        ...(role !== undefined ? { role } : {})
      }
    };
    let result: ForkHostThreadResponse;
    try {
      const response = await this.client.json<
        ForkHostThreadResponse & { error?: { code: string; message: string } }
      >("POST", agentHostRoutes.forkThread(parentId), request);
      if (response.status >= 500 || (response.status < 400 && !response.value?.head)) {
        // The host could not answer — or answered a success without the child's head: whether
        // it forked is unknown (a success says it may well hold the child), never a refusal.
        throw new ForkOutcomeUnknown();
      }
      if (response.status >= 400) {
        const message = response.value?.error?.message ?? "The agent host refused the fork.";
        // A host from before forks answers its generic route miss until its drain-restart.
        if (response.status === 404 && message.startsWith("No route for")) {
          throw new ChatSessionError(
            "Forking needs the updated agent host, which starts once no turn is running. Try again then.",
            "COMMAND_REJECTED"
          );
        }
        const code = response.value?.error?.code;
        throw new ChatSessionError(
          message,
          code === "THREAD_NOT_FOUND" || code === "INVALID_COMMAND" || code === "COMMAND_REJECTED"
            ? code
            : "SESSION_UNAVAILABLE"
        );
      }
      result = response.value!;
    } catch (error) {
      // Only a tab this call created is rolled back — a repeat leaves the first one's as it was —
      // and how depends on what the host did:
      // - it refused (a 4xx: nothing was created): the tab goes without a host delete, and as no
      //   close of the user's, so a retry under the same key forks afresh;
      // - its answer never came (unknown outcome: it may hold the child): under a key the tab
      //   STAYS, so the caller's retry converges on it — the host answers an existing child —
      //   and no queued delete can later kill a child that retry then returns; without a key
      //   nothing can retry, so the tab goes everywhere, host thread included.
      const definite = error instanceof ChatSessionError;
      if (!existing) {
        if (definite) this.chat.discard(id);
        else if (!keyed) this.chat.close(id);
      }
      if (definite) throw error;
      if (error instanceof HostUnavailableError || error instanceof ForkOutcomeUnknown) throw this.hostUnavailable();
      throw new ChatSessionError(error instanceof Error ? error.message : String(error), "HOST_UNAVAILABLE");
    }
    // The host resolves the fork point; the depth is the daemon's, from the parent's record.
    const lineage = withLineageStamps(result.lineage, this.delegationDepthOf(parent), agentCreated, this.inheritsWorkflowOwnership(parent));
    const forked = this.chat.setLineage(id, lineage) ?? summary;
    return { session: forked, lineage, strategy: result.strategy };
  }

  /** Fork tabs whose host fork this daemon is asking for right now ({@link forkSessionNow}). */
  private readonly forkChildrenInFlight = new Set<string>();
  /** Fork tabs a {@link reconcileForks} is confirming with the host right now. */
  private readonly forksConfirming = new Map<string, Promise<void>>();
  /**
   * Fork tabs the host keeps refusing to confirm with something other than "no such thread" (a
   * child still being deleted, a body it will not take): how often, and when to ask next. Backs
   * off from one reconcile tick, doubling, and gives up after FORK_CONFIRM_MAX_REFUSALS (D-T2).
   */
  private readonly forkRefusals = new Map<string, { count: number; retryAt: number }>();
  /** Plain creates waiting for the host's answer in this process ({@link reconcileCreates}). */
  private readonly createsInFlight = new Set<string>();
  private reconciling: Promise<void> | null = null;

  /**
   * Settle every fork tab the host has not answered for (`forkUnconfirmed`): its answer was
   * lost (the socket went, a 5xx, a timeout) or the daemon went before it came. The host is
   * asked — `confirmOnly`, so nothing is created now — whether it holds the child:
   * - it does (or its fork finishes meanwhile): the tab is confirmed and takes the lineage the
   *   host resolved, fork point included;
   * - it refuses (no such child, never created): the tab is taken back as a rollback — no host
   *   delete (there is nothing to delete, and no queued delete may later kill a child a retry
   *   creates), and the fork key may fork again;
   * - no answer again: the tab stays unconfirmed for the next attempt.
   * Run at host adoption, on every return to healthy and on each health tick; a fork in flight
   * in this daemon is left to its own answer.
   */
  reconcileForks(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    const run = (async () => {
      if (!this.supervisor.isHealthy()) return;
      await this.reconcileCreates();
      for (const id of this.chat.unconfirmedForks()) {
        if (this.stopped) return;
        if (this.forkChildrenInFlight.has(id) || this.forksConfirming.has(id)) continue;
        if ((this.forkRefusals.get(id)?.retryAt ?? 0) > (this.opts.now ?? Date.now)()) continue;
        const confirm = this.confirmFork(id).finally(() => this.forksConfirming.delete(id));
        this.forksConfirming.set(id, confirm);
        await confirm;
      }
    })()
      // Never a rejection: callers fire this from timers and status changes.
      .catch((error: unknown) => this.opts.logger?.warn?.("agent chat: fork reconcile failed; will retry", error))
      .finally(() => {
        this.reconciling = null;
      });
    this.reconciling = run;
    return run;
  }

  /** One unconfirmed fork tab, asked of the host ({@link reconcileForks}). Never throws. */
  private async confirmFork(id: string): Promise<void> {
    const tab = this.chat.get(id);
    const parentId = tab?.lineage?.relation === "fork" ? tab.lineage.parentThreadId : undefined;
    if (!tab || parentId === undefined) return;
    // The WHOLE original request — its cut and its launch environment, recomposed as the fork
    // composed them — with `confirmOnly`. A host that knows `confirmOnly` creates nothing; one
    // that does not (only builds of this feature before it) forks exactly as the lost request
    // asked, which converges just as the same key's retry does.
    const accountId = tab.accountId ?? "";
    let launchFields: Pick<ForkHostThreadRequest, "launchEnv" | "unsetEnv" | "homePath" | "serverPool" | "box"> = {};
    let profileFields: Pick<ForkHostThreadRequest, "profile" | "profileId"> = {};
    try {
      const entry = this.opts.registryEntry(tab.refId);
      const adapter = entry?.chat?.adapter;
      if (entry && adapter) {
        const launch = await this.opts.resolveLaunchEnv(entry, { accountId: accountId || SYSTEM_ACCOUNT_ID });
        if ((launch?.accountId ?? "") === accountId) {
          let fields = this.accountLaunchFields(entry, adapter, launch);
          // The child's profile, recomposed as the fork composed it (the tab mirrors it).
          const profileId = this.chat.profileOf(id) ?? null;
          if (profileId !== null) {
            const resolved = await this.profileLaunch({ profileId, adapter, accountId, projectPath: tab.projectPath, base: fields });
            fields = resolved.fields;
            profileFields = { profile: resolved.profile, profileId: resolved.profile.profileId };
          } else if (this.hostSupportsSessionProfiles()) {
            // A Global child (asked for, or a deleted profile's fallback): never the parent's.
            profileFields = { profile: null, profileId: null };
          }
          await this.prepareHome(adapter, fields.launchEnv, tab.projectPath);
          // boxes: the reconcile re-sends the box the fork named.
          launchFields = { ...fields, ...this.boxLaunchFor(tab.projectPath, adapter, accountId) };
        }
      }
    } catch (error) {
      // The account (or the profile) went: a host that knows `confirmOnly` needs none of it to answer.
      launchFields = {};
      profileFields = {};
      this.opts.logger?.warn?.(`agent chat: no launch environment for fork ${id}'s reconcile`, error);
    }
    const request: ForkHostThreadRequest = {
      threadId: id,
      projectPath: tab.projectPath,
      cwd: tab.cwd,
      title: tab.title,
      refId: tab.refId,
      accountId,
      home: resolveHomeKind(accountId),
      modelSelection: undefined,
      runtimeMode: undefined,
      ...launchFields,
      ...profileFields,
      fork: forkTargetOf(this.chat.forkFingerprint(id)),
      confirmOnly: true
    };
    let response: {
      status: number;
      value: (ForkHostThreadResponse & { error?: { code?: string; message?: string } }) | null;
    };
    try {
      response = await this.client.json<ForkHostThreadResponse & { error?: { code?: string; message?: string } }>(
        "POST",
        agentHostRoutes.forkThread(parentId),
        request
      );
    } catch (error) {
      this.opts.logger?.warn?.(`agent chat: could not confirm fork ${id} with the host; will retry`, error);
      return;
    }
    // A fork in flight for this tab took over meanwhile: its answer is the one that counts.
    if (this.forkChildrenInFlight.has(id) || !this.chat.has(id)) return;
    if (response.status < 400 && response.value?.head) {
      this.forkRefusals.delete(id);
      this.chat.setLineage(
        id,
        withLineageStamps(
          response.value.lineage ?? response.value.head.lineage ?? tab.lineage!,
          tab.lineage?.delegationDepth ?? 0,
          tab.lineage?.agentCreated === true,
          // What the tab recorded at creation (the parent may have closed since).
          tab.lineage?.workflowOwned === true
        )
      );
      return;
    }
    // Only "no such thread" — the host's own 404, or an older host's route miss — says the child
    // was never created. Any other refusal (a child still being deleted, a body it would not
    // take) says nothing of the kind: the tab stays unconfirmed for a later reconcile.
    if (response.status === 404 && response.value?.error?.code === "THREAD_NOT_FOUND") {
      this.opts.logger?.warn?.(
        `agent chat: the host holds no fork ${id} (${response.value.error.message ?? "not found"}); its tab is taken back`
      );
      this.forkRefusals.delete(id);
      this.chat.discard(id);
      return;
    }
    if (response.status < 500) {
      // Not "no such thread", but not a confirmation either: asked again with a doubling backoff
      // (never every tick, never forever, and the launch environment recomposed only then); after
      // FORK_CONFIRM_MAX_REFUSALS the tab is taken back like a fork the host never created — no
      // host delete is queued, so a child the host does hold is never deleted by this (D-T2).
      const count = (this.forkRefusals.get(id)?.count ?? 0) + 1;
      const reason = `${response.status} ${response.value?.error?.message ?? ""}`.trim();
      if (count >= FORK_CONFIRM_MAX_REFUSALS) {
        // Deliberate: the tab goes, but a child thread the host DOES hold stays on the host,
        // tabless (nothing deletes it — a delete queued here could kill a child a retry under the
        // same key would converge on). It keeps only the forked conversation and starts nothing
        // by itself; the user loses only a tab that never confirmed.
        this.opts.logger?.warn?.(`agent chat: the host refused to confirm fork ${id} ${count} times (${reason}); its tab is taken back`);
        this.forkRefusals.delete(id);
        this.chat.discard(id);
        return;
      }
      const delay = Math.min(FORK_CONFIRM_MAX_BACKOFF_MS, FORK_CONFIRM_FIRST_BACKOFF_MS * 2 ** (count - 1));
      this.forkRefusals.set(id, { count, retryAt: (this.opts.now ?? Date.now)() + delay });
      if (count === 1) {
        this.opts.logger?.warn?.(`agent chat: the host would not confirm fork ${id} (${reason}); asking again with backoff`);
      }
    }
  }

  /**
   * Plain chat tabs whose host create never answered because the daemon restarted in between
   * (`chat.createUnconfirmed`, persisted; the tab reads as starting meanwhile): the host holds the
   * thread → confirmed; the host never got it ("no such thread") → the tab is taken back, as a
   * fork the host never created is (D-T2). Anything else leaves it for a later reconcile. Never
   * throws.
   */
  private async reconcileCreates(): Promise<void> {
    for (const id of this.chat.unconfirmedCreates()) {
      if (this.stopped) return;
      if (this.createsInFlight.has(id)) continue;
      let response: { status: number; value: { error?: { code?: string; message?: string } } | null };
      try {
        response = await this.client.json<{ error?: { code?: string; message?: string } }>("GET", agentHostRoutes.read(id));
      } catch (error) {
        this.opts.logger?.warn?.(`agent chat: could not ask the host about tab ${id}; will retry`, error);
        continue;
      }
      if (this.createsInFlight.has(id) || !this.chat.has(id)) continue;
      if (response.status < 400) {
        this.chat.confirmCreated(id);
      } else if (response.status === 404 && response.value?.error?.code === "THREAD_NOT_FOUND") {
        this.opts.logger?.warn?.(`agent chat: the host never got chat ${id} (the daemon restarted mid-create); its tab is taken back`);
        this.chat.discard(id);
      }
    }
  }


  /**
   * Re-point an existing chat thread at another managed account (§3.4's
   * "account changed"), applied on the thread's **next message**.
   *
   * The order mirrors `createSession` for the same reason: everything that can
   * refuse runs before anything is written, the launch environment is
   * recomposed by the daemon (only it has the sources), the host records the
   * new identity and rewrites `launch.json`, and only then does the tab record
   * move. A host that refuses leaves the tab exactly as it was.
   */
  async switchAccount(
    id: string,
    input: { commandId: string; accountId: string }
  ): Promise<{ seq: number }> {
    const summary = this.chat.get(id);
    if (!summary) {
      throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND");
    }
    const commandId = typeof input?.commandId === "string" ? input.commandId.trim() : "";
    if (commandId.length === 0 || commandId.length > 200) {
      throw new ChatSessionError("commandId is required.", "INVALID_COMMAND");
    }
    if (typeof input?.accountId !== "string" || input.accountId.trim().length === 0) {
      throw new ChatSessionError("accountId is required.", "INVALID_COMMAND");
    }
    const requestedAccountId = input.accountId.trim();
    const entry = this.opts.registryEntry(summary.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new ChatSessionError(
        `Registry entry "${summary.refId}" is not available.`,
        "INVALID_COMMAND"
      );
    }
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      throw new ChatSessionError(`"${entry.name}" has no chat adapter.`, "INVALID_COMMAND");
    }
    // OpenCode runs ONE server per project under the daemon's own identity and
    // refuses a non-system home (§3.2); there is no per-thread account to move.
    if (adapter === "opencode") {
      throw new ChatSessionError(
        "OpenCode threads always run under the server's own identity.",
        "INVALID_COMMAND"
      );
    }
    // The family gate. `AgentAccountsService.resolveLaunchEnv` answers `null`
    // for an account of the wrong family — which would SILENTLY launch the
    // system identity — so a mismatched id is refused here rather than
    // degraded there. An entry draws its accounts from its own id's family.
    if (requestedAccountId !== SYSTEM_ACCOUNT_ID) {
      const managed = this.opts.listManagedAccounts?.().accounts ?? [];
      const account = managed.find((candidate) => candidate.id === requestedAccountId);
      if (!account || account.agent !== entry.id) {
        throw new ChatSessionError(
          `That account cannot run "${entry.name}".`,
          "INVALID_COMMAND"
        );
      }
    }
    if (!this.supervisor.isHealthy()) {
      throw this.hostUnavailable();
    }

    let launch: ChatLaunchEnv | null = null;
    try {
      // ALWAYS explicit: an omitted id makes `resolveLaunchEnv` fall back to
      // the family default, so "switch to System" would silently pick whatever
      // account happens to be the default instead.
      launch = await this.opts.resolveLaunchEnv(entry, {
        accountId: requestedAccountId
      });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }

    const accountId = launch?.accountId ?? "";
    const home = resolveHomeKind(accountId);
    let launchFields = this.accountLaunchFields(entry, adapter, launch);
    // A profile chat keeps its profile, prepared for the NEW account (Codex prepares one home per
    // account). A profile deleted meanwhile is left to the next session start's refresh, which
    // falls back to Global with the notice (or fails an unattended chat): the switch names no
    // profile then, so the host keeps the thread's. Any other refusal refuses the switch.
    let profileFields: Pick<SetThreadIdentityRequest, "profile" | "profileId"> = {};
    const profileId = this.chat.profileOf(id) ?? null;
    if (profileId !== null) {
      try {
        const resolved = await this.profileLaunch({
          profileId,
          adapter,
          accountId,
          projectPath: summary.projectPath,
          base: launchFields
        });
        launchFields = resolved.fields;
        profileFields = { profile: resolved.profile, profileId: resolved.profile.profileId };
      } catch (error) {
        if (!(error instanceof ChatSessionError && error.code === "PROFILE_NOT_FOUND")) throw error;
      }
    }
    // boxes: a launch field like the others (it replaces `launch.json`'s); the System account is
    // refused for a box project here.
    const boxField = this.boxLaunchFor(summary.projectPath ?? "", adapter, accountId);
    // The new home may never have been used for this project.
    await this.prepareHome(adapter, launchFields.launchEnv, summary.projectPath ?? "");

    // Every launch field REPLACES `launch.json`'s on the host, `serverPool` included — leaving
    // it out would move a keyed thread to the global server.
    const receipt = await this.postIdentity(
      id,
      { commandId, accountId, home, ...launchFields, ...profileFields, ...boxField },
      "The agent host refused the account switch."
    );
    // Only after the host accepted: `sessions.json`, the tab badge and
    // `liveAccountIds()` must never name an identity the thread does not have.
    this.chat.setAccount(id, { accountId, home });
    return { seq: receipt.seq };
  }

  /** `POST /threads/:id/identity` on the host, its refusals as `ChatSessionError`s. */
  private async postIdentity(id: string, body: SetThreadIdentityRequest, refused: string): Promise<SetThreadIdentityResponse> {
    try {
      const response = await this.client.json<{
        seq?: number;
        profileId?: unknown;
        error?: { code: string; message: string };
      }>("POST", agentHostRoutes.setThreadIdentity(id), body);
      if (response.status === 404 && response.value?.error?.code === undefined) {
        // A host that survived a deploy is still running the code it started
        // from (§8) and has no identity route. It is replaced on the next
        // drain-restart, so this is a retry, not a refusal.
        throw new ChatSessionError(
          "The agent host is still updating. Try again in a moment.",
          "HOST_UNAVAILABLE"
        );
      }
      if (response.status >= 400) {
        throw new ChatSessionError(
          response.value?.error?.message ?? refused,
          response.value?.error?.code ?? "SESSION_UNAVAILABLE"
        );
      }
      const profileId = response.value?.profileId;
      return {
        seq: typeof response.value?.seq === "number" ? response.value.seq : 0,
        // What the host's thread names now (`SetThreadIdentityResponse.profileId`); an older host omits it.
        ...(profileId === null || typeof profileId === "string" ? { profileId } : {})
      };
    } catch (error) {
      if (error instanceof ChatSessionError) throw error;
      if (error instanceof HostUnavailableError) {
        throw this.hostUnavailable();
      }
      throw new ChatSessionError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Profile switches by `threadId\0commandId`: in flight, or answered (bounded). */
  private readonly profileSwitches = new Map<string, { profileId: string | null; answer: Promise<{ seq: number }> }>();

  /**
   * The composer's profile chip (spec 2026-10-18 §5.3, `POST /api/sessions/:id/profile`): switch a
   * running chat to another Agent Profile (`null` = Global), applied at its next agent start. The
   * order mirrors {@link switchAccount}: everything that can refuse first — the profile prepared
   * for the chat's agent and account, its contribution over the account's launch — then the
   * host's identity switch with `profile` (a profile-only switch keeps the resume cursor), and
   * only then the tab record. Idempotent by `commandId`: a repeat shares the first's answer (and
   * the host's receipt answers one this daemon forgot); the same id with another profile is
   * COMMAND_ID_CONFLICT.
   */
  switchProfile(id: string, input: { commandId: string; profileId: string | null }): Promise<{ seq: number }> {
    if (!this.chat.has(id)) {
      return Promise.reject(new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND"));
    }
    const commandId = typeof input?.commandId === "string" ? input.commandId.trim() : "";
    if (commandId.length === 0 || commandId.length > 200) {
      return Promise.reject(new ChatSessionError("commandId is required.", "INVALID_COMMAND"));
    }
    let profileId: string | null;
    try {
      const requested = requestedProfileId(input?.profileId, true);
      if (requested === undefined) throw new ChatSessionError("profileId is required (null for Global).", "INVALID_COMMAND");
      profileId = requested;
    } catch (error) {
      return Promise.reject(error);
    }
    const key = `${id}\u0000${commandId}`;
    const known = this.profileSwitches.get(key);
    if (known) {
      return known.profileId === profileId
        ? known.answer
        : Promise.reject(new ChatSessionError("That commandId switched to another profile: send a new commandId.", "COMMAND_ID_CONFLICT"));
    }
    const answer = this.switchProfileNow(id, commandId, profileId);
    this.profileSwitches.set(key, { profileId, answer });
    if (this.profileSwitches.size > PROFILE_SWITCH_RECORDS) {
      this.profileSwitches.delete(this.profileSwitches.keys().next().value as string);
    }
    // A refusal is not remembered: the same commandId may be retried once the reason is gone.
    answer.catch(() => {
      if (this.profileSwitches.get(key)?.answer === answer) this.profileSwitches.delete(key);
    });
    return answer;
  }

  private async switchProfileNow(id: string, commandId: string, profileId: string | null): Promise<{ seq: number }> {
    const summary = this.chat.get(id);
    if (!summary) throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND");
    const entry = this.opts.registryEntry(summary.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new ChatSessionError(`Registry entry "${summary.refId}" is not available.`, "INVALID_COMMAND");
    }
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      throw new ChatSessionError(`"${entry.name}" has no chat adapter.`, "INVALID_COMMAND");
    }
    if (!this.supervisor.isHealthy()) {
      throw this.hostUnavailable();
    }
    if (!this.hostSupportsSessionProfiles()) {
      throw new ChatSessionError(
        "Agent Profiles need the updated agent host, which starts once no turn is running. Try again then.",
        "COMMAND_REJECTED"
      );
    }
    // The chat's own account, pinned (System included): a profile switch never moves the account.
    const accountId = summary.accountId ?? "";
    let launch: ChatLaunchEnv | null = null;
    try {
      launch = await this.opts.resolveLaunchEnv(entry, { accountId: accountId || SYSTEM_ACCOUNT_ID });
    } catch (error) {
      throw error instanceof ChatSessionError ? error : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }
    if ((launch?.accountId ?? "") !== accountId) {
      throw new ChatSessionError("The account this chat runs under is no longer available.", "COMMAND_REJECTED");
    }
    let launchFields = this.accountLaunchFields(entry, adapter, launch);
    let profile: HostThreadProfile | null = null;
    if (profileId !== null) {
      ({ profile, fields: launchFields } = await this.profileLaunch({
        profileId,
        adapter,
        accountId,
        projectPath: summary.projectPath,
        base: launchFields
      }));
    }
    // boxes: the switch's launch fields replace `launch.json`'s, the box included.
    const boxField = this.boxLaunchFor(summary.projectPath, adapter, accountId);
    await this.prepareHome(adapter, launchFields.launchEnv, summary.projectPath);
    const receipt = await this.postIdentity(
      id,
      {
        commandId,
        accountId,
        home: resolveHomeKind(accountId),
        ...launchFields,
        profile,
        profileId: profile?.profileId ?? null,
        ...boxField
      },
      "The agent host refused the profile switch."
    );
    // Only after the host accepted, as the account switch — and only the profile it applied: a
    // `commandId` this daemon forgot (a restart) may be answered by the host's receipt of an earlier
    // command, which left the thread on another profile. Mirror the host's then, and refuse.
    if (receipt.profileId !== undefined && receipt.profileId !== profileId) {
      this.chat.setProfile(id, receipt.profileId);
      throw new ChatSessionError(
        "That commandId already switched this chat to another profile: send a new commandId.",
        "COMMAND_ID_CONFLICT"
      );
    }
    this.chat.setProfile(id, profileId);
    return { seq: receipt.seq };
  }

  /**
   * The refresh before every provider-session start of a profile thread (spec 2026-10-18 §5.6,
   * §6.5; `daemonRoutesForHost.threadLaunchProfile`): the profile's CURRENT prepared version for
   * the chat's agent and account and its contribution over the account's launch, recomposed now
   * — so an edited profile applies at the next start and a version the GC removed never fails
   * one. `profileId` is what the HOST's thread names (its log is the record; the tab mirrors it).
   *
   * A deleted profile: an interactive chat falls back to Global — answered with the account's
   * own launch, `profile: null` and the notice the host appends — and an unattended one is
   * refused (`PROFILE_NOT_FOUND`). Every other refusal keeps its code and message, which the
   * host fails the start with. Throws `ChatSessionError` (`THREAD_NOT_FOUND`,
   * `PROFILES_UNAVAILABLE` while the daemon is still wiring profiles, `LAUNCH_UNAVAILABLE`,
   * `PROFILE_*`).
   */
  async threadLaunchProfile(threadId: string, profileId: string, hostAccountId?: string): Promise<ThreadLaunchProfileResponse> {
    const summary = this.chat.get(threadId);
    if (!summary) throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND");
    const profiles = this.sessionProfiles ?? this.opts.sessionProfiles ?? null;
    if (profiles === null) {
      throw new ChatSessionError("Orquester is still starting. Try again in a moment.", "PROFILES_UNAVAILABLE");
    }
    const entry = this.opts.registryEntry(summary.refId);
    const adapter = entry?.chat?.adapter;
    if (!entry || !adapter) {
      throw new ChatSessionError(`Registry entry "${summary.refId}" is not available.`, "LAUNCH_UNAVAILABLE");
    }
    // The host's thread is the record of the account (its log): a tab that lags it — the host
    // accepted an account switch and the daemon died before recording it — would hand every
    // start the OLD account's credentials. Launch with the host's, and realign the tab.
    const tabAccountId = summary.accountId ?? "";
    const accountId = hostAccountId ?? tabAccountId;
    let launch: ChatLaunchEnv | null;
    try {
      launch = await this.opts.resolveLaunchEnv(entry, { accountId: accountId || SYSTEM_ACCOUNT_ID });
    } catch (error) {
      throw new ChatSessionError(error instanceof Error ? error.message : String(error), "LAUNCH_UNAVAILABLE");
    }
    if ((launch?.accountId ?? "") !== accountId) {
      throw new ChatSessionError("The account this chat runs under is no longer available.", "LAUNCH_UNAVAILABLE");
    }
    if (accountId !== tabAccountId) {
      this.opts.logger?.log?.(`agent chat: ${threadId} runs under account "${accountId}" on the host; realigning its tab (was "${tabAccountId}")`);
      this.chat.setAccount(threadId, { accountId, home: resolveHomeKind(accountId) });
    }
    const base = this.accountLaunchFields(entry, adapter, launch);
    try {
      const resolved = await profiles.resolve({ profileId, agent: adapter, accountId, projectPath: summary.projectPath, base });
      this.chat.setProfile(threadId, profileId);
      return { profile: resolved.profile, ...resolved.fields };
    } catch (error) {
      const deleted = error instanceof SessionProfileError && error.code === "PROFILE_NOT_FOUND";
      if (!deleted || this.chat.isUnattended(threadId)) {
        if (deleted) {
          throw new ChatSessionError(
            "This chat's Agent Profile was deleted. An unattended chat never falls back to Global, so the agent was not started.",
            "PROFILE_NOT_FOUND"
          );
        }
        throw profileRefusal(error);
      }
      this.opts.logger?.log?.(`agent chat: ${threadId}'s Agent Profile ${profileId} was deleted; it falls back to Global`);
      this.chat.setProfile(threadId, null);
      const name = await Promise.resolve(profiles.profileName?.(profileId)).catch(() => undefined);
      return {
        profile: null,
        ...base,
        fallback: { previousProfileId: profileId, notice: deletedProfileNotice(name) }
      };
    }
  }

  /**
   * `PreparedDirLeases.onAvailable` (spec §6.5): `listener` runs each time a host BECOMES healthy
   * — adopted at boot, back after a respawn, or another instance took over — so a GC pass that
   * could not read {@link profileLeases} runs again. Not on every health tick (each one re-adopts
   * the same healthy host). Answers the unsubscribe.
   */
  onHostHealthy(listener: () => void): () => void {
    const healthyInstance = (status: { state: string; hostInstanceId: string | null }): string | null =>
      status.state === "healthy" ? (status.hostInstanceId ?? "") : null;
    let last = healthyInstance(this.supervisor.status());
    return this.supervisor.onChange((status) => {
      const now = healthyInstance(status);
      const edge = now !== null && now !== last;
      last = now;
      if (edge) listener();
    });
  }

  /**
   * `PreparedDirLeases.inUse()` (spec §6.5): the prepared directories the agent host's live
   * provider sessions launched from (`GET /profiles/leases`). REJECTS whenever that is not known
   * — no healthy host, a host that predates the route, an unreadable answer — so the GC deletes
   * nothing then.
   */
  async profileLeases(): Promise<ReadonlySet<string>> {
    if (!this.supervisor.isHealthy()) throw new Error("The agent host is not running; prepared-dir leases are unknown.");
    const response = await this.client.json<AgentHostProfileLeasesResponse>("GET", agentHostRoutes.profileLeases, undefined, {
      timeoutMs: PROFILE_LEASES_DEADLINE_MS
    });
    const dirs = response.status === 200 ? response.value?.preparedDirs : undefined;
    if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === "string")) {
      throw new Error(`The agent host did not report its prepared-dir leases (${response.status}).`);
    }
    return new Set(dirs);
  }

  /**
   * `DELETE` cascade (§6.1): the host settles pending requests, stops the
   * provider child, prunes every checkpoint ref under the thread's prefix and
   * removes the thread directory.
   *
   * **Durable, not fire-and-forget.** `ChatSessionManager.close` has already
   * queued the id into the persisted `pendingThreadDeletes`; this attempt only
   * clears it on a definitive answer. A host that is down at close time would
   * otherwise never write `thread.deleted`, and §3.3's reconcile would then
   * find an orphan with a cursor and a continuation marker and RESUME it —
   * spending tokens on a tab nobody is looking at. The queue is replayed the
   * moment a host is adopted, and survives the daemon restart in between.
   */
  deleteThread(id: string): void {
    this.summary.forget(id);
    void this.attemptThreadDelete(id);
  }

  /** One delete attempt. Clears the retry only on a definitive host answer. */
  private async attemptThreadDelete(id: string): Promise<void> {
    try {
      const response = await this.client.json("DELETE", agentHostRoutes.deleteThread(id));
      // 404 is definitive too: the host has no such thread, so there is nothing
      // left to reconcile. Anything 5xx stays queued.
      if (response.status < 500) {
        this.chat.resolveThreadDelete(id);
        return;
      }
      this.opts.logger?.warn?.(
        `agent host refused the thread delete for ${id} (${response.status}); will retry`
      );
    } catch (error) {
      this.opts.logger?.warn?.(`agent host thread delete failed for ${id}; will retry`, error);
    }
  }

  /**
   * Replay every queued delete. Called whenever a host becomes healthy —
   * boot adoption, a respawn, or the drain-restart.
   */
  async replayPendingThreadDeletes(): Promise<void> {
    if (!this.supervisor.isHealthy()) return;
    const pending = this.chat.pendingThreadDeletes();
    if (pending.length === 0) return;
    this.opts.logger?.log?.(`agent chat: replaying ${pending.length} pending thread delete(s)`);
    for (const id of pending) {
      await this.attemptThreadDelete(id);
    }
  }

  /**
   * A chat attachment (§6.3). The bytes are streamed straight through to the
   * host, which claims the file into the thread's attachment namespace and
   * answers the `AttachmentRef` — the host, not the daemon, mints the id and
   * re-checks the §4.1 bounds against the file it stat'd, and its thread-delete
   * cascade is what cleans the file up.
   *
   * The daemon deliberately does not write into the thread directory itself:
   * that directory is the host's, and a file the host never claimed could not
   * be resolved by `GET …/attachments/:id` when an adapter goes looking for it.
   */
  async uploadAttachment(
    sessionId: string,
    query: { name?: string; type?: string },
    body: Readable
  ): Promise<{ status: number; value: unknown }> {
    const params = new URLSearchParams();
    if (query.name) params.set("name", query.name);
    if (query.type) params.set("type", query.type);
    const suffix = params.toString();
    const path = `${agentHostExtraRoutes.putAttachment(sessionId)}${suffix ? `?${suffix}` : ""}`;
    // The cap is enforced TWICE, as AGENTS.md requires: the route already
    // refused a declared `Content-Length` above it, and this counts what
    // actually arrives — a chunked upload with no `Content-Length` would
    // otherwise stream unbounded straight through to the host.
    const counted = countingLimit(body, MAX_UPLOAD_BYTES);
    const stream = await this.client
      .open("POST", path, {
        body: counted,
        headers: { "content-type": "application/octet-stream" },
        timeoutMs: 0
      })
      .catch((error: unknown) => {
        // `open` can refuse before it ever listened on the body (no host
        // token yet). Retire the counted stream, or a body that fails later —
        // the refused request aborting — is forwarded into a stream nobody
        // listens to, and that is the crash `countingLimit` exists to prevent.
        counted.destroy();
        // The host client reports every failed request as HOST_UNAVAILABLE and
        // keeps what failed it as `cause`. The cap is the one failure that is
        // the caller's, not the host's: hand it on typed, so the upload route
        // and the MCP seam both answer 413 UPLOAD_TOO_LARGE, not 503.
        throw isUploadTooLarge(error) ? new UploadTooLargeError() : error;
      });
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    // The host can refuse while the body is still arriving: an empty `name`,
    // a 401, a malformed thread id, a staging mkdir/open failure. Nothing else
    // ever ends this request then. `countingLimit` forwards only an error, the
    // route's request is no longer aborted once its reply has gone out, and the
    // host runs with no keep-alive or request timeout, so one daemon↔host
    // socket pair would stay open until the host restarts. Tear it down, and
    // leave the source to its owner as ever. A success, or a refusal that came
    // after the whole body was sent, is left exactly as it was.
    if (stream.status >= 400 && !counted.readableEnded) {
      stream.abort();
      counted.destroy();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let value: unknown = null;
    try {
      value = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
    return { status: stream.status, value };
  }

  /**
   * Publish an agent's HTML page into its thread (spec 2026-10-14 §2.1,
   * §2.2): the `orquester` server's `html_render` handler calls this. The
   * page is prepared here (bootstrap, local images inlined from inside the
   * thread's project only), measured at every client width when a browser is
   * there (`htmlPreview`; never waited for past its budget), and stored
   * through the host's attachment upload, like any chat attachment; the
   * answer is the reference the tool returns. Refusals throw
   * `HtmlRenderPublishError` with an agent-facing message.
   */
  async publishHtmlRender(input: Omit<PublishHtmlRenderInput, "measure">): Promise<HtmlRenderReference> {
    const { signal, ...page } = input;
    const browser = this.opts.htmlPreview;
    return publishHtmlRender(
      {
        storeAttachment: async (threadId, fileName, bytes) => {
          const { status, value } = await this.uploadAttachment(
            threadId,
            { name: fileName, type: "text/html" },
            Readable.from([bytes])
          );
          const id = (value as { id?: unknown } | null)?.id;
          if (status !== 200 || typeof id !== "string") {
            const message = (value as { error?: { message?: unknown } } | null)?.error?.message;
            throw new Error(typeof message === "string" ? message : `the agent host answered ${status}`);
          }
          return id;
        },
        sandboxRoot: (threadId) => this.htmlRenderSandboxRoot(threadId),
        images: (root) => this.opts.localImages?.(root)
      },
      {
        ...page,
        ...(signal ? { signal } : {}),
        ...(browser && page.heights === undefined
          ? { measure: (prepared: string) => measureHtmlPage(browser, prepared, signal) }
          : {})
      }
    );
  }

  /**
   * Screenshot an agent's page as a reader would see it (`html_preview`,
   * spec 2026-10-14 §2.1), local images inlined from the thread's project
   * only. Throws `HtmlPreviewError` (no browser, timeout, cancelled) or
   * `HtmlRenderPublishError` (an image or the page too large), both with
   * agent-facing messages.
   */
  async previewHtmlRender(
    input: Omit<HtmlPreviewInput, "sandboxRoot"> & { threadId: string }
  ): Promise<HtmlPreview> {
    const browser = this.opts.htmlPreview;
    if (!browser) {
      throw new HtmlPreviewError("browser-unavailable", "This Orquester cannot render pages.");
    }
    const { threadId, ...rest } = input;
    const root = await this.htmlRenderSandboxRoot(threadId);
    // boxes: a box project's images are read in its box, against the root's realpath there.
    const images = root === null ? undefined : this.opts.localImages?.(root);
    if (images && root !== null) {
      return previewHtmlPage(browser, { ...rest, sandboxRoot: await images.realpath(root), images });
    }
    return previewHtmlPage(browser, { ...rest, sandboxRoot: root });
  }

  /**
   * The directory a thread's page may inline local images from: its
   * project, confined to the workspaces root and realpath'd, or null.
   */
  private async htmlRenderSandboxRoot(threadId: string): Promise<string | null> {
    const projectPath = this.chat.get(threadId)?.projectPath;
    return projectPath ? this.opts.resolveTrustedProjectDir(projectPath) : null;
  }

  /**
   * Resolve an attachment id to its absolute host path (§6.3 read-back).
   *
   * The daemon cannot serve it through `/api/fs/download`: that route is
   * confined to `fsRoot` (`<appdir>/workspaces`) and the thread's attachments
   * live under `<appdir>/daemon/agent/threads/<id>/attachments`. So the host
   * resolves the id — it owns the namespace and the traversal guard — and the
   * daemon streams what it names.
   */
  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    const response = await this.client.json<{ path?: unknown }>(
      "GET",
      agentHostExtraRoutes.attachment(sessionId, attachmentId)
    );
    if (response.status !== 200) return null;
    const path = response.value?.path;
    return typeof path === "string" && path ? path : null;
  }

  /**
   * `PUT` rename (§6.1) — the host appends `thread.meta-updated`.
   *
   * `opts.seed` forwards §7.7's "this is the client's auto-seed, not a rename"
   * so the host leaves the title replaceable by a provider retitle.
   */
  renameThread(id: string, title: string, opts?: { seed?: boolean }): void {
    void this.client
      .json("PUT", agentHostRoutes.updateThread(id), { title, seed: opts?.seed === true })
      .catch((error) => this.opts.logger?.warn?.(`agent host thread rename failed for ${id}`, error));
  }

  // --- internals -----------------------------------------------------------

  /**
   * Claude project trust for the home this thread will run under.
   *
   * The trusted path is **the daemon's, not the client's**: `projectPath` is
   * run through `resolveTrustedProjectDir`, which realpaths it and refuses
   * anything outside `fsRoot`. `cwd` off the create request is never trusted —
   * accepting it would let a client permanently enable an arbitrary directory's
   * Claude hooks (arbitrary shell as the daemon user, which holds scoped
   * passwordless sudo) host-wide, including for every future terminal tab on
   * that path.
   *
   * No other adapter is prepared here: see the module comment in `home-prep.ts`
   * for why the Grok config write is gone.
   */
  private async prepareHome(
    adapter: AgentAdapterId,
    env: Record<string, string>,
    projectPath: string
  ): Promise<void> {
    if (adapter !== "claude") return;
    try {
      const projectDir = await this.opts.resolveTrustedProjectDir(projectPath);
      if (!projectDir) {
        this.opts.logger?.warn?.(
          `agent chat: not granting Claude project trust for ${projectPath} (outside the workspaces sandbox)`
        );
        return;
      }
      const dir = env.CLAUDE_CONFIG_DIR;
      const file = dir ? join(dir, ".claude.json") : this.opts.systemClaudeConfigFile();
      await markClaudeProjectTrusted(file, projectDir, this.opts.logger);
    } catch (error) {
      // Never block a launch on home preparation.
      this.opts.logger?.warn?.("agent chat home preparation failed", error);
    }
  }

  /** Authenticated `GET /health`; classifies exactly the five §3.1 cases. */
  private async probe(): Promise<ProbeOutcome> {
    try {
      const response = await this.client.json<AgentHostHealthResponse>(
        "GET",
        agentHostRoutes.health,
        undefined,
        { timeoutMs: 5_000 }
      );
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reachable: true, rejected: true };
      }
      if (response.status === 200 && response.value?.ok) {
        return { ok: true, health: response.value };
      }
      return { ok: false, reachable: true, rejected: false, status: response.status };
    } catch {
      return { ok: false, reachable: false };
    }
  }

  private async requestHostStop(): Promise<void> {
    const response = await this.client.json<{ markedThreadIds?: unknown }>(
      "POST",
      agentHostRoutes.stop,
      {},
      { timeoutMs: 30_000 }
    );
    const marked = response.value?.markedThreadIds;
    this.lastMarkedThreadIds = Array.isArray(marked)
      ? marked.filter((id): id is string => typeof id === "string")
      : [];
  }

  /**
   * Agent goals §5.7: `POST /goals/hold` → the threads the host holds after
   * this request (`AgentHostHoldGoalsResponse`). `null` is a host that predates
   * the route — its generic route-miss 404 — which the supervisor then stops
   * asking; every other non-200 throws, for the supervisor to log. The answer
   * is another process's JSON, so it is read field-wise: anything but an array
   * reads as nothing held, and a non-string entry is dropped.
   */
  private async requestHostHoldGoals(): Promise<readonly string[] | null> {
    const response = await this.client.json<{
      heldThreadIds?: unknown;
      error?: { message?: unknown };
    }>("POST", agentHostRoutes.holdGoals, {}, { timeoutMs: GOAL_HOLD_DEADLINE_MS });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      const message = response.value?.error?.message;
      throw new Error(
        `agent host answered ${response.status} to the goal hold` +
          (typeof message === "string" && message ? `: ${message}` : "")
      );
    }
    const held = response.value?.heldThreadIds;
    return Array.isArray(held) ? held.filter((id): id is string => typeof id === "string") : [];
  }

  /** Agent goals §5.7 legacy handover: one blocking thread's running turn, off the host's own snapshot. */
  private async inspectLegacyGoalTurn(threadId: string): Promise<LegacyGoalTurn | null> {
    try {
      const response = await this.client.json<unknown>("GET", agentHostRoutes.read(threadId), undefined, {
        timeoutMs: LEGACY_GOAL_CALL_DEADLINE_MS
      });
      return response.status === 200 ? legacyGoalTurnOf(response.value) : null;
    } catch {
      return null;
    }
  }

  /** Agent goals §5.7 legacy handover: stop one Codex goal thread's provider session. */
  private async requestHostSessionStop(threadId: string): Promise<void> {
    const response = await this.client.json<{ error?: { message?: unknown } }>(
      "POST",
      agentHostRoutes.sessionStop(threadId),
      { commandId: `goal-handover:${randomUUID()}` },
      { timeoutMs: LEGACY_GOAL_CALL_DEADLINE_MS }
    );
    if (response.status < 200 || response.status >= 300) {
      const message = response.value?.error?.message;
      throw new Error(
        `agent host answered ${response.status} to the session stop` +
          (typeof message === "string" && message ? `: ${message}` : "")
      );
    }
  }

  /** Agent goals §5.7 legacy handover: the replacement resumes the sessions stopped, without a turn. */
  private async requestHostResumeGoalSessions(
    threadIds: readonly string[]
  ): Promise<readonly string[] | null> {
    const response = await this.client.json<{ threadIds?: unknown; error?: { message?: unknown } }>(
      "POST",
      agentHostRoutes.resumeGoalSessions,
      { threadIds },
      { timeoutMs: LEGACY_GOAL_CALL_DEADLINE_MS }
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      const message = response.value?.error?.message;
      throw new Error(
        `agent host answered ${response.status} to the goal session resume` +
          (typeof message === "string" && message ? `: ${message}` : "")
      );
    }
    const taken = response.value?.threadIds;
    return Array.isArray(taken) ? taken.filter((id): id is string => typeof id === "string") : [];
  }
}

/**
 * Which HOME the thread's provider child runs under — the §5.2 `home` field,
 * and the same split the resume picker already uses: a managed account's home,
 * else the system one.
 */
function resolveHomeKind(accountId: string): AgentChatHome {
  return accountId ? "account" : "system";
}

/**
 * Pass a body through, counting bytes, and fail the counted stream with
 * {@link UploadTooLargeError} past `limit`. The second half of AGENTS.md's
 * "the cap is enforced twice": a chunked request carries no `Content-Length`
 * for the route's declared-length check to refuse.
 *
 * `pipe` carries data, never errors. A body that fails mid-read — the file
 * stream the MCP sends for a `{path}` attachment hitting EIO, or a file
 * truncated or unlinked under it — would otherwise be an `'error'` with no
 * listener, which ends the daemon. Forwarded, it fails the counted stream,
 * and the host client turns that into a failed upload.
 *
 * `countingLimit` never destroys its source; the route owns the request. So
 * this is `pipe` plus that one forwarded error, not `stream.pipeline`, which
 * destroys every stream in its chain on the first failure: past the cap the
 * source is only unpiped and paused, and its owner ends it — the route with
 * `refuseUpload`'s 413 and `Connection: close`, the MCP seam by destroying the
 * file stream it opened. (Not because a destroyed request would lose the 413:
 * on Node 20 `pipeline` detaches a server request's socket before destroying
 * it, and the reply still goes out.)
 */
function countingLimit(source: Readable, limit: number): Readable {
  let seen = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(new UploadTooLargeError());
        return;
      }
      callback(null, chunk);
    }
  });
  source.on("error", (error) => counted.destroy(error));
  return source.pipe(counted);
}

/** §6.1: an id the adapter cannot use is refused at creation, never degraded. */
function isUsableConversationId(value: unknown): boolean {
  const id = typeof value === "string" ? value.trim() : "";
  return Boolean(id) && CONVERSATION_ID.test(id) && !id.split("/").includes("..");
}

export { ChatSessionError };

/** A tab as the lineage stamps read it. */
type LineageTab = { owner?: SessionSummary["owner"]; lineage?: ThreadLineage };

/**
 * How many agent-made links lie above and including `tab` (spec 2026-10-14 §5 "Delegation";
 * unified MCP design 2026-10-15 §5.6, §13 c — {@link countsTowardDelegationDepth}): its
 * lineage's recorded `delegationDepth`, else — a record from before the field — counted up
 * through the open tabs (`tabs`) its lineage names.
 */
export function lineageDelegationDepth(tab: { lineage?: ThreadLineage }, tabs: (id: string) => LineageTab | undefined): number {
  let depth = 0;
  let current: { lineage?: ThreadLineage } | undefined = tab;
  const seen = new Set<string>();
  while (current?.lineage) {
    if (current.lineage.delegationDepth !== undefined) return depth + current.lineage.delegationDepth;
    if (countsTowardDelegationDepth(current.lineage)) depth += 1;
    const parentId: string = current.lineage.parentThreadId;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    current = tabs(parentId) ?? undefined;
  }
  return depth;
}

/**
 * Whether a chat created from `creator` (its delegate, opened chat or fork) inherits workflow
 * ownership (unified MCP design 2026-10-15 §5.4): `creator` or an ancestor over the open tabs is
 * owned by a workflow, or carries the inherited marker (`ThreadLineage.workflowOwned`). Only
 * proven ownership is stamped — the marker is permanent; a walk that meets a closed ancestor stops
 * here, and the gate's own walk (fail-closed behind agent-made links) still applies.
 */
export function lineageInheritsWorkflowOwnership(creator: LineageTab, tabs: (id: string) => LineageTab | undefined): boolean {
  let current: LineageTab | undefined = creator;
  const seen = new Set<string>();
  while (current) {
    if (current.owner?.kind === "workflow" || current.lineage?.workflowOwned === true) return true;
    const parentId = current.lineage?.parentThreadId;
    if (parentId === undefined || seen.has(parentId)) return false;
    seen.add(parentId);
    current = tabs(parentId);
  }
  return false;
}

/**
 * The lineage the daemon records for a `delegate` or `opened` child of `parent` (spec 2026-10-14
 * §6; unified MCP design 2026-10-15 §4.1, §5.4, §5.6, §13 c): its depth (recorded even at 0, so no
 * later read walks the chain for this link), `agentCreated` when a chat tool made it (the route's
 * principal gate already removed a forged one), and the inherited workflow-ownership marker.
 */
export function createdChildLineage(
  parent: LineageTab & { id: string },
  link: { relation: "delegate" | "opened"; agentCreated: boolean },
  tabs: (id: string) => LineageTab | undefined,
  createdAt: string
): ThreadLineage {
  return {
    parentThreadId: parent.id,
    relation: link.relation,
    createdAt,
    delegationDepth: lineageDelegationDepth(parent, tabs) + (countsTowardDelegationDepth(link) ? 1 : 0),
    ...(link.agentCreated ? { agentCreated: true as const } : {}),
    ...(lineageInheritsWorkflowOwnership(parent, tabs) ? { workflowOwned: true as const } : {})
  };
}

/**
 * `lineage` with the daemon's own stamps: the delegation depth, unless it is 0 (a fork's lineage
 * without one reads as its parent's), and `agentCreated` when a chat tool made the child — never
 * taken from the host's answer, which does not know (unified MCP design 2026-10-15 §13 c).
 */
function withLineageStamps(lineage: ThreadLineage, depth: number, agentCreated: boolean, workflowOwned: boolean): ThreadLineage {
  const { delegationDepth: _depth, agentCreated: _agent, workflowOwned: _owned, ...rest } = lineage;
  return {
    ...rest,
    ...(depth > 0 ? { delegationDepth: depth } : {}),
    ...(agentCreated ? { agentCreated: true as const } : {}),
    // §5.4: the daemon's own stamp from the forked chat's tab, never the host's answer.
    ...(workflowOwned ? { workflowOwned: true as const } : {})
  };
}

/** A keyed fork's tab already recorded whether a chat tool made it; undefined when there is no tab yet. */
function existingAgentCreated(tab: { lineage?: ThreadLineage } | undefined): boolean | undefined {
  return tab?.lineage ? tab.lineage.agentCreated === true : undefined;
}

/**
 * Whether a lineage link counts toward `delegationDepth` (unified MCP design 2026-10-15 §5.6,
 * §13 c; D-15): a chat tool's `opened` child (`agentCreated`) and every `delegate` — only the
 * delegation tools make delegates, and a delegate from a build before `agentCreated` carries no
 * flag, so counting every one keeps that older chain's cap. A fork never counts, nor does an
 * `opened` chat the user or an external client made.
 */
export function countsTowardDelegationDepth(lineage: { relation: ThreadLineage["relation"]; agentCreated?: boolean }): boolean {
  return lineage.relation === "delegate" || (lineage.relation === "opened" && lineage.agentCreated === true);
}

/** A fork the host keeps refusing to confirm (other than "no such thread") is asked again after this, doubling. */
export const FORK_CONFIRM_FIRST_BACKOFF_MS = 15_000;
/** …never waiting longer than this between two asks. */
export const FORK_CONFIRM_MAX_BACKOFF_MS = 10 * 60_000;
/** …and taken back after this many refusals (about half an hour of asking). */
export const FORK_CONFIRM_MAX_REFUSALS = 8;
