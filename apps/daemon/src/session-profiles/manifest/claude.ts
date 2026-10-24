/**
 * Agent Profiles — the Claude section of a prepared directory's `manifest.json`
 * (`../manifest.ts`): what Claude's adapter in the agent host needs to launch a profile chat from
 * the prepared directory (`../preparers/claude.ts` writes it; `agent-host/adapters/claude/
 * profile-launch.ts` reads it). Must stay statically importable from the agent host: zod only, no
 * dynamic `import()`, no daemon services.
 *
 * Paths are RELATIVE to the prepared (version) directory, plain `a/b` segments only — the adapter
 * resolves them against `HostThreadProfile.preparedDir` and refuses anything else. Every field is
 * optional or defaulted so an older/emptier section still reads; unknown keys are kept.
 *
 *   {
 *     localPlugin?: { path: "plugin", name: "dev" },          the generated plugin (skills + commands)
 *     plugins: [{ itemId, name, path: "plugins/<itemId>" }],  copies of the profile's Claude plugins
 *     mcpConfig?: "mcp-servers.json",                          `{ mcpServers }` (SECRETS, 0600)
 *     mcpServerNames: [...],                                   the names inside it (no values)
 *     hooks: { <event>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] },
 *     instructionsFile?: "instructions.md",
 *     skills?: [...],                                          the SDK `skills` allow-list; absent = omit the option
 *     disableWorkflows: boolean                                the profile turned the Workflow tool off
 *     disableBuiltinTools?: true                               no built-in tool at all (managed profiles)
 *   }
 */

import { z } from "zod";

/** A relative path inside the prepared dir: `a/b`, no `..`, no `.`, no leading `/`, no backslash. */
export const preparedRelativePath = z
  .string()
  .min(1)
  .refine(
    (value) => !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "must be a relative path inside the prepared directory"
  );

const hookHandlerSchema = z
  .object({ type: z.literal("command"), command: z.string(), timeout: z.number().optional() })
  .passthrough();
const hookMatcherSchema = z.object({ matcher: z.string().optional(), hooks: z.array(hookHandlerSchema) }).passthrough();

export const claudePreparedSectionSchema = z
  .object({
    localPlugin: z.object({ path: preparedRelativePath, name: z.string().min(1) }).passthrough().optional(),
    plugins: z
      .array(z.object({ itemId: z.string().min(1), name: z.string().min(1), path: preparedRelativePath }).passthrough())
      .default([]),
    mcpConfig: preparedRelativePath.optional(),
    mcpServerNames: z.array(z.string()).default([]),
    hooks: z.record(z.array(hookMatcherSchema)).default({}),
    instructionsFile: preparedRelativePath.optional(),
    skills: z.array(z.string()).optional(),
    disableWorkflows: z.boolean().default(false),
    disableBuiltinTools: z.boolean().optional()
  })
  .passthrough();
export type ClaudePreparedSection = z.infer<typeof claudePreparedSectionSchema>;
/** One `settings.hooks` value: Claude's own hook format. */
export type ClaudePreparedHooks = ClaudePreparedSection["hooks"];
