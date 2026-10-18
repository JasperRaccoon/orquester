/**
 * Agent Profiles — the Codex section of a prepared directory's `manifest.json`
 * (`../manifest.ts`): what the Codex preparer (`../preparers/codex.ts`) built in the prepared
 * `CODEX_HOME`, and what Codex's adapter in the agent host needs at every thread start/resume.
 * Must stay statically importable from the agent host: zod only, no dynamic `import()`, no daemon
 * services.
 *
 * Every field is optional and unknown keys are kept, so an older or newer preparer's section still
 * reads (an older one is stale anyway: the preparer `version` is in the fingerprint).
 */

import { z } from "zod";

export const codexPreparedSectionSchema = z
  .object({
    /** The state DB file the home was seeded with (`CODEX_STATE_DB_FILE` at preparation). */
    stateDbFile: z.string().optional(),
    /** `[skills.bundled] enabled = false` is in the home's `config.toml`. */
    hideBuiltinSkills: z.boolean().optional(),
    /** The skill directories in `<CODEX_HOME>/skills` (profile skills and commands-as-skills). */
    skills: z.array(z.string()).optional(),
    /** The profile's `[mcp_servers.<name>]` names. */
    mcpServers: z.array(z.string()).optional(),
    /** Enabled plugin ids (`<name>@<marketplace>`), copied into `<CODEX_HOME>/plugins/cache`. */
    plugins: z.array(z.string()).optional(),
    /** How many profile hooks `hooks.json` holds besides Orquester's managed ones. */
    hooks: z.number().int().nonnegative().optional(),
    /**
     * Directories Codex reads user skills from outside `CODEX_HOME` (`$HOME/.agents/skills`,
     * `$HOME/.agents/plugins`): the adapter switches every skill under them off per thread
     * (`skills.config`, spec §6.2), together with the ones under the child's own `$HOME`.
     */
    userSkillRoots: z.array(z.string()).optional()
  })
  .passthrough();
export type CodexPreparedSection = z.infer<typeof codexPreparedSectionSchema>;
