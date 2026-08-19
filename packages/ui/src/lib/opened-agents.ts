import type { AgentSessionEntry } from "../components/attention/agent-sessions";
import type { ProjectIndex } from "./project-index";

/**
 * Collapse state for the sidebar's "Opened Agents" section. Stored as the
 * literal "1"/"0" so the load is validated by construction — anything else
 * (including a stale payload from an old bundle) falls back to expanded.
 */
const STORAGE_KEY = "orquester:opened-agents-collapsed";

export function loadOpenedAgentsCollapsed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the collapse choice; a storage failure is non-fatal. */
export function saveOpenedAgentsCollapsed(collapsed: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  } catch {
    /* ignore quota/availability errors — the choice stays in-memory only */
  }
}

/** One "Opened Agents" group: every agent session in one git repo, across all its checkouts. */
export interface RepoGroup {
  key: string;
  /** Header label — the remote's `owner/repo` (or the local repo's dir name). */
  title: string;
  items: AgentSessionEntry[];
  /**
   * The group's checkouts live in more than one workspace, so rows need their
   * workspace prefix to stay distinguishable.
   */
  multiWorkspace: boolean;
}

/**
 * Group verified agent sessions by the git repo their project belongs to, so a
 * repo's sibling checkouts (`Apps-Stats`, `Apps-Stats-2`, …) share one group.
 *
 * The repo identity is the index's `ProjectSummary.repoId` — the verified
 * list is a subset of the index by construction, so the lookup always hits; the
 * `projectPath` fallback covers a non-git project or an older daemon, which
 * then simply group per-project. The key is the repo identity ALONE:
 * checkouts of one remote merge into one group even across workspaces (rows
 * then carry their workspace prefix via `multiWorkspace`).
 *
 * Ordering is deliberately STABLE — alphabetical groups, and within a group
 * alphabetical by workspace then project folder (naturally, so `-2` < `-10`),
 * then tab order. Activity never reorders anything (an earlier
 * bubbling-by-attention version scrambled the list every time an agent
 * called); status lives on the row dot.
 */
export function groupAgentSessionsByRepo(
  entries: AgentSessionEntry[],
  index: ProjectIndex
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const entry of entries) {
    const repoId =
      index.visible.get(entry.session.projectPath)?.repoId ?? entry.session.projectPath;
    let group = groups.get(repoId);
    if (!group) {
      group = { key: repoId, title: repoTitle(repoId), items: [], multiWorkspace: false };
      groups.set(repoId, group);
    }
    group.items.push(entry);
    if (entry.project.workspace !== group.items[0].project.workspace) {
      group.multiWorkspace = true;
    }
  }
  for (const group of groups.values()) {
    group.items.sort(
      (a, b) =>
        compareNatural(a.project.workspace, b.project.workspace) ||
        compareNatural(a.project.name, b.project.name) ||
        a.session.order - b.session.order ||
        a.session.createdAt.localeCompare(b.session.createdAt)
    );
  }
  return Array.from(groups.values()).sort(
    (a, b) => compareNatural(a.title, b.title) || a.key.localeCompare(b.key)
  );
}

/**
 * `github.com/AppsStats/Apps-Stats` → `AppsStats/Apps-Stats`; a path id keeps
 * only its dir name (the parent segment of a local repo path is just where it
 * happens to live, not an owner).
 */
function repoTitle(repoId: string): string {
  const segments = repoId.split(/[\\/]/).filter(Boolean);
  const isPath = /^([\\/]|[a-zA-Z]:)/.test(repoId);
  const kept = isPath ? segments.slice(-1) : segments.slice(1);
  return kept.join("/") || repoId;
}

/** Alphabetical with numeric runs compared as numbers (`-2` before `-10`). */
function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
