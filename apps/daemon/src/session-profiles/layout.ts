/**
 * Agent Profiles — the file layout inside one profile's source directory
 * (`sessionProfileDir(appdir, profileId)`, `@orquester/config`). Only `store.ts` writes here;
 * preparers read through {@link profileLayout} (via the paths `resolve.ts` hands them).
 *
 *   profile.json              manifest (`@orquester/config` `session-profiles.ts`), 0600
 *   secrets.json              MCP env/header values by item id, 0600
 *   instructions.md           the profile's instructions (absent = none)
 *   skills/<itemId>/SKILL.md  a skill (+ its other files); the directory is the item ID, not its name
 *   commands/<itemId>.md      a command
 *   plugins/<itemId>/         a plugin's files: the per-profile plugin cache slot (spec §4.5)
 *
 * Every directory is 0700 and every file 0600: the manifest can hold an MCP server's args.
 */

import { join } from "node:path";

export const PROFILE_MANIFEST_FILE = "profile.json";
export const PROFILE_SECRETS_FILE = "secrets.json";
export const PROFILE_INSTRUCTIONS_FILE = "instructions.md";
export const PROFILE_SKILL_FILE = "SKILL.md";

export const PROFILE_DIR_MODE = 0o700;
export const PROFILE_FILE_MODE = 0o600;

export interface ProfileLayout {
  dir: string;
  manifest: string;
  secrets: string;
  instructions: string;
  skillsDir: string;
  skillDir(itemId: string): string;
  skillFile(itemId: string): string;
  commandsDir: string;
  commandFile(itemId: string): string;
  pluginsDir: string;
  pluginCacheDir(itemId: string): string;
}

export function profileLayout(dir: string): ProfileLayout {
  const skillsDir = join(dir, "skills");
  const commandsDir = join(dir, "commands");
  const pluginsDir = join(dir, "plugins");
  return {
    dir,
    manifest: join(dir, PROFILE_MANIFEST_FILE),
    secrets: join(dir, PROFILE_SECRETS_FILE),
    instructions: join(dir, PROFILE_INSTRUCTIONS_FILE),
    skillsDir,
    skillDir: (itemId) => join(skillsDir, itemId),
    skillFile: (itemId) => join(skillsDir, itemId, PROFILE_SKILL_FILE),
    commandsDir,
    commandFile: (itemId) => join(commandsDir, `${itemId}.md`),
    pluginsDir,
    pluginCacheDir: (itemId) => join(pluginsDir, itemId)
  };
}
