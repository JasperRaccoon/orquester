/**
 * Agent host — what an adapter calls to launch a profile thread (spec 2026-10-18 §6, §6.5).
 *
 * `StartSessionInput.profile` / `ForkConversationInput.profile` name the prepared directory the
 * daemon resolved for the thread's profile, agent and account. The adapter reads its own section
 * of `<preparedDir>/manifest.json` through {@link loadProfileManifest} and launches from it.
 *
 * A manifest that is missing, does not read, or names another profile, revision or agent FAILS
 * the session start with a message the thread shows — never a quiet Global launch (spec §2
 * anti-goals). A thread with no profile is Global: the helper answers `null`.
 *
 * Static imports only (AGENTS.md: no dynamic `import()` under `agent-host`); `manifest.ts`
 * imports zod and node built-ins alone.
 */

import type { SessionProfileAgentId } from "@orquester/api";

import {
  PreparedManifestError,
  readPreparedManifest,
  type PreparedSectionFor
} from "../../session-profiles/manifest.ts";
import type { HostThreadProfile } from "../host-protocol.ts";

/** A profile thread's session start that cannot launch from its prepared directory. */
export class ProfileLaunchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProfileLaunchError";
  }
}

/**
 * The thread's prepared section for `agent`, or `null` for a Global thread (no `profile`).
 * Throws {@link ProfileLaunchError} — the caller lets it fail the start — when the prepared
 * directory cannot be launched from.
 */
export async function loadProfileManifest<A extends SessionProfileAgentId>(
  input: { profile?: HostThreadProfile },
  agent: A
): Promise<PreparedSectionFor<A> | null> {
  const profile = input.profile;
  if (profile === undefined) {
    return null;
  }
  try {
    const manifest = await readPreparedManifest(profile.preparedDir, {
      profileId: profile.profileId,
      revision: profile.revision,
      agent
    });
    return manifest.agentSection as PreparedSectionFor<A>;
  } catch (error) {
    const reason =
      error instanceof PreparedManifestError
        ? error.message
        : "The prepared profile could not be read.";
    throw new ProfileLaunchError(
      `This chat's Agent Profile could not be loaded, so the agent was not started: ${reason}`,
      { cause: error }
    );
  }
}
