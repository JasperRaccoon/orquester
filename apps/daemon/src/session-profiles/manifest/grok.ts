/**
 * Agent Profiles — the Grok section of a prepared directory's `manifest.json` (`../manifest.ts`):
 * what Grok's adapter in the agent host needs to launch a profile chat from the prepared
 * directory, which IS the chat's `GROK_HOME` (`../preparers/grok.ts` writes it;
 * `agent-host/adapters/grok/profile-launch.ts` reads it). Must stay statically importable from the
 * agent host: zod only, no dynamic `import()`, no daemon services.
 *
 * Paths are RELATIVE to the prepared (version) directory, plain `a/b` segments only — the adapter
 * resolves them against `HostThreadProfile.preparedDir` and refuses anything else. `configBase` is
 * required (a home without it cannot launch); the rest is defaulted; unknown keys are kept.
 *
 *   {
 *     configBase: "profile/config.base.toml",   the carried-over Global runtime config + the
 *                                                profile's `[mcp_servers]` (SECRETS, 0600); the
 *                                                adapter renders `config.toml` from it at every spawn
 *     hideBundledSkills: boolean,                 add `<GROK_HOME>/bundled/skills` to `[skills] ignore`
 *     plugins: [{ itemId, name, path }],          copies of the profile's Grok plugins (`--plugin-dir`)
 *     hooksPlugin?: { name, path },               the profile's hooks as a generated plugin (`--plugin-dir`)
 *     mcpServerNames: [...]                       the names in `configBase` (no values)
 *   }
 */

import { z } from "zod";
import { preparedRelativePath } from "./claude.ts";

const pluginRefSchema = z.object({ name: z.string().min(1), path: preparedRelativePath }).passthrough();

export const grokPreparedSectionSchema = z
  .object({
    configBase: preparedRelativePath,
    hideBundledSkills: z.boolean().default(true),
    plugins: z.array(pluginRefSchema.extend({ itemId: z.string().min(1) }).passthrough()).default([]),
    hooksPlugin: pluginRefSchema.optional(),
    mcpServerNames: z.array(z.string()).default([])
  })
  .passthrough();
export type GrokPreparedSection = z.infer<typeof grokPreparedSectionSchema>;
