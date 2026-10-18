/**
 * Agent Profiles — the preparation lifecycle (spec §6.5): turns a profile into ready-to-launch
 * prepared directories, one per KEY `(profileId, agent, accountKey)`, tracks their readiness and
 * keeps them fresh. The per-agent preparers (`preparer.ts`) do the agent-specific work; this owns
 * everything around them.
 *
 * Keys. `accountKey` is `sessionProfileAccountKey(accountId)` for a `perAccount` preparer (Codex;
 * the System account is `SESSION_PROFILE_SYSTEM_ACCOUNT_KEY` and its "account home" is the
 * agent's system home) and `SESSION_PROFILE_SHARED_ACCOUNT_KEY` otherwise (the accountId is then
 * ignored and `ctx.accountHome` is `null`).
 *
 * Layout (`@orquester/config`): a key's dir `sessionProfilePreparedKeyDir(...)` holds immutable
 * VERSION dirs `sessionProfilePreparedDir(..., version)` and the pointer `current.json`
 * (`{"schema": 1, "version"}`) naming the current one. A version name (`v-<fingerprint>-<time>-<random>`)
 * is never reused, and nothing modifies a version dir once it is published: for Codex and Grok it
 * IS a running chat's config home, and OpenCode servers read it. Running chats keep the version
 * they launched with; new launches get the current one (spec §5.6).
 *
 * Invariants:
 * - **Atomic publish.** readSource → `resolveForAgent` → a fresh 0700 dir under
 *   `sessionProfileStagingDir` → `prepare` → `validate?` → `writePreparedManifest` LAST → the
 *   staging dir is renamed to a NEW version dir → `current.json` is replaced (temp + rename). The
 *   pointer always names a complete dir; a reader sees the old or the new version, never none. A
 *   failure anywhere removes the staging dir (and an unpointed new version) and leaves the current
 *   version untouched.
 * - **Leased GC.** A non-current version (or a legacy unversioned key dir) is removed only when
 *   {@link PreparedDirLeases.inUse} does not list it and it was not handed out by `ensureReady`
 *   within {@link SESSION_PROFILE_HANDOUT_GRACE_MS} (a launch between `ensureReady` and the host
 *   registering its session). Without a leases source, or when `inUse()` fails, nothing
 *   non-current is removed. GC runs after each publish, on profile delete, after `start()` and on
 *   `gc()`; per key it runs in the key's job chain (never during that key's preparation).
 * - **Per-key serialization, global cap.** Jobs of one key run one at a time (a promise chain);
 *   at most one more waits behind the running one and every request in the meantime joins it.
 *   Different keys run concurrently, at most `concurrency` (default 2) preparations at once.
 * - **Staleness** is a fingerprint stored in the manifest: profile revision + preparer `version`
 *   + agent CLI version + the content hash of every file the preparer's `inputs()` names. Every
 *   job recomputes it first; a match with the dir on disk is a no-op (`markStale` forces one).
 * - **Failures stick per fingerprint.** A background job does not retry a failure for the same
 *   fingerprint. A launch (`ensureReady`) waits for the key's jobs in flight; when one of them
 *   ran a preparation, that outcome is the launch's answer, otherwise the launch retries once.
 * - **No secrets out.** A failure reason has every MCP env/header value of the resolved profile
 *   redacted before it reaches status, events, errors or logs. The fingerprint is a hash.
 *
 * Triggers: `attach(service.events)` — `changed` re-prepares every known key of the profile and
 * seeds its default keys (the shared key, or the family's default account for a `perAccount`
 * preparer); `deleted` waits for the profile's jobs to settle, removes every key's pointer and
 * collects the profile's versions (leased ones stay until a later GC finds them unleased).
 * `start()` (daemon boot) empties the staging root, drops the pointers of deleted profiles, checks
 * every profile's keys in the background and then collects garbage. `globalConfigChanged(agent)` (the agent-profile
 * service's file watcher) re-checks that agent's keys; only those whose inputs changed re-prepare.
 *
 * Status per agent (`status`, `prepareStatusSource`, the `prepareStatus` event): no preparer →
 * `not-prepared` with a "not supported yet" reason; otherwise across the agent's keys of the
 * profile: any `failed` → `failed` (its reason); else any `preparing` → `preparing`; else any key
 * ready for the profile's current revision → `ready`; else `not-prepared` (nothing built, or only
 * for an older revision). `updatedAt` is the latest change among the keys.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_PROFILE_AGENT_LABELS,
  SESSION_PROFILES_CHANNEL,
  SESSION_PROFILE_AGENTS,
  isSessionProfileAgentId,
  type SessionProfileAgentId,
  type SessionProfilePrepareState,
  type SessionProfilePrepareStatus,
  type SessionProfilePrepareStatusResponse
} from "@orquester/api";
import {
  SESSION_PROFILE_PREPARED_CURRENT_FILE,
  SESSION_PROFILE_SHARED_ACCOUNT_KEY,
  SESSION_PROFILE_SYSTEM_ACCOUNT_KEY,
  sessionProfileAccountKey,
  sessionProfilePreparedKeyDir,
  sessionProfilePreparedProfileDir,
  sessionProfilePreparedRootDir,
  sessionProfileStagingDir
} from "@orquester/config";
import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import type { Broadcaster } from "../broadcaster.ts";
import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import { PREPARED_MANIFEST_FILE, parsePreparedManifest, writePreparedManifest, type PreparedManifest } from "./manifest.ts";
import {
  preparerFor,
  sessionProfilePreparers,
  type SessionProfilePrepareContext,
  type SessionProfilePrepareInputsContext,
  type SessionProfilePrepareLogger,
  type SessionProfilePreparer,
  type SessionProfilePreparers
} from "./preparer.ts";
import { resolveForAgent, type ResolvedAgentProfile } from "./resolve.ts";
import type { SessionProfileServiceEvents, SessionProfilePrepareStatusSource } from "./service.ts";
import type { SessionProfileStore } from "./store.ts";

export const SESSION_PROFILE_PREPARE_CONCURRENCY = 2;
/** How long a dir handed out by `ensureReady` is protected from GC without a lease (launch in progress). */
export const SESSION_PROFILE_HANDOUT_GRACE_MS = 10 * 60_000;
const DIR_MODE = 0o700;
const MAX_REASON_LENGTH = 600;
/** `v-<12 hex of the fingerprint>-<base36 ms time>-<8 hex random>`. */
const VERSION_RE = /^v-[0-9a-f]{12}-[0-9a-z]+-[0-9a-f]{8}$/;
const CURRENT_TMP_PREFIX = `.${SESSION_PROFILE_PREPARED_CURRENT_FILE}.`;

/** What a launch gets from {@link SessionProfileLifecycle.ensureReady}. */
export interface SessionProfileReady {
  profileId: string;
  agent: SessionProfileAgentId;
  accountKey: string;
  /** The profile revision the dir was prepared from (= `HostThreadProfile.revision`). */
  revision: string;
  /** The current VERSION dir, `sessionProfilePreparedDir(..., version)` (= `HostThreadProfile.preparedDir`). */
  preparedDir: string;
}

/**
 * Which prepared version dirs live provider sessions use right now. Implemented by the launch
 * plumbing (the agent host reports `HostThreadProfile.preparedDir` of every live provider session);
 * until it is wired the lifecycle never removes a non-current version.
 */
export interface PreparedDirLeases {
  /** Absolute versioned prepared dirs in use. Rejecting = unknown: GC removes nothing. */
  inUse(): Promise<ReadonlySet<string>>;
}

export interface SessionProfileLifecycleOptions {
  appdir: string;
  store: Pick<SessionProfileStore, "read" | "readSource" | "list">;
  /** The daemon user's own agent homes (`resolveAgentHomes`). */
  systemHomes: AgentHomes;
  /** A managed account's home; `null` when the account does not exist (or is another agent's). */
  accountHome(agent: SessionProfileAgentId, accountId: string): string | null;
  /** The agent family's default account (`null` = System); the account a new profile is prepared for. */
  defaultAccountId?(agent: SessionProfileAgentId): string | null;
  /** The installed CLI's version (registry), part of the fingerprint. */
  cliVersion?(agent: SessionProfileAgentId): string | null;
  /** The installed CLI's absolute binary (registry), handed to preparers that run it (`ctx.cliBin`). */
  cliBin?(agent: SessionProfileAgentId): string | null;
  preparers?: SessionProfilePreparers;
  /** Preparations running at once across keys. */
  concurrency?: number;
  logger?: SessionProfilePrepareLogger;
  now?: () => Date;
  /** Leases on prepared version dirs; absent = never remove a non-current version. */
  leases?: PreparedDirLeases;
  /** Overrides {@link SESSION_PROFILE_HANDOUT_GRACE_MS}. */
  handoutGraceMs?: number;
}

export interface SessionProfileLifecycleEvents {
  prepareStatus: [SessionProfilePrepareStatusResponse];
}

type Outcome = { ok: true; ready: SessionProfileReady } | { ok: false; error: SessionProfileError };

interface QueuedJob {
  promise: Promise<Outcome>;
  /** Re-run a preparation that failed for the same fingerprint (a launch asked, not a trigger). */
  retryFailed: boolean;
}

interface KeyState {
  id: string;
  profileId: string;
  agent: SessionProfileAgentId;
  accountKey: string;
  /** The managed account (`perAccount` only); `null` = System or a shared key. */
  accountId: string | null;
  /** `sessionProfilePreparedKeyDir(...)`: the pointer and the versions. */
  keyDir: string;
  state: SessionProfilePrepareState;
  reason?: string;
  updatedAt: string;
  /** The revision on disk as last seen (ready dirs only). */
  readyRevision?: string;
  failure?: { fingerprint: string; error: SessionProfileError };
  /** `markStale`: the next job prepares even if the fingerprint matches. */
  forceStale: boolean;
  /** Tail of this key's chain of jobs and GC passes; never rejects. */
  tail: Promise<void>;
  /** Jobs queued or running. */
  pending: number;
  /** Preparations finished, either way (not checks). */
  finished: number;
  queued: QueuedJob | null;
}

const noop = (): void => undefined;

export class SessionProfileLifecycle {
  readonly events = new EventEmitter<SessionProfileLifecycleEvents>();

  private readonly appdir: string;
  private readonly store: SessionProfileLifecycleOptions["store"];
  private readonly preparers: SessionProfilePreparers;
  private readonly logger: SessionProfilePrepareLogger;
  private readonly now: () => Date;
  private readonly slots: Slots;
  private readonly keys = new Map<string, KeyState>();
  /** Last known revision and update time per profile (for status answers and events). */
  private readonly profiles = new Map<string, { revision: string; updatedAt: string }>();
  /** Profiles being (or already) removed: nothing new is scheduled for them. */
  private readonly deleted = new Set<string>();
  /** Every job and removal in flight, for {@link idle}. */
  private readonly background = new Set<Promise<unknown>>();
  /** Version dirs answered by `ensureReady` → when their grace ends (ms). */
  private readonly handedOut = new Map<string, number>();
  private readonly graceMs: number;
  private readonly abort = new AbortController();
  private detach: () => void = noop;
  private stopped = false;

  constructor(private readonly options: SessionProfileLifecycleOptions) {
    this.appdir = options.appdir;
    this.store = options.store;
    this.preparers = options.preparers ?? sessionProfilePreparers;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.slots = new Slots(Math.max(1, options.concurrency ?? SESSION_PROFILE_PREPARE_CONCURRENCY));
    this.graceMs = options.handoutGraceMs ?? SESSION_PROFILE_HANDOUT_GRACE_MS;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /**
   * The prepared dir of the profile's CURRENT revision for this agent (and account, for a
   * `perAccount` agent; `accountId` null/""/"system" = System). Waits for a preparation in flight;
   * prepares now when missing or stale. Throws `SessionProfileError`:
   * `PROFILE_UNSUPPORTED_AGENT` (no preparer), `PROFILE_NOT_FOUND` (deleted profile — the launch
   * falls back to Global with a notice, spec §5.6), `PROFILE_NOT_READY` (preparation failed, the
   * account is gone, or the daemon is stopping; the message is the reason). Never a Global fallback.
   */
  async ensureReady(profileId: string, agent: SessionProfileAgentId, accountId: string | null): Promise<SessionProfileReady> {
    const preparer = this.preparerOf(agent);
    if (!preparer) throw sessionProfileErrors.unsupportedAgent(AGENT_PROFILE_AGENT_LABELS[agent]);
    if (this.stopped) throw stopping();
    if (this.deleted.has(profileId)) throw sessionProfileErrors.notFound(profileId);
    const state = this.keyState(profileId, agent, preparer.perAccount ? accountId : null, preparer.perAccount);
    // A preparation that ran while this launch waited is its answer; otherwise a failure is retried once.
    const finished = state.finished;
    if (state.pending > 0) await state.tail;
    const outcome = await this.schedule(state, state.finished === finished);
    if (!outcome.ok) throw outcome.error;
    return outcome.ready;
  }

  /** Each agent's preparation state of the profile (see the module header for the aggregation). */
  status(profileId: string): SessionProfilePrepareStatus[] {
    const known = this.profiles.get(profileId);
    return this.statusFor(profileId, known?.revision, known?.updatedAt ?? this.now().toISOString());
  }

  /** For `SessionProfileServiceOptions.prepareStatus`. */
  readonly prepareStatusSource: SessionProfilePrepareStatusSource = ({ profileId, revision, updatedAt }) => {
    this.noteProfile(profileId, revision, updatedAt);
    return this.statusFor(profileId, revision, updatedAt);
  };

  /**
   * Forces a fresh preparation of one key — e.g. Codex's launcher found the prepared home's state
   * DB missing (spec §6.2) — in the background; the next `ensureReady` waits for it.
   */
  markStale(profileId: string, agent: SessionProfileAgentId, accountId: string | null): void {
    const preparer = this.preparerOf(agent);
    if (!preparer || this.stopped || this.deleted.has(profileId)) return;
    let state: KeyState;
    try {
      state = this.keyState(profileId, agent, preparer.perAccount ? accountId : null, preparer.perAccount);
    } catch {
      return;
    }
    state.forceStale = true;
    void this.schedule(state, true);
  }

  /** The agent's Global config files changed: re-check its keys (only those whose inputs moved re-prepare). */
  globalConfigChanged(agent: SessionProfileAgentId): void {
    if (this.stopped) return;
    for (const state of this.keys.values()) {
      if (state.agent === agent) void this.schedule(state, false);
    }
  }

  /** Subscribes to the profile service's `changed` / `deleted`. Returns the unsubscribe. */
  attach(events: EventEmitter<SessionProfileServiceEvents>): () => void {
    const onChanged = ({ profileId, revision }: { profileId: string; revision: string }): void => this.onChanged(profileId, revision);
    const onDeleted = ({ profileId }: { profileId: string }): void => void this.onDeleted(profileId);
    events.on("changed", onChanged);
    events.on("deleted", onDeleted);
    const detach = (): void => {
      events.off("changed", onChanged);
      events.off("deleted", onDeleted);
    };
    this.detach = detach;
    return detach;
  }

  /**
   * Daemon boot: empties the staging root (leftovers of an interrupted preparation), registers
   * the current versions on disk (dropping the pointers of deleted profiles), checks every
   * profile's keys and seeds its default ones in the background (stale or missing → re-prepared),
   * then collects garbage in the background (a legacy unversioned key dir counts as stale).
   */
  async start(): Promise<void> {
    const staging = sessionProfileStagingDir(this.appdir);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: DIR_MODE });
    const { profiles } = await this.store.list();
    const existing = new Set(profiles.map((profile) => profile.manifest.id));
    for (const profile of profiles) {
      this.noteProfile(profile.manifest.id, String(profile.manifest.revision), profile.manifest.updatedAt);
    }
    await this.scanPrepared(existing);
    for (const profileId of existing) this.refreshProfile(profileId);
    void this.gc();
  }

  /**
   * One GC pass over every key on disk: removes each non-current version (and legacy key-dir
   * content) that no live session leases, then empty dirs. See the module header for the rule.
   */
  gc(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.track(this.collect());
  }

  /** Stops scheduling, aborts preparations in flight (`ctx.signal`) and detaches from the service. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detach();
    this.abort.abort();
  }

  /** Resolves once no job or removal is in flight (tests, shutdown drains). */
  async idle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  private onChanged(profileId: string, revision: string): void {
    if (this.stopped || this.deleted.has(profileId)) return;
    this.noteProfile(profileId, revision, this.now().toISOString());
    this.refreshProfile(profileId);
  }

  /** Seeds the profile's default keys and (re)checks every known key of it in the background. */
  private refreshProfile(profileId: string): void {
    for (const agent of SESSION_PROFILE_AGENTS) {
      const preparer = this.preparerOf(agent);
      if (!preparer) continue;
      try {
        this.keyState(profileId, agent, preparer.perAccount ? (this.options.defaultAccountId?.(agent) ?? null) : null, preparer.perAccount);
      } catch (error) {
        this.logger.warn(`Agent Profiles: cannot prepare profile ${profileId} for ${agent}: ${describe(error)}`);
      }
    }
    for (const state of this.keys.values()) {
      if (state.profileId === profileId) void this.schedule(state, false);
    }
  }

  private onDeleted(profileId: string): Promise<void> {
    if (this.deleted.has(profileId)) return Promise.resolve();
    this.deleted.add(profileId);
    const states = [...this.keys.values()].filter((state) => state.profileId === profileId);
    return this.track(
      (async () => {
        await Promise.all(states.map((state) => state.tail));
        for (const state of states) this.keys.delete(state.id);
        this.profiles.delete(profileId);
        await this.dropProfile(profileId);
      })()
    );
  }

  /** Registers the current version of every key on disk; drops the pointers of deleted profiles. */
  private async scanPrepared(existing: Set<string>): Promise<void> {
    const root = sessionProfilePreparedRootDir(this.appdir);
    for (const profileId of await listDirs(root)) {
      if (!existing.has(profileId)) {
        await this.dropProfile(profileId, false);
        continue;
      }
      for (const agent of await listDirs(join(root, profileId))) {
        if (!isSessionProfileAgentId(agent)) continue;
        const preparer = this.preparerOf(agent);
        if (!preparer) continue;
        for (const accountKey of await listDirs(join(root, profileId, agent))) {
          if (preparer.perAccount === (accountKey === SESSION_PROFILE_SHARED_ACCOUNT_KEY)) continue;
          let state: KeyState;
          try {
            state = this.keyState(profileId, agent, accountKey === SESSION_PROFILE_SYSTEM_ACCOUNT_KEY ? null : accountKey, preparer.perAccount);
          } catch {
            continue;
          }
          const current = await readCurrentVersion(state.keyDir);
          const manifest = current ? await readManifestIfAny(join(state.keyDir, current)) : null;
          if (manifest && manifest.profileId === profileId && manifest.agent === agent && manifest.accountKey === accountKey) {
            state.state = "ready";
            state.readyRevision = manifest.revision;
            state.updatedAt = manifest.preparedAt;
          }
        }
      }
    }
  }

  /**
   * A deleted profile: removes every key's pointer (no launch can pick a version any more), then
   * collects its versions (`collect = false` at boot: `start()` runs a full pass afterwards).
   */
  private async dropProfile(profileId: string, collect = true): Promise<void> {
    let keyDirs: string[];
    try {
      keyDirs = await listKeyDirs(sessionProfilePreparedProfileDir(this.appdir, profileId));
      for (const keyDir of keyDirs) await rm(join(keyDir, SESSION_PROFILE_PREPARED_CURRENT_FILE), { force: true });
    } catch (error) {
      this.logger.warn(`Agent Profiles: removing the prepared dirs of deleted profile ${profileId} failed: ${describe(error)}`);
      return;
    }
    if (collect) await this.collect(keyDirs);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private schedule(state: KeyState, retryFailed: boolean): Promise<Outcome> {
    if (this.stopped) return Promise.resolve({ ok: false, error: stopping() });
    if (this.deleted.has(state.profileId)) return Promise.resolve({ ok: false, error: sessionProfileErrors.notFound(state.profileId) });
    if (state.queued) {
      state.queued.retryFailed ||= retryFailed;
      return state.queued.promise;
    }
    const job: QueuedJob = { retryFailed, promise: Promise.resolve(undefined as never) };
    state.pending += 1;
    job.promise = state.tail
      .then(() => {
        if (state.queued === job) state.queued = null;
        return this.runJob(state, job.retryFailed);
      })
      .catch((error: unknown): Outcome => ({ ok: false, error: sessionProfileErrors.notReady(`Preparing the profile failed: ${describe(error)}`) }))
      .finally(() => {
        state.pending -= 1;
      });
    state.queued = job;
    state.tail = job.promise.then(noop);
    this.track(job.promise);
    return job.promise;
  }

  private async runJob(state: KeyState, retryFailed: boolean): Promise<Outcome> {
    if (this.stopped) return { ok: false, error: stopping() };
    const preparer = this.preparerOf(state.agent);
    if (!preparer) return { ok: false, error: sessionProfileErrors.unsupportedAgent(AGENT_PROFILE_AGENT_LABELS[state.agent]) };

    let accountHome: string | null = null;
    if (preparer.perAccount) {
      accountHome = state.accountId === null ? systemHome(this.options.systemHomes, state.agent) : this.options.accountHome(state.agent, state.accountId);
      if (accountHome === null) {
        // The account was removed: forget its prepared dir (a launch for it is refused).
        await this.forget(state);
        return { ok: false, error: sessionProfileErrors.notReady(`The account "${state.accountId}" no longer exists.`) };
      }
    }

    let revision: string;
    try {
      const stored = await this.store.read(state.profileId);
      revision = String(stored.manifest.revision);
      this.noteProfile(state.profileId, revision, stored.manifest.updatedAt);
    } catch (error) {
      if (error instanceof SessionProfileError && error.code === "PROFILE_NOT_FOUND") {
        await this.forget(state);
        return { ok: false, error };
      }
      return this.fail(state, null, error, null);
    }

    const inputsCtx: SessionProfilePrepareInputsContext = {
      agent: state.agent,
      accountKey: state.accountKey,
      accountHome,
      systemHomes: this.options.systemHomes,
      appdir: this.appdir
    };
    const fingerprint = await this.fingerprint(preparer, inputsCtx, revision);
    const current = await readCurrentVersion(state.keyDir);
    const currentDir = current ? join(state.keyDir, current) : null;
    if (!state.forceStale) {
      const manifest = currentDir ? await readManifestIfAny(currentDir) : null;
      if (currentDir && manifest && this.matches(manifest, state, revision, fingerprint)) {
        const unusable = await unusableReason(preparer, currentDir);
        if (unusable === null) {
          state.failure = undefined;
          this.setState(state, "ready", undefined, revision);
          return { ok: true, ready: this.ready(state, revision, currentDir) };
        }
        // Current but not launchable (Codex: its state DB is gone): a new version, never this one.
        this.logger.warn(
          `Agent Profiles: the prepared ${state.agent} dir of profile ${state.profileId} (${state.accountKey}) cannot be used (${unusable}); preparing it again.`
        );
      }
      if (!retryFailed && state.failure?.fingerprint === fingerprint) return { ok: false, error: state.failure.error };
    }

    const release = await this.slots.acquire();
    try {
      if (this.stopped) return { ok: false, error: stopping() };
      return await this.prepare(state, preparer, inputsCtx, fingerprint, currentDir);
    } finally {
      release();
    }
  }

  private async prepare(
    state: KeyState,
    preparer: SessionProfilePreparer,
    inputsCtx: SessionProfilePrepareInputsContext,
    expectedFingerprint: string,
    previousPreparedDir: string | null
  ): Promise<Outcome> {
    // A `markStale` from now on asks for another preparation after this one.
    const forced = state.forceStale;
    state.forceStale = false;
    this.setState(state, "preparing");
    let resolved: ResolvedAgentProfile | null = null;
    let fingerprint = expectedFingerprint;
    const stagingRoot = sessionProfileStagingDir(this.appdir);
    const stagingDir = join(stagingRoot, `${state.profileId}.${state.agent}.${state.accountKey}.${randomUUID()}`);
    try {
      const source = await this.store.readSource(state.profileId);
      resolved = resolveForAgent(source, state.agent);
      // The profile may have moved since the check: the dir is for what was actually read.
      if (source.revision !== this.profiles.get(state.profileId)?.revision) {
        this.noteProfile(state.profileId, source.revision, this.now().toISOString());
      }
      fingerprint = await this.fingerprint(preparer, inputsCtx, source.revision);
      const version = newVersionName(fingerprint, this.now());
      await mkdir(stagingRoot, { recursive: true, mode: DIR_MODE });
      await mkdir(stagingDir, { mode: DIR_MODE });
      const ctx: SessionProfilePrepareContext = {
        ...inputsCtx,
        resolved,
        stagingDir,
        preparedDir: join(state.keyDir, version),
        previousPreparedDir,
        cliBin: this.options.cliBin?.(state.agent) ?? null,
        logger: this.logger,
        signal: this.abort.signal
      };
      const agentSection = await preparer.prepare(ctx);
      await preparer.validate?.(ctx);
      if (this.stopped) throw new Error("The daemon is stopping.");
      const manifest = {
        schema: 1,
        profileId: state.profileId,
        revision: source.revision,
        agent: state.agent,
        accountKey: state.accountKey,
        preparedAt: this.now().toISOString(),
        fingerprint,
        agentSection
      } as PreparedManifest;
      await writePreparedManifest(stagingDir, manifest);
      await publish(stagingDir, state.keyDir, version);
      state.finished += 1;
      state.failure = undefined;
      this.setState(state, "ready", undefined, source.revision);
      this.logger.info(
        `Agent Profiles: prepared profile ${state.profileId} r${source.revision} for ${state.agent} (${state.accountKey}) as ${version}.`
      );
      // The previous version (or legacy content) goes once no session leases it — after this job.
      void this.track(this.collect([state.keyDir]));
      return { ok: true, ready: this.ready(state, source.revision, ctx.preparedDir) };
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(noop);
      state.forceStale ||= forced;
      state.finished += 1;
      return this.fail(state, fingerprint, error, resolved);
    }
  }

  /** Records a failed attempt (reason redacted) and answers it. */
  private fail(state: KeyState, fingerprint: string | null, error: unknown, resolved: ResolvedAgentProfile | null): Outcome {
    const reason = redact(describe(error), resolved);
    const failure = sessionProfileErrors.notReady(reason);
    if (fingerprint !== null) state.failure = { fingerprint, error: failure };
    this.setState(state, "failed", reason);
    this.logger.warn(`Agent Profiles: preparing profile ${state.profileId} for ${state.agent} (${state.accountKey}) failed: ${reason}`);
    return { ok: false, error: failure };
  }

  /**
   * Drops a key whose account or profile is gone (only when nothing else is queued on it): its
   * pointer now, its versions once no session leases them. Runs inside the key's job.
   */
  private async forget(state: KeyState): Promise<void> {
    if (state.pending > 1 || state.queued) return;
    if (this.keys.get(state.id) === state) this.keys.delete(state.id);
    await rm(join(state.keyDir, SESSION_PROFILE_PREPARED_CURRENT_FILE), { force: true }).catch(noop);
    void this.track(this.collect([state.keyDir]));
    this.emitStatus(state.profileId);
  }

  // -------------------------------------------------------------------------
  // Garbage collection
  // -------------------------------------------------------------------------

  /**
   * One GC pass over `keyDirs` (every key dir on disk when omitted). The leases are read once,
   * before any key is locked (a slow host never holds up a launch); dirs handed out since are
   * protected by their grace. Each key is collected inside its job chain when it has one.
   */
  private async collect(keyDirs?: string[]): Promise<void> {
    try {
      await this.collectPass(keyDirs);
    } catch (error) {
      this.logger.warn(`Agent Profiles: collecting unused prepared dirs failed: ${describe(error)}`);
    }
  }

  private async collectPass(keyDirs?: string[]): Promise<void> {
    const leases = this.options.leases;
    if (!leases) return;
    let leased: Set<string>;
    try {
      leased = new Set([...(await leases.inUse())].map((path) => resolve(path)));
    } catch (error) {
      this.logger.warn(`Agent Profiles: cannot tell which prepared dirs are in use, keeping them all: ${describe(error)}`);
      return;
    }
    const dirs = keyDirs ?? (await listKeyDirs(sessionProfilePreparedRootDir(this.appdir), 2));
    for (const keyDir of dirs) {
      if (this.stopped) return;
      const run = (): Promise<void> => this.collectKey(keyDir, leased);
      const state = [...this.keys.values()].find((candidate) => candidate.keyDir === keyDir);
      if (!state) {
        // No job can publish here: the profile is gone, or the agent/key kind has no preparer.
        await run();
        continue;
      }
      const job = state.tail.then(run);
      state.tail = job.then(noop, noop);
      await job;
    }
  }

  /** Removes the key's unleased non-current versions, stale pointer temp files and unleased legacy content. */
  private async collectKey(keyDir: string, leased: ReadonlySet<string>): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(keyDir, { withFileTypes: true });
    } catch {
      return;
    }
    const current = await readCurrentVersion(keyDir);
    const kept = (dir: string): boolean => leased.has(dir) || (this.handedOut.get(dir) ?? 0) > this.now().getTime();
    const legacy: string[] = [];
    for (const entry of entries) {
      const path = join(keyDir, entry.name);
      if (entry.name === SESSION_PROFILE_PREPARED_CURRENT_FILE) continue;
      if (entry.name.startsWith(CURRENT_TMP_PREFIX)) {
        await rm(path, { force: true }).catch(noop);
      } else if (VERSION_RE.test(entry.name) && entry.isDirectory()) {
        if (entry.name === current || kept(path)) continue;
        await this.remove(path);
      } else {
        legacy.push(entry.name);
      }
    }
    // The pre-versioning layout: the key dir itself was the prepared dir (a chat may run in it).
    if (legacy.length > 0 && !kept(keyDir)) {
      legacy.sort((a, b) => Number(a === PREPARED_MANIFEST_FILE) - Number(b === PREPARED_MANIFEST_FILE));
      for (const name of legacy) await this.remove(join(keyDir, name));
    }
    // Empty dirs up to (not including) the prepared root; `rmdir` refuses a non-empty one.
    const root = sessionProfilePreparedRootDir(this.appdir);
    for (let dir = keyDir; dir !== root && dir.startsWith(`${root}/`); dir = dirname(dir)) {
      if (!(await rmdir(dir).then(() => true, () => false))) break;
    }
  }

  private async remove(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
      this.logger.info(`Agent Profiles: removed unused prepared dir ${path}.`);
    } catch (error) {
      this.logger.warn(`Agent Profiles: removing the unused prepared dir ${path} failed: ${describe(error)}`);
    }
  }

  private matches(manifest: PreparedManifest, state: KeyState, revision: string, fingerprint: string): boolean {
    return (
      manifest.profileId === state.profileId &&
      manifest.agent === state.agent &&
      manifest.accountKey === state.accountKey &&
      manifest.revision === revision &&
      manifest.fingerprint === fingerprint
    );
  }

  private async fingerprint(preparer: SessionProfilePreparer, ctx: SessionProfilePrepareInputsContext, revision: string): Promise<string> {
    const paths = [...new Set(preparer.inputs?.(ctx) ?? [])].sort();
    const inputs = await Promise.all(paths.map(async (path) => [path, await hashFile(path)] as const));
    return sha256(
      JSON.stringify({
        revision,
        preparer: preparer.version ?? "0",
        cli: this.options.cliVersion?.(ctx.agent) ?? null,
        inputs
      })
    );
  }

  // -------------------------------------------------------------------------
  // State and status
  // -------------------------------------------------------------------------

  private preparerOf(agent: SessionProfileAgentId): SessionProfilePreparer | null {
    return preparerFor(agent, this.preparers) as SessionProfilePreparer | null;
  }

  /** The key's state, created on first use. Throws `PROFILE_NOT_FOUND`/`INVALID_REQUEST` for ids that cannot be path segments. */
  private keyState(profileId: string, agent: SessionProfileAgentId, accountId: string | null, perAccount: boolean): KeyState {
    let accountKey: string;
    let keyDir: string;
    try {
      accountKey = perAccount ? sessionProfileAccountKey(accountId) : SESSION_PROFILE_SHARED_ACCOUNT_KEY;
    } catch {
      throw sessionProfileErrors.invalid(`"${String(accountId).slice(0, 80)}" is not a valid account id.`);
    }
    try {
      keyDir = sessionProfilePreparedKeyDir(this.appdir, profileId, agent, accountKey);
    } catch {
      throw sessionProfileErrors.notFound(profileId);
    }
    const id = `${profileId}/${agent}/${accountKey}`;
    let state = this.keys.get(id);
    if (!state) {
      state = {
        id,
        profileId,
        agent,
        accountKey,
        accountId: perAccount && accountKey !== SESSION_PROFILE_SYSTEM_ACCOUNT_KEY ? accountKey : null,
        keyDir,
        state: "not-prepared",
        updatedAt: this.now().toISOString(),
        forceStale: false,
        tail: Promise.resolve(),
        pending: 0,
        finished: 0,
        queued: null
      };
      this.keys.set(id, state);
    }
    return state;
  }

  private setState(state: KeyState, next: SessionProfilePrepareState, reason?: string, readyRevision?: string): void {
    const moved = state.state !== next || state.reason !== reason || (readyRevision !== undefined && state.readyRevision !== readyRevision);
    state.state = next;
    state.reason = reason;
    if (readyRevision !== undefined) state.readyRevision = readyRevision;
    if (!moved) return;
    state.updatedAt = this.now().toISOString();
    if (this.keys.get(state.id) === state) this.emitStatus(state.profileId);
  }

  private emitStatus(profileId: string): void {
    const known = this.profiles.get(profileId);
    if (!known || this.deleted.has(profileId)) return;
    this.events.emit("prepareStatus", {
      profileId,
      revision: known.revision,
      agents: this.statusFor(profileId, known.revision, known.updatedAt)
    });
  }

  private statusFor(profileId: string, revision: string | undefined, fallbackUpdatedAt: string): SessionProfilePrepareStatus[] {
    return SESSION_PROFILE_AGENTS.map((agent): SessionProfilePrepareStatus => {
      if (!this.preparerOf(agent)) {
        return {
          agent,
          state: "not-prepared",
          reason: sessionProfileErrors.unsupportedAgent(AGENT_PROFILE_AGENT_LABELS[agent]).message,
          updatedAt: fallbackUpdatedAt
        };
      }
      const states = [...this.keys.values()].filter((state) => state.profileId === profileId && state.agent === agent);
      if (states.length === 0) return { agent, state: "not-prepared", updatedAt: fallbackUpdatedAt };
      const updatedAt = states.map((state) => state.updatedAt).reduce((a, b) => (a > b ? a : b));
      const failed = states.find((state) => state.state === "failed");
      if (failed) return { agent, state: "failed", ...(failed.reason ? { reason: failed.reason } : {}), updatedAt };
      if (states.some((state) => state.state === "preparing")) return { agent, state: "preparing", updatedAt };
      const ready = states.some((state) => state.state === "ready" && (revision === undefined || state.readyRevision === revision));
      if (ready) return { agent, state: "ready", updatedAt };
      const stale = states.some((state) => state.state === "ready");
      return {
        agent,
        state: "not-prepared",
        ...(stale ? { reason: "Prepared for an older version of the profile; it is prepared again before the next launch." } : {}),
        updatedAt
      };
    });
  }

  private noteProfile(profileId: string, revision: string, updatedAt: string): void {
    if (this.deleted.has(profileId)) return;
    this.profiles.set(profileId, { revision, updatedAt });
  }

  /** The launch's answer; the dir is protected from GC for the handout grace (until its session holds a lease). */
  private ready(state: KeyState, revision: string, preparedDir: string): SessionProfileReady {
    const now = this.now().getTime();
    for (const [dir, until] of this.handedOut) if (until <= now) this.handedOut.delete(dir);
    this.handedOut.set(preparedDir, now + this.graceMs);
    return { profileId: state.profileId, agent: state.agent, accountKey: state.accountKey, revision, preparedDir };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    tracked.catch(noop);
    return promise;
  }
}

/**
 * Every preparation state change → the `/events` bus on {@link SESSION_PROFILES_CHANNEL} as
 * `sessionProfile.prepareStatus` {@link SessionProfilePrepareStatusResponse}.
 */
export function publishSessionProfilePrepareEvents(lifecycle: SessionProfileLifecycle, broadcaster: Pick<Broadcaster, "publish">): void {
  lifecycle.events.on("prepareStatus", (payload) => broadcaster.publish(SESSION_PROFILES_CHANNEL, "sessionProfile.prepareStatus", payload));
}

/** Bounds the preparations running at once. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/** The agent's own home for the System account. */
function systemHome(homes: AgentHomes, agent: SessionProfileAgentId): string {
  switch (agent) {
    case "claude":
      return homes.claudeDir;
    case "codex":
      return homes.codexHome;
    case "grok":
      return homes.grokHome;
    case "opencode":
      return homes.opencodeDir;
  }
}

function stopping(): SessionProfileError {
  return sessionProfileErrors.notReady("The daemon is stopping; the profile cannot be prepared now.");
}

async function readManifestIfAny(dir: string): Promise<PreparedManifest | null> {
  try {
    return parsePreparedManifest(JSON.parse(await readFile(join(dir, PREPARED_MANIFEST_FILE), "utf8")));
  } catch {
    return null;
  }
}

/** A fresh, never-reused version name: the fingerprint's head, the time and randomness. */
function newVersionName(fingerprint: string, now: Date): string {
  return `v-${fingerprint.slice(0, 12)}-${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** The key's current version name, or `null` (no pointer, unreadable, or not a version name). */
export async function readCurrentVersion(keyDir: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(keyDir, SESSION_PROFILE_PREPARED_CURRENT_FILE), "utf8")) as { version?: unknown };
    return typeof value.version === "string" && VERSION_RE.test(value.version) ? value.version : null;
  } catch {
    return null;
  }
}

/** The preparer's {@link SessionProfilePreparer.unusableReason} of a current version; a throw is a reason too. */
async function unusableReason(preparer: SessionProfilePreparer, dir: string): Promise<string | null> {
  if (!preparer.unusableReason) return null;
  try {
    return await preparer.unusableReason(dir);
  } catch (error) {
    return describe(error);
  }
}

/** Replaces the key's pointer atomically (temp + rename in the key dir). */
async function writeCurrentVersion(keyDir: string, version: string): Promise<void> {
  const tmp = join(keyDir, `${CURRENT_TMP_PREFIX}${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schema: 1, version })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, join(keyDir, SESSION_PROFILE_PREPARED_CURRENT_FILE));
  } catch (error) {
    await rm(tmp, { force: true }).catch(noop);
    throw error;
  }
}

/**
 * Publishes a complete staging dir as the key's new version: renamed to a fresh version dir, then
 * the pointer flips to it. A version nobody was told about is removed again if the flip fails.
 */
async function publish(stagingDir: string, keyDir: string, version: string): Promise<void> {
  await mkdir(keyDir, { recursive: true, mode: DIR_MODE });
  const target = join(keyDir, version);
  if (await lstat(target).then(() => true, (error: unknown) => !isMissing(error))) {
    throw new Error("A prepared version with that name already exists.");
  }
  await rename(stagingDir, target);
  try {
    await writeCurrentVersion(keyDir, version);
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(noop);
    throw error;
  }
}

/** The dirs `depth + 1` levels below `root` (`prepared/` → key dirs at depth 2; a profile dir → depth 1). */
async function listKeyDirs(root: string, depth = 1): Promise<string[]> {
  let dirs = [root];
  for (let level = 0; level <= depth; level += 1) {
    dirs = (await Promise.all(dirs.map(async (dir) => (await listDirs(dir)).map((name) => join(dir, name))))).flat();
  }
  return dirs;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A Global input's content hash; `missing` / `dir` / `error:<code>` when it has no readable content. */
async function hashFile(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EISDIR") return "dir";
    return `error:${code ?? "unknown"}`;
  }
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The message with every MCP env/header value of the resolved profile masked, bounded in length. */
function redact(message: string, resolved: ResolvedAgentProfile | null): string {
  let text = message;
  if (resolved) {
    const secrets = resolved.mcpServers
      .flatMap((server) => [...Object.values(server.env), ...Object.values(server.headers)])
      .filter((value) => value.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.split(secret).join("•••");
  }
  text = text.trim() || "Preparation failed.";
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
