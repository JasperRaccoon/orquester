/**
 * Agent profile — importing skills and commands from a Git URL or an upload
 * (spec §6). A scan fetches the source into its own directory under
 * `agentProfileImportsDir(appdir)` (`<dir>/<importId>/`), lists what it found,
 * and keeps the tree until the owner's picks are taken — or until it expires
 * ({@link IMPORT_TTL_MS}, swept lazily on every call).
 *
 * - **Git** — see `import/git-url.ts` for the URLs accepted and refused, and
 *   `import/git-clone.ts` for the clone itself (argv only, 60 s, no prompts).
 *   The checkout's `.git` is deleted and the rest capped at 50 MB.
 * - **Upload** — a `.zip` is extracted (`import/zip.ts`: no absolute paths,
 *   `..`, symlinks; ≤ 5 000 entries, ≤ 100 MB); a `.md` file is one skill
 *   (`SKILL.md`) or one command (any other name).
 * - **Scan** — `import/scan.ts`; symlinks are never followed and a candidate
 *   holding one is skipped with a note.
 *
 * ## Candidates are what the TARGET agent will get
 * A candidate's `kind` and `name` are the item that will be created, so
 * `exists` is checked against the right thing:
 * - **Codex** has no custom commands (`AGENT_PROFILE_CREATABLE_KINDS`): each
 *   command found is offered as a **skill** named after it (`git/pr` →
 *   `git-pr`) and converted when taken (frontmatter `{name, description}`,
 *   the command's body), with a note on the scan;
 * - **Grok**'s commands are flat: `git/pr` is offered as `git-pr`.
 *
 * ## `take` answers items converted for the agent
 * Frontmatter is mapped to the agent's fields as a copy would be
 * (`mapFrontmatter` in `convert.ts`; dropped keys become notes). A skill
 * item's `dir` lies INSIDE the import directory (its `SKILL.md` rewritten in
 * place when the mapping changed it): the caller must not delete or move it,
 * only copy from it, and then call `release()`, which removes the whole
 * import. An import is single-use: once taken it cannot be taken again, and
 * `release()` (idempotent) ends it. The sweep leaves a taken import alone for
 * one more TTL, then removes it anyway.
 */

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentProfileAgentId, ProfileImportCandidate, ProfileImportScanResponse } from "@orquester/api";
import type { PortableItem } from "./adapters/types.ts";
import { CODEX_COMMAND_NOTE, commandNameFor, commandSkillName, commandToSkillDocument, droppedKeysNote, mapFrontmatter } from "./convert.ts";
import { isAgentProfileError, profileErrors } from "./errors.ts";
import { type GitCloneFn, gitClone } from "./import/git-clone.ts";
import { parseGitImportUrl } from "./import/git-url.ts";
import { type ScannedImportCandidate, scanImportTree, toSkillName } from "./import/scan.ts";
import { extractZip } from "./import/zip.ts";
import { SKILL_FILE, assertInside, parseMarkdownDocument, redactCliOutput, serializeMarkdownDocument } from "./infra/index.ts";

export type { GitCloneFn } from "./import/git-clone.ts";
export { gitClone, gitCloneArgs } from "./import/git-clone.ts";
export { type GitImportSource, parseGitImportUrl } from "./import/git-url.ts";

/** How long a scan's tree waits for its picks. */
export const IMPORT_TTL_MS = 15 * 60_000;

export interface ProfileImportLimits {
  /** Deadline of a `git clone`. */
  cloneTimeoutMs: number;
  /** Largest checkout (sum of file sizes, `.git` excluded). */
  maxCloneBytes: number;
  /** Most entries a zip may hold. */
  maxZipEntries: number;
  /** Most bytes a zip may inflate to. */
  maxZipBytes: number;
  /** Largest `.md` upload. */
  maxMarkdownBytes: number;
  /** Most imports open at once (each holds a tree on disk). */
  maxOpenImports: number;
}

export const DEFAULT_IMPORT_LIMITS: ProfileImportLimits = {
  cloneTimeoutMs: 60_000,
  maxCloneBytes: 50 * 1024 * 1024,
  maxZipEntries: 5000,
  maxZipBytes: 100 * 1024 * 1024,
  maxMarkdownBytes: 1024 * 1024,
  maxOpenImports: 16
};

/** Most entries a checkout may hold while its size is summed. */
const MAX_CHECKOUT_ENTRIES = 100_000;

/** A taken import: its items, notes on what the conversion changed, and `release()`. */
export interface ProfileImportTake {
  items: PortableItem[];
  notes: string[];
  /** Removes the import's directory; idempotent. */
  release(): Promise<void>;
}

/** The seam the service calls (spec §6). */
export interface ProfileImports {
  scanGit(agent: AgentProfileAgentId, url: string): Promise<ProfileImportScanResponse>;
  /** `filePath` is a temp file the route owns and deletes after this resolves: its content is copied/extracted here. */
  scanUpload(agent: AgentProfileAgentId, name: string, filePath: string): Promise<ProfileImportScanResponse>;
  take(agent: AgentProfileAgentId, importId: string, picks: string[]): Promise<ProfileImportTake>;
}

export interface ProfileImportStoreOptions {
  /** `agentProfileImportsDir(appdir)` — owned by the store: `stop()` removes it. */
  dir: string;
  /** `"<kind>:<name>"` of every item `agent` already has (the candidates' `exists`). */
  existing: (agent: AgentProfileAgentId) => Promise<Set<string>>;
  /** Defaults to {@link gitClone} (`https`/`ssh` only). */
  clone?: GitCloneFn;
  now?: () => Date;
  ttlMs?: number;
  limits?: Partial<ProfileImportLimits>;
  logger: { info(message: string): void; warn(message: string): void };
}

interface StoredCandidate {
  /** What the agent will get. */
  kind: "skill" | "command";
  name: string;
  description?: string;
  /** What was found. */
  found: ScannedImportCandidate;
}

interface ImportRecord {
  id: string;
  agent: AgentProfileAgentId;
  root: string;
  candidates: Map<string, StoredCandidate>;
  expiresAt: number;
  takenAt?: number;
  released?: Promise<void>;
}

export class ProfileImportStore implements ProfileImports {
  private readonly dir: string;
  private readonly existing: ProfileImportStoreOptions["existing"];
  private readonly clone: GitCloneFn;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly limits: ProfileImportLimits;
  private readonly logger: ProfileImportStoreOptions["logger"];
  private readonly imports = new Map<string, ImportRecord>();
  /** Scans still fetching: their directories are not orphans. */
  private readonly pending = new Set<string>();
  private stopped = false;

  constructor(options: ProfileImportStoreOptions) {
    this.dir = options.dir;
    this.existing = options.existing;
    this.clone = options.clone ?? ((url, ref, dest, o) => gitClone(url, ref, dest, o));
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? IMPORT_TTL_MS;
    this.limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
    this.logger = options.logger;
  }

  async scanGit(agent: AgentProfileAgentId, url: string): Promise<ProfileImportScanResponse> {
    await this.sweep();
    const source = parseGitImportUrl(url);
    return this.openImport(agent, "git", async (root) => {
      const tree = join(root, "tree");
      try {
        await this.clone(source.cloneUrl, source.ref, tree, { timeoutMs: this.limits.cloneTimeoutMs });
      } catch (error) {
        if (isAgentProfileError(error)) throw error;
        throw profileErrors.importFailed(`Could not clone ${source.cloneUrl}: ${redactCliOutput((error as Error).message)}`);
      }
      if ((await lstatOrNull(tree))?.isDirectory() !== true) {
        throw profileErrors.importFailed(`Cloning ${source.cloneUrl} produced no checkout.`);
      }
      await rm(join(tree, ".git"), { recursive: true, force: true });
      await this.assertCheckoutSize(tree);
      const scanRoot = await this.subFolder(tree, source.subPath);
      return scanImportTree(scanRoot, source.subPath !== undefined ? basename(source.subPath) : source.repoName);
    });
  }

  async scanUpload(agent: AgentProfileAgentId, name: string, filePath: string): Promise<ProfileImportScanResponse> {
    await this.sweep();
    const fileName = basename(String(name).replaceAll("\\", "/"));
    if (fileName.length === 0 || fileName.includes("\0")) {
      throw profileErrors.importFailed("The upload has no usable file name.");
    }
    const extension = extname(fileName).toLowerCase();
    const stem = fileName.slice(0, fileName.length - extension.length);
    if (extension === ".zip") {
      return this.openImport(agent, "upload", async (root) => {
        const tree = join(root, "tree");
        await mkdir(tree, { mode: 0o700 });
        await extractZip(filePath, tree, { maxEntries: this.limits.maxZipEntries, maxBytes: this.limits.maxZipBytes });
        return scanImportTree(tree, stem);
      });
    }
    if (extension === ".md") {
      return this.openImport(agent, "upload", async (root) => {
        const st = await lstat(filePath);
        if (st.size > this.limits.maxMarkdownBytes) {
          throw profileErrors.importFailed(`The file is larger than ${this.limits.maxMarkdownBytes} bytes.`);
        }
        const text = await readFile(filePath, "utf8");
        try {
          parseMarkdownDocument(text);
        } catch (error) {
          throw profileErrors.importFailed(`${fileName} could not be read: ${(error as Error).message}`);
        }
        const tree = join(root, "tree");
        if (fileName.toLowerCase() === SKILL_FILE.toLowerCase()) {
          // The scan names it from its frontmatter, else from this folder: `skill`.
          await mkdir(join(tree, "skill"), { recursive: true, mode: 0o700 });
          await writeFile(join(tree, "skill", SKILL_FILE), text, { mode: 0o644 });
        } else {
          const command = toSkillName(stem);
          if (command === null) {
            throw profileErrors.importFailed(`"${fileName}" cannot be made into a command name.`);
          }
          await mkdir(join(tree, "commands"), { recursive: true, mode: 0o700 });
          await writeFile(join(tree, "commands", `${command}.md`), text, { mode: 0o644 });
        }
        return scanImportTree(tree, stem);
      });
    }
    throw profileErrors.importFailed("Upload a .zip archive or a .md file.");
  }

  async take(agent: AgentProfileAgentId, importId: string, picks: string[]): Promise<ProfileImportTake> {
    await this.sweep();
    const record = this.imports.get(importId);
    if (record === undefined || record.agent !== agent || record.takenAt !== undefined) {
      throw profileErrors.importNotFound(importId);
    }
    if (!Array.isArray(picks) || picks.length === 0) {
      throw profileErrors.invalid("Pick at least one item to import.");
    }
    const chosen: StoredCandidate[] = [];
    for (const ref of new Set(picks)) {
      const candidate = typeof ref === "string" ? record.candidates.get(ref) : undefined;
      if (candidate === undefined) {
        throw profileErrors.invalid(`The import has no item "${String(ref)}".`);
      }
      chosen.push(candidate);
    }
    record.takenAt = this.now().getTime();
    const release = (): Promise<void> => this.release(record);
    try {
      const items: PortableItem[] = [];
      const notes: string[] = [];
      for (const candidate of chosen) {
        const built = await this.buildItem(record, agent, candidate);
        items.push(built.item);
        notes.push(...built.notes.map((note) => `${candidate.name}: ${note}`));
      }
      return { items, notes, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Removes every import, the directory with them; later calls are refused. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.imports.clear();
    await rm(this.dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn(`agent-profile imports: could not remove ${this.dir}: ${(error as Error).message}`);
    });
  }

  // -------------------------------------------------------------------------

  private async openImport(
    agent: AgentProfileAgentId,
    source: "git" | "upload",
    fetch: (root: string) => Promise<{ candidates: ScannedImportCandidate[]; notes: string[] }>
  ): Promise<ProfileImportScanResponse> {
    if (this.stopped) {
      throw profileErrors.importFailed("Imports are not available while the daemon stops.");
    }
    if (this.imports.size + this.pending.size >= this.limits.maxOpenImports) {
      throw profileErrors.importFailed("Too many imports are open. Finish one, or wait a few minutes and try again.");
    }
    const id = randomUUID();
    const root = join(this.dir, id);
    this.pending.add(id);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const scan = await fetch(root);
      const existing = await this.existing(agent);
      const notes = [...scan.notes];
      const candidates = new Map<string, StoredCandidate>();
      let codexCommands = 0;
      for (const found of scan.candidates) {
        let kind = found.kind;
        let name = found.name;
        if (found.kind === "command" && agent === "codex") {
          kind = "skill";
          name = commandSkillName(found.name);
          codexCommands += 1;
        } else if (found.kind === "command") {
          name = commandNameFor(found.name, agent);
        }
        candidates.set(found.ref, { kind, name, description: found.description, found });
      }
      if (codexCommands > 0) {
        notes.push(`Codex has no custom commands: ${codexCommands === 1 ? "1 command is" : `${codexCommands} commands are`} offered as skills.`);
      }
      if (candidates.size === 0) {
        const why = notes.length > 0 ? ` ${notes.slice(0, 3).join(" ")}` : "";
        throw profileErrors.importFailed(`No skills or commands found.${why}`);
      }
      if (this.stopped) {
        throw profileErrors.importFailed("Imports are not available while the daemon stops.");
      }
      this.imports.set(id, { id, agent, root, candidates, expiresAt: this.now().getTime() + this.ttlMs });
      this.logger.info(`agent-profile import ${id} (${agent}, ${source}): ${candidates.size} candidate(s)`);
      const wire: ProfileImportCandidate[] = [...candidates.entries()].map(([ref, candidate]) => ({
        ref,
        kind: candidate.kind,
        name: candidate.name,
        ...(candidate.description !== undefined ? { description: candidate.description } : {}),
        exists: existing.has(`${candidate.kind}:${candidate.name}`)
      }));
      return { importId: id, candidates: wire, notes };
    } catch (error) {
      await this.remove(root);
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }

  private async buildItem(
    record: ImportRecord,
    agent: AgentProfileAgentId,
    candidate: StoredCandidate
  ): Promise<{ item: PortableItem; notes: string[] }> {
    const path = await assertInside(record.root, candidate.found.path);
    if (candidate.found.kind === "skill") {
      const file = join(path, SKILL_FILE);
      const document = parseMarkdownDocument(await readFile(file, "utf8"));
      const mapped = mapFrontmatter(document.frontmatter, "skill", agent);
      const frontmatter = Object.hasOwn(mapped.frontmatter, "name")
        ? { ...mapped.frontmatter, name: candidate.name }
        : { name: candidate.name, ...mapped.frontmatter };
      await writeFile(file, serializeMarkdownDocument(frontmatter, document.body));
      return { item: { kind: "skill", name: candidate.name, dir: path }, notes: droppedKeysNote(mapped.dropped, agent) };
    }
    const document = parseMarkdownDocument(await readFile(path, "utf8"));
    if (candidate.kind === "skill") {
      const skill = commandToSkillDocument(candidate.found.name, document.frontmatter);
      await mkdir(join(record.root, "converted"), { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(record.root, "converted", `${skill.skillName}-`));
      await writeFile(join(dir, SKILL_FILE), serializeMarkdownDocument(skill.frontmatter, document.body), { mode: 0o644 });
      return {
        item: { kind: "skill", name: skill.skillName, dir },
        notes: [CODEX_COMMAND_NOTE, ...droppedKeysNote(skill.dropped, agent)]
      };
    }
    const mapped = mapFrontmatter(document.frontmatter, "command", agent);
    return {
      item: { kind: "command", name: candidate.name, frontmatter: mapped.frontmatter, body: document.body },
      notes: droppedKeysNote(mapped.dropped, agent)
    };
  }

  private release(record: ImportRecord): Promise<void> {
    if (record.released === undefined) {
      if (this.imports.get(record.id) === record) {
        this.imports.delete(record.id);
      }
      record.released = this.remove(record.root);
    }
    return record.released;
  }

  private async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn(`agent-profile imports: could not remove ${path}: ${(error as Error).message}`);
    });
  }

  /**
   * Removes expired imports (a taken one gets one more TTL), and any
   * directory under `dir` the store does not know — an import or a converter
   * copy (`convert-*`) a previous run leaked — once it is older than the TTL.
   */
  private async sweep(): Promise<void> {
    const now = this.now().getTime();
    for (const record of [...this.imports.values()]) {
      const deadline = record.takenAt !== undefined ? record.takenAt + this.ttlMs : record.expiresAt;
      if (deadline <= now) {
        await this.release(record);
      }
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (this.imports.has(name) || this.pending.has(name)) continue;
      const st = await lstatOrNull(join(this.dir, name));
      if (st !== null && st.mtimeMs + this.ttlMs <= now) {
        await this.remove(join(this.dir, name));
      }
    }
  }

  private async assertCheckoutSize(tree: string): Promise<void> {
    let total = 0;
    let entries = 0;
    const stack = [tree];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        entries += 1;
        if (entries > MAX_CHECKOUT_ENTRIES) {
          throw profileErrors.importFailed(`The repository holds more than ${MAX_CHECKOUT_ENTRIES} files.`);
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
        } else if (entry.isFile()) {
          total += (await lstat(path)).size;
          if (total > this.limits.maxCloneBytes) {
            throw profileErrors.importFailed(`The repository is larger than ${Math.round(this.limits.maxCloneBytes / 1024 / 1024)} MB.`);
          }
        }
      }
    }
  }

  /** `tree/<subPath>`, refusing a missing folder or one reached through a symlink. */
  private async subFolder(tree: string, subPath: string | undefined): Promise<string> {
    if (subPath === undefined) return tree;
    let current = tree;
    for (const segment of subPath.split("/")) {
      current = join(current, segment);
      const st = await lstatOrNull(current);
      if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
        throw profileErrors.importFailed(
          st?.isSymbolicLink() ? `"${subPath}" goes through a symlink.` : `The repository has no folder "${subPath}".`
        );
      }
    }
    return assertInside(tree, current);
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}
