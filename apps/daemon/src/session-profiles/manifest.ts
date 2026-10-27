/**
 * Agent Profiles — a prepared directory's `manifest.json`: the contract between the daemon's
 * preparation (which writes it LAST into the staging directory, before it is published) and the
 * agent host's adapters (which read it from `HostThreadProfile.preparedDir` at every launch).
 *
 *   { schema: 1, profileId, revision, agent, accountKey, preparedAt, fingerprint?, agentSection }
 *
 * The envelope is shared; `agentSection` is per agent (`manifest/<agent>.ts`, each owned by that
 * agent's preparer). A launch whose manifest is missing, does not read, or names another profile,
 * revision or agent FAILS with the reason — it never falls back to Global (spec §2 anti-goals).
 *
 * Statically importable from the agent host (AGENTS.md: no dynamic `import()` there): this module
 * and `manifest/*.ts` import only zod and node built-ins.
 */

import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SessionProfileAgentId } from "@orquester/api";
import { claudePreparedSectionSchema, type ClaudePreparedSection } from "./manifest/claude.ts";
import { codexPreparedSectionSchema, type CodexPreparedSection } from "./manifest/codex.ts";
import { grokPreparedSectionSchema, type GrokPreparedSection } from "./manifest/grok.ts";
import { opencodePreparedSectionSchema, type OpenCodePreparedSection } from "./manifest/opencode.ts";

export const PREPARED_MANIFEST_FILE = "manifest.json";
const PREPARED_MANIFEST_SCHEMA = 1;

const envelope = {
  schema: z.literal(PREPARED_MANIFEST_SCHEMA),
  profileId: z.string().min(1),
  /** The profile revision this directory was prepared from. */
  revision: z.string().min(1),
  /** `sessionProfileAccountKey(accountId)` or `SESSION_PROFILE_SHARED_ACCOUNT_KEY` (`@orquester/config`). */
  accountKey: z.string().min(1),
  /** ISO time the preparation finished. */
  preparedAt: z.string(),
  /**
   * The preparation lifecycle's staleness key (`lifecycle.ts`): an opaque hash of the revision,
   * the preparer's version, the agent CLI's version and the Global inputs the preparer read.
   * Optional so a manifest without it still reads (it is then simply stale).
   */
  fingerprint: z.string().optional()
};

const preparedManifestSchema = z.discriminatedUnion("agent", [
  z.object({ ...envelope, agent: z.literal("claude"), agentSection: claudePreparedSectionSchema }).passthrough(),
  z.object({ ...envelope, agent: z.literal("codex"), agentSection: codexPreparedSectionSchema }).passthrough(),
  z.object({ ...envelope, agent: z.literal("grok"), agentSection: grokPreparedSectionSchema }).passthrough(),
  z.object({ ...envelope, agent: z.literal("opencode"), agentSection: opencodePreparedSectionSchema }).passthrough()
]);
export type PreparedManifest = z.infer<typeof preparedManifestSchema>;

/** The `agentSection` type of each agent. */
export interface PreparedSections {
  claude: ClaudePreparedSection;
  codex: CodexPreparedSection;
  grok: GrokPreparedSection;
  opencode: OpenCodePreparedSection;
}
export type PreparedSectionFor<A extends SessionProfileAgentId> = PreparedSections[A];
export type PreparedManifestFor<A extends SessionProfileAgentId> = Extract<PreparedManifest, { agent: A }>;

/** Why a prepared directory cannot be launched from. The message is safe to show the user. */
export class PreparedManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedManifestError";
  }
}

/** Parses a manifest value; throws {@link PreparedManifestError}. */
export function parsePreparedManifest(value: unknown): PreparedManifest {
  const parsed = preparedManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PreparedManifestError(
      `The prepared profile's manifest does not read${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}.`
    );
  }
  return parsed.data;
}

/**
 * Reads `<preparedDir>/manifest.json` and checks it is the one the launch asked for. What the
 * agent host's adapters call at launch; throws {@link PreparedManifestError} (fail the launch).
 */
export async function readPreparedManifest<A extends SessionProfileAgentId>(
  preparedDir: string,
  expected: { profileId: string; revision: string; agent: A }
): Promise<PreparedManifestFor<A>> {
  let text: string;
  try {
    text = await readFile(join(preparedDir, PREPARED_MANIFEST_FILE), "utf8");
  } catch {
    throw new PreparedManifestError("The profile is not prepared for this agent (its manifest is missing).");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PreparedManifestError("The prepared profile's manifest is not valid JSON.");
  }
  const manifest = parsePreparedManifest(value);
  if (manifest.agent !== expected.agent) {
    throw new PreparedManifestError(`The prepared directory is for ${manifest.agent}, not ${expected.agent}.`);
  }
  if (manifest.profileId !== expected.profileId || manifest.revision !== expected.revision) {
    throw new PreparedManifestError("The prepared directory is for another version of the profile; it is being prepared again.");
  }
  return manifest as PreparedManifestFor<A>;
}

/** Writes `<dir>/manifest.json` atomically (0600). The preparation lifecycle calls it last, in the staging directory. */
export async function writePreparedManifest(dir: string, manifest: PreparedManifest): Promise<void> {
  parsePreparedManifest(manifest);
  const target = join(dir, PREPARED_MANIFEST_FILE);
  const tmp = join(dir, `.${PREPARED_MANIFEST_FILE}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
