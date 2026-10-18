/**
 * Agent Profiles — the per-agent preparer contract (spec §6, §6.5). A preparer turns one
 * {@link ResolvedAgentProfile} into the agent-native files a profile chat launches from, inside a
 * staging directory, and answers its `agentSection` for `manifest.json` (`manifest.ts`).
 *
 * The flow (run by `lifecycle.ts`, `SessionProfileLifecycle` — see its header for triggers,
 * staleness and status):
 *  1. `store.readSource(profileId)` → `resolveForAgent(source, agent)`.
 *  2. Make an empty 0700 staging dir under `sessionProfileStagingDir(appdir)`.
 *  3. `section = await preparer.prepare(ctx)`; then `await preparer.validate?.(ctx)` (Codex:
 *     `initialize` OK; Grok: `grok inspect --json` shows only profile items; OpenCode: config
 *     debug). Either throwing → state `failed` with the error's message (secret values are
 *     redacted from it, but never quote one on purpose).
 *  4. `writePreparedManifest(stagingDir, {schema: 1, profileId, revision, agent, accountKey,
 *     preparedAt, fingerprint, agentSection: section})` LAST, then the staging dir is renamed to a
 *     NEW version dir `sessionProfilePreparedDir(appdir, profileId, agent, accountKey, version)`
 *     and the key's `current.json` pointer flips to it. Older versions stay untouched until no
 *     live session uses them (leased GC, `lifecycle.ts`).
 *  5. `sessionProfile.prepareStatus` is published; a launch's `ensureReady` waits for a
 *     preparation in flight and fails with a failed one's reason (no fallback to Global).
 *
 * PATH CONTRACT. Files are written into `ctx.stagingDir`, but the directory is launched from
 * `ctx.preparedDir`, the final VERSIONED path it is renamed to: anything that names the
 * directory's own location (Codex hook trust keyed by `CODEX_HOME`, absolute paths inside
 * configs) must use `ctx.preparedDir`, never `stagingDir`. Relative symlinks inside the dir
 * survive the rename; absolute links must point outside it. A published version is immutable:
 * nothing (preparer or lifecycle) writes into it again; only the CLI running in it does.
 * `ctx.previousPreparedDir` is the key's current version while `prepare` runs (`null` when there
 * is none) — a running chat may be using it: read from it if useful (e.g. carry Codex's seeded
 * state DB over) but never modify it. A step that only works AT the final path (a CLI that records
 * its own home's location while running there) cannot run in `prepare`; run it in staging only
 * when the result is location-independent, else at launch. When a launch finds the dir unusable
 * (Codex: its state DB is missing, spec §6.2), the preparer's `unusableReason` says so and the
 * lifecycle prepares a new version (`lifecycle.markStale(...)` forces one from outside).
 *
 * STALENESS. A prepared dir is current while its fingerprint matches: profile revision +
 * {@link SessionProfilePreparer.version} + the agent CLI's version + the content of every file
 * {@link SessionProfilePreparer.inputs} names (the Global runtime config it carries over, §6.0).
 *
 * `accountKey`: `sessionProfileAccountKey(accountId)` when `perAccount` (Codex: one `CODEX_HOME`
 * per account, spec §6.2), else `SESSION_PROFILE_SHARED_ACCOUNT_KEY` (`@orquester/config`).
 *
 * Rules for every preparer: never write into the global agent homes or an account's credential
 * files (it may LINK to an account's login file and the shared history folder, spec §2); never
 * copy credentials; files holding MCP secrets are 0600 in 0700 dirs; never log `resolved` (it
 * carries secret values) and never put a secret in argv.
 */

import type { SessionProfileAgentId } from "@orquester/api";
import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import type { PreparedSectionFor } from "./manifest.ts";
import { claudePreparer } from "./preparers/claude.ts";
import { codexPreparer } from "./preparers/codex.ts";
import { grokPreparer } from "./preparers/grok.ts";
import { opencodePreparer } from "./preparers/opencode.ts";
import type { ResolvedAgentProfile } from "./resolve.ts";

export interface SessionProfilePrepareLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SessionProfilePrepareContext<A extends SessionProfileAgentId = SessionProfileAgentId> {
  /** What this agent gets from the profile, WITH secret values (`resolve.ts`). */
  resolved: ResolvedAgentProfile;
  agent: A;
  /** The prepared dir's account key (see the module header). */
  accountKey: string;
  /**
   * The home of the account the dir is for: a managed account's home, or the agent's system home
   * for the System account. `null` for a preparer that is not `perAccount`.
   */
  accountHome: string | null;
  /** The daemon user's own agent homes (`resolveAgentHomes`): read-only inputs (runtime settings, §6.0). */
  systemHomes: AgentHomes;
  /** An empty 0700 directory to build in; it is renamed to {@link preparedDir} after validation. */
  stagingDir: string;
  /**
   * The new version dir the staging dir will be renamed to (never existed before) — for config
   * that must name its own home (e.g. Codex hook trust).
   */
  preparedDir: string;
  /** The key's current version (may be in use by a running chat): read-only, never modify it. `null` = none. */
  previousPreparedDir: string | null;
  appdir: string;
  /**
   * The agent's CLI binary as the registry resolved it (absolute), for a preparer that runs it
   * (Codex: state-DB seeding); `null`/absent when not installed or not known.
   */
  cliBin?: string | null;
  logger: SessionProfilePrepareLogger;
  signal?: AbortSignal;
}

/** What {@link SessionProfilePreparer.inputs} may look at: no profile content, no secrets. */
export type SessionProfilePrepareInputsContext<A extends SessionProfileAgentId = SessionProfileAgentId> = Pick<
  SessionProfilePrepareContext<A>,
  "agent" | "accountKey" | "accountHome" | "systemHomes" | "appdir"
>;

export interface SessionProfilePreparer<A extends SessionProfileAgentId = SessionProfileAgentId> {
  agent: A;
  /** One prepared dir per account (Codex) rather than one shared by every account of the agent. */
  perAccount: boolean;
  /**
   * Bump it whenever the preparer's output changes for the same inputs (a new recipe key, a fixed
   * bug): every prepared dir built by another version is stale. Absent = `"0"`. Export it as a
   * constant next to the preparer.
   */
  version?: string;
  /**
   * The absolute paths of the Global files the preparer reads (e.g. `~/.codex/config.toml`,
   * `~/.grok/config.toml`, `~/.config/opencode/opencode.json(c)`, an account's `settings.json`):
   * their content (or absence) is part of the staleness fingerprint, so a Global change
   * re-prepares. Must be cheap and pure (no I/O).
   */
  inputs?(ctx: SessionProfilePrepareInputsContext<A>): string[];
  /** Writes the agent-native files into `ctx.stagingDir`; answers the manifest's `agentSection`. */
  prepare(ctx: SessionProfilePrepareContext<A>): Promise<PreparedSectionFor<A>>;
  /** Proves the staged files isolate as intended; throws with a user-facing reason when not. */
  validate?(ctx: SessionProfilePrepareContext<A>): Promise<void>;
  /**
   * Whether a published version whose fingerprint is current can still be launched from: `null`
   * when it can, else why not — the lifecycle then prepares a new version instead of answering it
   * (Codex: its seeded state DB is missing, spec §6.2). Asked by every job that would answer the
   * current version, so before every launch (`ensureReady`). Read-only and cheap; a throw counts
   * as unusable.
   */
  unusableReason?(preparedDir: string): Promise<string | null>;
}

/** Every agent's preparer; `null` until that agent's task implements it (`preparers/<agent>.ts`). */
export type SessionProfilePreparers = { [A in SessionProfileAgentId]: SessionProfilePreparer<A> | null };

export const sessionProfilePreparers: SessionProfilePreparers = {
  claude: claudePreparer,
  codex: codexPreparer,
  grok: grokPreparer,
  opencode: opencodePreparer
};

/**
 * The agent's preparer, or `null` when it has none yet: the lifecycle reports the agent as
 * `not-prepared` with a "not supported yet" reason and `ensureReady` throws
 * `PROFILE_UNSUPPORTED_AGENT`.
 */
export function preparerFor<A extends SessionProfileAgentId>(
  agent: A,
  preparers: SessionProfilePreparers = sessionProfilePreparers
): SessionProfilePreparer<A> | null {
  return preparers[agent] as SessionProfilePreparer<A> | null;
}
