/**
 * Agent Profiles — the OpenCode section of a prepared directory's `manifest.json`
 * (`../manifest.ts`): what OpenCode's launch contribution (`../preparers/opencode.ts`,
 * `opencodeLaunchContribution`) needs to start a profile chat's keyed `opencode serve` from the
 * prepared directory. Must stay statically importable from the agent host: zod only, no dynamic
 * `import()`, no daemon services.
 *
 * Paths are RELATIVE to the prepared (version) directory, plain `a/b` segments only, except
 * `realConfigHome` (absolute: the daemon user's real `~/.config`, as resolved at preparation).
 * Unknown keys are kept so a newer preparer's section still reads.
 *
 *   {
 *     configDir: "opencode",          OPENCODE_CONFIG_DIR: opencode.json (SECRETS, 0600), AGENTS.md,
 *                                     skills/, commands/, plugin/ — OpenCode writes its own
 *                                     package.json / node_modules / .gitignore in here
 *     xdgConfigHome: "xdg",           XDG_CONFIG_HOME: the shadow of the real ~/.config without `opencode`
 *     realConfigHome: "/home/u/.config",
 *     skills: [...], commands: [...], mcpServerNames: [...],   names only (no values)
 *     plugins: [{ itemId, name, files: ["notify.js"] }],        the files copied into plugin/
 *     hiddenSkills: ["customize-opencode"],                      denied by `permission.skill`
 *     userHome: "/home/u",            the HOME whose `.opencode` OpenCode reads unless overridden
 *     testHome: { dir: "home", verified: true }                  OPENCODE_TEST_HOME (an empty dir);
 *                                     `verified` = the CLI was probed to honour it (else `reason`)
 *   }
 */

import { z } from "zod";
import { preparedRelativePath } from "./claude.ts";

export const opencodePreparedSectionSchema = z
  .object({
    configDir: preparedRelativePath,
    xdgConfigHome: preparedRelativePath,
    realConfigHome: z.string().min(1).refine((value) => value.startsWith("/"), "must be an absolute path"),
    skills: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    mcpServerNames: z.array(z.string()).default([]),
    plugins: z
      .array(z.object({ itemId: z.string().min(1), name: z.string(), files: z.array(z.string()) }).passthrough())
      .default([]),
    hiddenSkills: z.array(z.string()).default([]),
    /** The daemon user's HOME at preparation: the launch re-checks its `.opencode` (absent in older sections). */
    userHome: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/"), "must be an absolute path")
      .optional(),
    /** `OPENCODE_TEST_HOME`'s empty dir, and whether the CLI was proven to honour it (absent in older sections). */
    testHome: z.object({ dir: preparedRelativePath, verified: z.boolean(), reason: z.string().optional() }).passthrough().optional()
  })
  .passthrough();
export type OpenCodePreparedSection = z.infer<typeof opencodePreparedSectionSchema>;
