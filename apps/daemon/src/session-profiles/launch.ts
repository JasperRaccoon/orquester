/**
 * Agent Profiles — the launch side (spec 2026-10-18 §6, §7 "One seam"): what a chat launch adds
 * to its account's launch environment once its profile is prepared.
 *
 * - {@link profileLaunchContributors}: ONE contributor per agent, keyed by agent, each turning
 *   the prepared directory's manifest section into env / unset / home / keyed-server fields
 *   (Codex: `CODEX_HOME` = the prepared home; Grok: `GROK_HOME`, `GROK_AUTH_PATH`, compat env;
 *   OpenCode: a `serverPool` key and its env). Claude's isolation is SDK options read by the host
 *   from the manifest, so its contributor is empty.
 * - {@link applyProfileContribution}: the contribution laid OVER the account's launch fields —
 *   the one composition rule every launch path (create, fork, fork reconcile, account switch,
 *   profile switch, the refresh at every session start) shares.
 * - {@link createProfileLaunchResolver}: `ensureReady` → manifest section → contributor, for
 *   `AgentChatService`. Throws `SessionProfileError` (`PROFILE_NOT_FOUND`, `PROFILE_NOT_READY`,
 *   `PROFILE_UNSUPPORTED_AGENT`); never answers Global for a profile it could not apply.
 * - `PreparedDirLeases` (the lifecycle's, re-exported): what its GC asks before it deletes a
 *   prepared version — implemented by `AgentChatService.profileLeases()` over the agent host's
 *   `GET /profiles/leases`.
 *
 * Never log a contribution: an env value may be a secret (a profile MCP server's token is not,
 * but a contributor is free to pass one through).
 */

import { AGENT_PROFILE_AGENT_LABELS, isSessionProfileAgentId, type SessionProfileAgentId } from "@orquester/api";
import type { HostThreadProfile, HostThreadServerPool } from "../agent-host/host-protocol.ts";
import { ACCOUNT_HOME_ENV_VAR } from "../agent-host/support/env.ts";
import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import { PreparedManifestError, readPreparedManifest, type PreparedSectionFor } from "./manifest.ts";
import { opencodeLaunchContribution } from "./preparers/opencode.ts";
import type { SessionProfileReady } from "./lifecycle.ts";
import { grokProfileLaunchContribution } from "./contributions/grok.ts";
import { codexProfileLaunchContribution } from "./contributions/codex.ts";

/** What one agent's contributor is given. */
export interface ProfileLaunchContext<A extends SessionProfileAgentId = SessionProfileAgentId> {
  agent: A;
  /** The prepared version the launch uses (`ensureReady`'s answer). */
  profile: HostThreadProfile;
  /** Its `manifest.json`'s `agentSection` (`manifest/<agent>.ts`), already validated. */
  manifestSection: PreparedSectionFor<A>;
  /** The managed account the chat runs under; `null` for the System identity. */
  accountId: string | null;
  /**
   * The account's home as the agent reads it: the launch env's home variable
   * (`ACCOUNT_HOME_ENV_VAR`), else the resolver's `accountHome` (the System home). `null` when
   * neither names one.
   */
  accountHome: string | null;
  /** The chat's project root ("" when it has none). */
  projectPath: string;
  /** The account's launch env (registry entry env + `resolveExtraEnv`), BEFORE the contribution. */
  launchEnv: Readonly<Record<string, string>>;
}

/** What a contributor adds. Every field optional; `{}` = the account's launch as is. */
export interface ProfileLaunchContribution {
  /** Layered over the account's launch env (the contribution wins a collision). */
  env?: Record<string, string>;
  /** Removed from the child's env after everything else is layered (and from `env` here). */
  unsetEnv?: string[];
  /**
   * The thread's `homePath` (the resume identity's home, spec §7). Absent: whatever the agent's
   * home variable names after `env` is applied — so a contributor that points `CODEX_HOME` at the
   * prepared home moves `homePath` with it.
   */
  homePath?: string;
  /** The keyed provider server (OpenCode, `HostThreadServerPool`). Absent: the account's. */
  serverPool?: HostThreadServerPool;
}

export type ProfileLaunchContributor<A extends SessionProfileAgentId = SessionProfileAgentId> = (
  ctx: ProfileLaunchContext<A>
) => ProfileLaunchContribution | Promise<ProfileLaunchContribution>;

/** One contributor per agent. */
export type ProfileLaunchContributors = { [A in SessionProfileAgentId]: ProfileLaunchContributor<A> };

/** Per-agent launch contributions. Claude's isolation is read from its prepared manifest. */
const profileLaunchContributors: ProfileLaunchContributors = {
  claude: () => ({}),
  codex: codexProfileLaunchContribution,
  grok: grokProfileLaunchContribution,
  opencode: opencodeLaunchContribution
};

/** A chat thread's launch fields, as `CreateHostThreadRequest` / `SetThreadIdentityRequest` carry them. */
export interface ChatLaunchFields {
  launchEnv: Record<string, string>;
  unsetEnv?: string[];
  homePath?: string;
  serverPool?: HostThreadServerPool;
}

/**
 * The account's launch fields with a profile's contribution on top. `homeVariable` is the
 * agent's home variable (`ACCOUNT_HOME_ENV_VAR`). Pure; the inputs are not modified.
 */
export function applyProfileContribution(
  base: ChatLaunchFields,
  contribution: ProfileLaunchContribution,
  homeVariable: string
): ChatLaunchFields {
  const launchEnv: Record<string, string> = { ...base.launchEnv, ...(contribution.env ?? {}) };
  const removed = contribution.unsetEnv ?? [];
  for (const name of removed) delete launchEnv[name];
  // A variable the contribution sets is never unset by the account's list: the profile's value wins.
  const unsetEnv = [
    ...new Set([...(base.unsetEnv ?? []).filter((name) => !(contribution.env && name in contribution.env)), ...removed])
  ];
  const homePath =
    contribution.homePath ?? launchEnv[homeVariable] ?? (removed.includes(homeVariable) ? undefined : base.homePath);
  const serverPool = contribution.serverPool ?? base.serverPool;
  return {
    launchEnv,
    ...(unsetEnv.length > 0 ? { unsetEnv } : {}),
    ...(homePath ? { homePath } : {}),
    ...(serverPool ? { serverPool } : {})
  };
}

/** What `AgentChatService` asks to launch a chat with a profile. */
export interface ProfileLaunchRequest {
  profileId: string;
  /** The chat's agent (its adapter id). */
  agent: string;
  /** The managed account id, or "" for the System identity. */
  accountId: string;
  projectPath: string;
  /** The account's launch fields, before the contribution. */
  base: ChatLaunchFields;
}

export interface ResolvedProfileLaunch {
  profile: HostThreadProfile;
  /** {@link applyProfileContribution} of the agent's contribution over `base`. */
  fields: ChatLaunchFields;
}

export type ResolveProfileLaunch = (request: ProfileLaunchRequest) => Promise<ResolvedProfileLaunch>;

export interface ProfileLaunchResolverOptions {
  lifecycle: { ensureReady(profileId: string, agent: SessionProfileAgentId, accountId: string | null): Promise<SessionProfileReady> };
  contributors?: ProfileLaunchContributors;
  /** The account's home when the launch env names none (System: the agent's system home). */
  accountHome?(agent: SessionProfileAgentId, accountId: string | null): string | null;
}

/**
 * `ensureReady(profileId, agent, account)` → the prepared manifest's section → the agent's
 * contribution over the account's launch. Throws `SessionProfileError` only: a manifest that does
 * not read, or a contributor that throws, is `PROFILE_NOT_READY` with the reason.
 */
export function createProfileLaunchResolver(options: ProfileLaunchResolverOptions): ResolveProfileLaunch {
  return async (request) => {
    if (!isSessionProfileAgentId(request.agent)) {
      throw sessionProfileErrors.unsupportedAgent(request.agent);
    }
    const agent = request.agent;
    const accountId = request.accountId.length > 0 ? request.accountId : null;
    const ready = await options.lifecycle.ensureReady(request.profileId, agent, accountId);
    const profile: HostThreadProfile = { profileId: ready.profileId, revision: ready.revision, preparedDir: ready.preparedDir };
    let manifestSection: PreparedSectionFor<typeof agent>;
    try {
      manifestSection = (await readPreparedManifest(ready.preparedDir, { profileId: ready.profileId, revision: ready.revision, agent })).agentSection;
    } catch (error) {
      throw sessionProfileErrors.notReady(
        `The Agent Profile is not prepared for ${AGENT_PROFILE_AGENT_LABELS[agent]}: ${error instanceof PreparedManifestError ? error.message : "its manifest could not be read."}`
      );
    }
    const homeVariable = ACCOUNT_HOME_ENV_VAR[agent];
    const accountHome = request.base.launchEnv[homeVariable] ?? options.accountHome?.(agent, accountId) ?? null;
    let contribution: ProfileLaunchContribution;
    try {
      const contribute = (options.contributors ?? profileLaunchContributors)[agent] as ProfileLaunchContributor;
      contribution = await contribute({
        agent,
        profile,
        manifestSection,
        accountId,
        accountHome,
        projectPath: request.projectPath,
        launchEnv: { ...request.base.launchEnv }
      });
    } catch (error) {
      if (error instanceof SessionProfileError) throw error;
      throw sessionProfileErrors.notReady(
        `The Agent Profile could not be applied to ${AGENT_PROFILE_AGENT_LABELS[agent]}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { profile, fields: applyProfileContribution(request.base, contribution, homeVariable) };
  };
}

/** The lifecycle's lease source (`lifecycle.ts`); `AgentChatService.profileLeases()` implements it. */
export type { PreparedDirLeases } from "./lifecycle.ts";

/** The user-facing notice of a deleted profile's fallback (spec §5.6). */
export function deletedProfileNotice(name: string | undefined): string {
  return name
    ? `Agent Profile "${name}" was deleted; this chat now uses Global.`
    : "This chat's Agent Profile was deleted; it now uses Global.";
}

/**
 * Follows which profiles exist now ({@link liveIds}): what workflow validation checks an agent
 * block's `profileId` against (§5.5), synchronously.
 */
export class SessionProfileNames {
  /** Created or changed since tracking began (live unless deleted after). */
  private readonly seen = new Set<string>();
  /** Deleted since tracking began: a list read that started before the delete must not revive them. */
  private readonly gone = new Set<string>();
  /** The ids the first list read answered (unreadable profile directories too); null until it landed. */
  private listed: Set<string> | null = null;

  /** The ids of the profiles that exist now, or undefined until the first list read landed (unknown). */
  liveIds(): string[] | undefined {
    if (this.listed === null) return undefined;
    return [...new Set([...this.listed, ...this.seen])].filter((id) => !this.gone.has(id));
  }

  /**
   * Fill from the service's list now and follow its changes. Never throws; a failed initial
   * read leaves the live ids unknown.
   */
  track(service: {
    list(): Promise<{ profiles: Array<{ id: string }>; errors?: Array<{ profileId: string }> }>;
    events: {
      on(event: "changed", listener: (payload: { profileId: string }) => void): unknown;
      on(event: "deleted", listener: (payload: { profileId: string }) => void): unknown;
    };
  }): Promise<void> {
    service.events.on("changed", ({ profileId }) => {
      this.seen.add(profileId);
      this.gone.delete(profileId);
    });
    service.events.on("deleted", ({ profileId }) => {
      this.seen.delete(profileId);
      this.gone.add(profileId);
    });
    return service.list().then(
      ({ profiles, errors }) => {
        // An unreadable profile directory still exists: a block naming it is not "missing".
        this.listed = new Set([...profiles.map((profile) => profile.id), ...(errors ?? []).map((error) => error.profileId)]);
      },
      () => undefined
    );
  }
}
