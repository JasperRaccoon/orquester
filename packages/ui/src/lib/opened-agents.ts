import { isFlaggedBucket, type AgentSessionEntry } from "../components/attention/agent-sessions";
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
  /** Header label — `workspace/<repo name>`. */
  title: string;
  items: AgentSessionEntry[];
}

/**
 * Group verified agent sessions by the git repo their project belongs to, so a
 * repo's sibling checkouts (`Apps-Stats`, `Apps-Stats-2`, …) share one group.
 *
 * The repo identity is the index's `ProjectSummary.repoId` — the verified
 * list is a subset of the index by construction, so the lookup always hits; the
 * `projectPath` fallback covers a non-git project or an older daemon, which
 * then simply group per-project. The workspace joins the key because two
 * workspaces can hold distinct checkouts of one repo, and each workspace keeps
 * its own group.
 *
 * Entries arrive in {@link deriveAgentSessions} order (loudest bucket first),
 * so each group's rows are already attention-first; groups with a flagged row
 * bubble to the top (most recent call first), the calm remainder alphabetical.
 */
export function groupAgentSessionsByRepo(
  entries: AgentSessionEntry[],
  index: ProjectIndex
): RepoGroup[] {
  const groups = new Map<string, { group: RepoGroup; flaggedAt: string }>();
  for (const entry of entries) {
    const repoId =
      index.visible.get(entry.session.projectPath)?.repoId ?? entry.session.projectPath;
    // `/` can't appear in a workspace name (a single directory), so the key is
    // unambiguous.
    const key = `${entry.project.workspace}/${repoId}`;
    let slot = groups.get(key);
    if (!slot) {
      const repoName = repoId.split(/[\\/]/).filter(Boolean).pop() ?? repoId;
      slot = {
        group: {
          key,
          title: `${entry.project.workspace ? `${entry.project.workspace}/` : ""}${repoName}`,
          items: []
        },
        flaggedAt: ""
      };
      groups.set(key, slot);
    }
    slot.group.items.push(entry);
    if (isFlaggedBucket(entry.bucket) && entry.flaggedAt > slot.flaggedAt) {
      slot.flaggedAt = entry.flaggedAt;
    }
  }
  return Array.from(groups.values())
    .sort(
      (a, b) =>
        // A non-empty flaggedAt sorts before "" and newer before older.
        b.flaggedAt.localeCompare(a.flaggedAt) || a.group.title.localeCompare(b.group.title)
    )
    .map((slot) => slot.group);
}
