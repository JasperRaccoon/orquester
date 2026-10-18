/**
 * Agent Profiles — the per-agent preparer contract (spec §6, §6.5). A preparer turns one
 * {@link ResolvedAgentProfile} into the agent-native files a profile chat launches from, inside a
 * staging directory, and answers its `agentSection` for `manifest.json` (`manifest.ts`).
 *
 * Expected flow (the preparation lifecycle — a later task — owns it; nothing here runs it):
 *  1. On profile create/save, first use for a new account, and daemon start for missing/stale
 *     dirs: `store.readSource(profileId)` → `resolveForAgent(source, agent)`.
 *  2. Make an empty 0700 staging dir under `sessionProfileStagingDir(appdir)`.
 *  3. `section = await preparer.prepare(ctx)`; then `await preparer.validate?.(ctx)` (Codex:
 *     `initialize` OK; Grok: `grok inspect --json` shows only profile items; OpenCode: config
 *     debug). Either throwing → state `failed` with the error's message (never quoting a secret).
 *  4. `writePreparedManifest(stagingDir, {schema: 1, profileId, revision, agent, accountKey,
 *     preparedAt, agentSection: section})` LAST, then swap the staging dir into
 *     `sessionProfilePreparedDir(appdir, profileId, agent, accountKey)` atomically.
 *  5. Publish `sessionProfile.prepareStatus` and answer it from `SessionProfileService`'s
 *     `prepareStatus` option. A launch waits for a preparation in flight; a failed one fails the
 *     launch with its reason (no fallback to Global).
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
  /** An empty 0700 directory to build in; it becomes {@link preparedDir} after validation. */
  stagingDir: string;
  /** Where the staging dir will live once swapped in — for config that must name its own home (e.g. Codex hook trust). */
  preparedDir: string;
  appdir: string;
  logger: SessionProfilePrepareLogger;
  signal?: AbortSignal;
}

export interface SessionProfilePreparer<A extends SessionProfileAgentId = SessionProfileAgentId> {
  agent: A;
  /** One prepared dir per account (Codex) rather than one shared by every account of the agent. */
  perAccount: boolean;
  /** Writes the agent-native files into `ctx.stagingDir`; answers the manifest's `agentSection`. */
  prepare(ctx: SessionProfilePrepareContext<A>): Promise<PreparedSectionFor<A>>;
  /** Proves the staged files isolate as intended; throws with a user-facing reason when not. */
  validate?(ctx: SessionProfilePrepareContext<A>): Promise<void>;
}

/** Every agent's preparer; `null` until that agent's task implements it (`preparers/<agent>.ts`). */
export type SessionProfilePreparers = { [A in SessionProfileAgentId]: SessionProfilePreparer<A> | null };

export const sessionProfilePreparers: SessionProfilePreparers = {
  claude: claudePreparer,
  codex: codexPreparer,
  grok: grokPreparer,
  opencode: opencodePreparer
};

/** The agent's preparer, or `null` when it has none yet (the lifecycle then reports `failed`). */
export function preparerFor<A extends SessionProfileAgentId>(
  agent: A,
  preparers: SessionProfilePreparers = sessionProfilePreparers
): SessionProfilePreparer<A> | null {
  return preparers[agent] as SessionProfilePreparer<A> | null;
}
