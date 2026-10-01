/** Shared infrastructure for native agent configuration files. */

export { ProfileBackups } from "./backups.ts";
export {
  type AgentCliResult,
  buildAgentCliEnv,
  redactCliOutput,
  runAgentCli,
  runAgentCliOrThrow
} from "./cli-runner.ts";
export {
  type FrontmatterYamlOptions,
  type MarkdownDocument,
  mergeFrontmatter,
  parseMarkdownDocument,
  serializeMarkdownDocument
} from "./frontmatter.ts";
export {
  type ProfileWriteResult,
  readTextIfExists,
  removeProfilePath,
  resolveWriteTarget,
  writeProfileFile,
  writeProfileFileVerified
} from "./fs-write.ts";
export {
  contentHash,
  hookItemId,
  itemId,
  parseItemId,
  stableStringify
} from "./hash.ts";
export {
  SKILL_FILE,
  type ScannedCommand,
  type ScannedSkill,
  readSkillFiles,
  scanCommands,
  scanSkills,
  writeCommand,
  writeSkill
} from "./markdown-items.ts";
export {
  assertCommandName,
  assertInside,
  assertMcpServerName,
  assertSafeSegment,
  assertSkillName,
  isValidCommandName,
  isValidMcpServerName,
  isValidSkillName,
  uniqueName,
  uniqueNameAsync
} from "./names.ts";
export { type StashEntry, ProfileStash } from "./stash.ts";
export { copyTree, pathKind } from "./tree.ts";
export { SecretDigester } from "./secret-digest.ts";
