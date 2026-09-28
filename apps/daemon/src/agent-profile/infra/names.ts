/**
 * Agent profile — name and path guards (spec §4.5). Every name that becomes a
 * file or directory name passes one of these before anything is written; a
 * refusal is a 400 the panel shows as it is.
 */

import { FsSandboxError, assertInsideFsRoot } from "@orquester/config/fs";
import {
  PROFILE_MCP_NAME_MAX,
  PROFILE_SKILL_NAME_MAX,
  isValidCommandName,
  isValidMcpServerName,
  isValidSkillName
} from "@orquester/api";
import { profileErrors } from "../errors.ts";

export { isValidCommandName, isValidMcpServerName, isValidSkillName };

/** Throws `INVALID_NAME` unless `name` is a valid skill name (lowercase words joined by `-`, ≤ 64). */
export function assertSkillName(name: string): void {
  if (!isValidSkillName(name)) {
    throw profileErrors.invalidName(
      `"${name}" is not a valid skill name: use lowercase letters, digits and single hyphens, at most ${PROFILE_SKILL_NAME_MAX} characters.`
    );
  }
}

/** Throws `INVALID_NAME` unless `name` is a valid command path (`review` or `git/pr`). */
export function assertCommandName(name: string): void {
  if (!isValidCommandName(name)) {
    throw profileErrors.invalidName(
      `"${name}" is not a valid command name: use lowercase letters, digits and single hyphens, with at most one "/" folder level.`
    );
  }
}

/** Throws `INVALID_NAME` unless `name` is a valid MCP server name (Grok's rule, the strictest). */
export function assertMcpServerName(name: string): void {
  if (!isValidMcpServerName(name)) {
    throw profileErrors.invalidName(
      `"${name}" is not a valid MCP server name: start with a letter or "_", then letters, digits, "_" or "-", not ending in "_", at most ${PROFILE_MCP_NAME_MAX} characters.`
    );
  }
}

/**
 * Throws `INVALID_NAME` unless `name` is safe as ONE path segment: not empty,
 * no `/`, `\`, NUL or `..`, and no leading `.` (which would also hide it from
 * every scan). The last line of defence for any name that is joined onto a path.
 */
export function assertSafeSegment(name: string): void {
  let problem: string | null = null;
  if (name.length === 0) {
    problem = "it is empty";
  } else if (name.includes("/") || name.includes("\\")) {
    problem = "it contains a path separator";
  } else if (name.includes("\0")) {
    problem = "it contains a NUL byte";
  } else if (name.includes("..")) {
    problem = 'it contains ".."';
  } else if (name.startsWith(".")) {
    problem = 'it starts with "."';
  }
  if (problem !== null) {
    throw profileErrors.invalidName(`"${name.replaceAll("\0", "\\0")}" cannot be used as a file name: ${problem}.`);
  }
}

/**
 * Resolves `candidatePath` through every symlink (the deepest existing
 * ancestor for a path that does not exist yet) and throws `INVALID_REQUEST`
 * unless it lands inside `root`'s realpath. Answers the resolved path.
 *
 * For paths that come from outside (an import tree, an upload, a scan ref).
 * Do not use it on a skill directory the host symlinks elsewhere on purpose —
 * a name-derived path is guarded by {@link assertSafeSegment} instead.
 */
export async function assertInside(root: string, candidatePath: string): Promise<string> {
  try {
    return await assertInsideFsRoot(root, candidatePath);
  } catch (error) {
    if (error instanceof FsSandboxError) {
      throw profileErrors.invalid(`${candidatePath} is outside ${root}.`);
    }
    throw error;
  }
}
