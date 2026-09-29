/** Shared infrastructure for native agent configuration files. */

export {
  PROFILE_BACKUPS_KEEP,
  ProfileBackups,
  type ProfileBackupsOptions
} from "./backups.ts";
export {
  CLI_ERROR_DETAIL_MAX,
  CLI_KILL_GRACE_MS,
  CLI_OUTPUT_MAX_BYTES,
  type AgentCliResult,
  type AgentCliRun,
  type RedactCliOutputOptions,
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
  type ProfileWriteOptions,
  type ProfileWriteResult,
  type VerifiedWriteOptions,
  readTextIfExists,
  removeProfilePath,
  resolveWriteTarget,
  writeProfileFile,
  writeProfileFileVerified
} from "./fs-write.ts";
export {
  type HookIdentity,
  contentHash,
  hookItemId,
  itemId,
  parseItemId,
  stableStringify
} from "./hash.ts";
export {
  SKILL_FILE,
  type MarkdownWriteOptions,
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
  isValidSkillName
} from "./names.ts";
export {
  type ProfileStashOptions,
  type StashEntry,
  type StashManifest,
  type StashOriginal,
  ProfileStash
} from "./stash.ts";
export { type CopyResult, type PathKind, copyTree, pathKind } from "./tree.ts";
export { SecretDigester } from "./secret-digest.ts";
