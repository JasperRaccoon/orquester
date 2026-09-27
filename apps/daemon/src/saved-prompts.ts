import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type CreateSavedPromptRequest,
  type SavedPrompt,
  type SavedPromptDeletedPayload,
  type SavedPromptEventType,
  type UpdateSavedPromptRequest,
  SAVED_PROMPT_BODY_MAX,
  SAVED_PROMPT_DESCRIPTION_MAX,
  SAVED_PROMPT_TAG_MAX,
  SAVED_PROMPT_TAGS_MAX,
  SAVED_PROMPT_TITLE_MAX,
  SAVED_PROMPTS_CHANNEL,
  SAVED_PROMPTS_MAX
} from "@orquester/api";
import { type SavedPromptsFile, parseSavedPromptsConfig } from "@orquester/config";
import { assertInsideFsRoot } from "@orquester/config/fs";
import { writeFileAtomic } from "./agent-hooks.ts";
import type { Broadcaster } from "./broadcaster.ts";
import { describeProjectPath } from "./recent-projects.ts";

/**
 * The prompts a first run starts with, in this order. Seeded exactly once —
 * when `saved-prompts.json` does not exist yet — and never again: the file
 * existing is the marker, so starters the user deleted stay deleted. Bodies
 * are stored verbatim; "Plan before coding" ends in `Task: ` on purpose, for
 * the user to type the task after inserting it.
 */
export const STARTER_PROMPTS: ReadonlyArray<
  Readonly<Pick<SavedPrompt, "title" | "description" | "body" | "pinned">> & { tags: readonly string[] }
> = [
  {
    title: "Review current changes",
    description:
      "Review the current diff for bugs, regressions, and missing tests. Prioritize findings by severity.",
    tags: ["Review"],
    pinned: true,
    body:
      "Review the current uncommitted changes on {branch} for bugs, regressions, and missing tests. " +
      "Prioritize the findings by severity and cite the file and line for each one.\n\n{diff}"
  },
  {
    title: "Plan before coding",
    description: "Explore the codebase and propose a plan",
    tags: ["Plan"],
    pinned: false,
    body:
      "Before writing any code, explore the relevant parts of {project} and propose a step-by-step " +
      "implementation plan: the files you expect to change, the approach, the risks, and any open " +
      "questions. Wait for my go-ahead before implementing.\n\nTask: "
  },
  {
    title: "Fix failing tests",
    description: "Find the root cause and verify the fix",
    tags: ["Debug"],
    pinned: false,
    body:
      "Run the test suite for {project}, find the root cause of each failing test, and fix it. " +
      "Re-run the tests to verify the fix. Don't weaken, skip or delete tests to make them pass."
  },
  {
    title: "Create a handoff",
    description: "Summarize decisions, changes, and next steps",
    tags: ["Docs"],
    pinned: false,
    body:
      "Write a handoff note for this session ({date}, branch {branch}): the goal, the decisions made " +
      "and why, what changed (files and behaviour), what is verified and how, and the open next steps."
  }
];

export type SavedPromptErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PROJECT_PATH"
  | "SAVED_PROMPT_NOT_FOUND"
  | "SAVED_PROMPTS_FULL"
  | "SAVED_PROMPTS_UNAVAILABLE";

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class SavedPromptError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: SavedPromptErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SavedPromptError";
  }
}

export interface SavedPromptsServiceOptions {
  /** `<appdir>/daemon/saved-prompts.json`. */
  file: string;
  /**
   * A project prompt's path must be exactly `<workspacesDir>/<workspace>/<project>`…
   * Getters, read at every use like the routes read `resolved`: `PUT
   * /api/config/daemon` can move both at runtime, without a restart.
   */
  workspacesDir: () => string;
  /** …and must realpath inside this sandbox root (the file browser's `fsRoot`). */
  fsRoot: () => string;
  logger?: Pick<Console, "warn" | "error">;
  /** The clock every stamp is read from; injected by tests. */
  now?: () => Date;
}

/**
 * The daemon-owned saved-prompt library behind `/api/saved-prompts`: global
 * prompts plus per-project ones, shared by every client. In-memory map mirrored
 * to `saved-prompts.json` with an atomic tmp+rename write — the todo and
 * recent-projects durability model — with differences that all protect the
 * user's prompts rather than a derived list:
 *
 * - a file that does not parse (or names a version this build does not know)
 *   is MOVED ASIDE to `saved-prompts.json.corrupt-<stamp>` rather than
 *   overwritten by the next write, and the daemon starts empty — never seeded,
 *   because the prompts it would seed over may be in that file;
 * - a file that cannot even be READ (permissions, I/O) may be a perfectly good
 *   library, so it is neither moved nor written over: the library starts
 *   empty and read-only, every mutation a 503 `SAVED_PROMPTS_UNAVAILABLE`
 *   refused before it touches memory — as it is when a corrupt file cannot be
 *   moved aside. Memory and disk never disagree, and no client is told a
 *   change was saved when nothing reached disk;
 * - whatever the file holds that this build cannot use — a record in a newer
 *   shape, an unknown top-level key — is written back verbatim by every write:
 *   never listed, never counted toward the cap, never touched by a cascade;
 * - writes are serialized, so overlapping mutations can never land on disk
 *   out of order.
 *
 * `lifecycle` emits `"upserted"` (the whole {@link SavedPrompt}) and
 * `"deleted"` ({@link SavedPromptDeletedPayload}) once per changed prompt — for
 * cascades too — and only after the change is written.
 *
 * Records are never mutated in place: a change replaces the map entry, so an
 * object already handed to a route or an event stays what it was.
 */
export class SavedPromptsService {
  private readonly prompts = new Map<string, SavedPrompt>();
  readonly lifecycle = new EventEmitter();
  /** The tail of the write chain (see `persist`). Never rejects. */
  private writes: Promise<void> = Promise.resolve();
  /**
   * Why the library is read-only this run, or null. Set only by `load`, when
   * the file on disk may hold the user's prompts and cannot be replaced safely
   * (unreadable, or corrupt and not movable): nothing is written over it.
   */
  private blockedReason: string | null = null;
  /** The file's `prompts` entries this build cannot use, written back verbatim after the library. */
  private rejected: unknown[] = [];
  /** The file's unknown top-level keys, written back verbatim beside `version` and `prompts`. */
  private extra: Record<string, unknown> = {};
  private readonly file: string;
  private readonly workspacesDir: () => string;
  private readonly fsRoot: () => string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly now: () => Date;

  constructor(options: SavedPromptsServiceOptions) {
    this.file = options.file;
    this.workspacesDir = options.workspacesDir;
    this.fsRoot = options.fsRoot;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read the library. A missing file is a first run: the starters are seeded
   * and written at once, so the file (the "seeded" marker) exists from then
   * on. A file that does not parse is quarantined; one that cannot be read at
   * all makes the library read-only for this run (see the class notes).
   */
  async load(): Promise<void> {
    this.prompts.clear();
    this.rejected = [];
    this.extra = {};
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.seed();
        await this.persist();
        return;
      }
      this.block(`saved-prompts.json could not be read (${code ?? "unknown error"})`, error);
      return;
    }

    let parsed: SavedPromptsFile;
    try {
      parsed = parseSavedPromptsConfig(JSON.parse(text));
    } catch (error) {
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const record of parsed.prompts) {
      this.prompts.set(record.id, record);
    }
    this.rejected = parsed.rejected;
    this.extra = parsed.extra;
    if (this.rejected.length > 0) {
      this.logger.warn(
        `saved-prompts.json: ${this.rejected.length} prompt(s) this build cannot read (malformed, a newer ` +
          "shape, or a repeated id) are not listed; they stay in the file untouched."
      );
    }
  }

  /** Every global prompt, plus `projectPath`'s own when given (validated as on create). Unordered. */
  async list(projectPath: string | null): Promise<SavedPrompt[]> {
    const project = projectPath === null ? null : await this.resolveProjectPath(projectPath);
    return [...this.prompts.values()].filter(
      (prompt) => prompt.projectPath === null || prompt.projectPath === project
    );
  }

  get(id: string): SavedPrompt | undefined {
    return this.prompts.get(id);
  }

  async create(request: CreateSavedPromptRequest): Promise<SavedPrompt> {
    this.requireWritable();
    const fields = fieldsOf(request);
    const title = normalizeTitle(fields.title);
    const body = normalizeBody(fields.body);
    const description = fields.description === undefined ? "" : normalizeDescription(fields.description);
    const tags = fields.tags === undefined ? [] : normalizeTags(fields.tags);
    const pinned = fields.pinned === undefined ? false : normalizePinned(fields.pinned);
    // An omitted projectPath is a global prompt, the same as an explicit null.
    const projectPath =
      fields.projectPath === undefined || fields.projectPath === null
        ? null
        : await this.resolveProjectPath(fields.projectPath);

    // Counted after the last await, so two racing creates cannot both take the last slot.
    if (this.prompts.size >= SAVED_PROMPTS_MAX) {
      throw new SavedPromptError(
        409,
        "SAVED_PROMPTS_FULL",
        `The prompt library is full (${SAVED_PROMPTS_MAX} prompts). Delete one to add another.`
      );
    }
    const now = this.timestamp();
    const prompt: SavedPrompt = {
      id: randomUUID(),
      title,
      description,
      body,
      tags,
      projectPath,
      pinned,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0
    };
    this.prompts.set(prompt.id, prompt);
    await this.persist();
    this.lifecycle.emit("upserted", prompt);
    return prompt;
  }

  /**
   * Apply a partial edit; `projectPath` moves the prompt between global and a
   * project. A patch that changes nothing answers the prompt as it is — no
   * new `updatedAt`, no write, no event.
   */
  async update(id: string, patch: UpdateSavedPromptRequest): Promise<SavedPrompt> {
    this.requireWritable();
    this.require(id);
    const fields = fieldsOf(patch);
    const changes: Partial<SavedPrompt> = {};
    if (fields.title !== undefined) changes.title = normalizeTitle(fields.title);
    if (fields.body !== undefined) changes.body = normalizeBody(fields.body);
    if (fields.description !== undefined) changes.description = normalizeDescription(fields.description);
    if (fields.tags !== undefined) changes.tags = normalizeTags(fields.tags);
    if (fields.pinned !== undefined) changes.pinned = normalizePinned(fields.pinned);
    if (fields.projectPath !== undefined) {
      changes.projectPath =
        fields.projectPath === null ? null : await this.resolveProjectPath(fields.projectPath);
    }

    // Re-read after the await: the prompt may have been deleted meanwhile.
    const current = this.require(id);
    const next: SavedPrompt = { ...current, ...changes };
    if (sameContent(current, next)) {
      return current;
    }
    next.updatedAt = this.timestamp();
    this.prompts.set(id, next);
    await this.persist();
    this.lifecycle.emit("upserted", next);
    return next;
  }

  /** An Insert or a Send used the prompt: `lastUsedAt` now, `useCount` + 1. Not an edit, so `updatedAt` stays. */
  async markUsed(id: string): Promise<SavedPrompt> {
    this.requireWritable();
    const current = this.require(id);
    const next: SavedPrompt = { ...current, lastUsedAt: this.timestamp(), useCount: current.useCount + 1 };
    this.prompts.set(id, next);
    await this.persist();
    this.lifecycle.emit("upserted", next);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.requireWritable();
    const current = this.require(id);
    this.prompts.delete(id);
    await this.persist();
    this.emitDeleted(current);
  }

  /** Cascade of a project delete: every prompt of that project goes with it. */
  async deleteForProject(projectPath: string): Promise<void> {
    const target = resolve(projectPath);
    await this.removeWhere((prompt) => prompt.projectPath !== null && resolve(prompt.projectPath) === target);
  }

  /** Cascade of a workspace delete: the prompts of every project under `workspaceDir`. */
  async deleteForWorkspace(workspaceDir: string): Promise<void> {
    const root = resolve(workspaceDir);
    await this.removeWhere(
      (prompt) => prompt.projectPath !== null && isInside(root, resolve(prompt.projectPath))
    );
  }

  /**
   * The stored form of a prompt's project, validated the way `POST
   * /api/projects/recent` validates its path: exactly
   * `<workspacesDir>/<workspace>/<project>` (both names through
   * `isValidName`), realpath'd inside the sandbox root, an existing directory.
   * Answered spelled the way `ProjectSummary.path` is — the raw join, symlinks
   * NOT resolved, no trailing slash — never the realpath: the client filters
   * prompts by comparing this string with its own project's path.
   */
  async resolveProjectPath(value: unknown): Promise<string> {
    if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
      throw invalidProject("projectPath must be an absolute project directory, or null for a global prompt.");
    }
    // Read once, so one validation never mixes two configurations.
    const workspacesDir = this.workspacesDir();
    const fsRoot = this.fsRoot();
    const described = describeProjectPath(workspacesDir, value);
    if (!described) {
      throw invalidProject(
        `projectPath must be a project directory, <workspaces>/<workspace>/<project>: ${excerpt(value)}`
      );
    }
    const path = join(workspacesDir, described.workspace, described.name);
    try {
      await assertInsideFsRoot(fsRoot, path);
    } catch {
      throw invalidProject(`projectPath is outside the sandbox: ${excerpt(value)}`);
    }
    let isDirectory = false;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch {
      // Missing or unreadable: not a project.
    }
    if (!isDirectory) {
      throw invalidProject(`projectPath is not an existing directory: ${excerpt(value)}`);
    }
    return path;
  }

  private require(id: string): SavedPrompt {
    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw new SavedPromptError(404, "SAVED_PROMPT_NOT_FOUND", `No saved prompt with id ${excerpt(id)}.`);
    }
    return prompt;
  }

  /** Every mutation's first step: a read-only library refuses before memory is touched. */
  private requireWritable(): void {
    if (this.blockedReason !== null) {
      throw new SavedPromptError(
        503,
        "SAVED_PROMPTS_UNAVAILABLE",
        `Saved prompts are read-only: ${this.blockedReason}. Nothing is saved until the file is fixed ` +
          "and the daemon restarts."
      );
    }
  }

  /** Make the library read-only for this run: the file on disk is never written over. */
  private block(reason: string, error: unknown): void {
    this.blockedReason = reason;
    this.logger.error(
      `${reason}: ${String(error)}. Saved prompts are read-only until it is fixed and the daemon restarts.`
    );
  }

  private async removeWhere(match: (prompt: SavedPrompt) => boolean): Promise<void> {
    // A read-only library holds nothing, and a cascade must not fail the delete it follows.
    if (this.blockedReason !== null) {
      return;
    }
    const removed = [...this.prompts.values()].filter(match);
    if (removed.length === 0) {
      return;
    }
    for (const prompt of removed) {
      this.prompts.delete(prompt.id);
    }
    await this.persist();
    for (const prompt of removed) {
      this.emitDeleted(prompt);
    }
  }

  private emitDeleted(prompt: SavedPrompt): void {
    const payload: SavedPromptDeletedPayload = { id: prompt.id, projectPath: prompt.projectPath };
    this.lifecycle.emit("deleted", payload);
  }

  private seed(): void {
    // The client lists never-used prompts newest first, so each starter is
    // stamped a millisecond before the one above it: they list in this
    // order, the order the rail's design shows them in.
    const start = this.now().getTime();
    STARTER_PROMPTS.forEach((starter, index) => {
      const now = new Date(start - index).toISOString();
      const prompt: SavedPrompt = {
        id: randomUUID(),
        title: starter.title,
        description: starter.description,
        body: starter.body,
        tags: [...starter.tags],
        projectPath: null,
        pinned: starter.pinned,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        useCount: 0
      };
      this.prompts.set(prompt.id, prompt);
    });
  }

  /**
   * Move a file this build cannot parse out of the way, then write the empty
   * library in its place: the file existing is what says "already seeded", so
   * the starters never land over a library that was only unparseable. A file
   * that cannot be moved is never written over either — it may be the only
   * copy of the user's prompts — and the library is read-only instead.
   */
  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.file}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.block(
        `saved-prompts.json is corrupt and could not be moved aside (${code ?? "unknown error"})`,
        `${detail}; ${String(error)}`
      );
      return;
    }
    this.logger.warn(`saved-prompts.json is corrupt (${detail}); moved it to ${aside} and started with an empty library.`);
    await this.persist();
  }

  /**
   * Write the whole library (0600): the prompts, then the entries this build
   * could not read and the unknown top-level keys, both verbatim. Writes are
   * chained and each one serializes the map when it RUNS, not when it was
   * queued, so the last write always carries the latest state and two
   * overlapping mutations cannot leave the older one on disk. A failed write
   * is logged, not thrown — memory stays authoritative and the next write
   * catches the file up.
   */
  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.blockedReason !== null) {
        return;
      }
      const data = { version: 1 as const, prompts: [...this.prompts.values(), ...this.rejected], ...this.extra };
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
      } catch (error) {
        this.logger.error("Failed to persist saved prompts", error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/**
 * Every library change → the `/events` bus, on {@link SAVED_PROMPTS_CHANNEL}.
 * `/events` streams every channel to every client, so this is all it takes for
 * the web and desktop clients to update live. Lives here rather than inline in
 * `startDaemon` so the channel and type strings the clients match on are
 * pinned by a test.
 */
export function publishSavedPromptEvents(
  service: SavedPromptsService,
  broadcaster: Pick<Broadcaster, "publish">
): void {
  const publish = (type: SavedPromptEventType, payload: SavedPrompt | SavedPromptDeletedPayload) =>
    broadcaster.publish(SAVED_PROMPTS_CHANNEL, type, payload);
  service.lifecycle.on("upserted", (prompt: SavedPrompt) => publish("savedPrompt.upserted", prompt));
  service.lifecycle.on("deleted", (payload: SavedPromptDeletedPayload) => publish("savedPrompt.deleted", payload));
}

function invalid(message: string): SavedPromptError {
  return new SavedPromptError(400, "INVALID_REQUEST", message);
}

function invalidProject(message: string): SavedPromptError {
  return new SavedPromptError(400, "INVALID_PROJECT_PATH", message);
}

/** A user-supplied string quoted in an error message, bounded. */
function excerpt(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The request body as a field bag. Every field is checked at runtime: it is JSON off the wire. */
function fieldsOf(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("The request body must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("title must be a string.");
  }
  const title = value.trim();
  if (title.length === 0) {
    throw invalid("title must not be empty.");
  }
  if (title.length > SAVED_PROMPT_TITLE_MAX) {
    throw invalid(`title must be at most ${SAVED_PROMPT_TITLE_MAX} characters (got ${title.length}).`);
  }
  return title;
}

/** Kept exactly as written — whitespace is part of a template (a trailing `Task: ` is deliberate). */
function normalizeBody(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("body must be a string.");
  }
  if (value.trim().length === 0) {
    throw invalid("body must not be empty.");
  }
  if (value.length > SAVED_PROMPT_BODY_MAX) {
    throw invalid(`body must be at most ${SAVED_PROMPT_BODY_MAX} characters (got ${value.length}).`);
  }
  return value;
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("description must be a string.");
  }
  const description = value.trim();
  if (description.length > SAVED_PROMPT_DESCRIPTION_MAX) {
    throw invalid(
      `description must be at most ${SAVED_PROMPT_DESCRIPTION_MAX} characters (got ${description.length}).`
    );
  }
  return description;
}

/**
 * Tags in the user's order: each trimmed, blanks dropped, duplicates dropped
 * case-insensitively (the first spelling wins), then held to the limits — so
 * `["Review", "review "]` is one tag, not a refusal.
 */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalid("tags must be an array of strings.");
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw invalid("tags must be an array of strings.");
    }
    const tag = entry.trim();
    if (tag.length === 0) {
      continue;
    }
    if (tag.length > SAVED_PROMPT_TAG_MAX) {
      throw invalid(`Each tag must be at most ${SAVED_PROMPT_TAG_MAX} characters: "${excerpt(tag, 40)}".`);
    }
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > SAVED_PROMPT_TAGS_MAX) {
    throw invalid(`At most ${SAVED_PROMPT_TAGS_MAX} tags are allowed (got ${tags.length}).`);
  }
  return tags;
}

function normalizePinned(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalid("pinned must be a boolean.");
  }
  return value;
}

/** Whether an edit changed anything a user can see (the stamps aside). */
function sameContent(a: SavedPrompt, b: SavedPrompt): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.body === b.body &&
    a.pinned === b.pinned &&
    a.projectPath === b.projectPath &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** `path` is `root` or below it. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
