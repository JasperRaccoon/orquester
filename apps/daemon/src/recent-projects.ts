import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RecentProjectSummary } from "@orquester/api";
import {
  MAX_RECENT_PROJECTS,
  type RecentProject,
  type WorkspacesConfig,
  isValidName,
  parseRecentProjectsConfig
} from "@orquester/config";

/**
 * Derive the {name, workspace} pair the project routes use from a path, which
 * must be exactly `<workspacesDir>/<workspace>/<project>` — the same shape
 * `listProjects` builds. Anything else (the workspaces root, a workspace dir, a
 * file deeper in a project, a path outside the tree) is not a project and
 * returns null. Both segments go through the same `isValidName` gate the
 * project routes use, so a dot-directory the file browser hides (`.git`,
 * `.stage`) can never be recorded as a project either.
 */
export function describeProjectPath(
  workspacesDir: string,
  path: string
): { name: string; workspace: string } | null {
  const rel = relative(resolve(workspacesDir), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  const segments = rel.split(sep);
  if (segments.length !== 2 || !segments.every((s) => isValidName(s))) {
    return null;
  }
  return { workspace: segments[0], name: segments[1] };
}

/**
 * Newest first. Only used to restore an order from disk — live ordering comes
 * from moving the marked entry to the front, since `lastInteractedAt` has
 * millisecond resolution and two marks can land in the same tick. Ties break on
 * path so a reload is at least deterministic.
 */
function byRecency(a: RecentProject, b: RecentProject): number {
  if (a.lastInteractedAt !== b.lastInteractedAt) {
    return a.lastInteractedAt < b.lastInteractedAt ? 1 : -1;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Daemon-owned list of recently interacted-with projects. In-memory array
 * mirrored to `recent-projects.json` with an atomic tmp+rename write and
 * reloaded on boot — the same durability model as the todo/session indexes.
 * Server-side (rather than per-browser localStorage) so every device sees the
 * same list. `lifecycle` emits "changed" with the full list.
 */
export class RecentProjectsService {
  private entries: RecentProject[] = [];
  /** `<workspace>/<project>` keys behind the archive curtain, as of the last `list()`. */
  private archived = new Set<string>();
  /** Workspace names archived wholesale, as of the last `list()`. */
  private archivedWorkspaces = new Set<string>();
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly indexPath: string,
    /** Root the `<workspace>/<project>` shape of an entry's path is measured from. */
    private readonly workspacesDir: string,
    private readonly logger: Pick<Console, "warn"> = console,
    /**
     * Reader for the workspaces side-table (`workspaces.json`), injected so the
     * route layer keeps owning the tolerant parse. Omitted ⇒ nothing is ever
     * reported archived.
     */
    private readonly readWorkspacesMeta?: () => Promise<WorkspacesConfig>
  ) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.indexPath, "utf8");
      this.entries = parseRecentProjectsConfig(JSON.parse(text)).projects.sort(byRecency);
      this.entries.length = Math.min(this.entries.length, MAX_RECENT_PROJECTS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // Corrupt/unreadable: keep the list empty but DON'T overwrite the file.
        this.logger.warn(`Failed to read recent projects index: ${String(error)}`);
      }
    }
  }

  /**
   * The list as clients see it, minus entries whose directory is gone — a
   * deleted project must not linger. Best-effort: a `stat` that fails for any
   * reason other than "not there" keeps the entry. Prunes the persisted file
   * (and notifies) only when something actually disappeared.
   */
  async list(): Promise<RecentProjectSummary[]> {
    await this.refreshArchived();
    const alive = await Promise.all(
      this.entries.map(async (entry) => {
        try {
          return (await stat(entry.path)).isDirectory();
        } catch (error) {
          return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
        }
      })
    );
    if (alive.includes(false)) {
      this.entries = this.entries.filter((_, i) => alive[i]);
      await this.persist();
      this.lifecycle.emit("changed", this.decorate());
    }
    return this.decorate();
  }

  /**
   * The list as it stands, without the `list()` liveness sweep or its event.
   * Still re-reads the side-table: the flag is the archived curtain, and a
   * response that carries a curtain state from minutes ago is a hole in it.
   */
  async snapshot(): Promise<RecentProjectSummary[]> {
    await this.refreshArchived();
    return this.decorate();
  }

  /**
   * Stamp each entry with the archive curtain state from the last
   * `refreshArchived()`. Read once per call (not once per entry): the join is a
   * cosmetic flag on a ≤MAX_RECENT_PROJECTS list, not something worth a
   * workspaces.json read each.
   */
  private decorate(): RecentProjectSummary[] {
    return this.entries.map((entry) => {
      const hidden =
        this.archivedWorkspaces.has(entry.workspace) || this.archived.has(`${entry.workspace}/${entry.name}`);
      return hidden ? { ...entry, isArchived: true } : { ...entry };
    });
  }

  /**
   * Rebuild the archived key set from `workspaces.json`. A project counts as
   * archived when it is listed in its workspace's `archivedProjects` OR the
   * whole workspace is archived — both hide it behind the same curtain in the
   * sidebar, so a recents row must be treated the same way. Best-effort: an
   * unreadable side-table keeps the previous set rather than un-hiding rows.
   */
  private async refreshArchived(): Promise<void> {
    if (!this.readWorkspacesMeta) {
      return;
    }
    let meta: WorkspacesConfig;
    try {
      meta = await this.readWorkspacesMeta();
    } catch {
      return;
    }
    const projects = new Set<string>();
    const workspaces = new Set<string>();
    for (const workspace of meta.workspaces) {
      if (workspace.isArchived) {
        workspaces.add(workspace.name);
      }
      for (const project of workspace.archivedProjects) {
        projects.add(`${workspace.name}/${project}`);
      }
    }
    this.archived = projects;
    this.archivedWorkspaces = workspaces;
  }

  /**
   * Record one interaction with `path` (already sandbox-validated by the
   * caller). Returns null when the path is not a project — callers treat that
   * as "nothing to record", never as an error. The path is normalized (but not
   * realpath'd) so it stays comparable to `ProjectSummary.path`, and so a
   * trailing slash can't create a duplicate entry.
   */
  async markInteracted(rawPath: string): Promise<RecentProjectSummary | null> {
    const described = describeProjectPath(this.workspacesDir, rawPath);
    if (!described) {
      return null;
    }
    const path = resolve(rawPath);
    // Only real directories get in: `list()` prunes what disappears, so an
    // entry for a path that never existed (a typo'd client POST) would
    // otherwise sit at the top of the list until the next read.
    try {
      if (!(await stat(path)).isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }
    const existing = this.entries.find((entry) => entry.path === path);
    const record: RecentProject = {
      ...described,
      path,
      lastInteractedAt: new Date().toISOString(),
      interactionCount: (existing?.interactionCount ?? 0) + 1
    };
    this.entries = [record, ...this.entries.filter((entry) => entry.path !== path)];
    this.entries.length = Math.min(this.entries.length, MAX_RECENT_PROJECTS);
    await this.persist();
    // Re-read the curtain before decorating: this list is broadcast to every
    // client, and archiving a project does not itself touch recents — without
    // this, a row stays un-hidden until the next `list()`.
    await this.refreshArchived();
    const decorated = this.decorate();
    this.lifecycle.emit("changed", decorated);
    return decorated[0] ?? record;
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.indexPath}.tmp`;
    try {
      await mkdir(dirname(this.indexPath), { recursive: true });
      const data = { version: 1 as const, projects: this.entries };
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.indexPath);
    } catch (error) {
      console.error("Failed to persist recent projects index", error);
    }
  }
}
