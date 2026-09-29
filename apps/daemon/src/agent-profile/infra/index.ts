/**
 * Agent profile — the shared infrastructure every adapter (Claude, Codex,
 * Grok, OpenCode) builds on. Import from here, not from the modules.
 *
 * ## Ids and revisions — `hash.ts`
 * - `itemId(kind, name)` → `"mcp:jira"`; `parseItemId(id)` → `{kind, name} | null`.
 * - `hookItemId(event, {matcher?, ...handler})` → `"hook:<event>:<16 hex>"` —
 *   pass the same normalized handler shape for one agent every time.
 * - `contentHash(value)` → 16 hex of sha256 (strings/bytes hashed raw, other
 *   values via `stableStringify`, so key order never moves it). Use it for
 *   `ProfileItem.revision` (hash the item's content AND its on/off state) and
 *   the instructions revision (hash the file text).
 *
 * ## Names — `names.ts`
 * - `assertSkillName` / `assertCommandName` / `assertMcpServerName` throw 400
 *   `INVALID_NAME` with the rule spelled out (validators from `@orquester/api`
 *   are re-exported as `isValid…`).
 * - `assertSafeSegment(name)` — one path segment: no `/` `\` NUL `..`, no
 *   leading `.`, not empty.
 * - `assertInside(root, path)` — realpath containment for untrusted paths
 *   (imports); throws 400 `INVALID_REQUEST`, answers the resolved path.
 *
 * ## Writing agent files — `fs-write.ts` (the ONLY way to write them)
 * Construct once per service: `new ProfileBackups({dir: agentProfileBackupsDir(appdir)})`.
 * - `writeProfileFile(path, content, {backups, agent, defaultMode?})` →
 *   `{path: real, backup}`: writes THROUGH symlinks to the real file (never
 *   replaces a link), keeps the mode, backs up first, temp + fsync + rename.
 * - `writeProfileFileVerified(path, content, {…, verify})` — then re-reads and
 *   runs `verify(text)` (your reader's parser, throwing on bad input); on a
 *   throw the previous version is restored and 500 `WRITE_VERIFY_FAILED` thrown.
 *   Use it for every config file you serialize yourself (JSON, TOML, JSONC).
 * - `removeProfilePath(path, {backups, agent})` — backup, then delete a file or
 *   a directory tree; a symlink loses only the link.
 * - `readTextIfExists(path)` → `string | null`; `pathKind(path)` (lstat) →
 *   `"file" | "dir" | "symlink" | "other" | null`.
 * - `copyTree(src, dest, {refuseSymlinks})` → `{files, skipped}` — for imports
 *   and copies between agents: `src` may be a symlink, symlinks INSIDE are
 *   refused (400 `IMPORT_FAILED`, `dest` cleaned up) or skipped.
 * - `resolveWriteTarget(path)` — the real path a write would land on.
 *
 * ## Turning off by stash — `stash.ts` (kinds with no native "off")
 * `new ProfileStash({dir: agentProfileStashDir(appdir), logger})`:
 * - `stashPath(agent, kind, id, name, originalPath, meta?)` moves the file or
 *   directory aside; `restorePath(agent, kind, id)` moves it back (409
 *   `STASH_CONFLICT` when the path is taken again).
 * - `stashFragment(agent, kind, id, name, data, meta?)` keeps a hook entry's
 *   JSON (remove it from its settings file afterwards); `get()` then
 *   `remove()` after writing it back.
 * - `list(agent)` → entries (`payloadPath` to read a stashed file for the
 *   snapshot), tolerant of broken ones; `get()`, `remove()` (delete for good).
 * - Stashing an id twice is a 409 `PROFILE_CONFLICT`: `remove()` first to replace.
 *
 * ## Markdown items — `frontmatter.ts`, `markdown-items.ts`
 * - `parseMarkdownDocument(text)` → `{frontmatter, body, hadFrontmatter}`
 *   (throws on bad YAML); `serializeMarkdownDocument(frontmatter, body)`;
 *   `mergeFrontmatter(existing, draft)` — draft overrides, `null` removes,
 *   unmentioned keys survive.
 * - `scanSkills(root, {source?, includeHidden?})`, `scanCommands(root, {nested})`
 *   — tolerant listings (`error` per entry, missing root → `[]`);
 *   `readSkillFiles(dir)` — the skill's other files (≤ 500).
 * - `writeSkill(root, draft, {backups, agent, mergeExisting?})` and
 *   `writeCommand(…)` — validated names, frontmatter merged into the file on
 *   disk, written verified. A skill's frontmatter `name` is forced to its
 *   directory name.
 *
 * ## Agent CLIs — `cli-runner.ts`
 * - `runAgentCli({bin, args, timeoutMs, cwd?, input?, env?})` →
 *   `{code, signal, stdout, stderr, timedOut}`: argv only, explicit env (no
 *   agent-home overrides, no `ORQUESTER_*`, session PATH), SIGTERM then SIGKILL
 *   on the deadline, 4 MiB per stream.
 * - `runAgentCliOrThrow({…, label?, redact?})` — non-zero, deadline or start
 *   failure → 502 `AGENT_CLI_FAILED` with redacted, capped stderr.
 * - `redactCliOutput(text)` — before any CLI output reaches a client or a log.
 */

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
